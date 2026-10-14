/**
 * `wative/browser` — the aggregate entry point for wative's PORTABLE, dual-env
 * surface (runs in a browser AND in Node): the viewport scheduler and the
 * balance/nonce caching stores (injected-reader factories), the pure interaction
 * kernels extracted from the Node layer (the SIWE message builder, input-shape
 * validators, network-slug derivation, the masked-secret input reducer), and the
 * portable helpers (send math, error mapping). (`passwordStrength` is kept OUT of
 * this aggregate — see the note by the exports below — and lives at its own
 * `wative/passwordStrength` subpath.)
 *
 * Like `wative/node`, this is an aggregation manifest, NOT a wrapper: every line
 * is an identity-preserving re-export of a value-adding wative module, with no
 * forwarding code. The wative-core object itself is reached through `wative/core`,
 * never re-exposed here.
 *
 * 🚨 Browser-safe by construction: NONE of these modules import a Node builtin,
 * the process lifecycle, or wative-core's `node`-condition provider classes (a
 * `tsconfig.browser.json` gate enforces it for the type-clean modules; the stores
 * are runtime-portable via a type-only `WalletBalances` import). The Node-only
 * surface (bootstrap/preflight/session/paths/container + the default-RPC store
 * readers) lives under `wative/node`.
 */
export * from "./core/viewportStore.js";
export * from "./core/balanceStore.js";
// nonceStore re-exports the Viewport* types (shared with viewportStore above), so
// re-export only its OWN names here to avoid an ambiguous duplicate export.
export { createNonceStore, type NonceValue, type NonceEntry, type NonceStore, type NonceStoreOptions } from "./core/nonceStore.js";
export * from "./core/siwe.js";
export * from "./core/validators.js";
export * from "./core/slug.js";
export * from "./core/secretInput.js";
export * from "./core/sendMath.js";
export * from "./core/errors.js";
// NOTE: `passwordStrength` is intentionally NOT re-exported from this aggregate.
// It value-imports wative-core (`PasswordPolicy`), whose browser build statically
// pulls ethers/@solana — so re-exporting it here would make `import "wative/browser"`
// drag that whole bundle in (and hard-fail under strict ESM on `ws`). It stays
// available at its own `wative/passwordStrength` subpath for consumers who already
// bundle wative-core's browser build.
