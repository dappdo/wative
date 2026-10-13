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
| `wative/sendMath` · `wative/paths` · `wative/passwordStrength` · `wative/container` · `wative/errors` | focused helpers (chain math, path masking, password strength, the container probe, error messages) |

A static test keeps the package free of any terminal-UI dependency, so a headless
consumer pulls none in. Mount a UI on `bootstrap`, or run headless — see the examples.

## License

MIT
