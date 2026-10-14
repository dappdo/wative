// Runtime browser-condition smoke test for the LEAN `wative/browser` surface.
//
// The `typecheck:browser` gate only resolves TYPES under wative-core's browser
// condition; the `node-exports` test imports under Node's DEFAULT condition. Neither
// proves the browser surface actually LOADS under the browser condition at runtime.
// This script does: run via `node --conditions=browser scripts/smoke-browser.mjs`
// (wired into `verify` after `build`). It fails if any lean-surface specifier pulls
// a node:* builtin or wative-core's node build and throws on import.
//
// `wative/passwordStrength` is deliberately NOT in this set: it value-imports
// wative-core (PasswordPolicy), whose browser build pulls ethers/@solana, so it is
// not part of the lean, wative-core-free aggregate (see src/browserIndex.ts).
const SURFACE = [
  "wative", //                      the browser `.` condition -> browserIndex
  "wative/browser",
  "wative/browser/balances",
  "wative/browser/nonces",
  "wative/browser/siwe",
  "wative/browser/validators",
  "wative/browser/slug",
  "wative/browser/secretInput",
  "wative/viewport",
  "wative/sendMath",
  "wative/errors",
];

let failed = 0;
for (const spec of SURFACE) {
  try {
    await import(spec);
    console.log(`ok   ${spec}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${spec} — ${error?.name}: ${String(error?.message).slice(0, 160)}`);
  }
}

if (failed > 0) {
  console.error(`\nbrowser-condition smoke FAILED for ${failed}/${SURFACE.length} specifier(s)`);
  process.exit(1);
}
console.log(`\nbrowser-condition smoke OK (${SURFACE.length} specifiers load clean under --conditions=browser)`);
