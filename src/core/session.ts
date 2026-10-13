/**
 * The one place a `Workspace` lives, and the one place a secret is cleared.
 *
 * 🚨 Every wative-core password API takes a `string` — `Workspace.open`,
 * `unlock`, `tryUnlock`, `checkPassword`, `accounts.create`,
 * `unlockContainer` — so a plaintext string must exist to call the library at
 * all, and a `Buffer`-backed vault is unreachable by construction;
 * `Workspace._getPassword()` also exists and returns it. What this layer can
 * guarantee is narrower: it adds no copy of its own, writes none to disk or to
 * any environment variable, and holds nothing for longer than the workspace is
 * unlocked.
 *
 * The library keys the password into WeakMaps on **`_Workspace` and
 * `HybridProviderV3`**, which is the mechanism the clearing below relies on.
 * So the vault below is deliberately one binding. No password of ours, no
 * per-account password map, no "last used" value, no history array — every one
 * of those would be a heap copy that buys nothing, since the library already
 * holds its own.
 *
 * 💡 **Clearing is synchronous, which is what makes every exit path
 * tractable.** Measured three ways: after an un-awaited `ws.lock()`, read
 * immediately in the same turn, `ws.locked` is true, every `account.locked` is
 * true, `_getPassword()` throws, and a parsed heap snapshot finds zero
 * password strings. A `process.on("exit")` handler cannot await, and it does
 * not need to. `ws.lock()` locks its accounts synchronously before returning
 * its promise. The `account.lock()` loop is kept anyway as defence in depth,
 * not as the mechanism.
 *
 * ⚠️ What this cannot defend against: locking removes the plaintext from a
 * heap snapshot (measured, including the one Node writes unprompted on OOM),
 * but a **full** core dump still recovers it — measured, `lldb process
 * save-core --style full` found a string that had already been dropped and
 * garbage-collected, where the heap snapshot found none. V8 does not zero
 * freed strings and no amount of JS can make it. That attacker already has
 * debugger rights and is out of scope.
 */
import { ChainClient, HybridProvider, HybridProviderV3, Network, Workspace, argon2BackendInfo } from "wative-core";
import type { Address, AssetRef, DestinationReport, EvmTransaction, SimulationResult, SvmTransaction, TransactionStatus, TransactionTracker, TransferPayload, TransferRequest } from "wative-core";
import { errorCode, safeMessage } from "./errors.js";
import { SVM_FEE_LAMPORTS } from "./sendMath.js";

export type SessionStatus = "closed" | "locked" | "unlocked";

/**
 * The vault. Module-private, one binding, nothing else.
 *
 * One `Workspace` per process is not a style preference. Measured: three
 * concurrent `Workspace.open({path})` calls on one container **all succeeded**
 * — 5–6 ms each, no KDF, because the container was already unlocked — and then
 * diverged silently: handle A saw only its own new account, B only its own,
 * and a fresh reopen saw both. The library's documented guard is
 * per-`Provider`-instance, and the `{path}` form mints a new provider every
 * call, so there is no guard at all on this path.
 */
let vault: Workspace | undefined;

/**
 * How long to yield before a call that blocks the event loop.
 *
 * 🚨 Argon2 is a **synchronous native call inside an `async` function**.
 * Measured: `ws.unlock()` takes ~69 ms of wall time (p50, min 65) while a 4 ms
 * interval fires only **1–4 times, median 2**, where 16–22 are due. So nothing
 * can repaint during it, a spinner cannot animate, and a caller that renders
 * "Unlocking…" and then immediately awaits `unlock()` shows the user a **black
 * screen** rather than a slow one.
 *
 * ⚠️ The yield matters when a repaint is already pending (a paste followed by
 * Enter, or a `MAX_INPUT`-split paste): that frame lands at ~32 ms and
 * **nothing shorter works**. Measured: a microtask, `setImmediate` once,
 * `setImmediate` twice, and `setTimeout` at 0, 1, 8, 16, 24 and 31 ms all left
 * the screen blank for the entire block. `setTimeout(32)` passed by 0.03 ms;
 * 33+ passes reliably. So `>32` is required and 44 carries ~12 ms of margin,
 * which is why it is 44 and not 33. When no repaint is pending the yield is
 * dead latency, but keeping it unconditional means it can never be forgotten.
 */
export const PAINT_YIELD_MS = 44;

/** Let the consumer's UI paint the frame the caller just rendered. */
async function yieldForPaint(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, PAINT_YIELD_MS));
}

export function status(): SessionStatus {
  if (vault === undefined || vault.closed) return "closed";
  return vault.locked ? "locked" : "unlocked";
}

function refuseSecondWorkspace(): void {
  if (vault !== undefined && !vault.closed) {
    throw new Error("a workspace is already open in this process");
  }
}

/**
 * Build the storage provider for a container, pinned to the v3 envelope.
 *
 * 🚨 **Explicit `HybridProviderV3`, never the `Workspace.open({path})` default.**
 * The default picks v3 only when `@node-rs/argon2`'s native binding resolved and
 * **silently falls back to the v2 envelope otherwise** — whose unlock cost is
 * LINEAR in the number of secrets a container holds (measured ~7.6 s for a
 * 52-address account vs v3's ~145 ms), with nothing on screen to say so. Pinning
 * v3 here, and recording any fallback, is the settled decision: we choose the
 * envelope and the UI warns loudly when it is the weaker one.
 *
 * Both classes come from the `wative-core` ROOT specifier — the same bundle as
 * `Workspace`. The library refuses a provider from a different entry point
 * (`wative-core/node`) with PARAMETER_ERROR, so they must share a specifier.
 * `HybridProviderV3` resolves the native binding eagerly in its constructor, so
 * a platform that cannot build it throws HERE, where we can fall back, rather
 * than mid-unlock after a container directory already exists.
 */
let activeEnvelope: "v3" | "v2" = "v3";
let fellBackToV2 = false;
let v2Reason: string | undefined;

function makeProvider(path: string): HybridProvider {
  try {
    const provider = new HybridProviderV3(path);
    activeEnvelope = "v3";
    fellBackToV2 = false;
    v2Reason = undefined;
    return provider;
  } catch (error) {
    // Native Argon2 unavailable on this platform. Open with v2 so the workspace
    // can still be opened, but record it so a consumer can warn — a user on a
    // large account would otherwise meet a multi-second "frozen" unlock with no
    // explanation.
    activeEnvelope = "v2";
    fellBackToV2 = true;
    v2Reason = safeMessage(error);
    return new HybridProvider(path);
  }
}

/**
 * What envelope + KDF backend the open workspace is actually using.
 *
 * `envelope` is ground truth — the provider class we instantiated, not a guess.
 * The Argon2 fields are supplementary (for a consumer's settings view): per the library,
 * `argon2BackendInfo().backend` reports the process DEFAULT — measured
 * `"unresolved"` here even after a v3 unlock, because v3 seals via a per-provider
 * OVERRIDE rather than changing the default backend — so `nativeArgon2` reads
 * `overrides` instead: a non-empty override list is what proves a native derive
 * is in use. A consumer's settings view should therefore lean on `envelope` + `nativeArgon2`, not the
 * `argon2Backend` string, which may simply read "unresolved".
 */
export interface ProviderInfo {
  readonly envelope: "v3" | "v2";
  readonly fellBackToV2: boolean;
  readonly reason?: string;
  readonly argon2Backend: string;
  readonly nativeArgon2: boolean;
}

export function providerInfo(): ProviderInfo {
  let argon2Backend = "unresolved";
  let nativeArgon2 = false;
  try {
    const info = argon2BackendInfo();
    argon2Backend = info.backend;
    nativeArgon2 = info.overrides.length > 0;
  } catch {
    // argon2BackendInfo is documented as a pure read that never throws; guarded
    // anyway so a surprise here can never take down the caller.
  }
  return { envelope: activeEnvelope, fellBackToV2, reason: v2Reason, argon2Backend, nativeArgon2 };
}

/**
 * Open an existing container **without** a password.
 *
 * Measured: this creates nothing — `Workspace.open` writes a container only
 * when a password is supplied — and costs **~8 ms on the first call in a fresh
 * process, 0.05 ms warm**. So it is the correct second step of the open
 * sequence: inspect, open locked, paint, then unlock. Do not reach for the `create`
 * argument to probe existence; `container.ts` records why that does not work.
 */
export async function openLocked(path: string): Promise<void> {
  refuseSecondWorkspace();
  vault = await Workspace.open(makeProvider(path));
}

/**
 * Initialize a new container at `path`.
 *
 * Separate from `openLocked` because the caller has already decided which of the
 * two it wants, from `inspect()`. Folding them together is how
 * `Workspace.open`'s default `create: true` silently makes an empty workspace
 * out of a typo.
 */
export async function createWorkspace(path: string, password: string): Promise<void> {
  refuseSecondWorkspace();
  await yieldForPaint();
  vault = await Workspace.open(makeProvider(path), password);
}

/**
 * Unlock the open workspace.
 *
 * The yield is here rather than at the call site so it cannot be forgotten. A
 * caller renders its pending state and awaits; the frame gets out.
 */
export async function unlock(password: string): Promise<void> {
  const ws = vault;
  if (ws === undefined) throw new Error("no workspace is open");
  await yieldForPaint();
  await ws.unlock(password);
}

/** A user-initiated lock, which can afford to await. */
export async function lock(): Promise<void> {
  const ws = vault;
  if (ws === undefined || ws.closed) return;
  for (const account of ws.accounts) account.lock();
  await ws.lock();
}

/**
 * Re-unlock the open (locked) workspace from a consumer — a RESULT wrapper over
 * `unlock`, so the caller never has to catch a raw rejection (an uncaught one
 * bails the host process) and gets the same `safeMessage` string the pre-flight
 * re-prompt shows. A wrong password throws in `ws.unlock` (measured — the
 * pre-flight catches it), so the workspace stays LOCKED on `{ok:false}`.
 */
export async function unlockWorkspace(password: string): Promise<AccountMutation> {
  try {
    await unlock(password);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: safeMessage(error) };
  }
}

/**
 * Clear every secret, synchronously, from anywhere — including a handler that
 * cannot await.
 *
 * Wired to `exit`, SIGINT, SIGTERM, **SIGHUP**, stdin EOF, `bail()` and the
 * error boundary. SIGHUP and stdin EOF are the additions worth naming: an ssh
 * session dying, a terminal tab closing, or a laptop sleeping and losing the
 * pty is the realistic way an unlocked console is left unattended — far more
 * likely than someone walking up to the keyboard, which is what an idle
 * auto-lock would defend against and which this deliberately does not add.
 *
 * Idempotent without a latch: the first call drops the vault binding, so a
 * second call returns at the guard. Re-opening later installs a new workspace
 * and this works again — a permanent flag would have left a *later* session's
 * password in memory, which is exactly the bug a naive latch introduces.
 *
 * Every step is guarded, because an exit path has nowhere to report a failure
 * and a throw here would skip the rest of the clearing.
 */
export function panicLock(): void {
  const ws = vault;
  vault = undefined;
  if (ws === undefined || ws.closed) return;

  try {
    // Only while unlocked: on a locked workspace `ws.accounts` reads as empty
    // anyway, and there is nothing left to clear.
    if (!ws.locked) {
      for (const account of ws.accounts) {
        try {
          // ⚠️ Defence in depth, not the mechanism — `ws.lock()` below already
          // locks these synchronously. See the header note.
          account.lock();
        } catch {
          // One bad account must not stop the others being cleared.
        }
      }
    }
    // Un-awaited on purpose — the clearing has already happened by the time
    // this returns. The catch is attached so a rejection during shutdown
    // cannot surface as an unhandled rejection and pre-empt the real exit.
    void ws.lock().catch(() => {});
  } catch {
    // Nowhere to report to, and nothing useful to say.
  }
}

/** Release the container. Awaits, so it is for a deliberate quit. */
export async function close(): Promise<void> {
  const ws = vault;
  vault = undefined;
  if (ws === undefined || ws.closed) return;
  await ws.close();
}

export interface WorkspaceSummary {
  readonly accounts: number;
  /**
   * Slugs of records that failed to load. A bare string is all the library
   * gives — no name, no kind, no reason.
   */
  readonly damaged: readonly string[];
}

/**
 * The workspace's contents, or `undefined` if it is not unlocked.
 *
 * 🚨 The `undefined` is the whole point. Measured: on a **locked** workspace
 * `ws.accounts.length` is `0`, `bySlug()` returns `null` and
 * `damagedAccountSlugs` is `[]` — all with **no error**, while `ws.networks`
 * still returns the built-in networks, so nothing about the object looks unusable.
 * A caller reading those numbers directly would conclude "a fresh, empty
 * workspace" about a workspace full of accounts, and offer to create a first
 * account over the top of them.
 *
 * Returning `undefined` while locked makes that mistake impossible to make
 * rather than something to remember. There is deliberately no accessor that
 * hands out the raw counts.
 */
export function summary(): WorkspaceSummary | undefined {
  const ws = vault;
  if (ws === undefined || ws.closed || ws.locked) return undefined;
  return {
    accounts: ws.accounts.length,
    // Copied, not aliased: the library's array is a live view, and a
    // `ReadonlyArray` type on it is a compile-time promise about someone
    // else's object.
    damaged: [...ws.damagedAccountSlugs],
  };
}

/** One account, as **plain data** — never a live handle. See `accounts()`. */
export interface AccountRow {
  readonly slug: string;
  readonly name: string;
  /** How many wallets it holds. A count, so no wallet handle escapes either. */
  readonly wallets: number;
  /** It carries its own password, so entering it prompts a second unlock. */
  readonly ownPassword: boolean;
  /** Slug of the account's persisted default network. */
  readonly network: string;
}

/**
 * The workspace's accounts, or `undefined` if it is not unlocked.
 *
 * 🚨 **Plain rows, copied — never an `Account`.** Two measured library
 * behaviours make handing out handles unsafe rather than merely untidy: a
 * handle goes **stale across any lock**, and a detached one **lies silently**
 * instead of throwing, while still being able to hand out real keys. So
 * navigation state is `slug` (+ `wallet.id`, + `(vm, network)`) re-resolved
 * every time,
 * and this accessor exists to make that the only option available.
 *
 * The `undefined` carries the same weight as in `summary()`: on a **locked**
 * workspace `ws.accounts.length` is `0` with no error, so a caller reading it
 * directly would conclude "a fresh, empty workspace" about a full one and
 * offer to create a first account over the top.
 *
 * ⚠️ `displayName` is **free user text** and is returned verbatim. The caller
 * must treat it as untrusted, width-bearing display text and budget it itself,
 * and this function deliberately does not sanitise, because a display transform
 * must never alter what a validator or a signer reads.
 */
export function accounts(): readonly AccountRow[] | undefined {
  const ws = vault;
  if (ws === undefined || ws.closed || ws.locked) return undefined;
  return ws.accounts.map((account) => ({
    slug: String(account.slug),
    name: account.displayName,
    wallets: account.wallets.length,
    ownPassword: account.hasOwnPassword,
    network: String(account.defaultNetwork),
  }));
}

