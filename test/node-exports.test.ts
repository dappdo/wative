/**
 * Resolution contract for the `wative/node` move (3.0.0).
 *
 * Every other test imports `../src/...` by relative path, so none of them exercise
 * the package `exports` map — the one thing this release changes. This test is the
 * runtime gate on it. It runs after `build` (verify order: typecheck → build →
 * test) and resolves the package's OWN subpaths via Node's self-reference,
 * asserting:
 *   - every `wative/node*` subpath + the kept portable/core subpaths RESOLVE to a
 *     built module, and
 *   - every removed 2.x subpath REJECTS with `ERR_PACKAGE_PATH_NOT_EXPORTED`.
 *
 * Specifiers are assembled from variables, not string literals, so `tsc` does not
 * try to resolve them at typecheck time (the freshly-built `dist/nodeIndex.*` does
 * not exist yet at the typecheck step); resolution is proven here, at runtime,
 * against the built `dist/`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const PKG = "wative";

/** Subpaths that must resolve after the move (new node family + kept surface). */
const PRESENT = [
  "/node",
  "/node/bootstrap",
  "/node/preflight",
  "/node/session",
  "/node/balances",
  "/node/nonces",
  "/node/paths",
  "/node/container",
  "/core",
  "/core/node",
  "/browser",
  "/browser/siwe",
  "/browser/validators",
  "/browser/slug",
  "/browser/secretInput",
  "/browser/balances",
  "/browser/nonces",
  "/viewport",
  "/sendMath",
  "/passwordStrength",
  "/errors",
];

/** Flat 2.x subpaths the move removed — must no longer be exported. */
const REMOVED = ["/bootstrap", "/preflight", "/session", "/balances", "/nonces", "/paths", "/container"];

test("every wative/node* subpath and kept subpath resolves to a built module", async () => {
  for (const sub of PRESENT) {
    const spec = `${PKG}${sub}`;
    const mod = (await import(spec)) as Record<string, unknown>;
    assert.ok(mod && typeof mod === "object", `${spec} resolved to a module`);
  }
});

test("the aggregate wative/node barrel re-exports the whole Node surface", async () => {
  const mod = (await import(`${PKG}/node`)) as Record<string, unknown>;
  for (const name of ["bootstrap", "runPreflight", "createWorkspace", "createBalanceStore", "createNonceStore", "inspect", "maskPath"]) {
    assert.equal(typeof mod[name], "function", `wative/node re-exports ${name}`);
  }
});

test("the aggregate wative/browser barrel re-exports the portable surface", async () => {
  const mod = (await import(`${PKG}/browser`)) as Record<string, unknown>;
  for (const name of [
    "createViewportStore",
    "createBalanceStore",
    "createNonceStore",
    "buildSiweMessage",
    "isHexData",
    "deriveNetworkSlug",
    "stepSecretInput",
    "assessPassword",
    "errorCode",
    "evmFees",
  ]) {
    assert.equal(typeof mod[name], "function", `wative/browser re-exports ${name}`);
  }
});

test("every removed 2.x subpath is no longer exported", async () => {
  for (const sub of REMOVED) {
    const spec = `${PKG}${sub}`;
    await assert.rejects(
      () => import(spec),
      (err: NodeJS.ErrnoException) => err.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
      `${spec} must reject with ERR_PACKAGE_PATH_NOT_EXPORTED`,
    );
  }
});
