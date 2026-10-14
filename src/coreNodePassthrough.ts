/**
 * `wative/core/node` — mirrors `wative-core/node`: importing this module runs
 * wative-core's Node backend-REGISTRATION side effect AND re-exports the `/node`
 * surface (`HybridProvider`, `HybridProviderV3`, `FileSink`, …).
 *
 * After `import "wative/core/node"` (in any form — bare, named, or namespace),
 * the root `Workspace.open(path, password, true)` reached via `wative/core`
 * works against a real on-disk keystore, because the backend is now registered
 * on the same wative-core instance.
 *
 * 🚨 Keep the ROOT vs `/node` split: the registration belongs HERE, never folded
 * into `wative/core`. The root `Workspace` and this backend must come from one
 * wative-core instance, which they do — both resolve `wative-core` through the
 * same `node` export condition.
 */
// Load-bearing side-effect import: registers the Node backend even if a consumer
// only takes a named binding below (and guards against a re-export being elided).
import "wative-core/node";
export * from "wative-core/node";
