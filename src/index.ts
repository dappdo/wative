/**
 * `wative` — the workspace-management layer over `wative-core`. Pure logic, no
 * terminal UI: build a UI on top of it, or drive it headless (see `./headless.ts`).
 *
 * This barrel re-exports the entry surface a consumer starts from. The richer
 * domain surface lives on the subpath exports — `wative/session`, `wative/sendMath`,
 * `wative/paths`, `wative/passwordStrength`, `wative/container`, `wative/errors`.
 */
export { bootstrap } from "./bootstrap.js";
export type { BootstrapContext, BootstrapOptions } from "./bootstrap.js";
export { runPreflight } from "./preflight.js";
export type { OpenedWorkspace } from "./preflight.js";
