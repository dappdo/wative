# Changelog

## 2.1.5

### Added

- `selectableNetworks(slug)` on `wative/node/session` — every workspace network
  whose VM the account has an address for, so a consumer's default-network picker
  can offer ANY same-VM network, not just the ones the account was derived on.
  `accountNetworks(slug)` is unchanged (still the narrower set the account has an
  Address explicitly bound to), for its existing callers.

### Changed

- `readWalletBalances` / `fillBalances` / `readWalletNonce` / `fillNonces` now
  resolve the wallet's per-VM address and read on the account's (freely-settable)
  default network via the keyless `ChainClient`, instead of requiring an Address
  bound to that exact network. An account can therefore switch its default to any
  same-VM network after creation and have balances/nonce read there — its single
  per-VM pubkey is valid on every network of that VM. Signatures are unchanged;
  per-asset `readError` isolation, the worker-pool concurrency bound, and the
  timeout/abort (`AbortSignal`) semantics are all preserved. The send path is
  unchanged (a separate follow-up).

Pins `wative-core` 2.5.8. No wative-core change — cross-network reads go through
the keyless, network-scoped `ChainClient` (the sanctioned path; an `Address` stays
bound to its creation network in core).

## 2.1.4

### Added

- Crypto-correctness test coverage for the `wative/node/session` export + sign
  wrappers (EVM and SVM): `exportPrivateKey` returns the key matching the wallet's
  public key, `signMessage` recovers/verifies to the wallet, and a wrong password
  is refused with no key leak. `ethers` / `bs58` / `tweetnacl` added as
  devDependencies for the tests.

No runtime or API change from 2.1.3 — this release only adds test coverage (and
test-only devDependencies); the shipped surface (`dist/`) is identical.

## 2.1.3

### Changed — wative's Node-only surface moved under `wative/node/*`

wative's own Node-only modules now live under the `wative/node` family, so the
public surface signals which parts require the Node runtime (filesystem, process
lifecycle, and `wative-core`'s `node`-condition provider classes). The pure-browser
surface (`wative/browser`) ships in this same release (see Added); the portable
helpers already run in either environment. This is an import-path change (consumers
currently track `wative` via a local link and adapt their imports); no runtime
behavior changed.

**Unchanged:** `wative` (root), `wative/viewport`, `wative/sendMath`,
`wative/passwordStrength`, `wative/errors`.

### Added

- **`wative/browser`** — the aggregate PORTABLE (dual-env) surface, plus focused
  subpaths `wative/browser/{siwe,validators,slug,secretInput,balances,nonces}`.
  Pure interaction kernels (the EIP-4361 SIWE message builder, input-shape
  validators, network-slug derivation, the masked-secret input reducer) were
  extracted out of the Node modules into dual-env modules; `wative/node/*`
  re-exports them, so its surface is unchanged. The balance/nonce stores were
  split into a portable injected-reader factory (`wative/browser/{balances,nonces}`)
  and the Node slug-based convenience (`wative/node/{balances,nonces}`, API
  unchanged). The root `.` gains a `browser` export condition so `import "wative"`
  resolves to the portable surface in a browser bundler. A `tsconfig.browser.json`
  gate (wired into `verify`) typechecks the portable surface under the browser
  condition so a Node leak can't compile green.
- **`wative/node`** — an aggregate barrel that re-exports the whole Node surface
  (bootstrap, preflight, session, balances, nonces, paths, container) in one
  import, alongside the focused `wative/node/*` subpaths.
- **`wative/core`** and **`wative/core/node`** — a transparent, identity-preserving
  pass-through to the `wative-core` object (root) and its Node backend
  registration, so a consumer can depend on `wative` alone and still reach the
  full `wative-core` toolkit.

No runtime behavior changed in this release — it only remaps export paths and adds
the pass-through entries.
