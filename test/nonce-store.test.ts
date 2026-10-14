/**
 * The nonce store (`wative/nonces`). The viewport/batch/cancel/cache scheduler is
 * the shared `createViewportStore`, already pinned by `balance-store.test.ts`, so
 * these tests focus on what is nonce-specific — the value / `na` / failed loaded
 * mapping — plus a confirmation that the scheduling still runs through
 * `createNonceStore` (viewport-only, batching, cancel, cache).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createNonceStore, type NonceValue } from "../src/core/nodeNonceStore.js";
import type { ViewportReader } from "../src/core/viewportStore.js";

type NonceRead = { kind: "loaded"; value: NonceValue } | { kind: "failed" };
const value = (n: number): NonceRead => ({ kind: "loaded", value: { kind: "value", value: n } });
const NA: NonceRead = { kind: "loaded", value: { kind: "na" } };
const FAILED: NonceRead = { kind: "failed" };
const abortError = (): Error => Object.assign(new Error("aborted"), { name: "AbortError" });
const range = (n: number, start = 0): number[] => Array.from({ length: n }, (_, i) => i + start);
const drain = async (turns = 4): Promise<void> => {
  for (let i = 0; i < turns; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

interface Call {
  readonly id: number;
  settled: boolean;
  aborted: boolean;
  resolve(result: NonceRead): void;
  reject(error: unknown): void;
}

function makeHarness(): {
  read: ViewportReader<NonceValue>;
  sleep: (ms: number) => Promise<void>;
  pendingIds(): number[];
  callFor(id: number): Call | undefined;
  readCount(id: number): number;
  settle(id: number, result: NonceRead): void;
} {
  const calls: Call[] = [];
  const read: ViewportReader<NonceValue> = (id, signal) =>
    new Promise<NonceRead>((resolve, reject) => {
      const call: Call = { id, settled: false, aborted: false, resolve, reject };
      const onAbort = (): void => {
        if (call.settled) return;
        call.settled = true;
        call.aborted = true;
        reject(abortError());
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      calls.push(call);
    });
  return {
    read,
    sleep: () => Promise.resolve(),
    pendingIds: () => calls.filter((call) => !call.settled).map((call) => call.id),
    callFor: (id) => [...calls].reverse().find((call) => call.id === id),
    readCount: (id) => calls.filter((call) => call.id === id).length,
    settle(id, result) {
      const call = [...calls].reverse().find((candidate) => candidate.id === id && !candidate.settled);
      assert.ok(call, `no pending read for wallet ${id}`);
      call.settled = true;
      call.resolve(result);
    },
  };
}

test("the nonce store loads only the viewport, in batches of 5", () => {
  const h = makeHarness();
  const store = createNonceStore("acct", "sepolia", { read: h.read, sleep: h.sleep, batchSize: 5 });
  store.setViewport(range(10));
  assert.deepEqual(h.pendingIds(), [0, 1, 2, 3, 4], "only the first batch is in flight");
  assert.equal(store.get(0).status, "loading");
  assert.equal(store.get(5).status, "queued");
  assert.equal(store.get(99).status, "unstarted");
  store.dispose();
});

test("a value, an na, and a failed read map to the right entry", async () => {
  const h = makeHarness();
  const store = createNonceStore("acct", "sepolia", { read: h.read, sleep: h.sleep, batchSize: 5 });
  store.setViewport([0, 1, 2]);
  h.settle(0, value(42));
  h.settle(1, NA);
  h.settle(2, FAILED);
  await drain();
  assert.deepEqual(store.get(0), { status: "loaded", value: { kind: "value", value: 42 } }, "a numeric nonce");
  assert.deepEqual(store.get(1), { status: "loaded", value: { kind: "na" } }, "no EVM address → na, a loaded terminal");
  assert.deepEqual(store.get(2), { status: "failed" }, "a read failure → failed");
  store.dispose();
});

test("a loading read aborts when the wallet scrolls out of the viewport", () => {
  const h = makeHarness();
  const store = createNonceStore("acct", "sepolia", { read: h.read, sleep: h.sleep, batchSize: 5 });
  store.setViewport(range(5)); // 0..4 loading
  store.setViewport(range(5, 5)); // 5..9 — 0..4 leave while loading
  assert.equal(store.get(0).status, "unstarted", "an aborted read returns to unstarted");
  assert.equal(h.callFor(0)?.aborted, true, "the departed wallet's read was aborted");
  store.dispose();
});

test("loaded (value or na) is cached; re-entering the viewport does not re-read", async () => {
  const h = makeHarness();
  const store = createNonceStore("acct", "sepolia", { read: h.read, sleep: h.sleep, batchSize: 5 });
  store.setViewport([0, 1]);
  h.settle(0, value(7));
  h.settle(1, NA);
  await drain();
  store.setViewport([2, 3]); // 0,1 leave
  store.setViewport([0, 1]); // and return
  assert.deepEqual(store.get(0), { status: "loaded", value: { kind: "value", value: 7 } });
  assert.deepEqual(store.get(1), { status: "loaded", value: { kind: "na" } });
  assert.equal(h.readCount(0), 1, "a cached value is not re-read");
  assert.equal(h.readCount(1), 1, "a cached na is not re-read");
  store.dispose();
});

test("refresh re-reads a cached wallet", async () => {
  const h = makeHarness();
  const store = createNonceStore("acct", "sepolia", { read: h.read, sleep: h.sleep, batchSize: 5 });
  store.setViewport([0]);
  h.settle(0, value(1));
  await drain();
  assert.equal(store.get(0).status, "loaded");
  store.refresh([0]);
  assert.equal(store.get(0).status, "loading", "refresh re-queues and re-reads");
  assert.equal(h.readCount(0), 2);
  store.dispose();
});

test("dispose aborts in-flight reads and makes the store inert", () => {
  const h = makeHarness();
  const store = createNonceStore("acct", "sepolia", { read: h.read, sleep: h.sleep, batchSize: 5 });
  store.setViewport(range(5)); // 0..4 loading
  store.dispose();
  assert.equal(h.callFor(0)?.aborted, true, "dispose aborts in-flight reads");
  store.setViewport(range(5, 10));
  assert.equal(h.callFor(10), undefined, "a disposed store does not read");
});
