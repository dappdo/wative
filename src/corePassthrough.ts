/**
 * `wative/core` — a transparent, identity-preserving pass-through to the
 * `wative-core` ROOT specifier.
 *
 * It lets a consumer depend on `wative` alone and still reach `wative-core`'s
 * object surface — `Workspace`, `newMnemonic`, `BUILTIN_NETWORKS`,
 * `BUILTIN_ASSETS`, the `ChainId` type, and the rest — without a second direct
 * dependency on `wative-core`. Nothing is wrapped, normalised or reshaped:
 * `(await import("wative/core")).X` is the very same binding as
 * `(await import("wative-core")).X`, so every concrete shape a consumer reaches
 * into (`Workspace.open`'s overloads, `receipt.raw.*`, a pre-sign `tx.*`,
 * `BUILTIN_*` entries, …) is passed through untouched.
 *
 * 🚨 ROOT only. The Node backend (`HybridProvider`) lives behind the sibling
 * `wative/core/node` entry, mirroring wative-core's own root-vs-`/node` split.
 * `Workspace` (root) and the backend (`/node`) must resolve to ONE wative-core
 * instance or `Workspace.open` throws `PARAMETER_ERROR`, so this file touches
 * only the root specifier and never the backend — importing `wative/core` alone
 * registers nothing.
 */
export * from "wative-core";
// `ChainId` is a type-only name; re-export it explicitly so it is guaranteed
// reachable as `import type { ChainId } from "wative/core"` under
// `verbatimModuleSyntax` (the wildcard above already carries it, this pins it).
export type { ChainId } from "wative-core";