/** One wallet of an account, as **plain data** — never a `Wallet` handle. */
export interface WalletRow {
  readonly id: number;
  readonly disabled: boolean;
  /** The wallet's addresses, each a public key on a network. */
  readonly addresses: readonly { readonly vm: string; readonly network: string; readonly publicKey: string }[];
  readonly tags: readonly string[];
}

/** The result of trying to enter an account. */
export type AccountEntry =
  | { readonly kind: "opened"; readonly wallets: readonly WalletRow[] }
  /** Own-password account: a second unlock is required before it opens. */
  | { readonly kind: "needsPassword" }
  /** A supplied account password was wrong. Only `unlockAccount` returns this. */
  | { readonly kind: "wrongPassword" }
  /** Not unlocked, not found, or damaged — nothing to enter. */
  | { readonly kind: "unavailable" };

/**
 * Try to enter an account by slug, auto-unlocking it if it shares the workspace
 * password.
 *
 * 🚨 **Returns plain `WalletRow`s, never a `Wallet` or `Account` handle** — the
 * same discipline as `accounts()`: a handle goes stale across a lock and then
 * lies silently. Wallet **addresses are public** and readable whether or not
 * the account is unlocked; the unlock gates signing and private-key export,
 * which this list view does not touch.
 *
 * 🎯 **The auto-unlock is the whole shared-vs-own distinction.** Measured: a
 * no-arg `tryUnlock()` opens a shared-password account (`locked` true → false)
 * and leaves an own-password one locked, with no error either way. So a shared
 * account returns `opened`; an own-password one returns `needsPassword` so the
 * caller can prompt rather than silently show a half-entered account. A
 * workspace that is locked, or a slug that does not resolve, is `unavailable` —
 * which is also what a damaged account's slug gives, since it is not in
 * `ws.accounts`.
 */
/**
 * What a failed `tryUnlock()` means for the caller — a pure classifier, so it
 * can be tested without making the library throw.
 *
 * 🚨 **Only `ACCOUNT_LOCKED` means "needs its own password".** A no-arg
 * `tryUnlock()` on an own-password account throws a typed `WativeError` with
 * that code (measured) — but a genuinely different failure (I/O, a corrupted
 * record) must NOT tell the user to retype a password that cannot help. Those
 * are `unavailable`. The error carries the account slug but no secret
 * (measured) and is otherwise discarded.
 */
export function classifyUnlockFailure(error: unknown): AccountEntry {
  return errorCode(error) === "ACCOUNT_LOCKED" ? { kind: "needsPassword" } : { kind: "unavailable" };
}

/**
 * What a failed explicit-password unlock means — the `unlockAccount` twin of
 * `classifyUnlockFailure`.
 *
 * 🚨 **Only `BAD_PASSWORD` means "wrong password".** The library throws a typed
 * `WativeError` with that code for a bad account password (measured — and the
 * message does NOT contain the attempted password). Anything else — the account
 * vanished, an I/O failure — is `unavailable`, so the prompt reports "that did
 * not work" rather than looping on a password the user cannot fix.
 */
export function classifyPasswordFailure(error: unknown): AccountEntry {
  return errorCode(error) === "BAD_PASSWORD" ? { kind: "wrongPassword" } : { kind: "unavailable" };
}

/**
 * Unlock an own-password account with an explicit password and enter it.
 *
 * 🚨 The password is used once, here, and never stored — the same rule the
 * whole layer lives under. On success the account is open (for the session,
 * as with any unlock) and its wallets are returned as plain rows; a wrong
 * password is `wrongPassword` so the prompt can say so and stay open; anything
 * else is `unavailable`. A shared-password account that does not need this still
 * works (its `tryUnlock(password)` succeeds), so the caller need not pre-check.
 */
export async function unlockAccount(slug: string, password: string): Promise<AccountEntry> {
  const ws = vault;
  if (ws === undefined || ws.closed || ws.locked) return { kind: "unavailable" };
  const account = ws.accounts.bySlug(slug as never) ?? undefined;
  if (account === undefined) return { kind: "unavailable" };
  if (account.locked) {
    try {
      await account.tryUnlock(password);
    } catch (error) {
      return classifyPasswordFailure(error);
    }
    if (account.locked) return { kind: "wrongPassword" };
  }
  return { kind: "opened", wallets: mapWallets(account) };
}

export async function enterAccount(slug: string): Promise<AccountEntry> {
  const ws = vault;
  if (ws === undefined || ws.closed || ws.locked) return { kind: "unavailable" };
  // `bySlug` wants the library's branded `Slug`, but the brand is runtime-erased,
  // so the plain string the caller holds (from `accounts()`) matches by value with
  // an `as never` cast — the same idiom as `networks.bySlug`.
  const account = ws.accounts.bySlug(slug as never) ?? undefined;
  if (account === undefined) return { kind: "unavailable" };
  if (account.locked) {
    try {
      await account.tryUnlock();
    } catch (error) {
      return classifyUnlockFailure(error);
    }
    if (account.locked) return { kind: "needsPassword" };
  }
  return { kind: "opened", wallets: mapWallets(account) };
}

/**
 * Create a SHARED (workspace-password) account from `secret`, on the library's
 * default network. `secret` is a BIP-39 phrase (→ an HD account) OR a private
 * key (→ a PK account) — the library accepts either in this slot and infers the
 * kind (measured; a PK is EVM hex, Solana base58, or solana-keygen JSON).
 * Validate/normalize the key before calling: the library's rejection wording is
 * useless to a user.
 *
 * 🚨 `workspacePassword` MUST be the workspace password: a shared account
 * (`hasOwnPassword: false`) is sealed with it, and the library rejects any other
 * value (measured). The session never retains the
 * workspace password, so the create flow prompts for it and passes it straight
 * through here, holding no copy of its own. The new account is left unlocked
 * (it auto-unlocks with the workspace password). Returns its slug.
 */
export async function createAccount(
  name: string,
  workspacePassword: string,
  secret: string,
  /** The account's default network slug (the default-network step). Omitted →
   * the library's own default, as before. Must be one of `workspaceNetworkChoices()`. */
  network?: string,
): Promise<string> {
  const ws = vault;
  if (ws === undefined || ws.closed || ws.locked) throw new Error("the workspace is not open");
  // Normalise an empty slug to `undefined` so it means "the library's default"
  // (matching the doc above) rather than being forwarded as an unresolvable
  // empty `NetworkLike`. Defensive — the UI always supplies a real slug.
  const defaultNetwork = network === "" ? undefined : network;
  const account = await ws.accounts.create(name, workspacePassword, secret, defaultNetwork, { hasOwnPassword: false });
  return String(account.slug);
}

/**
 * The workspace's networks as `{slug, name}`, for the create-account default-
 * network step — the account does not exist yet, so `accountNetworks(slug)` is
 * not available; these come straight off `ws.networks`. Empty when closed.
 *
 * 🚨 Plain copied rows (slug + name strings), never a `Network` handle — same
 * rule as every other accessor here.
 */
export function workspaceNetworkChoices(): readonly AccountNetwork[] {
  const ws = vault;
  if (ws === undefined || ws.closed) return [];
  try {
    return [...ws.networks].map((network) => ({
      slug: String(network.slug),
      name: network.name,
      currencySymbol: String(network.nativeCurrency.symbol),
    }));
  } catch {
    return [];
  }
}

/** Plain, handle-free wallet rows for an account — the shared mapping. */
function mapWallets(account: {
  readonly wallets: ReadonlyArray<{
    readonly id: number;
    readonly disabled: boolean;
    readonly tags: readonly string[];
    readonly addresses: ReadonlyArray<{ readonly vm: unknown; readonly network: unknown; readonly publicKey: unknown }>;
  }>;
}): readonly WalletRow[] {
  return account.wallets.map((wallet) => ({
    id: wallet.id,
    disabled: wallet.disabled,
    addresses: wallet.addresses.map((address) => ({
      vm: String(address.vm),
      // 🔄 The network's slug, read directly. A prior `?? address.network`
      // fallback was dead code — `Network.slug` is always present (measured) —
      // and would have stringified a raw `Network` to `[object Object]` had it
      // ever fired. A network with no slug is a library contract break, not
      // something to paper over with a misleading cell.
      network: String((address.network as { slug: unknown }).slug),
      publicKey: String(address.publicKey),
    })),
    tags: [...wallet.tags],
  }));
}

/**
 * The wallets of an **already-open** account, read synchronously — or
 * `undefined` if the workspace is locked, the slug does not resolve, or the
 * account is not unlocked.
 *
 * 🚨 The split from `enterAccount` is deliberate: `enterAccount` does the async
 * unlock on the way IN (and is the only thing that should), while the wallet
 * layer, already past that gate, reads once on mount with no side effect — no
 * re-unlock, no await, no loading flash. Plain rows, never a handle, same as
 * everywhere.
 */
export function walletsFor(slug: string): readonly WalletRow[] | undefined {
  const ws = vault;
  if (ws === undefined || ws.closed || ws.locked) return undefined;
  const account = ws.accounts.bySlug(slug as never) ?? undefined;
  if (account === undefined || account.locked) return undefined;
  return mapWallets(account);
}

/** One account in the global-search index: plain data, with its wallets
 * flattened to public-key strings. `locked` marks an own-password account whose
 * wallets could not be read (so `wallets` is empty, but the account itself is
 * still searchable by name/slug). */
export interface SearchAccount {
  readonly slug: string;
  readonly displayName: string;
  readonly locked: boolean;
  readonly wallets: readonly { readonly id: number; readonly tags: readonly string[]; readonly addresses: readonly string[] }[];
}

/**
 * The whole workspace, flattened for global search (the global search surface):
 * every account by name/slug, plus each readable account's wallets (id, tags,
 * public keys). A locked own-password account contributes its name/slug with
 * `locked: true` and no wallets — it is still findable, just not expandable
 * until unlocked. `undefined` when the workspace is not unlocked (same contract
 * as `accounts()`). Plain data only; no handle escapes.
 */
export function workspaceIndex(): readonly SearchAccount[] | undefined {
  const all = accounts();
  if (all === undefined) return undefined;
  return all.map((account) => {
    const wallets = walletsFor(account.slug); // undefined when a locked own-password account can't be read
    return {
      slug: account.slug,
      displayName: account.name,
      locked: wallets === undefined,
      wallets: (wallets ?? []).map((wallet) => ({ id: wallet.id, tags: wallet.tags, addresses: wallet.addresses.map((a) => a.publicKey) })),
    };
  });
}

/** A wallet address matched by `resolveOwnedAddress` — enough to route a Send/
 * Sign flow (slug + walletId + the matched address's vm) and to name the match
 * for the user (account name + network). */
export interface AddressMatch {
  readonly slug: string;
  readonly accountName: string;
  readonly walletId: number;
  readonly vm: "evm" | "svm";
  readonly network: string;
  readonly publicKey: string;
}

/**
 * Every OWNED address matching `query`, across all READABLE accounts — the
 * address-entry resolver (and the address-search scan). EVM addresses
 * compare case-insensitively (checksum-agnostic); SVM exactly. The result is a
 * LIST: an address belongs to one wallet in practice, but a list lets the UI say
 * "found in N" and lets the Search screen render matches. A locked own-password
 * account contributes nothing (its wallets are unreadable until it is entered) —
 * so "any address" is really "any address of an already-readable account", which
 * is the only kind a Send/Sign could use anyway. `undefined` only when the
 * workspace is not unlocked (same contract as `workspaceIndex`); plain data only.
 */
export function resolveOwnedAddress(query: string): readonly AddressMatch[] | undefined {
  const ws = vault;
  if (ws === undefined || ws.closed || ws.locked) return undefined;
  const q = query.trim();
  if (q === "") return [];
  const qLower = q.toLowerCase();
  const matches: AddressMatch[] = [];
  for (const account of ws.accounts) {
    // 🚨 Read addresses via `mapWallets(account.wallets)` DIRECTLY, not the
    // locked-gated `walletsFor`: an address (public key) is readable even for a
    // `locked` (un-entered) shared account — measured — and `walletsFor` bails on
    // `account.locked`, which would make the resolver blind to every account the
    // user has not already entered (the whole point is to resolve without that).
    // An own-password account that genuinely cannot derive its wallets throws →
    // skipped. No key is read here; the Send/Sign flow still demands the unlock.
    let slug: string;
    let name: string;
    let wallets: readonly WalletRow[];
    try {
      slug = String(account.slug);
      name = String(account.displayName);
      wallets = mapWallets(account);
    } catch {
      continue;
    }
    for (const wallet of wallets) {
      for (const address of wallet.addresses) {
        const vm: "evm" | "svm" = address.vm === "svm" ? "svm" : "evm";
        const hit = vm === "evm" ? address.publicKey.toLowerCase() === qLower : address.publicKey === q;
        if (hit) {
          matches.push({ slug, accountName: name, walletId: wallet.id, vm, network: address.network, publicKey: address.publicKey });
        }
      }
    }
  }
  return matches;
}

/**
 * The account's organization kind, or `undefined` if it cannot be read.
 *
 * 🚨 Disable/Enable addresses are **HD-only** — on a PK account the library
 * throws `UNSUPPORTED_OP` on the write (though `getDisabledSlots()` reads safely
 * as `[]`). A consumer uses this to HIDE the Disable/Enable action on a PK
 * account rather than offer it and fail.
 */
export function accountKind(slug: string): "HD" | "PK" | undefined {
  const ws = vault;
  if (ws === undefined || ws.closed || ws.locked) return undefined;
  const account = ws.accounts.bySlug(slug as never) ?? undefined;
  if (account === undefined) return undefined;
  return String(account.organizationType) === "PK" ? "PK" : "HD";
}

