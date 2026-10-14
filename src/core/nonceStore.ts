/**
 * A viewport-aware, cancellable, caching NONCE-loading store — the nonce
 * specialisation of the generic `createViewportStore` scheduler, reading each
 * wallet's pending transaction nonce on a given `network` (for a grid's optional
 * nonce column). Same batching / cursor-crawl / cancel-on-scroll / cache
 * behaviour as the balance store.
 *
 * EVM-only by nature: a wallet with no EVM address on `network` loads as `na`
 * (a terminal, not a failure, and never an RPC call). The consumer subscribes and
 * renders from `snapshot()`/`get()`.
 */
import { readWalletNonce } from "./session.js";
import { createViewportStore, type ViewportStore, type ViewportEntry, type ViewportReader, type ViewportStatus } from "./viewportStore.js";

export type { ViewportStore, ViewportEntry, ViewportStatus };

/** One wallet's nonce read outcome, as the store's `loaded` payload: a numeric
 * nonce, or `na` (the wallet has no EVM address on this network, so there is no
 * nonce to read). */
export type NonceValue = { readonly kind: "value"; readonly value: number } | { readonly kind: "na" };

/** One wallet's nonce entry: the five viewport statuses, carrying a `NonceValue`
 * when `loaded`. */
export type NonceEntry = ViewportEntry<NonceValue>;

/** A nonce store for one account `slug`'s nonce column on `network`. */
export type NonceStore = ViewportStore<NonceValue>;

export interface NonceStoreOptions {
  /** Wallets read per batch (default 5). */
  readonly batchSize?: number;
  /** Delay between batches, ms (default 250). */
  readonly batchDelayMs?: number;
  /** Per-read timeout passed to the default reader, ms (default 12000). */
  readonly timeoutMs?: number;
  /** Override the per-wallet read (tests / alternative backends). */
  readonly read?: ViewportReader<NonceValue>;
  /** Override the inter-batch delay (tests). */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Create a nonce store for `slug`'s nonce column on `network`. The default reader
 * reads each wallet's pending nonce over RPC (EVM-only; a non-EVM / missing
 * address loads as `na`). Scheduling is tested with an injected `read`; the real
 * read is exercised by the consumer's integration tests. */
export function createNonceStore(slug: string, network: string, options: NonceStoreOptions = {}): NonceStore {
  const timeoutMs = options.timeoutMs ?? 12_000;
  const read: ViewportReader<NonceValue> =
    options.read ??
    (async (id, signal) => {
      const result = await readWalletNonce(slug, id, network, { timeoutMs, signal });
      if (result.kind === "ready") return { kind: "loaded", value: { kind: "value", value: result.value } };
      if (result.kind === "na") return { kind: "loaded", value: { kind: "na" } };
      return { kind: "failed" };
    });
  return createViewportStore<NonceValue>({ read, batchSize: options.batchSize, batchDelayMs: options.batchDelayMs, sleep: options.sleep });
}
