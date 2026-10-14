/**
 * The Node convenience for the nonce store: `createNonceStore(slug, network,
 * options?)` supplies the default wative-core RPC reader (each wallet's pending
 * nonce on `network`; EVM-only — a non-EVM / missing address loads as `na`) and
 * delegates to the PORTABLE nonce store.
 *
 * This is what `wative/node/nonces` exposes — its API is unchanged from 2.1.x
 * (slug + network + optional overrides). The portable factory it wraps (injected
 * `read`, browser-safe) is `wative/browser/nonces` (`core/nonceStore.ts`).
 */
import { readWalletNonce } from "./session.js";
import { mapNonceRead } from "./nonceReadMap.js";
import type { ViewportReader } from "./viewportStore.js";
import {
  createNonceStore as createPortableNonceStore,
  type NonceEntry,
  type NonceStore,
  type NonceValue,
  type ViewportEntry,
  type ViewportStatus,
  type ViewportStore,
} from "./nonceStore.js";

export type { NonceEntry, NonceStore, NonceValue, ViewportEntry, ViewportStatus, ViewportStore };

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

/** Create a nonce store for `slug`'s nonce column on `network`. The default
 * reader reads each wallet's pending nonce over RPC (EVM-only; a non-EVM /
 * missing address loads as `na`); override it with `read` (how scheduling is
 * tested). */
export function createNonceStore(slug: string, network: string, options: NonceStoreOptions = {}): NonceStore {
  const timeoutMs = options.timeoutMs ?? 12_000;
  const read: ViewportReader<NonceValue> =
    options.read ?? (async (id, signal) => mapNonceRead(await readWalletNonce(slug, id, network, { timeoutMs, signal })));
  return createPortableNonceStore({ read, batchSize: options.batchSize, batchDelayMs: options.batchDelayMs, sleep: options.sleep });
}