/** The outcome of a disable/enable mutation: the refreshed rows, or a reason. */
export type SlotMutation =
  | { readonly ok: true; readonly wallets: readonly WalletRow[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Disable, then re-read — or enable, then re-read. The grid's multi-select feeds
 * these; both verbs take the same wallet ids.
 *
 * 🚨 **Index 0 can never be disabled** — the library throws `addressNos[] must
 * be >= 1`, so ids < 1 are filtered out here rather than left to fail (the UI
 * must not offer #0). Both verbs are **idempotent
 * no-ops** (re-disabling a disabled id, enabling a never-disabled one, or an
 * empty set all succeed silently), so there is no pre-check. Disabling **works
 * while the account is LOCKED** — the marker is metadata, not key material — so
 * this never unlocks. The library coalesces ranges, so the caller re-reads
 * `wallets` rather than modelling the slots itself.
 */
async function mutateSlots(
  slug: string,
  ids: readonly number[],
  verb: "disable" | "enable",
): Promise<SlotMutation> {
  const ws = vault;
  if (ws === undefined || ws.closed) return { ok: false, reason: "The workspace is closed." };
  const account = ws.accounts.bySlug(slug as never) ?? undefined;
  if (account === undefined) return { ok: false, reason: "That account is unavailable." };
  const nos = [...new Set(ids)].filter((id) => Number.isInteger(id) && id >= 1);
  // 🚨 The re-read (`mapWallets`) is INSIDE the try. It can throw on a detached
  // handle (the class guarded at senderAddress/catalogueFor/onUnlockSubmit), and
  // the UI caller uses `.then` with no `.catch` (safe only because this never
  // rejects) — so a bare throw here would become an unhandledRejection and bail
  // the process. Catching it yields the normal `{ok:false}` instead.
  try {
    if (nos.length > 0) {
      await (verb === "disable" ? account.disableAddressNos(nos) : account.enableAddressNos(nos));
    }
    return { ok: true, wallets: mapWallets(account) };
  } catch (error) {
    return { ok: false, reason: safeMessage(error) };
  }
}

export async function disableWallets(slug: string, ids: readonly number[]): Promise<SlotMutation> {
  return mutateSlots(slug, ids, "disable");
}

export async function enableWallets(slug: string, ids: readonly number[]): Promise<SlotMutation> {
  return mutateSlots(slug, ids, "enable");
}

/**
 * Expand an HD account by deriving `count` more addresses (`deriveWallets`).
 * HD-only — the action is offered only on HD accounts; a PK account would throw
 * (no derivation), which is caught and surfaced. The caller validates `count` as
 * a positive integer up front. The new wallets appear when a consumer re-reads
 * `walletsFor` on success; `deriveWallets` keeps existing ids and disabled slots
 * intact.
 */
export async function expandAccount(slug: string, count: number): Promise<AccountMutation> {
  const ws = vault;
  if (ws === undefined || ws.closed) return { ok: false, reason: "The workspace is closed." };
  const account = ws.accounts.bySlug(slug as never) ?? undefined;
  if (account === undefined) return { ok: false, reason: "That account is unavailable." };
  try {
    await account.deriveWallets(count);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: safeMessage(error) };
  }
}

/**
 * Discard an HD account's derived addresses from `fromIndex` onward
 * (`sliceWallets`) — e.g. `fromIndex === 1` keeps only `#0`. HD-only, and
 * RE-DERIVABLE: the dropped addresses are deterministic, so `Expand` re-creates
 * the same ones (any on-chain funds stay on-chain, just no longer listed). The
 * caller validates `fromIndex` as an integer in `[1, derivedCount - 1]` up front
 * (`#0` can never be dropped). The caller re-reads on success.
 */
export async function discardAddresses(slug: string, fromIndex: number): Promise<AccountMutation> {
  const ws = vault;
  if (ws === undefined || ws.closed) return { ok: false, reason: "The workspace is closed." };
  const account = ws.accounts.bySlug(slug as never) ?? undefined;
  if (account === undefined) return { ok: false, reason: "That account is unavailable." };
  try {
    await account.sliceWallets(fromIndex);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: safeMessage(error) };
  }
}

/**
 * Import a private key into a PK account (`importPrivateKey`), adding one wallet.
 * PK-only — the action is offered only on PK accounts; an HD account would throw.
 * The caller validates + normalizes the key (EVM hex, Solana base58, or
 * solana-keygen JSON) before this, so a throw here is
 * a library rejection
 * (e.g. a DUPLICATE key) surfaced verbatim. The caller re-reads on success.
 */
export async function importPrivateKeyToAccount(slug: string, key: string): Promise<AccountMutation> {
  const ws = vault;
  if (ws === undefined || ws.closed) return { ok: false, reason: "The workspace is closed." };
  const account = ws.accounts.bySlug(slug as never) ?? undefined;
  if (account === undefined) return { ok: false, reason: "That account is unavailable." };
  try {
    await account.importPrivateKey(key);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: safeMessage(error) };
  }
}

/**
 * Remove one wallet (address) from a PK account (`account.wallets.drop`). PK's
 * destructive analog of HD Disable — 🚨 IRREVERSIBLE: the dropped key is gone
 * unless re-imported from the original key material (unlike HD Discard, which
 * re-derives). The library refuses dropping the LAST wallet (`UNSUPPORTED_OP`),
 * surfaced verbatim; the caller also gates the action's one-wallet case up
 * front. The caller re-reads on success.
 */
export async function removeAddress(slug: string, walletId: number): Promise<AccountMutation> {
  const ws = vault;
  if (ws === undefined || ws.closed) return { ok: false, reason: "The workspace is closed." };
  const account = ws.accounts.bySlug(slug as never) ?? undefined;
  if (account === undefined) return { ok: false, reason: "That account is unavailable." };
  const wallet = account.wallets.byId(walletId);
  if (wallet === null) return { ok: false, reason: `No address #${walletId} on this account.` };
  try {
    await account.wallets.drop(wallet);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: safeMessage(error) };
  }
}

/**
 * Resolve one wallet handle on an open account for a mutation, mirroring the
 * find-account-find-wallet dance of `removeAddress`. No `account.locked` guard:
 * the only callers (the tag trio) are reached from a consumer already past the
 * unlock gate — same contract as `removeAddress`. The handle is used
 * synchronously inside the caller's try and never escapes as a stored value.
 */
function openWalletHandle(slug: string, walletId: number):
  | { readonly ok: true; readonly wallet: { addTag(tag: string): Promise<void>; removeTag(tag: string): Promise<void>; clearTags(): Promise<void> } }
  | { readonly ok: false; readonly reason: string } {
  const ws = vault;
  if (ws === undefined || ws.closed) return { ok: false, reason: "The workspace is closed." };
  const account = ws.accounts.bySlug(slug as never) ?? undefined;
  if (account === undefined) return { ok: false, reason: "That account is unavailable." };
  const wallet = account.wallets.byId(walletId);
  if (wallet === null) return { ok: false, reason: `No address #${walletId} on this account.` };
  return { ok: true, wallet };
}

/**
 * Read one wallet's tags synchronously (plain strings), or `undefined` when the
 * workspace/account is not readable — same contract as `walletsFor`. The Tags
 * modal reloads through this after every mutation; no handle escapes.
 */
export function walletTagsFor(slug: string, walletId: number): readonly string[] | undefined {
  const ws = vault;
  if (ws === undefined || ws.closed || ws.locked) return undefined;
  const account = ws.accounts.bySlug(slug as never) ?? undefined;
  if (account === undefined || account.locked) return undefined;
  const wallet = account.wallets.byId(walletId);
  return wallet === null ? undefined : [...wallet.tags];
}

/**
 * Add a tag to a wallet (`Wallet.addTag`, async, per-wallet). The tag is
 * canonicalized by TRIMMING and an empty tag is refused up front (the library
 * would otherwise store a blank chip). 🚨 MEASURED (2.5.4): a duplicate is
 * idempotent-silent — re-adding a tag already present returns ok and leaves a
 * single entry (it does NOT throw or report a dup). Any genuine rule the library
 * does enforce (length, charset) throws and is surfaced verbatim. One tag per
 * call so a consumer's batch loop reports each tag's OWN failure. The caller
 * re-reads on success.
 */
export async function addWalletTag(slug: string, walletId: number, tag: string): Promise<AccountMutation> {
  const trimmed = tag.trim();
  if (trimmed === "") return { ok: false, reason: "A tag cannot be empty." };
  const handle = openWalletHandle(slug, walletId);
  if (!handle.ok) return { ok: false, reason: handle.reason };
  try {
    await handle.wallet.addTag(trimmed);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: safeMessage(error) };
  }
}

/** Remove one tag from a wallet (`Wallet.removeTag`). The tag is passed VERBATIM
 * — the caller removes the exact stored string under the cursor, so no trim (a
 * stored tag is already trimmed by `addWalletTag`). */
export async function removeWalletTag(slug: string, walletId: number, tag: string): Promise<AccountMutation> {
  const handle = openWalletHandle(slug, walletId);
  if (!handle.ok) return { ok: false, reason: handle.reason };
  try {
    await handle.wallet.removeTag(tag);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: safeMessage(error) };
  }
}

/** Clear all of a wallet's tags (`Wallet.clearTags`). */
export async function clearWalletTags(slug: string, walletId: number): Promise<AccountMutation> {
  const handle = openWalletHandle(slug, walletId);
  if (!handle.ok) return { ok: false, reason: handle.reason };
  try {
    await handle.wallet.clearTags();
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: safeMessage(error) };
  }
}

/**
 * Remove a CUSTOM network (`ws.networks.drop`). A built-in is refused
 * up front with a clear message — the library also throws on one, with code
 * `UNSUPPORTED_OP` (message "Cannot drop built-in network …"); `safeMessage`
 * keys on that CODE, so it is the backstop if the `isBuiltinSlug` guard above
 * ever misses a built-in. Any OTHER library refusal surfaces via `safeMessage`
 * (whether the library refuses a still-in-use network is unverified; either way
 * is safe — dropping config removes no keys/funds, and an account whose default
 * was this network degrades gracefully, since `defaultNetworkOf` returns
 * `undefined` when the slug no longer resolves). The list re-reads on success.
 */
export async function dropNetwork(slug: string): Promise<AccountMutation> {
  const ws = vault;
  if (ws === undefined || ws.closed) return { ok: false, reason: "The workspace is closed." };
  if (Network.isBuiltinSlug(slug as never)) return { ok: false, reason: "Built-in networks cannot be removed." };
  try {
    const network = ws.networks.bySlug(slug as never);
    if (network === null) return { ok: false, reason: "That network is unavailable." };
    await ws.networks.drop(network);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: safeMessage(error) };
  }
}

/** The outcome of an account-level mutation (rename / reset-password / remove). */
export type AccountMutation = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Whether an account seals with its OWN password (`true`) or the workspace
 * password (`false`), or `undefined` if it cannot be read. The reset-password
 * flow uses it to label the step ("Change password" vs "Set a password") and to
 * know whether the OLD password is the account's own or the workspace one. */
export function accountHasOwnPassword(slug: string): boolean | undefined {
  const ws = vault;
  if (ws === undefined || ws.closed || ws.locked) return undefined;
  const account = ws.accounts.bySlug(slug as never) ?? undefined;
  return account === undefined ? undefined : account.hasOwnPassword === true;
}

/**
 * Rename an account's display name. The caller validates the name up front (the
 * create flow's `nameProblem`), so a throw here is unexpected; it is still
 * caught and surfaced. 🚨 The slug is **stable** across a rename (measured), so
 * nav state (which keys off the slug) survives — no re-navigation needed, only a
 * re-read of the accounts list.
 */
export async function renameAccount(slug: string, newName: string): Promise<AccountMutation> {
  const ws = vault;
  if (ws === undefined || ws.closed) return { ok: false, reason: "The workspace is closed." };
  const account = ws.accounts.bySlug(slug as never) ?? undefined;
  if (account === undefined) return { ok: false, reason: "That account is unavailable." };
  try {
    await account.rename(newName);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: safeMessage(error) };
  }
}

/**
 * Reset an account's password.
 *
 * 🚨 On a SHARED account (`hasOwnPassword: false`) this CONVERTS it to an
 * own-password account (measured: `hasOwnPassword` flips to `true`), so it then
 * needs its own password to enter rather than auto-unlocking with the workspace
 * password — the flow warns about this. `oldPassword` is the current seal: the
 * workspace password for a shared account, the account's own for an
 * own-password one. A wrong `oldPassword` is `BAD_PASSWORD`, reported plainly.
 */
export async function resetAccountPassword(
  slug: string,
  oldPassword: string,
  newPassword: string,
): Promise<AccountMutation> {
  const ws = vault;
  if (ws === undefined || ws.closed) return { ok: false, reason: "The workspace is closed." };
  const account = ws.accounts.bySlug(slug as never) ?? undefined;
  if (account === undefined) return { ok: false, reason: "That account is unavailable." };
  try {
    await account.resetPassword(oldPassword, newPassword);
    return { ok: true };
  } catch (error) {
    if (errorCode(error) === "BAD_PASSWORD") return { ok: false, reason: "That is not the current password." };
    return { ok: false, reason: safeMessage(error) };
  }
}

/**
 * Remove an account — `account.drop()`. 🚨 **Irreversible**: the keys go with
 * it. The flow gates this behind a typed-name confirmation. The slug is freed
 * (the account no longer appears in `ws.accounts`), so the caller must pop back
 * away from the account — its view is now invalid — and re-read.
 */
export async function removeAccount(slug: string): Promise<AccountMutation> {
  const ws = vault;
  if (ws === undefined || ws.closed) return { ok: false, reason: "The workspace is closed." };
  const account = ws.accounts.bySlug(slug as never) ?? undefined;
  if (account === undefined) return { ok: false, reason: "That account is unavailable." };
  try {
    await account.drop();
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: safeMessage(error) };
  }
}

/** The account's default network slug (null-checked), or `undefined`. The grid
 * shows this one network's address + per-asset balances. */
export function defaultNetworkOf(slug: string): string | undefined {
  const ws = vault;
  if (ws === undefined || ws.closed || ws.locked) return undefined;
  const account = ws.accounts.bySlug(slug as never) ?? undefined;
  if (account === undefined) return undefined;
  const network = String(account.defaultNetwork);
  return ws.networks.bySlug(network as never) === null ? undefined : network;
}

/** A network the account can be defaulted to — one it actually holds an address
 * on. `name` is the human label from the workspace's network table. */
export interface AccountNetwork {
  readonly slug: string;
  readonly name: string;
  /** The network's native-coin symbol (ETH / BNB / SOL / …), from
   * `nativeCurrency.symbol` — so a per-network native row can be labelled in the
   * chain's own coin rather than a hardcoded ETH/SOL guess. */
  readonly currencySymbol: string;
}

/**
 * The networks an account has addresses on, each with its display name, in
 * first-seen order and de-duplicated — the ONLY meaningful choices for the
 * default. 🚨 Deliberately NOT all `ws.networks`: `setDefaultNetwork` accepts
 * any workspace network (measured, even one the account has no address on),
 * which would leave the grid's default-network address column empty. Restricting
 * the picker to the account's own networks keeps the grid coherent.
 */
export function accountNetworks(slug: string): readonly AccountNetwork[] | undefined {
  const ws = vault;
  if (ws === undefined || ws.closed || ws.locked) return undefined;
  const account = ws.accounts.bySlug(slug as never) ?? undefined;
  if (account === undefined || account.locked) return undefined;
  const seen = new Set<string>();
  const out: AccountNetwork[] = [];
  for (const wallet of account.wallets) {
    for (const address of wallet.addresses) {
      // `Network.slug` is always present (measured) — no `?? address.network`
      // fallback, which `mapWallets` deliberately purged as dead code that would
      // stringify a Network to `[object Object]`.
      const netSlug = String((address.network as { slug: unknown }).slug);
      if (seen.has(netSlug)) continue;
      seen.add(netSlug);
      const network = ws.networks.bySlug(netSlug as never);
      // A network not in the workspace table is unusable — `defaultNetworkOf`
      // and `catalogueFor` both treat a `bySlug`-null as such, so the picker must
      // not offer one (setting it default would blank the grid). Unreachable with
      // built-in-only networks today; the filter keeps the three consistent.
      if (network === null) continue;
      out.push({ slug: netSlug, name: network.name, currencySymbol: String(network.nativeCurrency.symbol) });
    }
  }
  return out;
}

/**
 * The workspace's registered networks, as colour-coded chips for a consumer —
 * all of `ws.networks`, not an account's subset. Empty while
 * closed; readable while locked (the network table is workspace config, not an
 * account secret).
 */
export function workspaceNetworks(): readonly { readonly name: string; readonly color: string }[] {
  const ws = vault;
  if (ws === undefined || ws.closed) return [];
  try {
    return [...ws.networks].map((network) => ({ name: network.name, color: network.color ?? "" }));
  } catch {
    return [];
  }
}

