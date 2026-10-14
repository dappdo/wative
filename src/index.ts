/**
 * `wative` — the workspace-management layer over `wative-core`. Pure logic, no
 * terminal UI: build a UI on top of it, or drive it headless (see `./headless.ts`).
 *
 * This barrel re-exports the entry surface a consumer starts from. The richer
 * Node-only domain surface lives under the `wative/node` family — `wative/node`
 * (the aggregate), `wative/node/session`, `wative/node/paths`, `wative/node/container`,
 * … — while the portable helpers stay on their own subpaths (`wative/sendMath`,
 * `wative/passwordStrength`, `wative/errors`, `wative/viewport`). The underlying
 * `wative-core` object is reached through `wative/core` · `wative/core/node`.
 */
export { bootstrap } from "./bootstrap.js";
export type { BootstrapContext, BootstrapOptions } from "./bootstrap.js";
export { runPreflight } from "./preflight.js";
export type { OpenedWorkspace } from "./preflight.js";
