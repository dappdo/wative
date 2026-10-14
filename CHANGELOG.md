# Changelog

## 2.1.3

### Changed — wative's Node-only surface moved under `wative/node/*`

wative's own Node-only modules now live under the `wative/node` family, so the
public surface signals which parts require the Node runtime (filesystem, process
lifecycle, and `wative-core`'s `node`-condition provider classes). A pure-browser
surface (`wative/browser`) is planned next; the portable helpers already run in
either environment. This is an import-path change (consumers currently track
`wative` via a local link and adapt their imports); no runtime behavior changed.

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

- **`wative/node`** — an aggregate barrel that re-exports the whole Node surface
  (bootstrap, preflight, session, balances, nonces, paths, container) in one
  import, alongside the focused `wative/node/*` subpaths.
- **`wative/core`** and **`wative/core/node`** — a transparent, identity-preserving
  pass-through to the `wative-core` object (root) and its Node backend
  registration, so a consumer can depend on `wative` alone and still reach the
  full `wative-core` toolkit.

No runtime behavior changed in this release — it only remaps export paths and adds
the pass-through entries.