/** One workspace network, plain data, for a consumer's networks view. */
export interface NetworkDetail {
  readonly slug: string;
  readonly name: string;
  readonly vm: "evm" | "svm";
  readonly chainId: number;
  readonly rpcUrl: string;
  /** A library built-in: 🔒 cannot be dropped (override-only via `update`). */
  readonly builtin: boolean;
}

/**
 * Every workspace network as plain rows, in the library's PERSISTED order
 * — the order `ws.networks` returns, which the user reorders via `moveNetwork`
 * (2.5.5 `networks.move`). 🔄 An earlier EVM-first re-partition was DROPPED when
 * 2.5.5 landed: re-sorting here would hide a user's reorder. Each row is marked
 * `builtin`. Networks are workspace config (not a secret), so this reads whether
 * or not the workspace is locked — same contract as `workspaceNetworks`.
 */
export function networksDetail(): readonly NetworkDetail[] | undefined {
  const ws = vault;
  if (ws === undefined || ws.closed) return undefined;
  try {
    return [...ws.networks].map((network) => ({
      slug: String(network.slug),
      name: network.name,
      vm: (String(network.vm) === "svm" ? "svm" : "evm") as "evm" | "svm",
      chainId: Number(network.chainId),
      rpcUrl: network.rpcUrl,
      builtin: Network.isBuiltinSlug(network.slug),
    }));
  } catch {
    return undefined;
  }
}

/**
 * Reorder a network to `toIndex` (2.5.5 `ws.networks.move`) — persisted.
 * `toIndex` is the slug's final 0-based position in `networksDetail()`. Built-ins
 * ARE reorderable (only `drop`/`save` of a built-in is refused), so no built-in
 * guard here. The library throws `PARAMETER_ERROR` on an out-of-range index and
 * `RECORD_NOT_FOUND` on an unknown slug (surfaced via `safeMessage`); the caller
 * clamps `toIndex` to the list bounds, so a throw is defensive.
 */
export async function moveNetwork(slug: string, toIndex: number): Promise<AccountMutation> {
  const ws = vault;
  if (ws === undefined || ws.closed) return { ok: false, reason: "The workspace is closed." };
  try {
    await ws.networks.move(slug as never, toIndex);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: safeMessage(error) };
  }
}

/**
 * Derive a network slug from its display name — the single source of truth
 * shared by the add form (for the up-front duplicate check) and `addNetwork`
 * (which re-derives it), so the two never drift. Lower-cases, collapses every
 * non-`[a-z0-9]` run to a single `-`, and trims leading/trailing `-`. The result
 * may still be too short / malformed for the library's slug rule (4–64,
 * `^[a-z][a-z0-9_-]*[a-z0-9]$`, MEASURED); the form validates that before this
 * is ever reached, and `addNetwork` surfaces any residual library refusal.
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
 * 4-64 chars, start with [a-z], end with [a-z0-9], middle [a-z0-9_-]`). The UI
 * allows a 3–16 char NAME (3 is the library's own floor on
 * `Network.name`, so the name cannot be shorter), so a short name's base slug is
 * auto-extended with the chain id to clear the slug floor — name `OPx` on chain 10
 * → slug `opx-10`. A base already ≥4 chars is kept verbatim, so every existing
 * network and slug is unchanged. The add form guarantees the base starts with a
 * letter and carries ≥2 alphanumerics, so `${base}-${chainId}` is always ≥4 and
 * matches the library's `^[a-z][a-z0-9_-]{2,62}[a-z0-9]$`; `addNetwork` is still
 * the final gate for anything that slips through (e.g. a duplicate).
 */
export function finalizeNetworkSlug(name: string, chainId: number): string {
  const base = deriveNetworkSlug(name);
  return base.length >= 4 ? base : `${base}-${chainId}`;
}

/** The explicit-full add-network form's collected input. */
export interface NetworkInput {
  readonly name: string;
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly vm: "evm" | "svm";
  readonly currencyName: string;
  readonly currencySymbol: string;
  readonly currencyDecimals: number;
  readonly multicallAddress?: string;
  readonly color?: string;
}

/**
 * Add a CUSTOM network (`ws.networks.add(new Network(init))`). The slug
 * is derived from the name. The library validates thoroughly and THROWS
 * (`Network "<slug>" already exists.`, `Invalid slug …`, `nativeCurrency.symbol
 * must be at least 2 …` — the duplicate is `DUPLICATE_IDENTITY` since 2.5.5, the
 * rest `PARAMETER_ERROR`; MEASURED); `safeMessage`
 * collapses those to one generic line, so the FORM validates each field up front
 * for specific feedback and this is the final gate. Grid/chips are unaffected;
 * the caller re-reads on success.
 */
export async function addNetwork(input: NetworkInput): Promise<AccountMutation> {
  const ws = vault;
  if (ws === undefined || ws.closed) return { ok: false, reason: "The workspace is closed." };
  try {
    await ws.networks.add(
      new Network({
        slug: finalizeNetworkSlug(input.name, input.chainId) as never,
        name: input.name.trim(),
        chainId: input.chainId as never,
        rpcUrl: input.rpcUrl.trim(),
        nativeCurrency: {
          name: input.currencyName.trim(),
          symbol: input.currencySymbol.trim(),
          decimals: input.currencyDecimals,
        },
        ...(input.multicallAddress !== undefined && input.multicallAddress.trim() !== ""
          ? { multicallAddress: input.multicallAddress.trim() }
          : {}),
        ...(input.color !== undefined && input.color.trim() !== "" ? { color: input.color.trim() } : {}),
        vm: input.vm,
      } as never),
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: safeMessage(error) };
  }
}

/**
 * One network's COMPLETE field set, for a consumer's network edit form — the
 * multicall address and colour (empty string when unset) that `NetworkDetail`
 * omits, plus `builtin`. A built-in is editable (rpc / multicall / colour) but
 * not droppable, and the UI keeps its identity fields (name / chainId / vm /
 * currency) read-only; a custom network is fully editable.
 */
export interface NetworkFull {
  readonly slug: string;
  readonly name: string;
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly vm: "evm" | "svm";
  readonly currencyName: string;
  readonly currencySymbol: string;
  readonly currencyDecimals: number;
  readonly multicallAddress: string;
  readonly color: string;
  readonly builtin: boolean;
}

export function networkFull(slug: string): NetworkFull | undefined {
  const ws = vault;
  if (ws === undefined || ws.closed) return undefined;
  const network = ws.networks.bySlug(slug as never);
  if (network === null) return undefined;
  return {
    slug: String(network.slug),
    name: network.name,
    chainId: Number(network.chainId),
    rpcUrl: network.rpcUrl,
    vm: (String(network.vm) === "svm" ? "svm" : "evm") as "evm" | "svm",
    currencyName: network.nativeCurrency.name,
    currencySymbol: network.nativeCurrency.symbol,
    currencyDecimals: Number(network.nativeCurrency.decimals),
    multicallAddress: network.multicallAddress ?? "",
    color: network.color ?? "",
    builtin: Network.isBuiltinSlug(network.slug),
  };
}

/** The editable fields of a network. One is set per edit; the rest keep their
 * current value. `multicallAddress` / `color` set to "" clears that field. The
 * slug is NEVER here — it is the identity `update()` matches on. */
export interface NetworkPatch {
  readonly name?: string;
  readonly chainId?: number;
  readonly rpcUrl?: string;
  readonly vm?: "evm" | "svm";
  readonly currencyName?: string;
  readonly currencySymbol?: string;
  readonly currencyDecimals?: number;
  readonly multicallAddress?: string;
  readonly color?: string;
}

/**
 * Edit a network (`ws.networks.update(new Network(init))`). The existing
 * network is read, the patch applied, the SLUG kept (update matches on it), and
 * endpoints/routes preserved. A built-in CAN be updated this way (its drop throws
 * UNSUPPORTED_OP, but update is allowed — the common case is a custom RPC); the
 * UI restricts a built-in's editable fields to rpc / multicall / colour. The
 * library validates and THROWS on a bad value; `safeMessage` collapses it, so the
 * UI validates each field up front and this is the final gate.
 */
export async function updateNetwork(slug: string, patch: NetworkPatch): Promise<AccountMutation> {
  const ws = vault;
  if (ws === undefined || ws.closed) return { ok: false, reason: "The workspace is closed." };
  const existing = ws.networks.bySlug(slug as never);
  if (existing === null) return { ok: false, reason: "That network is unavailable." };
  const multicall = patch.multicallAddress !== undefined ? patch.multicallAddress.trim() : (existing.multicallAddress ?? "");
  const rawColor = patch.color !== undefined ? patch.color.trim() : (existing.color ?? "");
  const color = rawColor === "" ? "" : rawColor.startsWith("#") ? rawColor : `#${rawColor}`;
  try {
    await ws.networks.update(
      new Network({
        slug: existing.slug,
        name: (patch.name ?? existing.name).trim(),
        chainId: (patch.chainId ?? Number(existing.chainId)),
        rpcUrl: (patch.rpcUrl ?? existing.rpcUrl).trim(),
        nativeCurrency: {
          name: (patch.currencyName ?? existing.nativeCurrency.name).trim(),
          symbol: (patch.currencySymbol ?? existing.nativeCurrency.symbol).trim(),
          decimals: patch.currencyDecimals ?? Number(existing.nativeCurrency.decimals),
        },
        vm: patch.vm ?? (String(existing.vm) === "svm" ? "svm" : "evm"),
        ...(existing.endpoints !== undefined ? { endpoints: existing.endpoints } : {}),
        ...(existing.readEndpoints !== undefined ? { readEndpoints: existing.readEndpoints } : {}),
        ...(existing.writeEndpoints !== undefined ? { writeEndpoints: existing.writeEndpoints } : {}),
        ...(existing.routes !== undefined ? { routes: existing.routes } : {}),
        ...(multicall !== "" ? { multicallAddress: multicall } : {}),
        ...(color !== "" ? { color } : {}),
      } as never),
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: safeMessage(error) };
  }
}

/**
 * Set the account's default network (the one the grid shows). `networkSlug` must
 * be one of `accountNetworks(slug)` — the caller (the picker) restricts it; the
 * library would otherwise accept a network the account cannot display. Re-read
 * the grid after (no change-notification API).
 */
export async function setAccountDefaultNetwork(slug: string, networkSlug: string): Promise<AccountMutation> {
  const ws = vault;
  if (ws === undefined || ws.closed) return { ok: false, reason: "The workspace is closed." };
  const account = ws.accounts.bySlug(slug as never) ?? undefined;
  if (account === undefined) return { ok: false, reason: "That account is unavailable." };
  try {
    await account.setDefaultNetwork(networkSlug as never);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: safeMessage(error) };
  }
}

/** A displayed asset column for the balance grid — plain data, from the catalogue.
 * `native` marks the chain/gas coin so the grid can filter it by the showGasToken
 * pref WITHOUT a positional assumption (the library's `network.assets.move` can
 * demote the native coin out of index 0). */
export interface AssetColumn {
  readonly id: number;
  readonly symbol: string;
  readonly decimals: number;
  readonly displayDecimals: number;
  readonly native: boolean;
}

/**
 * The displayed assets of an account's DEFAULT network — the grid's balance
 * columns (one network at a time).
 *
 * 🚨 `ws.assets(slug)` is the flat listing used here (built-in + imported tokens);
 * it is async and throws `UNSUPPORTED_NETWORK` for an unknown slug — so the
 * default network is null-checked first. (2.5.7 also exposes `network.assets` as
 * a live editable collection, but a flat read is all the grid needs here.) A
 * custom network starts with an empty catalogue; built-ins carry the native +
 * known tokens. `displayStatus` is mutable and persistable in 2.5.7 (`asset.save`
 * / `updateAsset`), but this only READS it — the show/hide override lives in a
 * consumer's own preferences, outside this package, deliberately global across
 * workspaces.
 */
export async function catalogueFor(slug: string): Promise<readonly AssetColumn[]> {
  const ws = vault;
  if (ws === undefined || ws.closed || ws.locked) return [];
  const account = ws.accounts.bySlug(slug as never) ?? undefined;
  if (account === undefined) return [];
  const network = String(account.defaultNetwork);
  if (ws.networks.bySlug(network as never) === null) return [];
  // 🚨 The one awaited library call here must not be allowed to reject. Its
  // only caller is a `void catalogueFor(slug).then(...)` with no `.catch`, and a
  // rejection there reaches the process-wide `unhandledRejection` handler
  // (armed in `bootstrap`), which runs `bail` and exits the host process. The
  // bad-slug throw is already pre-empted by the `bySlug` guard above, but any
  // other transient throw from `ws.assets` on a valid network would quit the
  // host process over a single catalogue read. Degrade to "no asset columns"
  // instead — the same
  // safe value this function's sibling early-returns produce. (A post-audit
  // lens flagged this as the lone unguarded await among session.ts's otherwise
  // meticulously guarded library calls.)
  let assets: Awaited<ReturnType<typeof ws.assets>>;
  try {
    assets = await ws.assets(network);
  } catch {
    return [];
  }
  return assets
    .filter((asset) => asset.displayStatus)
    // native coin first (the gas token sits closest to the address column),
    // then the rest in the library's order — the same native-first ordering
    // `assetsForNetwork` applies for the send picker. A stable no-op when the
    // library already returns the native coin first.
    .sort((a, b) => (Boolean(a.native) === Boolean(b.native) ? 0 : a.native ? -1 : 1))
    .map((asset) => ({
      id: Number(asset.id),
      symbol: String(asset.symbol),
      decimals: Number(asset.decimals),
      displayDecimals: Number(asset.displayDecimals),
      native: asset.native === true,
    }));
}

/** A send-flow asset row for a chosen network: enough to lower the transfer (by
 * `symbol`), parse the amount (`decimals`), read the MAX balance (`address`),
 * and mark the native coin. */
export interface SendAsset {
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly native: boolean;
  /** The ERC-20 contract / SPL mint; null for the native coin. */
  readonly address: string | null;
}

/**
 * The displayed assets of a SPECIFIC network, native coin first. Unlike
 * `catalogueFor` (which reads the account's DEFAULT network), the
 * send flow can target any of the wallet's networks, so this takes the network
 * explicitly (the one the caller chose). Guarded like the others: a
 * locked/closed workspace or a rejecting `ws.assets` degrades to `undefined`,
 * never a host-process exit.
 */
export async function assetsForNetwork(slug: string, networkSlug: string): Promise<readonly SendAsset[] | undefined> {
  const ws = vault;
  if (ws === undefined || ws.closed || ws.locked) return undefined;
  const account = ws.accounts.bySlug(slug as never) ?? undefined;
  if (account === undefined || account.locked) return undefined;
  if (ws.networks.bySlug(networkSlug as never) === null) return undefined;
  let assets: Awaited<ReturnType<typeof ws.assets>>;
  try {
    assets = await ws.assets(networkSlug);
  } catch {
    return undefined;
  }
  return assets
    .filter((asset) => asset.displayStatus)
    .map((asset) => ({
      symbol: String(asset.symbol),
      name: String(asset.name),
      decimals: Number(asset.decimals),
      native: asset.native === true,
      address: asset.contractAddress === null ? null : String(asset.contractAddress),
    }))
    .sort((a, b) => (a.native === b.native ? 0 : a.native ? -1 : 1)); // native coin first
}

