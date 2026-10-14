/**
 * The balance store's scheduler + 5-status state machine, driven through its
 * injectable `read`/`sleep` seams — no RPC, no real timers. The real network read
 * (`readWalletBalances`) is exercised by the consumer's integration tests; here
 * we prove the viewport/queue/batch/crawl/cancel/cache logic deterministically.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createBalanceStore, type BalanceReader } from "../src/core/balanceStore.js";
import type { WalletBalances } from "../src/core/session.js";

type ReadResult = Extract<WalletBalances, { kind: "ready" | "error" }>;
const READY: ReadResult = { kind: "ready", byAsset: new Map() };
const abortError = (): Error => Object.assign(new Error("aborted"), { name: "AbortError" });
const range = (n: number, start = 0): number[] => Array.from({ length: n }, (_, i) => i + start);
/** Let the async pump settle (drain microtasks across a few turns). */
const drain = async (turns = 4): Promise<void> => {
  for (let i = 0; i < turns; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

interface Call {
  readonly id: number;
  settled: boolean;
  aborted: boolean;
  resolve(result: ReadResult): void;
  reject(error: unknown): void;
}

function makeHarness(): {
  read: BalanceReader;
  sleep: (ms: number) => Promise<void>;
  sleeps: number[];
  pendingIds(): number[];
  callFor(id: number): Call | undefined;
  everRead(id: number): boolean;
  readCount(id: number): number;
  settle(id: number, result: ReadResult): void;
  settleReady(id: number): void;
  settleAllReady(): void;
} {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const read: BalanceReader = (id, signal) =>
    new Promise<ReadResult>((resolve, reject) => {
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
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    sleeps,
    pendingIds: () => calls.filter((call) => !call.settled).map((call) => call.id),
    callFor: (id) => [...calls].reverse().find((call) => call.id === id),
    everRead: (id) => calls.some((call) => call.id === id),
    readCount: (id) => calls.filter((call) => call.id === id).length,
    settle(id, result) {
      const call = [...calls].reverse().find((candidate) => candidate.id === id && !candidate.settled);
      assert.ok(call, `no pending read for wallet ${id}`);
      call.settled = true;
      call.resolve(result);
    },
    settleReady(id) {
      this.settle(id, READY);
    },
    settleAllReady() {
      for (const call of calls.filter((candidate) => !candidate.settled)) {
        call.settled = true;
        call.resolve(READY);
      }
    },
  };
}

test("only viewport wallets are queued; the first batch of 5 loads, the rest wait queued", () => {
  const h = makeHarness();
  const store = createBalanceStore("acct", { read: h.read, sleep: h.sleep, batchSize: 5, batchDelayMs: 100 });
  store.setViewport(range(10));
  assert.deepEqual(h.pendingIds(), [0, 1, 2, 3, 4], "exactly the first batch of 5 is in flight");
  assert.equal(store.get(0).status, "loading");
  assert.equal(store.get(4).status, "loading");
  assert.equal(store.get(5).status, "queued");
  assert.equal(store.get(9).status, "queued");
  assert.equal(store.get(99).status, "unstarted", "a wallet never in the viewport is unstarted");
  store.dispose();
});

test("a wallet outside the viewport is never read (lazy, viewport-only)", () => {
  const h = makeHarness();
  const store = createBalanceStore("acct", { read: h.read, sleep: h.sleep, batchSize: 5 });
  store.setViewport(range(5)); // 0..4 only
  assert.deepEqual(h.pendingIds(), [0, 1, 2, 3, 4]);
  assert.equal(h.everRead(100), false);
  assert.equal(h.everRead(5), false);
  store.dispose();
});

test("batches of 5 with a delay between them; the window loads every visible wallet", async () => {
  const h = makeHarness();
  const store = createBalanceStore("acct", { read: h.read, sleep: h.sleep, batchSize: 5, batchDelayMs: 100 });
  store.setViewport(range(10));
  assert.deepEqual(h.pendingIds(), [0, 1, 2, 3, 4]);
  assert.deepEqual(h.sleeps, [], "no delay before the first batch");

  h.settleAllReady(); // finish batch 1
  await drain();
  assert.deepEqual(h.pendingIds(), [5, 6, 7, 8, 9], "batch 2 started after batch 1");
  assert.deepEqual(h.sleeps, [100], "one inter-batch delay of batchDelayMs");

  h.settleAllReady(); // finish batch 2
  await drain();
  assert.equal(h.pendingIds().length, 0, "no reads remain");
  assert.deepEqual(h.sleeps, [100], "no delay after the final batch (nothing left to do)");
  for (const id of range(10)) assert.equal(store.get(id).status, "loaded", `wallet ${id} loaded`);
  store.dispose();
});

test("the crawling window starts at the cursor and follows the travel direction", () => {
  for (const [direction, expected] of [
    ["down", [10, 11, 12, 13, 14]],
    ["up", [10, 9, 8, 7, 6]],
  ] as const) {
    const h = makeHarness();
    const store = createBalanceStore("acct", { read: h.read, sleep: h.sleep, batchSize: 5 });
    store.setViewport(range(20), { anchor: 10, direction });
    assert.deepEqual(h.pendingIds(), expected, `the first batch crawls ${direction} from the cursor`);
    store.dispose();
  }
});

test("a queued wallet that scrolls out of the viewport is dequeued (unstarted), never read", () => {
  const h = makeHarness();
  const store = createBalanceStore("acct", { read: h.read, sleep: h.sleep, batchSize: 5 });
  store.setViewport(range(10)); // 0..4 loading, 5..9 queued
  assert.equal(store.get(9).status, "queued");
  store.setViewport(range(7)); // 7,8,9 leave while still queued
  assert.equal(store.get(9).status, "unstarted", "a departed queued wallet returns to unstarted");
  assert.equal(h.everRead(9), false, "a dequeued wallet is never read");
  assert.equal(store.get(5).status, "queued", "a still-visible queued wallet stays queued");
  store.dispose();
});

test("a loading wallet that scrolls out of the viewport has its read aborted (→ unstarted)", () => {
  const h = makeHarness();
  const store = createBalanceStore("acct", { read: h.read, sleep: h.sleep, batchSize: 5 });
  store.setViewport(range(10)); // 0..4 loading
  assert.equal(store.get(0).status, "loading");
  store.setViewport(range(10, 5)); // 5..14 — 0..4 leave while loading
  assert.equal(store.get(0).status, "unstarted", "an aborted in-flight read returns to unstarted");
  assert.equal(h.callFor(0)?.aborted, true, "the in-flight read for the departed wallet was aborted");
  store.dispose();
});

test("loaded balances are cached; re-entering the viewport does not re-read", async () => {
  const h = makeHarness();
  const store = createBalanceStore("acct", { read: h.read, sleep: h.sleep, batchSize: 5 });
  store.setViewport(range(5));
  h.settleReady(0);
  await drain();
  assert.equal(store.get(0).status, "loaded");

  store.setViewport(range(5, 1)); // 0 leaves
  store.setViewport(range(5)); // 0 returns
  assert.equal(store.get(0).status, "loaded", "a cached wallet stays loaded on re-entry");
  assert.equal(h.readCount(0), 1, "a cached wallet is not re-read");
  store.dispose();
});

test("a failed read is terminal and not re-queued until an explicit refresh", async () => {
  const h = makeHarness();
  const store = createBalanceStore("acct", { read: h.read, sleep: h.sleep, batchSize: 5 });
  store.setViewport(range(5));
  h.settle(0, { kind: "error" }); // wallet 0 fails...
  h.settleAllReady(); // ...and the rest of the batch succeeds, so the pump goes idle
  await drain();
  assert.equal(store.get(0).status, "failed");
  assert.equal(h.readCount(0), 1);

  // Re-declaring the same viewport must NOT re-queue a failed (cached) wallet.
  store.setViewport(range(5));
  await drain();
  assert.equal(store.get(0).status, "failed", "a failed wallet is cached, not auto-retried");
  assert.equal(h.readCount(0), 1);

  // An explicit refresh re-queues and re-reads it.
  store.refresh([0]);
  assert.equal(store.get(0).status, "loading", "refresh re-reads a failed wallet");
  assert.equal(h.readCount(0), 2);
  store.dispose();
});

test("a completed read is cached even if the wallet scrolled away mid-flight", async () => {
  const h = makeHarness();
  const store = createBalanceStore("acct", { read: h.read, sleep: h.sleep, batchSize: 5 });
  store.setViewport(range(5)); // 0..4 loading
  // Wallet 0's read RESOLVES before we remove it: its data is valid, so it should
  // be cached as loaded rather than discarded.
  h.settleReady(0);
  store.setViewport(range(4, 1)); // 1..4 — 0 removed, but its read already resolved
  await drain();
  assert.equal(store.get(0).status, "loaded", "a read that completed is cached, not thrown away");
  store.dispose();
});

test("refresh of visible wallets re-reads; refresh of off-screen wallets just clears the cache", async () => {
  const h = makeHarness();
  const store = createBalanceStore("acct", { read: h.read, sleep: h.sleep, batchSize: 5 });
  store.setViewport(range(5));
  h.settleAllReady();
  await drain();
  for (const id of range(5)) assert.equal(store.get(id).status, "loaded");

  // Narrow the viewport, then refresh the whole original set.
  store.setViewport(range(2)); // only 0,1 visible
  store.refresh(range(5));
  assert.equal(store.get(0).status, "loading", "a visible refreshed wallet re-reads");
  assert.equal(store.get(4).status, "unstarted", "an off-screen refreshed wallet is cleared, not read");
  assert.equal(h.everRead(4) && h.readCount(4) > 1, false);
  store.dispose();
});

test("subscribe fires on change, unsubscribe stops it, and snapshot is stable until state changes", () => {
  const h = makeHarness();
  const store = createBalanceStore("acct", { read: h.read, sleep: h.sleep, batchSize: 5 });
  let fired = 0;
  const unsubscribe = store.subscribe(() => (fired += 1));

  const s0 = store.snapshot();
  assert.equal(store.snapshot(), s0, "snapshot is a stable reference while nothing changes");

  store.setViewport(range(5));
  assert.ok(fired > 0, "a state change notifies subscribers");
  assert.notEqual(store.snapshot(), s0, "snapshot is a new reference after a change");

  const before = fired;
  unsubscribe();
  store.setViewport(range(6));
  assert.equal(fired, before, "no notification after unsubscribe");
  store.dispose();
});

test("dispose aborts in-flight reads and makes the store inert", () => {
  const h = makeHarness();
  const store = createBalanceStore("acct", { read: h.read, sleep: h.sleep, batchSize: 5 });
  store.setViewport(range(5)); // 0..4 loading
  store.dispose();
  assert.equal(h.callFor(0)?.aborted, true, "dispose aborts in-flight reads");
  store.setViewport(range(5, 10)); // inert after dispose
  assert.equal(h.everRead(10), false, "a disposed store does not read");
});
