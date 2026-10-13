/**
 * The one place a library error becomes text a user may read.
 *
 * 🚨 **A `WativeError`'s own `message` never reaches the screen.** The two
 * messages reachable from the unlock path were measured clean — e.g. `Bad
 * password for account "<name>".` and `Workspace password is incorrect.`,
 * neither echoing the attempt — but `wative-core`'s messages cannot be
 * statically enumerated, so two clean samples are not a guarantee about the rest.
 *
 * And the places these land make it matter: these strings can surface directly
 * in a consumer's status text and modal bodies — i.e. in any screenshot or log.
 * A balance error's prose already carries an RPC URL — which for a hosted
 * provider carries the API key in its path.
 *
 * So: an allowlist keyed on `code`, and prose we wrote. Anything that is not a
 * `WativeError` gets one generic line.
 *
 * The map is `Record<WativeErrorCode, string>` on purpose — **exhaustive, and
 * checked by the compiler**. A future version of the library that adds a code
 * fails to build here rather than silently falling through to the generic
 * line, which is the failure mode an allowlist is supposed to prevent.
 */
import type { WativeErrorCode } from "wative-core";

/** One line per code. No interpolation, so nothing from the error leaks in. */
const MESSAGES: Record<WativeErrorCode, string> = {
  WORKSPACE_LOCKED: "The workspace is locked.",
  ACCOUNT_LOCKED: "That account is locked.",
  WALLET_DISABLED: "That wallet is disabled.",
  RECORD_LOCKED: "That record is sealed.",
  BAD_PASSWORD: "That password is not correct.",
  WEAK_PASSWORD: "That password is too weak.",
  RECORD_NOT_FOUND: "No such record.",
  PROVIDER_IO: "The workspace could not be read.",
  PERMISSION_DENIED: "Permission denied for the workspace path.",
  DISK_FULL: "The disk is full.",
  PARAMETER_ERROR: "That value is not valid.",
  DUPLICATE_IDENTITY: "That already exists.",
  IRREGULAR_DESTINATION: "That destination looks irregular.",
  DECRYPT_FAILED: "A record could not be decrypted.",
  ENCRYPT_FAILED: "A record could not be written.",
  ALGORITHM_IRREVERSIBLE: "That value cannot be recovered.",
  INVALID_MNEMONIC: "That recovery phrase is not valid.",
  INVALID_PRIVATE_KEY: "That private key is not valid.",
  UNSUPPORTED_NETWORK: "That network is not supported.",
  TX_BUILD_FAILED: "The transaction could not be built.",
  TX_SIGN_FAILED: "The transaction could not be signed.",
  TX_SUBMIT_FAILED: "The transaction could not be submitted.",
  TX_TIMEOUT: "The transaction timed out.",
  TX_DROPPED: "The transaction was dropped.",
  TX_ABORTED: "The transaction was aborted.",
  RPC_UNREACHABLE: "The network endpoint could not be reached.",
  RPC_REJECTED: "The network endpoint rejected the request.",
  STORAGE_NOT_DURABLE: "This storage cannot be trusted to persist.",
  UNSUPPORTED_OP: "That is not available in this build.",
};

/**
 * What we say instead of anything we did not write ourselves.
 *
 * Deliberately not "see the log": nothing writes one. The log sinks exist and
 * are deliberately unwired, and pointing at a file that is never created is
 * worse than saying nothing.
 */
export const UNKNOWN_FAILURE = "Something went wrong.";

/** The 29 codes, as a runtime set. Derived from the map, so it cannot drift. */
const KNOWN_CODES: ReadonlySet<string> = new Set(Object.keys(MESSAGES));

/**
 * A `WativeError`'s code, or `undefined` for anything else.
 *
 * 🚨 **Duck-typed on `.code`, deliberately, because `instanceof` silently
 * disabled this whole allowlist on the one path that needed it.** The
 * `wative-core` and `wative-core/node` entry points ship **different**
 * `WativeError` classes: the `/node` subpath throws its own *internal* one (it is
 * not exported — `/node` exports only its providers), a DIFFERENT class object
 * from the root `wative-core`'s exported `WativeError`. So a
 * `PROVIDER_IO` thrown by `HybridProvider` — the only library object
 * `container.ts` touches — has the right `.code` but fails
 * `instanceof rootWativeError`, and every `inspect()` failure collapsed to
 * "Something went wrong." The previous comment here cross-referenced
 * `container.ts` as the reason `instanceof` was safe; it was exactly backwards.
 *
 * Checking the code against `KNOWN_CODES` is what keeps this from being a
 * blanket "trust any `.code`": Node's own `fs` errors carry codes like
 * `ENOENT`, which are not in the map and so fall through to the generic line.
 */
export function errorCode(error: unknown): WativeErrorCode | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" && KNOWN_CODES.has(code)
    ? (code as WativeErrorCode)
    : undefined;
}

/** Prose safe to paint for any thrown value. Never derived from the throw. */
export function safeMessage(error: unknown): string {
  const code = errorCode(error);
  return code === undefined ? UNKNOWN_FAILURE : MESSAGES[code];
}

/**
 * Whether a failed operation is worth offering a retry for.
 *
 * 🔄 This is narrower than it first appears, and the reason is measured: a
 * **balance** read's failure is not a coded error at all — it arrives as
 * `AssetBalance.readError`, which is free prose (`"RPC HTTP 500 …"`,
 * `"RPC unreachable: …"`, and an SVM string carrying no cause whatsoever).
 * Distinguishing unreachable from rejected there would mean prefix-matching
 * prose, the brittle substring-sniffing this layer avoids.
 *
 * So balance reads are *always* retryable — a read is idempotent and costs
 * nothing but a request — and this function governs the paths that really do
 * throw coded errors. A send is never retried automatically whatever it says.
 */
export function isRetryable(error: unknown): boolean {
  switch (errorCode(error)) {
    case "RPC_UNREACHABLE":
    case "RPC_REJECTED":
    case "PROVIDER_IO":
      return true;
    default:
      return false;
  }
}