/** The fields the add-token form collects. */
export interface NewToken {
  readonly contract: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
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

/**
 * Add a custom token to a SPECIFIC network — a consumer's settings
 * calls this (per-network). Validates the contract/symbol/decimals, refuses a
 * duplicate SYMBOL on the network (the library only enforces contract
 * uniqueness, but two same-symbol tokens make the grid/picker ambiguous), then
 * hands the token to `network.assets.add`, which allocates the id (2.5.7). Any
 * library refusal surfaces via `safeMessage`.
 */
export async function addTokenToNetwork(networkSlug: string, token: NewToken): Promise<AccountMutation> {
  const ws = vault;
  if (ws === undefined || ws.closed || ws.locked) return { ok: false, reason: "The workspace is not open." };
  const network = ws.networks.bySlug(networkSlug as never);
  if (network === null) return { ok: false, reason: "That network is unavailable." };

  // 🚨 Validate the token address by the NETWORK's VM, not EVM-only (an SVM
  // network's token is a base58 SPL MINT, not a 0x address). Both this and the UI
  // add-form go through `isTokenAddressForVm`, so the two can never drift — a
  // drift is exactly what kept blocking SPL tokens.
  const contract = token.contract.trim();
  const vm = String(network.vm) === "svm" ? "svm" : "evm";
  if (!isTokenAddressForVm(vm, contract)) return { ok: false, reason: tokenAddressHint(vm) };
  const symbol = token.symbol.trim();
  if (symbol === "") return { ok: false, reason: "Enter a token symbol." };
  if (!Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 36) {
    return { ok: false, reason: "Decimals must be a whole number from 0 to 36." };
  }
  const name = token.name.trim() === "" ? symbol : token.name.trim();

  // Refuse a duplicate symbol ON THIS NETWORK: two same-symbol tokens make the
  // asset picker and the balance grid ambiguous. (The library only enforces
  // CONTRACT uniqueness, so without this a second "USDC" with a different
  // contract would be accepted.) The send path already lowers by contract
  // address, so this is catalogue/UI hygiene, not a fund-safety gate.
  try {
    const existing = await ws.assets(networkSlug);
    if (existing.some((asset) => String(asset.symbol) === symbol)) {
      return { ok: false, reason: `This network already has a token with the symbol "${symbol}".` };
    }
  } catch (error) {
    return { ok: false, reason: safeMessage(error) };
  }

  // 🚨 The LIBRARY allocates the id (2.5.7 `network.assets.add` — user ids start
  // at 1000). This package no longer scans every network for a global max, nor builds
  // an `Asset` with a caller-chosen id (the deprecated `addAsset(asset)` path). A
  // duplicate `(network, contract)` is refused by the library as
  // `DUPLICATE_IDENTITY` ("That already exists."); the symbol guard above is
  // this package's additional, UI-only uniqueness rule.
  try {
    await network.assets.add({ symbol, name, decimals: token.decimals, contractAddress: contract });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: safeMessage(error) };
  }
}

/**
 * Remove a token by its workspace-global id — `ws.dropAsset`. A built-in
 * asset (ETH/USDC/… — not exposed as a flag) throws `UNSUPPORTED_OP`, surfaced
 * as a plain "cannot be removed"; any other refusal via `safeMessage`.
 */
export async function removeTokenById(assetId: number): Promise<AccountMutation> {
  const ws = vault;
  if (ws === undefined || ws.closed || ws.locked) return { ok: false, reason: "The workspace is not open." };
  try {
    await ws.dropAsset(assetId as never);
    return { ok: true };
  } catch (error) {
    if (errorCode(error) === "UNSUPPORTED_OP") {
      return { ok: false, reason: "That is a built-in token and cannot be removed." };
    }
    return { ok: false, reason: safeMessage(error) };
  }
}

/** A network's tokens for a consumer's token list. The token selection keys on
 * the workspace-global `id` (built-ins carry a real
 * `contract` too, so a contract key could never distinguish them); `native`
 * flags the native coin, which has no column toggle and cannot be removed. The
 * `contract` is still carried for display/diagnostics. */
export interface NetworkToken {
  readonly id: number;
  readonly symbol: string;
  readonly name: string;
  readonly native: boolean;
  readonly contract: string | null;
  /** The asset's own decimals — the ceiling for the display-decimals override. */
  readonly decimals: number;
  /** The library's per-asset `displayDecimals` (2.5.7, per-workspace). Defaults to
   * `decimals`; interpret via `effectiveDisplayDecimals` for the lean default. */
  readonly displayDecimals: number;
}

/** A specific network's tokens as plain rows, in the library's PERSISTED
 * order — so the UI index lines up with `moveToken`'s `toIndex` (no re-sort, same
 * discipline as `networksDetail`; the native coin is first in the library order
 * already). Guarded like `catalogueFor`: a locked/closed workspace or a
 * rejecting `ws.assets` degrades to `undefined`, never an exit. */
export async function networkTokensDetail(networkSlug: string): Promise<readonly NetworkToken[] | undefined> {
  const ws = vault;
  if (ws === undefined || ws.closed || ws.locked) return undefined;
  if (ws.networks.bySlug(networkSlug as never) === null) return undefined;
  try {
    const assets = await ws.assets(networkSlug);
    return assets.map((asset) => ({
      id: Number(asset.id),
      symbol: String(asset.symbol),
      name: String(asset.name),
      native: asset.native === true,
      contract: asset.contractAddress === null || asset.contractAddress === undefined ? null : String(asset.contractAddress),
      decimals: Number(asset.decimals),
      displayDecimals: Number(asset.displayDecimals),
    }));
  } catch {
    return undefined;
  }
}

/** Reorder a token within a network (2.5.7 `network.assets.move`) — persisted.
 * `toIndex` is 0-based among that network's tokens (`networkTokensDetail` order);
 * the caller clamps it, so a library out-of-range throw is defensive. */
export async function moveToken(networkSlug: string, assetId: number, toIndex: number): Promise<AccountMutation> {
  const ws = vault;
  if (ws === undefined || ws.closed || ws.locked) return { ok: false, reason: "The workspace is not open." };
  const network = ws.networks.bySlug(networkSlug as never);
  if (network === null) return { ok: false, reason: "That network is unavailable." };
  try {
    await network.assets.move(assetId as never, toIndex);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: safeMessage(error) };
  }
}

/**
 * Set a token's display-decimals — 2.5.7 `ws.updateAsset`, persisted PER-WORKSPACE.
 * Both built-in and user tokens allow editing `displayDecimals` (the library's
 * two-tier rule); it must be `<= decimals` (the caller validates, so a library
 * `PARAMETER_ERROR` here is defensive). Replaces the former consumer-local prefs
 * override — the library now owns per-asset display-decimals (the grid reads
 * `asset.displayDecimals` via `effectiveDisplayDecimals`).
 */
export async function setTokenDisplayDecimals(networkSlug: string, assetId: number, value: number): Promise<AccountMutation> {
  const ws = vault;
  if (ws === undefined || ws.closed || ws.locked) return { ok: false, reason: "The workspace is not open." };
  if (ws.networks.bySlug(networkSlug as never) === null) return { ok: false, reason: "That network is unavailable." };
  try {
    await ws.updateAsset(assetId as never, { displayDecimals: value });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: safeMessage(error) };
  }
}

/** One wallet's balances on the default network — plain data for a grid row. */
export type WalletBalances =
  | { readonly kind: "loading" }
  /** The whole read failed (our timeout fired, or `confirm()` rejected, e.g. a
   * locked account). Retryable — a balance read is idempotent. */
  | { readonly kind: "error" }
  /** Per asset id: the raw amount + its decimals, and a per-cell `readError`
   * (free prose) when that one asset failed (`raw` is then `0n`, NOT a balance). */
  | {
      readonly kind: "ready";
      readonly byAsset: ReadonlyMap<number, { readonly raw: bigint; readonly decimals: number; readonly readError?: string }>;
    };

/** Race a promise against our own timeout — because `Settling.abort()` is a
 * no-op after dispatch and the library's internal timeout is 30 s. A late
 * resolution after the timeout is dropped (the outer promise already settled). */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("balance read timed out")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Fill the given wallets' DEFAULT-network balances, bounded by `concurrency`,
 * each read wrapped in `timeoutMs`, reporting every state transition via
 * `onUpdate`.
 *
 * 🚨 **Handle-free by construction** — it holds the `Address` handles internally
 * (only `refreshBalances(displayedOnly)` works; the per-network/per-asset
 * overloads reject) and hands the caller only plain `WalletBalances`. The caller
 * owns the store and the window; a late result for a scrolled-away wallet simply
 * overwrites that wallet's cache entry (keyed by id), so no cross-window
 * corruption and no abort is needed. Disabling/locking is irrelevant — addresses
 * are public, so balances read whether or not key material is unlocked.
 */
export async function fillBalances(
  slug: string,
  walletIds: readonly number[],
  opts: {
    readonly concurrency: number;
    readonly timeoutMs: number;
    readonly onUpdate: (walletId: number, state: WalletBalances) => void;
  },
): Promise<void> {
  const ws = vault;
  if (ws === undefined || ws.closed || ws.locked) return;
  const account = ws.accounts.bySlug(slug as never) ?? undefined;
  // No `account.locked` gate, and no unlock here. The grid is reached via
  // `enterAccount`, which has already unlocked a shared account (and an
  // own-password one through its prompt). A read on a still-locked account's
  // address rejects, which the worker catches and reports as an `error` cell —
  // a balance window never triggers an unlock.
  if (account === undefined) return;
  const network = String(account.defaultNetwork);
  // Guarded like the awaited reads below: a throw from this sync setup call
  // would reject the promise, and every caller is a `.catch`-less `void
  // fillBalances(...)`, so the rejection would reach `unhandledRejection` →
  // `bail` → the host process exits (same class as the `catalogueFor` guard). A
  // failure to even list the wallets just leaves the window unread.
  let wallets: ReturnType<typeof account.getWalletList>;
  try {
    wallets = account.getWalletList(true);
  } catch {
    return;
  }
  const queue = [...walletIds];

  const worker = async (): Promise<void> => {
    for (;;) {
      const id = queue.shift();
      if (id === undefined) return;
      const wallet = wallets.find((candidate) => candidate.id === id);
      const address = wallet?.addresses.find(
        (candidate) => String((candidate.network as { slug: unknown }).slug) === network,
      );
      if (address === undefined) {
        // No address on the default network → an empty (but ready) row.
        opts.onUpdate(id, { kind: "ready", byAsset: new Map() });
        continue;
      }
      opts.onUpdate(id, { kind: "loading" });
      try {
        const balances = await withTimeout(address.refreshBalances(true).confirm(), opts.timeoutMs);
        const byAsset = new Map(
          balances.map((balance) => [
            Number(balance.assetId),
            { raw: balance.raw, decimals: Number(balance.decimals), readError: balance.readError },
          ]),
        );
        opts.onUpdate(id, { kind: "ready", byAsset });
      } catch {
        opts.onUpdate(id, { kind: "error" });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.floor(opts.concurrency)) }, worker));
}

/** Our own nonce-read timeout: the library's internal one is 30s, which would
 * pin a consumer's nonce "loading" that long on a dead RPC. 12s, not 4s,
 * for the same reason as `BALANCE_TIMEOUT_MS`: a slow-but-alive public RPC
 * (5–8s under load) must not be misreported as an error, while a dead one still
 * fails well inside the library's 30s. */
const NONCE_TIMEOUT_MS = 12000;

/**
 * The pending transaction nonce for one wallet's address on `network`, read live
 * over RPC — a consumer's nonce display. EVM-ONLY: a nonce is an EVM
 * concept (SVM orders by a recent blockhash, with no per-account nonce), so a
 * non-EVM network resolves to `{ ok: false }` and the caller shows no nonce line.
 *
 * 🚨 Handle-free and read-only, like `fillBalances`: it holds the `Address`
 * handle internally and returns a plain number. It resolves the address by
 * (wallet, network) DIRECTLY — not via `senderAddress` — so it reads even for a
 * DISABLED wallet (an address is public and a nonce display is not a send), and
 * it stays correct even if a wallet ever holds more than one address on a vm.
 * The read is bounded by `NONCE_TIMEOUT_MS`.
 */
export async function readNonce(
  slug: string,
  walletId: number,
  network: string,
): Promise<{ readonly ok: true; readonly nonce: number } | { readonly ok: false }> {
  const ws = vault;
  if (ws === undefined || ws.closed || ws.locked) return { ok: false };
  try {
    const account = ws.accounts.bySlug(slug as never) ?? undefined;
    if (account === undefined) return { ok: false };
    const wallet = account.wallets.byId(walletId) ?? undefined;
    if (wallet === undefined) return { ok: false };
    const address = wallet.addresses.find(
      (candidate) => String((candidate.network as { slug: unknown }).slug) === network,
    );
    if (address === undefined || String(address.vm) !== "evm") return { ok: false };
    const client = new ChainClient(address.network);
    const nonce = await withTimeout(client.getTransactionCount(String(address.publicKey), "pending"), NONCE_TIMEOUT_MS);
    return { ok: true, nonce: Number(nonce) };
  } catch {
    // RPC failure / transient handle throw → the caller shows the error glyph.
    // Must NOT propagate: the caller runs this under a `.catch`-less
    // `void readNonce(...).then()`, so an unhandled rejection would bail the host process
    // (same guard discipline as `fillBalances`/`catalogueFor`).
    return { ok: false };
  }
}

/** A grid nonce cell's state: `na` = no EVM address on this network
 * (so no nonce exists), distinct from a still-`loading` read. */
export type NonceReadState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly value: number }
  | { readonly kind: "na" }
  | { readonly kind: "error" };

/**
 * Read the pending nonce for each of `walletIds` on `network`, concurrency-bounded,
 * for the grid's optional nonce column — the window-driven analog of
 * `fillBalances`, and the batched sibling of the single-wallet `readNonce`.
 *
 * 🚨 EVM-ONLY and guarded exactly like `fillBalances`: a non-EVM / missing
 * address reports `na` (never an RPC call), a read is bounded by `timeoutMs`,
 * every throw is caught and reported as `error`, and the sync setup is
 * try-wrapped — the only caller is a `.catch`-less `void fillNonces(...)`, so a
 * leaked rejection would reach `unhandledRejection` → `bail` → the host process exits.
 */
