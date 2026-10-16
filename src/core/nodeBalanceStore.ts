/**
 * The Node convenience for the balance store: `createBalanceStore(slug, options?)`
 * supplies the default wative-core RPC reader (each wallet's DEFAULT-network
 * balances) from a workspace slug and delegates to the PORTABLE balance store.
 *
 * This is what `wative/node/balances` exposes — its API is unchanged from 2.1.x
 * (slug + optional overrides). The portable factory it wraps (injected `read`,
 * browser-safe) is `wative/browser/balances` (`core/balanceStore.ts`).
 */
import { readWalletBalances } from "./session.js";
import {
  createBalanceStore as createPortableBalanceStore,
  type AssetBalances,
  type BalanceEntry,
  type BalanceReader,
  type BalanceStatus,
  type BalanceStore,
} from "./balanceStore.js";

export type { AssetBalances, BalanceEntry, BalanceReader, BalanceStatus, BalanceStore };

export interface BalanceStoreOptions {
  /** Wallets read per batch (default 5). */
  readonly batchSize?: number;
  /** Delay between batches, ms (default 250). */
  readonly batchDelayMs?: number;
  /** Per-read timeout passed to the default reader, ms (default 12000). */
  readonly timeoutMs?: number;
  /** Bind the default reader to THIS network instead of the account's current
   * default. The keyless cross-network read means a store can be pinned to a
   * FIXED network, so a consumer can keep one store per network and recall its
   * cache after a default-network switch. Omit to read the current default (the
   * unchanged 2.1.x behaviour). Ignored when `read` is overridden — a custom
   * reader binds its own network. */
  readonly network?: string;
  /** Override the per-wallet read (tests / alternative backends). */
  readonly read?: BalanceReader;
  /** Override the inter-batch delay (tests). */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Create a balance store for one account `slug`. The default reader reads each
 * wallet's balances over RPC — on `options.network` when given, else the
 * account's current default; override it with `read` (which is how the scheduler
 * is tested). The real network read is exercised by the consumer's integration
 * tests. */
export function createBalanceStore(slug: string, options: BalanceStoreOptions = {}): BalanceStore {
  const timeoutMs = options.timeoutMs ?? 12_000;
  const network = options.network;
  const read: BalanceReader = options.read ?? ((id, signal) => readWalletBalances(slug, id, { timeoutMs, signal, network }));
  return createPortableBalanceStore({ read, batchSize: options.batchSize, batchDelayMs: options.batchDelayMs, sleep: options.sleep });
}
