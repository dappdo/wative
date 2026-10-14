/**
 * A viewport-aware, cancellable, caching read store — the generic scheduler
 * behind `wative/node/balances` and `wative/node/nonces`. A consumer tells it which items
 * are visible; it lazily reads just those, in small batches with a delay between
 * them, following the cursor, cancelling reads for items that scroll away, and
 * caching the results so re-entering the viewport costs nothing.
 *
 * It is UI-free and payload-agnostic: the concrete stores pick the `loaded`
 * payload type `L` (per-asset balances, a nonce value, …) and supply the `read`.
 * The consumer subscribes and renders from `snapshot()`/`get()`.
 *
 * The scheduler is driven through two injectable seams — `read` (the per-item
 * read) and `sleep` (the inter-batch delay) — so the whole state machine is
 * testable without a live backend or real timers.
 */

/** The five lifecycle states of one item's read:
 * - `unstarted` — never queued (outside the viewport, or cancelled),
 * - `queued` — in the viewport, waiting for a batch slot,
 * - `loading` — a read is in flight,
 * - `loaded` — read succeeded; the entry carries the `L` payload (cached),
 * - `failed` — the read failed; terminal until an explicit `refresh` (cached). */
export type ViewportStatus = "unstarted" | "queued" | "loading" | "loaded" | "failed";

/** One item's store entry. The `value` payload is present iff `status === "loaded"`. */
export type ViewportEntry<L> = { readonly status: Exclude<ViewportStatus, "loaded"> } | { readonly status: "loaded"; readonly value: L };

/** The per-item read the store schedules. Resolves `loaded` (with the payload) or
 * `failed`; MUST reject when `signal` aborts (so the store can tell a cancellation
 * from a failure). Injectable so the scheduler can be tested with a fake reader. */
export type ViewportReader<L> = (id: number, signal: AbortSignal) => Promise<{ kind: "loaded"; value: L } | { kind: "failed" }>;

