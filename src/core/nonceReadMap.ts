/**
 * Map one wallet's `readWalletNonce` result to the nonce store's reader outcome:
 * a numeric nonce, `na` (no EVM address on this network — a terminal, NOT a
 * failure, and never an RPC call), or a failed read (`error`/`loading`).
 *
 * Pure; extracted from `nodeNonceStore`'s default reader so the nonce-specific
 * mapping is unit-testable without a live RPC. INTERNAL — not re-exported by any
 * barrel or the `exports` map, so it is not part of the public `wative/node`
 * surface.
 */
import type { NonceReadState } from "./session.js";
import type { NonceValue } from "./nonceStore.js";

export function mapNonceRead(result: NonceReadState): { readonly kind: "loaded"; readonly value: NonceValue } | { readonly kind: "failed" } {
  if (result.kind === "ready") return { kind: "loaded", value: { kind: "value", value: result.value } };
  if (result.kind === "na") return { kind: "loaded", value: { kind: "na" } };
  return { kind: "failed" };
}