export async function fillNonces(
  slug: string,
  walletIds: readonly number[],
  network: string,
  opts: {
    readonly concurrency: number;
    readonly timeoutMs: number;
    readonly onUpdate: (walletId: number, state: NonceReadState) => void;
  },
): Promise<void> {
  const ws = vault;
  if (ws === undefined || ws.closed || ws.locked) return;
  const account = ws.accounts.bySlug(slug as never) ?? undefined;
  if (account === undefined) return;
  let wallets: ReturnType<typeof account.getWalletList>;
  try {
    wallets = account.getWalletList(true);
  } catch {
    return;
  }
  const queue = [...walletIds];

  const worker = async (): Promise<void> => {
    for (;;) {
      const id = queue.shift();
      if (id === undefined) return;
      const wallet = wallets.find((candidate) => candidate.id === id);
      const address = wallet?.addresses.find(
        (candidate) => String((candidate.network as { slug: unknown }).slug) === network,
      );
      if (address === undefined || String(address.vm) !== "evm") {
        opts.onUpdate(id, { kind: "na" }); // no EVM address here → no nonce, no RPC
        continue;
      }
      opts.onUpdate(id, { kind: "loading" });
      try {
        const client = new ChainClient(address.network);
        const nonce = await withTimeout(client.getTransactionCount(String(address.publicKey), "pending"), opts.timeoutMs);
        opts.onUpdate(id, { kind: "ready", value: Number(nonce) });
      } catch {
        opts.onUpdate(id, { kind: "error" });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.floor(opts.concurrency)) }, worker));
}

// ─────────────────────────────────────────────────────────────────────────────
// Send / Sign — the build → prefill → simulate → screen → sign → send → track
// flow, wrapped handle-free. 🚨 This follows the measured wative-core send/sign
// contract — understand it before touching this. This is the OFFLINE
// inferred-type preview + the refuse-tier destination gate.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The sender address resolved from (account, wallet, vm) — module-internal, so
 * no `Address` handle escapes (the same discipline as the rest of session.ts).
 * `undefined` when the workspace is not open, or the account / wallet / per-vm
 * address cannot be found.
 *
 * 🚨 Routing is by VM ONLY — it returns `wallet.evm`/`wallet.svm`, the FIRST
 * address of that vm, on that address's own network. This is correct because a
 * wallet holds exactly one address per vm (measured). A future feature that
 * derives two same-vm addresses on different networks MUST add a `network`
 * parameter here (and to `SendIntent`) to route by (vm, network); a consumer's
 * send/sign UI must honour the same picker invariant.
 */
function senderAddress(accountSlug: string, walletId: number, vm: "evm" | "svm"): Address | undefined {
  const ws = vault;
  if (ws === undefined || ws.closed || ws.locked) return undefined;
  try {
    const account = ws.accounts.bySlug(accountSlug as never) ?? undefined;
    if (account === undefined) return undefined;
    const wallet = account.wallets.byId(walletId) ?? undefined;
    if (wallet === undefined) return undefined;
    // A disabled wallet is not a valid sender — reject it HERE rather than let the
    // library throw WALLET_DISABLED late at sign (which the send path would then
    // surface as `failed` + safeToResend, misleadingly: resending can't help until
    // the wallet is re-enabled).
    if (wallet.disabled) return undefined;
    const address = vm === "evm" ? wallet.evm : wallet.svm;
    return address ?? undefined;
  } catch {
    // 🚨 The accessors above are getters on live library handles. A transient
    // throw must degrade to "no sender" — every caller handles `undefined` — and
    // must NOT propagate: all three send callers (`prepareSend`/`maxSendable`/
    // `confirmSend`) and the signers run this BEFORE their own try, under a
    // `.catch`-less `void …then()`, so a rejection here would reach the
    // process-wide `unhandledRejection` handler (armed in `bootstrap`) → `bail`
    // → `panicLock` + exit. Same guard discipline
    // as `catalogueFor`'s awaited call.
    return undefined;
  }
}

/** The transfer intent a consumer collects (plain data). `amount` is raw base
 * units (wei / lamports / the token's smallest unit). `asset` omitted = the
 * native coin. `acknowledgeUnsafe` re-runs a refuse-tier destination past the
 * destination gate. */
export interface SendIntent {
  readonly accountSlug: string;
  readonly walletId: number;
  readonly vm: "evm" | "svm";
  readonly to: string;
  readonly asset?: AssetRef;
  readonly amount: bigint;
  readonly acknowledgeUnsafe?: boolean;
  /**
   * RAW-CALL mode (EVM only): sign `to` + `amount` (as the native value) + this
   * exact calldata directly, bypassing the transfer lowering. When present the
   * tx is NOT a transfer — `asset` is ignored, no transfer payload is built, and
   * the refuse-tier destination gate does not block (that check is advisory).
   * `0x` (or empty) means a plain value call with no calldata.
   */
  readonly raw?: { readonly data: string };
}

/** A `0x`-prefixed, even-length hex calldata (`0x` alone = no data). */
const HEX_DATA = /^0x([0-9a-fA-F]{2})*$/;
export function isHexData(data: string): boolean {
  return HEX_DATA.test(data);
}

/**
 * The lowered transfer as plain data — powers the inferred-type header and
 * the refuse-tier destination gate, with NO transaction built or sent and
 * NO network call. `buildTransferPayload` lowers the chain-agnostic intent into
 * native value vs. token calldata/instructions, and throws `IRREGULAR_DESTINATION`
 * for a refuse-tier recipient (zero/burn/precompile/token-self on EVM; off-curve
 * native / incinerator on SVM) — overridable via `acknowledgeUnsafe`. A malformed
 * address is `PARAMETER_ERROR` and is NOT overridable.
 */
export type SendPreview =
  | { readonly ok: true; readonly vm: "evm"; readonly type: "native" | "token"; readonly to: string; readonly value: bigint; readonly data: string }
  | {
      readonly ok: true;
      readonly vm: "svm";
      readonly type: "native" | "token";
      readonly recipient: string;
      readonly amount: bigint;
      readonly instructionCount: number;
    }
  | { readonly ok: false; readonly reason: string; readonly code?: string; readonly overridable: boolean };

/**
 * A lowering failure, shared by `previewTransfer` and `prepareSend`.
 *
 * 🚨 LIMITATION — `overridable` is a LIBRARY-level capability, NOT a live UI
 * affordance. It is `true` only for an offline refuse-tier destination
 * (`IRREGULAR_DESTINATION`: zero/burn/precompile/token-self on EVM; off-curve
 * native / incinerator on SVM), signalling that `acknowledgeUnsafe` COULD force
 * the send past the destination gate. This package deliberately does NOT wire that path: when
 * `prepareSend` fails this way it shows the failure reason and dead-ends — there
 * is no "send anyway to the burn address" button. This is a fail-safe stance
 * (sending to these destinations is almost always a mistake, and the loss is
 * irreversible), so the flag is exercised only by `prepareSend` unit tests that
 * pass `acknowledgeUnsafe: true` directly. The separate RPC destination check
 * (`SendDestination.action` — allow/warn/confirm/refuse) is the gate a consumer
 * DOES surface, via a fund-safety acknowledge step. If a future UI ever adds a
 * force-send affordance, it must gate on an explicit, typed confirmation — never
 * a single keystroke — and never for the zero address.
 */
type LowerFailure = { readonly ok: false; readonly reason: string; readonly code?: string; readonly overridable: boolean };

/**
 * Lower a transfer intent to its chain payload, OFFLINE. The refuse-tier
 * destination gate throws `IRREGULAR_DESTINATION` (overridable via
 * `acknowledgeUnsafe`); a malformed address is a non-overridable
 * `PARAMETER_ERROR`.
 */
function lowerTransfer(address: Address, intent: SendIntent): { readonly ok: true; readonly payload: TransferPayload } | LowerFailure {
  const req: TransferRequest = { to: intent.to, asset: intent.asset, amount: intent.amount };
  try {
    return { ok: true, payload: address.buildTransferPayload(req, { forceUnsafeTransfer: intent.acknowledgeUnsafe }) };
  } catch (error) {
    const code = errorCode(error);
    const destinationCode = (error as { details?: { destinationCode?: unknown } })?.details?.destinationCode;
    return {
      ok: false,
      reason: safeMessage(error),
      code: typeof destinationCode === "string" ? destinationCode : code,
      overridable: code === "IRREGULAR_DESTINATION",
    };
  }
}

/** The inferred transfer type from a lowered payload. */
function inferType(payload: TransferPayload): "native" | "token" {
  if (payload.vm === "evm") return payload.data !== "0x" && payload.data !== "" ? "token" : "native";
  return (payload.instructions?.length ?? 0) > 0 ? "token" : "native";
}

export function previewTransfer(intent: SendIntent): SendPreview {
  const address = senderAddress(intent.accountSlug, intent.walletId, intent.vm);
  if (address === undefined) return { ok: false, reason: "That wallet is unavailable.", overridable: false };
  const lowered = lowerTransfer(address, intent);
  if (!lowered.ok) return lowered;
  const payload = lowered.payload;
  const type = inferType(payload);
  if (payload.vm === "evm") {
    return { ok: true, vm: "evm", type, to: payload.to, value: payload.value, data: payload.data };
  }
  return { ok: true, vm: "svm", type, recipient: payload.recipient, amount: payload.amount, instructionCount: payload.instructions?.length ?? 0 };
}

/** The library's EIP-1559 priority-fee floor — 1 gwei. */
const TIP_FLOOR_WEI = 1_000_000_000n;

// `SVM_FEE_LAMPORTS` (the single-sig Solana fee reserved by a native MAX) now
// lives in `./sendMath.js` (send math), imported above — it was the exact
// constant the UI duplicated, so it has one home. Its full multi-sig/priority-fee
// LIMITATION note travels with it there.

/** A plain simulation summary for the review (no library handle). */
export interface SendSimulation {
  readonly success: boolean;
  readonly error?: string;
  readonly gasUsed?: bigint;
  readonly computeUnits?: number;
}

/** A plain destination-screen summary for the review banner. */
export interface SendDestination {
  readonly action: "allow" | "warn" | "confirm" | "refuse";
  readonly code?: string;
  readonly warnings: readonly string[];
  readonly rpcChecked: boolean;
}

/**
 * A fully-populated, editable review model as plain data — built,
 * fee/nonce-prefilled, simulated, and destination-screened. STATELESS: the tx is
 * rebuilt each call and never retained (the UI holds the edited field values and
 * hands them back to the send step), matching session.ts's "state re-resolved
 * every time" discipline. Fees are prefilled from `ChainClient.getGasPrice`:
 * `maxPriorityFeePerGas` = the 1 gwei floor,
 * `maxFeePerGas` = the legacy gas price — concrete and overridable. `gasLimit` is
 * the well-known 21000 for a native send, else the simulate estimate ×1.2 (left
 * undefined — "auto" — when the simulate could not estimate).
 */
export type PreparedSend =
  | {
      readonly ok: true;
      readonly vm: "evm";
      /** "raw" = a hand-authored calldata call (raw-call mode), not a transfer. */
      readonly type: "native" | "token" | "raw";
      readonly chainId: number;
      /** The SENDING address (the signer), for the review's From line. */
      readonly from: string;
      /** The network's native-coin symbol (ETH / BNB / …), so fee lines on a
       * token send are labelled in the gas coin, not the token. */
      readonly nativeSymbol: string;
      /** The sender's native-coin balance (for remaining-after); undefined if the
       * balance read failed — the review degrades to no "after" line, never fails. */
      readonly nativeBalance?: bigint;
      /** The sender's token balance for a token send (same non-fatal contract). */
      readonly tokenBalance?: bigint;
      readonly to: string;
      readonly value: bigint;
      readonly data: string;
      readonly nonce: number;
      readonly gasLimit?: bigint;
      readonly maxFeePerGas: bigint;
      readonly maxPriorityFeePerGas: bigint;
      readonly simulation: SendSimulation;
      readonly destination: SendDestination;
    }
  | {
      readonly ok: true;
      readonly vm: "svm";
      readonly type: "native" | "token";
      /** The cluster's chain id (distinguishes devnet / testnet / mainnet). */
      readonly chainId: number;
      readonly from: string;
      readonly nativeSymbol: string;
      readonly nativeBalance?: bigint;
      readonly tokenBalance?: bigint;
      readonly recipient: string;
      readonly amount: bigint;
      readonly instructionCount: number;
      readonly recentBlockhash: string;
      readonly simulation: SendSimulation;
      readonly destination: SendDestination;
    }
  | LowerFailure;

/** Read the sender's native (and, for a token send, token) balance — NON-FATAL:
 * a failed read returns undefined so the review still renders (it just drops the
 * remaining-after line) rather than failing the whole prepare. */
async function readSendBalances(
  client: ChainClient,
  from: string,
  token: string | undefined,
): Promise<{ readonly native?: bigint; readonly token?: bigint }> {
  let native: bigint | undefined;
  let tokenBal: bigint | undefined;
  try {
    native = await client.readBalance(from);
  } catch {
    // Leave undefined; the review shows no "after" line.
  }
  if (token !== undefined) {
    try {
      tokenBal = await client.readBalance(from, token);
    } catch {
      // Same: non-fatal.
    }
  }
  return { native, token: tokenBal };
}

/** The ERC-20 contract / SPL mint to read a token balance against, from the
 * intent's asset ref — only when it carries a concrete address (a `{symbol}`
 * fallback has no address to read). */
function assetToken(asset: SendIntent["asset"]): string | undefined {
  return asset !== undefined && "address" in asset ? asset.address : undefined;
}

function summarizeSim(sim: SimulationResult): SendSimulation {
  return { success: sim.success, error: sim.error, gasUsed: sim.gasUsed, computeUnits: sim.computeUnitsConsumed };
}

function summarizeDestination(report: DestinationReport): SendDestination {
  return { action: report.action, code: report.code, warnings: report.warnings.map((w) => w.detail), rpcChecked: report.rpcChecked };
}

