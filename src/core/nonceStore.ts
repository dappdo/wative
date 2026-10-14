/**
 * A viewport-aware, cancellable, caching NONCE-loading store — the PORTABLE
 * (dual-env) nonce specialisation of `createViewportStore`. The per-wallet `read`
 * is REQUIRED and injected, so this module has NO wative-core RUNTIME dependency
 * and therefore runs in a browser.
 *
 * `wative/browser/nonces` exposes this factory; the Node convenience that reads
 * each wallet's pending nonce over RPC from a workspace slug + network is
 * `wative/node/nonces` (`core/nodeNonceStore.ts`), a thin wrapper over this one.
 */
import { createViewportStore, type ViewportStore, type ViewportEntry, type ViewportReader, type ViewportStatus } from "./viewportStore.js";

export type { ViewportStore, ViewportEntry, ViewportStatus };

/** One wallet's nonce read outcome: a numeric nonce, or `na` (no EVM address on
 * this network, so there is no nonce to read — a terminal, not a failure). */
export type NonceValue = { readonly kind: "value"; readonly value: number } | { readonly kind: "na" };

/** One wallet's nonce entry: the five viewport statuses, carrying a `NonceValue`
 * when `loaded`. */
export type NonceEntry = ViewportEntry<NonceValue>;

/** A nonce store. */
export type NonceStore = ViewportStore<NonceValue>;

export interface NonceStoreOptions {
  /** The per-wallet read (REQUIRED — this portable factory supplies no default). */
  readonly read: ViewportReader<NonceValue>;
  /** Wallets read per batch (default 5). */
  readonly batchSize?: number;
  /** Delay between batches, ms (default 250). */
  readonly batchDelayMs?: number;
  /** Override the inter-batch delay (tests). */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Create a nonce store over an injected per-wallet `read`. Scheduling is the
 * shared `createViewportStore`. */
export function createNonceStore(options: NonceStoreOptions): NonceStore {
  return createViewportStore<NonceValue>({ read: options.read, batchSize: options.batchSize, batchDelayMs: options.batchDelayMs, sleep: options.sleep });
}
