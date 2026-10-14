/**
 * A viewport-aware, cancellable, caching balance-loading store — the balance
 * specialisation of the generic `createViewportStore` scheduler, reading each
 * wallet's DEFAULT-network balances. A consumer (a TUI grid, a headless crawler)
 * tells the store which wallets are visible; the store lazily loads just those,
 * in small batches with a delay between them, following the cursor, cancelling
 * reads for wallets that scroll away, and caching the results so re-entering the
 * viewport costs nothing.
 *
 * It is UI-free: the consumer subscribes and renders from `snapshot()`/`get()`.
 * The scheduler is tested via `test/balance-store.test.ts` (and the shared core
 * directly); the real network read is exercised by the consumer's integration
 * tests.
 */
import { readWalletBalances, type WalletBalances } from "./session.js";
import { createViewportStore, type ViewportEntry, type ViewportStatus } from "./viewportStore.js";

/** One wallet's per-asset balances (the library's `ready` map). */
export type AssetBalances = Extract<WalletBalances, { kind: "ready" }>["byAsset"];

/** The five lifecycle states of one wallet's balance read:
 * - `unstarted` — never queued (outside the viewport, or cancelled),
 * - `queued` — in the viewport, waiting for a batch slot,
 * - `loading` — a read is in flight,
 * - `loaded` — read succeeded; `byAsset` holds the balances (cached),
 * - `failed` — the read failed; terminal until an explicit `refresh` (cached). */
export type BalanceStatus = ViewportStatus;

/** One wallet's store entry. `byAsset` is present iff `status === "loaded"`. */
export type BalanceEntry =
  | { readonly status: Exclude<BalanceStatus, "loaded"> }
  | { readonly status: "loaded"; readonly byAsset: AssetBalances };

/** The per-wallet read the store schedules. Resolves `ready`/`error`; MUST reject
 * when `signal` aborts (the default, `readWalletBalances`, does). Injectable so
 * the scheduler can be tested with a fake reader. */
export type BalanceReader = (walletId: number, signal: AbortSignal) => Promise<Extract<WalletBalances, { kind: "ready" | "error" }>>;

export interface BalanceStoreOptions {
  /** Wallets read per batch (default 5). */
  readonly batchSize?: number;
  /** Delay between batches, ms (default 250). */
  readonly batchDelayMs?: number;
  /** Per-read timeout passed to the default reader, ms (default 12000). */
  readonly timeoutMs?: number;
  /** Override the per-wallet read (tests / alternative backends). */
  readonly read?: BalanceReader;
  /** Override the inter-batch delay (tests). */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface BalanceStore {
  /** Declare the wallets currently visible, in display order. Newly-visible
   * wallets that are not already loaded/failed are queued; wallets that left the
   * viewport are dequeued (`queued`) or have their in-flight read aborted
   * (`loading`); loaded/failed stay cached. `anchor` (the cursor's wallet id) and
   * `direction` steer the crawl order so the window follows the cursor. */
  setViewport(visibleIds: readonly number[], opts?: { readonly anchor?: number; readonly direction?: "up" | "down" }): void;
  /** Force a re-read of `ids`: clears their cache and re-queues the ones in the
   * viewport (others reset to `unstarted`). Powers an explicit refresh. */
  refresh(ids: readonly number[]): void;
  /** This wallet's entry (`{ status: "unstarted" }` if never seen). */
  get(walletId: number): BalanceEntry;
  /** A stable snapshot of every tracked wallet — a new reference only when the
   * state has changed since the last call (suitable for `useSyncExternalStore`). */
  snapshot(): ReadonlyMap<number, BalanceEntry>;
  /** Subscribe to state changes; returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Abort every in-flight read and drop all listeners. */
  dispose(): void;
}

/** Map a generic viewport entry (payload `byAsset`) to the public `BalanceEntry`
 * shape, so the `wative/balances` API keeps its `byAsset` field. */
function toBalanceEntry(entry: ViewportEntry<AssetBalances>): BalanceEntry {
  return entry.status === "loaded" ? { status: "loaded", byAsset: entry.value } : entry;
}

/** Create a balance store for one account `slug`. The default reader reads each
 * wallet's DEFAULT-network balances over RPC; the real network read is exercised
 * by the consumer's integration tests, while this store's scheduling is tested
 * with an injected `read`. */
export function createBalanceStore(slug: string, options: BalanceStoreOptions = {}): BalanceStore {
  const timeoutMs = options.timeoutMs ?? 12_000;
  const balanceRead: BalanceReader = options.read ?? ((id, signal) => readWalletBalances(slug, id, { timeoutMs, signal }));
  const inner = createViewportStore<AssetBalances>({
    read: async (id, signal) => {
      const result = await balanceRead(id, signal);
      return result.kind === "ready" ? { kind: "loaded", value: result.byAsset } : { kind: "failed" };
    },
    batchSize: options.batchSize,
    batchDelayMs: options.batchDelayMs,
    sleep: options.sleep,
  });

  // Keep a stable remapped snapshot keyed on the inner one, so `useSyncExternalStore`
  // still sees a new reference only when the state changed.
  let srcSnap: ReadonlyMap<number, ViewportEntry<AssetBalances>> | undefined;
  let outSnap: ReadonlyMap<number, BalanceEntry> | undefined;

  return {
    setViewport: (visibleIds, opts) => inner.setViewport(visibleIds, opts),
    refresh: (ids) => inner.refresh(ids),
    get: (walletId) => toBalanceEntry(inner.get(walletId)),
    snapshot: () => {
      const src = inner.snapshot();
      if (src === srcSnap && outSnap !== undefined) return outSnap;
      srcSnap = src;
      const mapped: ReadonlyMap<number, BalanceEntry> = new Map(Array.from(src, ([id, entry]) => [id, toBalanceEntry(entry)]));
      outSnap = mapped;
      return mapped;
    },
    subscribe: (listener) => inner.subscribe(listener),
    dispose: () => inner.dispose(),
  };
}