export async function prepareSend(intent: SendIntent): Promise<PreparedSend> {
  const address = senderAddress(intent.accountSlug, intent.walletId, intent.vm);
  if (address === undefined) return { ok: false, reason: "That wallet is unavailable.", overridable: false };
  // RAW-CALL mode (EVM only): build the tx straight from to/value/data, skipping
  // the transfer lowering (and its offline refuse-tier throw). The destination
  // screen still runs but is advisory — the UI does not block on it in raw mode.
  if (intent.vm === "evm" && intent.raw !== undefined) return prepareRawEvm(address, intent, intent.raw.data);
  const lowered = lowerTransfer(address, intent);
  if (!lowered.ok) return lowered;
  const payload = lowered.payload;
  const type = inferType(payload);
  const screenReq: TransferRequest = { to: intent.to, asset: intent.asset, amount: intent.amount };
  if (payload.vm === "svm") {
    // SVM: prefill the recent blockhash (so the review is concrete and sign stays
    // offline); the compute budget auto-defaults. No gas/nonce — the review shows
    // the blockhash + simulate + destination.
    try {
      const client = new ChainClient(address.network);
      const { blockhash } = await client.getRecentBlockhash();
      const tx = address.buildTransaction({
        recipient: payload.recipient,
        amount: payload.amount,
        instructions: payload.instructions,
        recentBlockhash: blockhash,
      });
      const sim = await tx.simulate();
      const report = await address.checkDestination(screenReq);
      const balances = await readSendBalances(client, String(address.publicKey), assetToken(intent.asset));
      return {
        ok: true,
        vm: "svm",
        type,
        chainId: Number(address.network.chainId),
        from: String(address.publicKey),
        nativeSymbol: String(address.network.nativeCurrency.symbol),
        nativeBalance: balances.native,
        tokenBalance: balances.token,
        recipient: payload.recipient,
        amount: payload.amount,
        instructionCount: payload.instructions?.length ?? 0,
        recentBlockhash: blockhash,
        simulation: summarizeSim(sim),
        destination: summarizeDestination(report),
      };
    } catch (error) {
      return { ok: false, reason: safeMessage(error), code: errorCode(error), overridable: false };
    }
  }
  try {
    const network = address.network;
    const client = new ChainClient(network);
    const chainId = Number(network.chainId);
    const nonce = await client.getTransactionCount(String(address.publicKey), "pending");
    const gasPrice = await client.getGasPrice();
    const maxPriorityFeePerGas = TIP_FLOOR_WEI;
    // Legacy gas price as the 1559 ceiling, floored at the tip so the caps never
    // invert (the library rejects maxPriorityFeePerGas > maxFeePerGas). Both are
    // overridable in the review.
    //
    // ⚠️ LIMITATION I (EIP-1559 base-fee prefill): the canonical 1559 ceiling is
    // `baseFee × 2 + tip`, which absorbs a base-fee that doubles before the tx is
    // mined. We instead seed `maxFeePerGas` from the LEGACY `eth_gasPrice`
    // because `ChainClient` exposes no `baseFee` / `feeHistory`
    // accessor to read the pending block's base fee. `eth_gasPrice` already tracks
    // the base fee on a 1559 node (it reports ≈ baseFee + a tip), so the seed is
    // safe on a calm chain; the risk is a chain whose base fee SPIKES between
    // prefill and mining, where this cap can be too low and the tx sits pending
    // until the base fee recedes. Mitigation: the cap is editable on the review —
    // the user can raise "Max fee" before sending.
    // 🔄 The current library LIFTS this limitation: omit `maxFeePerGas` and it autofills
    // the canonical `baseFee × 2 + tip`, and `EvmTxBuildParams.maxFeePerGasCeiling`
    // adds an RPC-independent fee-drain cap on top (a caller-supplied fee is used
    // verbatim and never re-capped, so the ceiling only bites the autofill). Adopting
    // it means DROPPING this explicit legacy-gasPrice prefill — a change to the fee a
    // LIVE tx pays, so it is deferred; not exercised here.
    const maxFeePerGas = gasPrice > maxPriorityFeePerGas ? gasPrice : maxPriorityFeePerGas;
    // ⚠️ LIMITATION O (type-2 only): we always build an EIP-1559 (type-2) tx.
    // `ChainClient` / the address expose no per-network "1559-capable" flag, and
    // every built-in network (Ethereum + its testnets, the EVM L2s) is 1559. A
    // legacy-only EVM chain (no EIP-1559) added as a CUSTOM network is therefore
    // unsupported by this flow — the node would reject a type-2 tx. Supporting one
    // needs a capability probe (or a per-network legacy flag) to fall back to a
    // type-0 `gasPrice` tx; out of scope while only 1559 networks are reachable.
    const tx = address.buildTransaction({
      to: payload.to,
      value: payload.value,
      data: payload.data,
      // chainId is taken from the sender address's own network (the doc's
      // build-from-address path), so it is not passed here.
      type: 2,
      nonce,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });
    const sim = await tx.simulate();
    // 🚨 A native transfer to a brand-NEW account costs well over the 21000
    // intrinsic (measured on Sepolia: a new-account send estimates ~207k gas and
    // a hardcoded 21000 ran OUT OF GAS on-chain, status 0). So native no longer
    // pins to 21000 — it takes the simulate estimate when that exceeds the 21000
    // floor (the estimate is exact for a value transfer, so no ×1.2 buffer; that
    // also keeps a normal same-account send at 21000). A token keeps the ×1.2
    // estimate (its gas varies), falling back to "auto" when it cannot estimate.
    const estimated = sim.success && sim.gasUsed !== undefined ? sim.gasUsed : undefined;
    const gasLimit = type === "native" ? (estimated !== undefined && estimated > 21_000n ? estimated : 21_000n) : estimated !== undefined ? (estimated * 6n) / 5n : undefined;
    const report = await address.checkDestination(screenReq);
    const balances = await readSendBalances(client, String(address.publicKey), assetToken(intent.asset));
    return {
      ok: true,
      vm: "evm",
      type,
      chainId,
      from: String(address.publicKey),
      nativeSymbol: String(network.nativeCurrency.symbol),
      nativeBalance: balances.native,
      tokenBalance: balances.token,
      to: payload.to,
      value: payload.value,
      data: payload.data,
      nonce,
      gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas,
      simulation: summarizeSim(sim),
      destination: summarizeDestination(report),
    };
  } catch (error) {
    return { ok: false, reason: safeMessage(error), code: errorCode(error), overridable: false };
  }
}

/**
 * Prepare a RAW-CALL EVM review: the tx is built from the explicit to/value/data
 * (no transfer payload), simulated, and fee/nonce-prefilled exactly like a
 * transfer. The destination screen is run for information but is ADVISORY — it is
 * wrapped non-fatally so a refuse-tier `to` (which the transfer path would refuse
 * offline) still prepares, since raw mode is the deliberate way to call one.
 */
async function prepareRawEvm(address: Address, intent: SendIntent, data: string): Promise<PreparedSend> {
  if (!isHexData(data)) return { ok: false, reason: "Data must be 0x-prefixed hex with an even number of digits.", code: "PARAMETER_ERROR", overridable: false };
  try {
    const network = address.network;
    const client = new ChainClient(network);
    const chainId = Number(network.chainId);
    const nonce = await client.getTransactionCount(String(address.publicKey), "pending");
    const gasPrice = await client.getGasPrice();
    const maxPriorityFeePerGas = TIP_FLOOR_WEI;
    const maxFeePerGas = gasPrice > maxPriorityFeePerGas ? gasPrice : maxPriorityFeePerGas;
    const tx = address.buildTransaction({ to: intent.to, value: intent.amount, data, type: 2, nonce, maxFeePerGas, maxPriorityFeePerGas });
    const sim = await tx.simulate();
    // estimate ×1.2 (a raw call's gas varies), but never below the 21000 intrinsic
    // — a node can estimate under 21000 (measured on Sepolia for an existing-
    // account value transfer), and a sub-intrinsic gas limit is rejected outright.
    const estimated = sim.success && sim.gasUsed !== undefined ? (sim.gasUsed * 6n) / 5n : undefined;
    const gasLimit = estimated === undefined ? undefined : estimated > 21_000n ? estimated : 21_000n;
    // Advisory + non-fatal: a raw call may legitimately target an address the
    // transfer screen would refuse, so a screen failure degrades to "unscreened"
    // rather than failing the prepare.
    let destination: SendDestination;
    try {
      destination = summarizeDestination(await address.checkDestination({ to: intent.to, amount: intent.amount }));
    } catch {
      destination = { action: "warn", warnings: ["Raw call — destination not screened."], rpcChecked: false };
    }
    const balances = await readSendBalances(client, String(address.publicKey), undefined);
    return {
      ok: true,
      vm: "evm",
      type: "raw",
      chainId,
      from: String(address.publicKey),
      nativeSymbol: String(network.nativeCurrency.symbol),
      nativeBalance: balances.native,
      tokenBalance: undefined,
      to: intent.to,
      value: intent.amount,
      data,
      nonce,
      gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas,
      simulation: summarizeSim(sim),
      destination,
    };
  } catch (error) {
    return { ok: false, reason: safeMessage(error), code: errorCode(error), overridable: false };
  }
}

/** What the MAX affordance needs: the sender, and (for a native send) the fee
 * fields currently in the review, so the gas reserved is THIS tx's gas. */
export interface MaxSendableParams {
  readonly accountSlug: string;
  readonly walletId: number;
  readonly vm: "evm" | "svm";
  /** ERC-20 contract / SPL mint. Omitted = the native coin. */
  readonly token?: string;
  /** EVM native only: the recipient, so the real gas can be ESTIMATED (a send to
   * a brand-new account costs well over 21000). Omitted ⇒ the 21000 fallback. */
  readonly to?: string;
  /** EVM native only: the review's current cap (defaults to the live gas price). */
  readonly maxFeePerGas?: bigint;
  /** EVM native only: an explicit gas limit (the review's edited value) that wins
   * over the estimate; absent ⇒ estimate for `to`, else 21000. */
  readonly gasLimit?: bigint;
}

export type MaxSendable = { readonly ok: true; readonly amount: bigint } | { readonly ok: false; readonly reason: string };

/**
 * The MAX-sendable amount in raw base units. A
 * **token** send spends none of the native balance, so MAX is the FULL token
 * balance. A **native** send must leave THIS tx's gas behind, so MAX is
 * `balance − gasLimit×maxFeePerGas`, floored at 0 (and reported as insufficient
 * when the balance cannot even cover the gas). The native case reads the CURRENT
 * (possibly user-overridden) fee fields, so the button must recompute on press,
 * not reuse a prepare-time value.
 */
export async function maxSendable(params: MaxSendableParams): Promise<MaxSendable> {
  const address = senderAddress(params.accountSlug, params.walletId, params.vm);
  if (address === undefined) return { ok: false, reason: "That wallet is unavailable." };
  try {
    const client = new ChainClient(address.network);
    const from = String(address.publicKey);
    if (params.token !== undefined) {
      return { ok: true, amount: await client.readBalance(from, params.token) };
    }
    if (params.vm === "svm") {
      // Native SOL: reserve the standard per-signature fee (5000 lamports).
      const balance = await client.readBalance(from);
      return { ok: true, amount: balance > SVM_FEE_LAMPORTS ? balance - SVM_FEE_LAMPORTS : 0n };
    }
    const balance = await client.readBalance(from);
    // The fee cap: a supplied override verbatim, else the legacy gas price floored
    // at the 1 gwei tip (prepareSend's cap). Without the floor, on a chain whose
    // gas price is below 1 gwei (e.g. Sepolia) MAX would under-reserve and fail.
    let maxFeePerGas = params.maxFeePerGas;
    if (maxFeePerGas === undefined) {
      const gasPrice = await client.getGasPrice();
      maxFeePerGas = gasPrice > TIP_FLOOR_WEI ? gasPrice : TIP_FLOOR_WEI;
    }
    // 🚨 Reserve THIS tx's REAL gas, not a flat 21000. An explicit override (the
    // review's edited limit) wins; otherwise estimate for the ACTUAL recipient —
    // a native transfer to a brand-NEW account costs well above the 21000
    // intrinsic (measured ~207k on Sepolia), and a flat 21000 made MAX reserve
    // far too little, so the send was rejected at admission. Floored at 21000; a
    // failed estimate degrades to it (the review's own prepare still surfaces a
    // too-low reserve as an insufficient "After").
    let gasLimit = params.gasLimit;
    if (gasLimit === undefined) {
      gasLimit = 21_000n;
      if (params.to !== undefined) {
        try {
          const tx = address.buildTransaction({ to: params.to, value: 1n, data: "0x", type: 2, maxFeePerGas, maxPriorityFeePerGas: TIP_FLOOR_WEI });
          const sim = await tx.simulate();
          if (sim.success && sim.gasUsed !== undefined && sim.gasUsed > gasLimit) gasLimit = sim.gasUsed;
        } catch {
          // keep the 21000 fallback
        }
      }
    }
    const gas = gasLimit * maxFeePerGas;
    return { ok: true, amount: balance > gas ? balance - gas : 0n };
  } catch (error) {
    return { ok: false, reason: safeMessage(error) };
  }
}

/**
 * The review's final fee fields, handed back to the send. These come from the
 * prefilled review model (and any user override). 🚨 A SUPPLIED `nonce` is used
 * verbatim, which opts out of the library's per-(chain,sender) anti-collision
 * watermark — so a wallet's prepared send must be confirmed or discarded before
 * another is prepared for the same wallet (concurrent same-wallet prepares could
 * collide on one nonce; this degrades safely to a failed/timeout terminal, never
 * a double-pay). An omitted `gasLimit` (the token-"auto" case) is filled by the
 * library at sign via an `eth_estimateGas` round-trip — so signing is offline
 * only when every field, gasLimit included, is supplied.
 */
export interface SendOverrides {
  readonly nonce?: number;
  readonly gasLimit?: bigint;
  readonly maxFeePerGas?: bigint;
  readonly maxPriorityFeePerGas?: bigint;
}

/** A confirmed receipt as plain data (no library handle). */
export interface SendReceipt {
  readonly hash: string;
  readonly blockNumber: number | null;
  readonly success: boolean;
  readonly gasUsed?: bigint;
  readonly fee?: bigint;
}

/**
 * The terminal outcome of a send. On failure, `safeToResend` encodes the 🚨
 * resend rule: `failed`/`dropped` never landed (safe to rebuild); `timeout` is a
 * broadcast of unknown outcome (NOT safe — look up `hash` first); `aborted`
 * asserts nothing.
 */
export type SendOutcome =
  | { readonly ok: true; readonly status: TransactionStatus; readonly hash: string; readonly receipt: SendReceipt }
  | { readonly ok: false; readonly status: TransactionStatus | "unsent"; readonly reason: string; readonly hash: string | null; readonly safeToResend: boolean };

/** Streams each status transition to the UI (broadcast+track). */
export type SendProgress = (status: TransactionStatus) => void;

/**
 * Sign, broadcast, and track a send. 🚨 It takes the same `SendIntent` that was
 * previewed/prepared (NOT raw to/value/data) and RE-LOWERS it, so the recipient
 * that was destination-screened is, by construction, the recipient that is
 * broadcast — `confirmSend` cannot be handed a target different from what the
 * review screened, and the offline refuse-tier gate runs once more here as a
 * final structural backstop. Fee/nonce come from `overrides` (the review's
 * prefilled-and-editable values; for SVM the compute budget auto-defaults and the
 * recent blockhash is fetched at sign). Progress streams through `onProgress`;
 * the tx and tracker handles never escape.
 *
 * ⚠️ LIMITATION R (no app-level track cancel WIRED): once broadcast, confirmSend
 * awaits the library's `TransactionTracker.whenConfirmed()`. The tracker CAN be
 * aborted — 🔄 MEASURED on 2.5.7: `tracker.abort()` transitions status → `aborted`
 * and rejects `whenConfirmed()` with "Transaction observation aborted by the
 * caller" (this is NOT the BALANCE `Settling.abort()`, which is a measured no-op —
 * do not conflate the two distinct `Settling`s). But this flow does NOT wire a
 * cancel: it just awaits. And even a wired abort only stops WATCHING — it cannot
 * recall the broadcast (no chain can), so an aborted-but-maybe-landed tx carries
 * the same resend hazard as a `timeout` status: the UI reports `safeToResend:
 * false` (🚨 the tx may still land, so a naive resend could double-spend — see the
 * timeout-vs-failed rule). An in-app "cancel" would therefore be a stop-watching
 * affordance, not a true cancel; that part is inherent, not a gap this flow can close.
 */
