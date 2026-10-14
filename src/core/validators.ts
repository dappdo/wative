/**
 * Pure input-shape validators, shared by the session layer and a consumer's UI
 * add-form — dual-env (Node + browser; NO wative-core dependency). They are the
 * ONE source of truth for calldata and token-address shape, so the session layer
 * and the form can never drift.
 *
 * ⚠️ These are SHAPE checks, not authoritative validation: `isTokenAddressForVm`
 * is a cheap pre-filter, while `addTokenToNetwork` remains the real gate (it can
 * be stricter than this regex). Never present a `true` here as a guarantee the
 * library will accept the address.
 */

/** A `0x`-prefixed, even-length hex calldata (`0x` alone = no data). */
const HEX_DATA = /^0x([0-9a-fA-F]{2})*$/;

/** Whether `data` is `0x`-prefixed hex with an even number of digits. */
export function isHexData(data: string): boolean {
  return HEX_DATA.test(data);
}

/**
 * Whether `address` is a valid token identifier for `vm`: an EVM contract is
 * `0x` + 40 hex; an SVM (SPL) mint is a base58 pubkey (32–44 chars). The ONE
 * source of truth for token-address shape — `addTokenToNetwork` AND the UI
 * add-form both validate through it, so they cannot drift (a drift is exactly
 * what left the form rejecting SPL mints after the session layer learned to
 * accept them).
 */
export function isTokenAddressForVm(vm: "evm" | "svm", address: string): boolean {
  return vm === "evm" ? /^0x[0-9a-fA-F]{40}$/.test(address.trim()) : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address.trim());
}

/** The matching "what a token address should look like" message for `vm`. */
export function tokenAddressHint(vm: "evm" | "svm"): string {
  return vm === "evm" ? "An EVM contract address is 0x followed by 40 hex characters." : "A Solana token mint is a base58 address (32-44 characters).";
}