export interface ViewportStoreOptions<L> {
  /** The per-item read (required). */
  readonly read: ViewportReader<L>;
  /** Items read per batch (default 5). */
  readonly batchSize?: number;
  /** Delay between batches, ms (default 250). */
  readonly batchDelayMs?: number;
  /** Override the inter-batch delay (tests). */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface ViewportStore<L> {
  /** Declare the items currently visible, in display order. Newly-visible items
   * not already loaded/failed are queued; items that left the viewport are
   * dequeued (`queued`) or have their in-flight read aborted (`loading`);
   * loaded/failed stay cached. `anchor` (the cursor's id) and `direction` steer
   * the crawl order so the window follows the cursor. */
  setViewport(visibleIds: readonly number[], opts?: { readonly anchor?: number; readonly direction?: "up" | "down" }): void;
  /** Force a re-read of `ids`: clears their cache and re-queues the ones in the
   * viewport (others reset to `unstarted`). Powers an explicit refresh. */
  refresh(ids: readonly number[]): void;
  /** This item's entry (`{ status: "unstarted" }` if never seen). */
  get(id: number): ViewportEntry<L>;
  /** A stable snapshot of every tracked item — a new reference only when the
   * state has changed since the last call (suitable for `useSyncExternalStore`). */
  snapshot(): ReadonlyMap<number, ViewportEntry<L>>;
  /** Subscribe to state changes; returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Abort every in-flight read and drop all listeners. */
  dispose(): void;
}

const UNSTARTED = { status: "unstarted" } as const;

/** Create a viewport store over a `read`. The concrete `wative/node/balances` and
 * `wative/node/nonces` stores are thin wrappers that fix `L` and wire the real read;
 * this scheduler is what both are tested through. */
export function createViewportStore<L>(options: ViewportStoreOptions<L>): ViewportStore<L> {
  const { read } = options;
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 5));
  const batchDelayMs = Math.max(0, options.batchDelayMs ?? 250);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const entries = new Map<number, ViewportEntry<L>>();
  const inflight = new Map<number, AbortController>();
  const listeners = new Set<() => void>();
  let viewport: readonly number[] = [];
  let viewportSet = new Set<number>();
  let anchor: number | undefined;
  let direction: "up" | "down" | undefined;
  let pumping = false;
  let disposed = false;
  let snapshotCache: ReadonlyMap<number, ViewportEntry<L>> | undefined;

  const statusOf = (id: number): ViewportStatus => entries.get(id)?.status ?? "unstarted";

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };
  const setEntry = (id: number, entry: ViewportEntry<L>): void => {
    entries.set(id, entry);
    snapshotCache = undefined;
    notify();
  };

  /** Abort an in-flight read (if any) and reset the entry to `unstarted`. */
  const cancel = (id: number): void => {
    const controller = inflight.get(id);
    if (controller !== undefined) {
      inflight.delete(id);
      controller.abort();
    }
    setEntry(id, UNSTARTED);
  };

  /** The viewport ids in crawl order: from the anchor (cursor) outward, biased to
   * the travel direction so the window loads ahead of the cursor first. */
  const crawlOrder = (): readonly number[] => {
    if (viewport.length === 0) return [];
    let at = anchor !== undefined ? viewport.indexOf(anchor) : 0;
    if (at < 0) at = 0;
    const ordered: number[] = [];
    const push = (i: number): void => {
      const id = viewport[i];
      if (id !== undefined) ordered.push(id);
    };
    if (direction === "up") {
      for (let i = at; i >= 0; i--) push(i);
      for (let i = at + 1; i < viewport.length; i++) push(i);
    } else {
      for (let i = at; i < viewport.length; i++) push(i);
      for (let i = at - 1; i >= 0; i--) push(i);
    }
    return ordered;
  };

  /** The in-viewport items still needing a read, in crawl order. */
  const orderedPending = (): readonly number[] =>
    crawlOrder().filter((id) => {
      const status = statusOf(id);
      return status === "unstarted" || status === "queued";
    });

  const readOne = async (id: number): Promise<void> => {
    if (disposed || !viewportSet.has(id)) return;
    const status = statusOf(id);
    if (status === "loading" || status === "loaded" || status === "failed") return;
    const controller = new AbortController();
    inflight.set(id, controller);
    setEntry(id, { status: "loading" });
    let result: { kind: "loaded"; value: L } | { kind: "failed" } | undefined;
    try {
      result = await read(id, controller.signal);
    } catch {
      // A rejection is either the abort we asked for, or a reader failure. The
      // `signal.aborted` check below tells them apart; `result` stays undefined.
    } finally {
      if (inflight.get(id) === controller) inflight.delete(id);
    }
    if (disposed) return;
    if (result !== undefined) {
      // A COMPLETED read is valid data — cache it even if the item has since
      // scrolled away (loaded is cached; re-entry never re-queues).
      setEntry(id, result.kind === "loaded" ? { status: "loaded", value: result.value } : { status: "failed" });
      return;
    }
    // No result: aborted before completion → leave as `cancel` set it
    // (`unstarted`); a non-abort rejection → `failed`.
    if (controller.signal.aborted) return;
    setEntry(id, { status: "failed" });
  };

  /** Drain the queue in batches, re-targeting the viewport each round, until no
   * visible item needs a read. Re-entrant-safe: a second call while pumping is a
   * no-op (the running loop picks up viewport changes on its own). */
  const pump = async (): Promise<void> => {
    if (pumping || disposed) return;
    pumping = true;
    try {
      for (;;) {
        if (disposed) break;
        const pending = orderedPending();
        if (pending.length === 0) break;
        await Promise.all(pending.slice(0, batchSize).map((id) => readOne(id)));
        if (disposed) break;
        if (orderedPending().length > 0) await sleep(batchDelayMs);
      }
    } finally {
      pumping = false;
    }
  };

  return {
    setViewport(visibleIds, opts) {
      if (disposed) return;
      const next = [...visibleIds];
      const nextSet = new Set(next);
      // Items that LEFT the viewport: dequeue (queued) or abort (loading).
      for (const id of viewport) {
        if (nextSet.has(id)) continue;
        const status = statusOf(id);
        if (status === "queued") setEntry(id, UNSTARTED);
        else if (status === "loading") cancel(id);
      }
      // Newly-visible items not already terminal/in-progress: queue them.
      for (const id of next) {
        if (statusOf(id) === "unstarted") setEntry(id, { status: "queued" });
      }
      viewport = next;
      viewportSet = nextSet;
      anchor = opts?.anchor;
      direction = opts?.direction;
      void pump();
    },
    refresh(ids) {
      if (disposed) return;
      for (const id of ids) {
        const controller = inflight.get(id);
        if (controller !== undefined) {
          inflight.delete(id);
          controller.abort();
        }
        setEntry(id, viewportSet.has(id) ? { status: "queued" } : UNSTARTED);
      }
      void pump();
    },
    get(id) {
      return entries.get(id) ?? UNSTARTED;
    },
    snapshot() {
      return (snapshotCache ??= new Map(entries));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      for (const controller of inflight.values()) controller.abort();
      inflight.clear();
      listeners.clear();
    },
  };
}
