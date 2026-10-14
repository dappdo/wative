# Changelog

## 2.1.3

### Changed — wative's Node-only surface moved under `wative/node/*`

wative's own Node-only modules now live under the `wative/node` family, so the
public surface signals which parts require the Node runtime (filesystem, process
lifecycle, and `wative-core`'s `node`-condition provider classes). The pure-browser
surface (`wative/browser`) ships in this same release (see Added); the portable
helpers already run in either environment. This is an import-path change (consumers
currently track `wative` via a local link and adapt their imports); no runtime
behavior changed.

Rewrite these imports:

| Removed | New (2.1.3) |
|---|---|
| `wative/bootstrap` | `wative/node/bootstrap` (or the aggregate `wative/node`, or the root `wative`) |
| `wative/preflight` | `wative/node/preflight` |
| `wative/session` | `wative/node/session` |
| `wative/balances` | `wative/node/balances` |
| `wative/nonces` | `wative/node/nonces` |
| `wative/paths` | `wative/node/paths` |
| `wative/container` | `wative/node/container` |

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
