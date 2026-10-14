/**
 * `buildSiweMessage` — the canonical EIP-4361 "Sign-In with Ethereum" message
 * body, reconstructed field-by-field. Pure string composition with NO wallet and
 * NO wative-core dependency, so it is dual-env (Node + browser): a browser app can
 * render the exact "what you are signing" preview before a (separately signed)
 * SIWE sign-in.
 *
 * 🚨 Its exact byte layout — including the two-blank-line case when there is no
 * statement, and verbatim (un-normalised) interpolation of non-ASCII fields — is
 * what makes a preview safe to show as "what you are signing"; it is pinned
 * byte-for-byte by a unit test. Do not edit the shape without re-running it.
 */
export function buildSiweMessage(p: {
  readonly domain: string;
  readonly address: string;
  readonly statement?: string;
  readonly uri: string;
  readonly version: string;
  readonly chainId: number;
  readonly nonce: string;
  readonly issuedAt: string;
}): string {
  const lines: string[] = [`${p.domain} wants you to sign in with your Ethereum account:`, p.address, ""];
  if (p.statement !== undefined && p.statement !== "") lines.push(p.statement);
  lines.push("");
  lines.push(`URI: ${p.uri}`);
  lines.push(`Version: ${p.version}`);
  lines.push(`Chain ID: ${p.chainId}`);
  lines.push(`Nonce: ${p.nonce}`);
  lines.push(`Issued At: ${p.issuedAt}`);
  return lines.join("\n");
}