export async function confirmSend(
  intent: SendIntent,
  overrides: SendOverrides = {},
  onProgress?: SendProgress,
): Promise<SendOutcome> {
  const address = senderAddress(intent.accountSlug, intent.walletId, intent.vm);
  if (address === undefined) return { ok: false, status: "unsent", reason: "That wallet is unavailable.", hash: null, safeToResend: false };

  // RAW-CALL mode (EVM only): sign the explicit to/value/data directly. No
  // re-lower, so the transfer-only refuse gate never runs — raw mode is the
  // deliberate way to call an address the transfer path would refuse.
  const rawData = intent.vm === "evm" ? intent.raw?.data : undefined;

  let tx: EvmTransaction | SvmTransaction;
  if (rawData !== undefined) {
    if (!isHexData(rawData)) return { ok: false, status: "unsent", reason: "Data must be 0x-prefixed hex.", hash: null, safeToResend: false };
    try {
      tx = address.buildTransaction({
        to: intent.to,
        value: intent.amount,
        data: rawData,
        type: 2,
        nonce: overrides.nonce,
        gasLimit: overrides.gasLimit,
        maxFeePerGas: overrides.maxFeePerGas,
        maxPriorityFeePerGas: overrides.maxPriorityFeePerGas,
      });
    } catch (error) {
      return { ok: false, status: "unsent", reason: safeMessage(error), hash: null, safeToResend: false };
    }
  } else {
    // Re-lower the intent: re-runs the offline refuse-tier destination gate on the
    // TRUE recipient and re-derives the exact payload that will be signed.
    const lowered = lowerTransfer(address, intent);
    if (!lowered.ok) return { ok: false, status: "unsent", reason: lowered.reason, hash: null, safeToResend: false };
    const payload = lowered.payload;
    try {
      tx =
        payload.vm === "evm"
          ? address.buildTransaction({
              to: payload.to,
              value: payload.value,
              data: payload.data,
              type: 2,
              nonce: overrides.nonce,
              gasLimit: overrides.gasLimit,
              maxFeePerGas: overrides.maxFeePerGas,
              maxPriorityFeePerGas: overrides.maxPriorityFeePerGas,
            })
          : // SVM: the EVM fee overrides don't apply; the compute budget auto-
            // defaults and the recent blockhash is fetched at sign.
            address.buildTransaction({ recipient: payload.recipient, amount: payload.amount, instructions: payload.instructions });
    } catch (error) {
      return { ok: false, status: "unsent", reason: safeMessage(error), hash: null, safeToResend: false };
    }
  }

  let tracker: TransactionTracker;
  let off: () => void = () => {};
  try {
    // 🚨 `send()` signs + broadcasts and `on()` subscribes — the one region
    // between the two guarded blocks. A SYNCHRONOUS throw here must not escape:
    // the only caller is a `.catch`-less `void confirmSend(…).then(…)` (a
    // consumer's send/sign UI), so a rejection would reach the process-wide
    // `unhandledRejection` handler (armed in `bootstrap`) → `bail` → `panicLock`
    // + `process.exit(1)` mid-broadcast — a crash at the
    // worst possible moment. Degrade to the same `unsent` outcome the build guard
    // returns; an unbroadcast throw never landed, so it is NOT safe to blind-resend.
    tracker = tx.send();
    off = onProgress ? tracker.on("change", (change) => onProgress(change.next)) : () => {};
  } catch (error) {
    return { ok: false, status: "unsent", reason: safeMessage(error), hash: null, safeToResend: false };
  }
  try {
    const receipt = await tracker.whenConfirmed();
    off();
    return {
      ok: true,
      status: tracker.status,
      hash: receipt.hash,
      receipt: { hash: receipt.hash, blockNumber: receipt.blockNumber, success: receipt.success, gasUsed: receipt.gasUsed, fee: receipt.fee },
    };
  } catch (error) {
    off();
    const status = tracker.status;
    return {
      ok: false,
      status,
      reason: safeMessage(error),
      // `tracker.hash` is null on an unacknowledged broadcast; the signed id on
      // the tx still lets the user look a possible `timeout` up before resending.
      hash: tracker.hash ?? tx.hash,
      safeToResend: status === "failed" || status === "dropped",
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sign — the sign-with-any-address utility. Message signing is OFFLINE
// and synchronous (no RPC), so these resolve the signer the same handle-free way
// `senderAddress` does and return plain data only — never a signer handle.
// ─────────────────────────────────────────────────────────────────────────────

/** The signing standard a request uses. `message` is personal_sign (EVM) /
 * ed25519 (SVM); `typedData` is EIP-712; `siwe` is Sign-In With Ethereum. The
 * last two are EVM-only. */
export type SignKind = "message" | "typedData" | "siwe";

/** A plain signing result (no handle). `details` carries the standard's extra
 * fields for the review (the message hash, or the SIWE message that was signed). */
export type SignOutcome =
  | { readonly ok: true; readonly signature: string; readonly details?: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly reason: string };

/** The fields the SIWE sign-in collects. `nonce` is REQUIRED — the library
 * refuses to invent it (it must be a server-generated value, for replay
 * protection); address / chainId auto-fill from the signer. `statement` is the
 * optional EIP-4361 human-readable assertion. `issuedAt` is normally auto-filled
 * by the library at sign time, but the pre-sign review freezes it (so the
 * reviewed message and the signed message carry the SAME timestamp) and threads
 * it back here. */
export interface SiweFields {
  readonly domain: string;
  readonly uri: string;
  readonly nonce: string;
  readonly statement?: string;
  readonly issuedAt?: string;
}

/**
 * Sign a plain message with any wallet: EIP-191 `personal_sign` on EVM, raw
 * ed25519 on SVM. Offline. A disabled wallet is refused by `senderAddress`.
 */
export function signMessage(accountSlug: string, walletId: number, vm: "evm" | "svm", message: string): SignOutcome {
  const address = senderAddress(accountSlug, walletId, vm);
  if (address === undefined) return { ok: false, reason: "That wallet is unavailable." };
  try {
    const { signature, messageHash } = address.signMessageEncoded(message, vm === "svm" ? "ed25519" : "personal_sign");
    return { ok: true, signature, details: { messageHash } };
  } catch (error) {
    return { ok: false, reason: safeMessage(error) };
  }
}

/** The EIP-712 `domain.chainId` as an integer, or `undefined` when the domain
 * omits it. Per the 2.5.4 contract it may be a `number`, a `bigint`, or a numeric
 * string (`"1"` from a JSON-decoded or viem-built domain); all compare as
 * integers. A present-but-non-numeric value is treated as absent so the library's
 * own domain validation surfaces the error rather than a `NaN` cross-check. */
function readDomainChainId(typedData: unknown): number | undefined {
  if (typeof typedData !== "object" || typedData === null) return undefined;
  const domain = (typedData as { readonly domain?: unknown }).domain;
  if (typeof domain !== "object" || domain === null) return undefined;
  const raw = (domain as { readonly chainId?: unknown }).chainId;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "bigint") return Number(raw);
  if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) return Number(raw);
  return undefined;
}

/**
 * Sign EIP-712 typed data (EVM only) with any wallet. The `typedData` is the raw
 * JSON the user supplies.
 *
 * 🚨 The chainId passed to the library is the DOMAIN's, not the signer's network.
 * Per the 2.5.4 contract (`wallets-addresses/signing.mdx`) the `chainId` arg is
 * CROSS-CHECKED against `domain.chainId` (a mismatch throws `PARAMETER_ERROR`) and
 * the domain separator is ALWAYS computed from the domain object — so the arg never
 * selects the chain, it only asserts agreement. Passing the signer's chainId
 * therefore made EIP-712 signing throw for any chain ≠ the wallet's own network
 * (e.g. a dapp payload for an L2 the same wallet spans). When the domain omits
 * chainId the payload is chain-agnostic and the arg is not cross-checked, so the
 * signer's network chainId is a harmless fallback that never enters the separator.
 */
export function signTypedData(accountSlug: string, walletId: number, typedDataJson: string): SignOutcome {
  const address = senderAddress(accountSlug, walletId, "evm");
  if (address === undefined) return { ok: false, reason: "That wallet is unavailable." };
  let typedData: unknown;
  try {
    typedData = JSON.parse(typedDataJson);
  } catch {
    return { ok: false, reason: "The typed data must be valid JSON." };
  }
  try {
    const domainChainId = readDomainChainId(typedData);
    const chainId = domainChainId ?? Number(address.network.chainId);
    const { signature, domainSeparator, structHash } = address.signTypedData(typedData, chainId);
    // Echo the decoded domain + primary type so the review shows WHAT was signed,
    // not only opaque hashes (EIP-712's whole point is human-readable signing).
    const td = typedData as { readonly domain?: { readonly name?: unknown }; readonly primaryType?: unknown };
    const domainName = typeof td.domain?.name === "string" ? td.domain.name : "(unnamed)";
    const primaryType = typeof td.primaryType === "string" ? td.primaryType : "(?)";
    // State the chain the signature is BOUND to — the domain's, or "chain-agnostic"
    // when the domain carries none — so the review never claims a chain the domain
    // separator does not actually include.
    const chainLabel = domainChainId === undefined ? "chain-agnostic" : `chainId ${domainChainId}`;
    return { ok: true, signature, details: { type: primaryType, domain: `${domainName} (${chainLabel})`, domainSeparator, structHash } };
  } catch (error) {
    return { ok: false, reason: safeMessage(error) };
  }
}

/**
 * Sign a SIWE (Sign-In With Ethereum) message (EVM only). The library composes
 * the canonical message from the fields (filling address / chainId / nonce /
 * issuedAt from the signer) and returns both the message and its signature.
 */
export function signIn(accountSlug: string, walletId: number, fields: SiweFields): SignOutcome {
  const address = senderAddress(accountSlug, walletId, "evm");
  if (address === undefined) return { ok: false, reason: "That wallet is unavailable." };
  try {
    // `issuedAt` passed through ONLY when the review froze it, so the signed
    // message matches the one previewed; otherwise the library fills it.
    const { message, signature } = address.signIn({
      domain: fields.domain,
      uri: fields.uri,
      nonce: fields.nonce,
      statement: fields.statement,
      issuedAt: fields.issuedAt,
    });
    return { ok: true, signature, details: { message } };
  } catch (error) {
    return { ok: false, reason: safeMessage(error) };
  }
}

/** The pre-sign review of a SIWE message. */
export type SiwePreview =
  | { readonly ok: true; readonly message: string; readonly issuedAt: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Reconstruct the EIP-4361 message a SIWE sign-in will produce, WITHOUT signing
 * it, so the user can review the exact message before confirming.
 *
 * 🚨 **The reconstruction's shape is pinned, not guessed.** The library builds
 * AND signs in one call (`signIn` returns `{message, signature}` together, with no
 * *exported* message-only builder), so a preview can only be a reconstruction.
 * `buildSiweMessage` below produces the canonical EIP-4361 body, and its exact
 * byte layout — with and without a statement (the blank-line case) — is pinned by
 * a unit test; a consuming app additionally checks it byte-equals the library's
 * live `signIn().message`, which needs a signer. The one time-dependent field is
 * frozen here and threaded into the sign (`issuedAt`), so the reviewed message and
 * the signed message cannot drift on the timestamp.
 * (A consumer may width-repair this message for DISPLAY, so the painted copy
 * may differ from these raw bytes for non-ASCII; that is honest, not a drift.)
 */
export function previewSignIn(accountSlug: string, walletId: number, fields: SiweFields): SiwePreview {
  const address = senderAddress(accountSlug, walletId, "evm");
  if (address === undefined) return { ok: false, reason: "That wallet is unavailable." };
  const issuedAt = fields.issuedAt ?? new Date().toISOString();
  try {
    const message = buildSiweMessage({
      domain: fields.domain,
      address: String(address.publicKey),
      statement: fields.statement,
      uri: fields.uri,
      version: "1",
      chainId: Number(address.network.chainId),
      nonce: fields.nonce,
      issuedAt,
    });
    return { ok: true, message, issuedAt };
  } catch (error) {
    return { ok: false, reason: safeMessage(error) };
  }
}

/**
 * The EIP-4361 message body, reconstructed field-by-field. Exported so its exact
 * byte layout can be pinned by a test — do not edit the shape without re-running
 * it, since that byte-for-byte fidelity is the only thing that makes a preview
 * safe to show as "what you are signing".
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
  const lines: string[] = [
    `${p.domain} wants you to sign in with your Ethereum account:`,
    p.address,
    "",
  ];
  if (p.statement !== undefined && p.statement !== "") lines.push(p.statement);
  lines.push("");
  lines.push(`URI: ${p.uri}`);
  lines.push(`Version: ${p.version}`);
  lines.push(`Chain ID: ${p.chainId}`);
  lines.push(`Nonce: ${p.nonce}`);
  lines.push(`Issued At: ${p.issuedAt}`);
  return lines.join("\n");
}

// ── EXPORT PRIVATE KEY ──────────────────────────────────────────────────────

/**
 * The result of a key export. On success the plaintext `privateKey` is handed
 * back ONCE for the UI to paint and then drop — it is never logged, stored, put
 * on navigation state, or returned anywhere else.
 */
export type ExportOutcome =
  | { readonly ok: true; readonly privateKey: string }
  | { readonly ok: false; readonly reason: "wrong-password" | "unavailable" };

/**
 * Export a wallet's private key for one VM, behind a password re-check.
 *
 * 🚨 **Re-auth even though the account is already session-unlocked.** A
 * shared-password account stays unlocked for the whole session and an
 * own-password account is unlocked the moment you enter it, so without this a
 * key would reveal with no fresh check at an unattended terminal. `checkPassword`
 * verifies the password that gates THIS account's keys — its own for an
 * own-password account, the workspace's for a shared one (the account knows
 * which) — and does so with no lock/unlock side effect, in either state. A wrong
 * password is reported, not thrown.
 *
 * 🚨 **The plaintext key never persists here.** `dumpPrivateKey` returns a fresh
 * string; it is handed straight back and this function keeps no reference. The
 * caller paints it and drops it. No `console`, no sink, no navigation state.
 */
export async function exportPrivateKey(
  accountSlug: string,
  walletId: number,
  vm: "evm" | "svm",
  password: string,
): Promise<ExportOutcome> {
  const ws = vault;
  if (ws === undefined || ws.closed || ws.locked) return { ok: false, reason: "unavailable" };
  const account = ws.accounts.bySlug(accountSlug as never) ?? undefined;
  if (account === undefined) return { ok: false, reason: "unavailable" };
  let verified = false;
  try {
    verified = await account.checkPassword(password);
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (!verified) return { ok: false, reason: "wrong-password" };
  const wallet = account.wallets.byId(walletId) ?? undefined;
  if (wallet === undefined) return { ok: false, reason: "unavailable" };
  try {
    return { ok: true, privateKey: wallet.dumpPrivateKey(vm) };
  } catch {
    // A VM the wallet has no address on, or a locked wallet — surfaced, not thrown.
    return { ok: false, reason: "unavailable" };
  }
}

/**
 * Test-only reset, so one file can exercise several workspaces.
 *
 * Not a general "close everything": it exists because `refuseSecondWorkspace`
 * is process-wide by design, and a test file legitimately needs more than one
 * container over its lifetime.
 */
export async function resetForTests(): Promise<void> {
  await close();
  // Reset the provider-pin bookkeeping too, so a test that exercises the v2
  // fallback cannot leak its envelope/flags into the next test in the file.
  activeEnvelope = "v3";
  fellBackToV2 = false;
  v2Reason = undefined;
}
