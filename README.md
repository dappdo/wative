# wative

A Node.js toolkit for scaffolding wallet-dispatch applications on top of
[`wative-core`](https://www.npmjs.com/package/wative-core): open a workspace, manage
accounts and wallets, and sign or send transactions. Pure logic, no UI — mount your
own interface on it, or drive it headless.

## Requirements

- **Node.js ≥ 22.12.** Node only: it uses the filesystem and `wative-core`'s Node
  provider, so there is no browser build.

## Install

```sh
pnpm add wative      # pulls wative-core as a dependency
```

## Quick start

```ts
import { createWorkspace, createAccount, accounts, walletsFor } from "wative/session";
import { newMnemonic } from "wative-core";

await createWorkspace("./.wative2", "a-strong-password");          // created + unlocked
await createAccount("Main", "a-strong-password", newMnemonic(12)); // an HD account

for (const account of accounts() ?? []) {
  for (const wallet of walletsFor(account.slug) ?? []) {
    for (const address of wallet.addresses) {
      console.log(`#${wallet.id}`, address.vm, address.publicKey);
    }
  }
}
```

See [`examples/`](examples/):

- [`quickstart.mts`](examples/quickstart.mts) — open → account → wallets → build a
  transaction, in about three minutes.
- [`funded-walkthrough.mts`](examples/funded-walkthrough.mts) — an interactive
  **testnet** walk: derive 20 wallets, fund one from a faucet, poll the chain, then
  distribute to the others.

## API

Start from `wative/bootstrap`; the rest of the surface is on focused subpath exports:

| Import | What it gives you |
|---|---|
| `wative` · `wative/bootstrap` | `bootstrap(entrypoint)` — arms the process lifecycle, opens + unlocks a workspace, and hands it to your code (a UI, or a headless script) |
| `wative/preflight` | the plain-stdout open/unlock flow + the `OpenedWorkspace` type |
| `wative/session` | the workspace gateway — accounts, wallets, networks, balances, send/sign |
| `wative/balances` | `createBalanceStore(slug)` — a viewport-aware, cancellable, caching balance loader for large accounts (see below) |
| `wative/nonces` | `createNonceStore(slug, network)` — the same loader for a wallet list's pending-nonce column (EVM-only; off-network wallets load as `na`) |
| `wative/viewport` | `createViewportStore(opts)` — the generic viewport/batch/cancel/cache scheduler the two stores above are built on; parameterise it with your own `read` |
| `wative/sendMath` · `wative/paths` · `wative/passwordStrength` · `wative/container` · `wative/errors` | focused helpers (chain math, path masking, password strength, the container probe, error messages) |

### Loading a large wallet list

`wative/session` exposes `fillBalances` / `fillNonces` (read a set of wallets,
concurrency-bounded) and the cancellable single reads `readWalletBalances` /
`readWalletNonce` (one wallet, abortable via an `AbortSignal`). For a list UI over
hundreds of wallets, prefer the stores, which load only what is on screen:

```ts
import { createBalanceStore } from "wative/balances";

const store = createBalanceStore(accountSlug); // batchSize 5, 250ms between batches
store.subscribe(render);                       // re-render on any state change
store.setViewport(visibleWalletIds, { anchor: cursorId, direction: "down" });
// store.get(id) → { status: "unstarted" | "queued" | "loading" | "loaded" | "failed", byAsset? }
```

It loads only the wallets you declare visible, in batches, following the cursor;
wallets that scroll away are dequeued or have their in-flight read aborted; loaded
and failed results are cached, so re-entering the viewport costs nothing. Call
`store.refresh(ids)` to force a re-read and `store.dispose()` when the view unmounts.
`createNonceStore(slug, network)` is the same, for the nonce column; both share the
generic `createViewportStore` from `wative/viewport`.

A static test keeps the package free of any terminal-UI dependency, so a headless
consumer pulls none in. Mount a UI on `bootstrap`, or run headless — see the examples.

## License

MIT
