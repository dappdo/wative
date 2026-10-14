/**
 * `wative/node` — the aggregate entry point for wative's **Node-only** surface.
 *
 * One import that re-exports every Node-bound module of wative's own
 * workspace-management layer: the process-lifecycle `bootstrap`, the interactive
 * `preflight`, the `session` workspace gateway, the viewport-backed `balances` and
 * `nonces` stores, and the `paths` / `container` helpers. The focused subpaths
 * (`wative/node/session`, `wative/node/bootstrap`, …) remain available for a
 * narrow import; this barrel is the convenience front door that mirrors
 * `wative/core`.
 *
 * It is an aggregation manifest, NOT a wrapper: every line is an identity-
 * preserving `export *` over a value-adding wative module — no forwarding code,
 * no reshaping. The wative-core object itself is reached through `wative/core` /
 * `wative/core/node`, never re-exposed here.
 *
 * 🚨 Node-only by construction: these modules pull `node:*` builtins, the process
 * lifecycle, and wative-core's `node`-condition provider classes. The portable,
 * dual-env surface (`wative/viewport`, `wative/sendMath`, `wative/passwordStrength`,
 * `wative/errors`) is deliberately NOT re-exported here — import it from its own
 * subpath (and, later, from `wative/browser`).
 */
export * from "./bootstrap.js";
export * from "./preflight.js";
export * from "./core/session.js";
export * from "./core/nodeBalanceStore.js";
export * from "./core/nodeNonceStore.js";
export * from "./core/paths.js";
export * from "./core/container.js";
