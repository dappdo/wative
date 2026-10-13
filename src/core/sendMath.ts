/**
 * Chain math + calldata helpers for the Send flow — pure logic.
 *
 * These are chain semantics, not display: a consumer that wants the same fee
 * preview or ERC-20 calldata cross-check calls these rather than re-implementing
 * them. Pure and dependency-free — no library, no UI; the values are
 * standards/economics constants and bigint arithmetic.
 */

/**
 * The Solana per-signature base fee (lamports) — the standard fee a native MAX
 * reserves. (Also used by `session.maxSendable`; kept in one place so a consumer
 * need not re-derive it.)
 *
 * ⚠️ LIMITATION (documented, not a bug): 5000 lamports is the EXACT fee for a
 * plain single-signature transfer — the only shape this flow builds — so the MAX
 * reserve is correct for every send it can produce. It would UNDER-count only a
 * message that is not a single-sig transfer: a multi-signer tx (5000 × signers)
 * or one carrying an explicit compute-unit priority fee. `ChainClient` exposes no
 * `getFeeForMessage` accessor, so the exact fee of such a message cannot be read
 * here; on devnet the priority fee is effectively 0, and the single-sig flow
 * never adds one. If a future feature builds multi-sig or priority-fee messages,
 * it must reserve the message's real fee (via a `getFeeForMessage` capability)
 * rather than this single-sig constant.
 */
export const SVM_FEE_LAMPORTS = 5_000n;

/**
 * ≈0.00203928 SOL: the rent-exempt minimum for the CLASSIC 165-byte SPL token
 * account — the rent to create an associated-token account for the ORIGINAL SPL
 * Token program. 🚨 A Token-2022 (Token Extensions) mint's ATA is LARGER (it
 * carries extension state), so its rent exceeds this figure. wative-core does not
 * expose the exact per-mint amount, so this is the well-known classic-SPL floor,
 * shown with "≈" and only as a conditional caution — a lower bound, and the label
 * says so (Token-2022 recipients will see a slightly higher charge).
 */
export const SVM_ATA_RENT_LAMPORTS = 2_039_280n;

/** The ERC-20 `transfer(address,uint256)` selector, for the calldata cross-check. */
export const ERC20_TRANSFER_SELECTOR = "0xa9059cbb";

/**
 * The EVM fee in native wei, from the LIVE overrides (so it recomputes as the user
 * edits the gas/fee rows — the live cost line a consumer renders).
 *
 * `max` = gasLimit × maxFeePerGas — the ceiling the user authorizes — or
 * `undefined` when the gas limit is genuinely unknown ("auto" AND the simulate
 * produced no gasUsed); the UI then shows "auto", never a misleading `0` that
 * reads as free gas. `est` = gasUsed × maxFeePerGas, the realistic figure, still
 * an UPPER bound (the true effective price needs a baseFee the library does not
 * expose), so the UI labels it "≤" — and it is clamped to the authorized gas so a
 * user who edits the gas limit BELOW the estimate never sees est > max.
 *
 * Takes PRIMITIVES (not a consumer's own override/prepared-send types) so this
 * layer stays dependency-free: `gasUsed` from the simulation, the user's `gasLimit`
 * override (or undefined for "auto"), and the `maxFeePerGas`.
 */
export function evmFees(
  gasUsed: bigint | undefined,
  gasLimitOverride: bigint | undefined,
  maxFeePerGas: bigint,
): { readonly max?: bigint; readonly est?: bigint } {
  const limit = gasLimitOverride ?? (gasUsed !== undefined ? (gasUsed * 6n) / 5n : undefined);
  const max = limit !== undefined ? limit * maxFeePerGas : undefined;
  const estGas = gasUsed === undefined ? undefined : limit !== undefined && limit < gasUsed ? limit : gasUsed;
  const est = estGas !== undefined ? estGas * maxFeePerGas : undefined;
  return { max, est };
}

/**
 * Decode a bare ERC-20 `transfer(address,uint256)` calldata to its embedded
 * recipient + amount (the review cross-checks these against the displayed To /
 * Amount). `undefined` when `data` is not exactly a transfer call. Pure hex
 * slicing — no library/ABI dependency.
 */
export function decodeErc20Transfer(data: string): { readonly to: string; readonly amount: bigint } | undefined {
  const d = data.toLowerCase();
  // selector(10) + address word(64) + amount word(64) = 138 chars.
  if (!d.startsWith(ERC20_TRANSFER_SELECTOR) || d.length !== 138) return undefined;
  try {
    return { to: `0x${d.slice(34, 74)}`, amount: BigInt(`0x${d.slice(74, 138)}`) };
  } catch {
    return undefined;
  }
}
