/**
 * Network-slug derivation — pure string logic (dual-env; NO wative-core
 * dependency) tuned to wative-core's slug rule, shared by a network add-form (its
 * up-front duplicate check) and `addNetwork` (which re-derives it), so the two
 * never drift.
 */

/**
 * Derive a network slug from its display name. Lower-cases, collapses every
 * non-`[a-z0-9]` run to a single `-`, and trims leading/trailing `-`. The result
 * may still be too short / malformed for the library's slug rule (4–64,
 * `^[a-z][a-z0-9_-]*[a-z0-9]$`, MEASURED); the caller validates that before this
 * is relied on, and `addNetwork` surfaces any residual library refusal.
 */
export function deriveNetworkSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The persisted slug for a custom network, derived from the display name.
 *
 * 🚨 wative-core floors the slug at 4 chars (MEASURED: `Invalid slug "ab": must be
 * 4-64 chars, start with [a-z], end with [a-z0-9], middle [a-z0-9_-]`). A short
 * name's base slug is auto-extended with the chain id to clear the floor — name
 * `OPx` on chain 10 → slug `opx-10`. A base already ≥4 chars is kept verbatim, so
 * every existing network and slug is unchanged.
 */
export function finalizeNetworkSlug(name: string, chainId: number): string {
  const base = deriveNetworkSlug(name);
  return base.length >= 4 ? base : `${base}-${chainId}`;
}
