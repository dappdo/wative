# Examples

## `quickstart.mts` — use wative in 3 minutes

Open a workspace, create an account, read its wallets and addresses, and build a
transaction — all headless, with no UI, using only the public `wative/*` surface.

```sh
# in this repo (tsx is a devDependency):
pnpm exec tsx examples/quickstart.mts

# ALSO broadcast a real transfer (testnet network + a funded wallet only):
pnpm exec tsx examples/quickstart.mts --send
```

(From your own project that depends on `wative`, copy the file and run it with
`pnpm dlx tsx quickstart.mts`.)

What it shows:

1. **Open** — `createWorkspace(path, password)` on first run; `openLocked(path)` +
   `unlock(password)` after. `inspect(path)` (from `wative/node/container`) tells a fresh
   folder from an existing workspace without a password.
2. **Create an account** — `createAccount(name, password, mnemonic, networkSlug?)`
   returns the new account's slug. Generate a phrase with `newMnemonic(12)` from
   `wative/core` (the passthrough, so you depend on `wative` alone); pick a network from `workspaceNetworkChoices()`.
3. **Read wallets** — `accounts()`, then `walletsFor(slug)` → each wallet's
   `addresses` (`{ vm, network, publicKey }`). Everything is plain data, never a
   live handle.
4. **Send** — build a `SendIntent`, then `prepareSend(intent)` (offline review:
   fee, balances, destination safety) and `confirmSend(intent, overrides, onProgress)`
   (sign + broadcast + track).

The script writes a throwaway workspace to `./.wative2-example` (gitignored). The
demo password and generated mnemonic are for that throwaway **only** — never reuse
them, and never point it at your real `~/.wative2`. Clean up with:

```sh
rm -rf .wative2-example
```

> 🚨 `--send` broadcasts and cannot be undone. Only use it on a **testnet** network
> with a wallet you have funded from a faucet.
