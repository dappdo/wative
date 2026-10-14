/**
 * A viewport-aware, cancellable, caching balance-loading store — the PORTABLE
 * (dual-env) balance specialisation of the generic `createViewportStore`
 * scheduler. The per-wallet `read` is REQUIRED and injected, so this module has
 * NO wative-core RUNTIME dependency (only a type-only import, erased under
 * `verbatimModuleSyntax`) and therefore runs in a browser.
 *
 * `wative/browser/balances` exposes this factory; the Node convenience that
 * supplies the default RPC reader from a workspace slug is `wative/node/balances`
 * (`core/nodeBalanceStore.ts`), a thin wrapper over this one.
 *
 * It is UI-free: the consumer subscribes and renders from `snapshot()`/`get()`.
 */
import type { WalletBalances } from "./session.js";
import { createViewportStore, type ViewportEntry, type ViewportStatus } from "./viewportStore.js";

/** One wallet's per-asset balances (the library's `ready` map). */
export type AssetBalances = Extract<WalletBalances, { kind: "ready" }>["byAsset"];

/** The five lifecycle states of one wallet's balance read:
 * `unstarted` | `queued` | `loading` | `loaded` (carries `byAsset`) | `failed`. */
export type BalanceStatus = ViewportStatus;

/** One wallet's store entry. `byAsset` is present iff `status === "loaded"`. */
export type BalanceEntry =
  | { readonly status: Exclude<BalanceStatus, "loaded"> }
  | { readonly status: "loaded"; readonly byAsset: AssetBalances };

/** The per-wallet read the store schedules. Resolves `ready`/`error`; MUST reject
 * when `signal` aborts (so the store can tell a cancellation from a failure).
 * Injectable so the scheduler is testable, and so a browser supplies its own. */
export type BalanceReader = (walletId: number, signal: AbortSignal) => Promise<Extract<WalletBalances, { kind: "ready" | "error" }>>;

export interface BalanceStoreOptions {
  /** The per-wallet read (REQUIRED — this portable factory supplies no default). */
  readonly read: BalanceReader;
  /** Wallets read per batch (default 5). */
  readonly batchSize?: number;
  /** Delay between batches, ms (default 250). */
  readonly batchDelayMs?: number;
  /** Override the inter-batch delay (tests). */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface BalanceStore {
  /** Declare the wallets currently visible, in display order. */
  setViewport(visibleIds: readonly number[], opts?: { readonly anchor?: number; readonly direction?: "up" | "down" }): void;
  /** Force a re-read of `ids`. */
  refresh(ids: readonly number[]): void;
  /** This wallet's entry (`{ status: "unstarted" }` if never seen). */
  get(walletId: number): BalanceEntry;
  /** A stable snapshot of every tracked wallet (new reference only on change). */
  snapshot(): ReadonlyMap<number, BalanceEntry>;
  /** Subscribe to state changes; returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Abort every in-flight read and drop all listeners. */
  dispose(): void;
}

/** Map a generic viewport entry (payload `byAsset`) to the public `BalanceEntry`. */
function toBalanceEntry(entry: ViewportEntry<AssetBalances>): BalanceEntry {
  return entry.status === "loaded" ? { status: "loaded", byAsset: entry.value } : entry;
}

/** Create a balance store over an injected per-wallet `read`. Scheduling
 * (viewport/queue/batch/crawl/cancel/cache) is the shared `createViewportStore`. */
export function createBalanceStore(options: BalanceStoreOptions): BalanceStore {
  const balanceRead = options.read;
  const inner = createViewportStore<AssetBalances>({
    read: async (id, signal) => {
      const result = await balanceRead(id, signal);
      return result.kind === "ready" ? { kind: "loaded", value: result.byAsset } : { kind: "failed" };
    },
    batchSize: options.batchSize,
    batchDelayMs: options.batchDelayMs,
    sleep: options.sleep,
  });

  // Cache the remapped entry per SOURCE entry object, so `get()`/`snapshot()` return
  // a STABLE reference until the underlying entry changes. Without this, `get()`
  // minted a fresh object each call, breaking a consumer wiring
  // `useSyncExternalStore(subscribe, () => store.get(id))` per row (React's
  // "getSnapshot should be cached" infinite loop).
  const remapCache = new WeakMap<ViewportEntry<AssetBalances>, BalanceEntry>();
  const remap = (entry: ViewportEntry<AssetBalances>): BalanceEntry => {
    const cached = remapCache.get(entry);
    if (cached !== undefined) return cached;
    const mapped = toBalanceEntry(entry);
    remapCache.set(entry, mapped);
    return mapped;
  };

  // Keep a stable remapped snapshot keyed on the inner one, so `useSyncExternalStore`
  // still sees a new reference only when the state changed.
  let srcSnap: ReadonlyMap<number, ViewportEntry<AssetBalances>> | undefined;
  let outSnap: ReadonlyMap<number, BalanceEntry> | undefined;

  return {
    setViewport: (visibleIds, opts) => inner.setViewport(visibleIds, opts),
    refresh: (ids) => inner.refresh(ids),
    get: (walletId) => remap(inner.get(walletId)),
    snapshot: () => {
      const src = inner.snapshot();
      if (src === srcSnap && outSnap !== undefined) return outSnap;
      srcSnap = src;
      const mapped: ReadonlyMap<number, BalanceEntry> = new Map(Array.from(src, ([id, entry]) => [id, remap(entry)]));
      outSnap = mapped;
      return mapped;
    },
    subscribe: (listener) => inner.subscribe(listener),
    dispose: () => inner.dispose(),
  };
}
