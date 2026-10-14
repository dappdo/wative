# wative

A ready-to-use toolkit for scaffolding wallet-dispatch applications on top of
[`wative-core`](https://www.npmjs.com/package/wative-core): open a workspace, manage
accounts and wallets, and sign or send transactions. Pure logic, no UI — mount your
own interface on it, or drive it headless.

## Requirements

- **Node.js ≥ 22.12** for the `wative/node` surface (it uses the filesystem and
  `wative-core`'s Node provider). The **`wative/browser`** surface and the
  portable helpers (`wative/viewport`, `wative/sendMath`, `wative/passwordStrength`,
  `wative/errors`) are dual-env — they run in a browser too.

## Install

```sh
pnpm add wative      # pulls wative-core as a dependency
```

## Quick start

```ts
import { createWorkspace, createAccount, accounts, walletsFor } from "wative/node/session";
import { newMnemonic } from "wative/core";

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

Start from `wative` (or `wative/node`); the rest of the surface is on focused
subpath exports, namespaced by environment (`wative/node/*` and `wative/core/node`
are Node-only; the rest is portable, though `wative/passwordStrength` pulls
wative-core's browser build):

| Import | What it gives you |
|---|---|
| `wative/core` · `wative/core/node` | a transparent, identity-preserving pass-through to the `wative-core` object (root) and its Node backend registration — depend on `wative` alone and still reach the full core toolkit |
| `wative` · `wative/node` · `wative/node/bootstrap` | `bootstrap(entrypoint)` — arms the process lifecycle, opens + unlocks a workspace, and hands it to your code (a UI, or a headless script) |
| `wative/node/preflight` | the plain-stdout open/unlock flow + the `OpenedWorkspace` type |
| `wative/node/session` | the workspace gateway — accounts, wallets, networks, balances, send/sign |
| `wative/node/balances` | `createBalanceStore(slug)` — a viewport-aware, cancellable, caching balance loader for large accounts (see below) |
| `wative/node/nonces` | `createNonceStore(slug, network)` — the same loader for a wallet list's pending-nonce column (EVM-only; off-network wallets load as `na`) |
| `wative/node/paths` · `wative/node/container` | Node helpers — path masking, the container probe |
| `wative/browser` | the aggregate PORTABLE (dual-env) surface — viewport scheduler, balance/nonce caching factories (you supply the `read`), the SIWE builder, input validators, slug derivation, the masked-secret input reducer, send math, password strength, error mapping |
| `wative/browser/siwe` · `wative/browser/validators` · `wative/browser/slug` · `wative/browser/secretInput` | the extracted dual-env kernels (EIP-4361 SIWE message, input-shape validators, network-slug, masked-secret reducer) |
| `wative/browser/balances` · `wative/browser/nonces` | the portable store factories (inject your own `read`); the Node slug-based conveniences are `wative/node/{balances,nonces}` |
| `wative/viewport` | `createViewportStore(opts)` — the generic viewport/batch/cancel/cache scheduler the two stores above are built on; parameterise it with your own `read` (portable, dual-env) |
| `wative/sendMath` · `wative/passwordStrength` · `wative/errors` | portable helpers (chain math, password strength, error messages) — dual-env |

### Loading a large wallet list

`wative/node/session` exposes `fillBalances` / `fillNonces` (read a set of wallets,
concurrency-bounded) and the cancellable single reads `readWalletBalances` /
`readWalletNonce` (one wallet, abortable via an `AbortSignal`). For a list UI over
hundreds of wallets, prefer the stores, which load only what is on screen:

```ts
import { createBalanceStore } from "wative/node/balances";

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

### Switching an account's default network

A wallet holds one address per VM (EVM / SVM), but that address is valid on every
network of its VM — so an account can operate on any same-VM network, not just the
one it was created on. `selectableNetworks(slug)` lists those networks (for a
default-network picker); `setAccountDefaultNetwork(slug, network)` switches the
default, and `readWalletBalances` / `readWalletNonce` (and the stores) then read on
it, resolving the wallet's per-VM address on the selected network. `accountNetworks(slug)`
remains the narrower set the account has an address explicitly bound to.

## License

MIT
