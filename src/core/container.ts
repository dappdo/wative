/**
 * The pre-unlock probe: is there a workspace at this path or not?
 *
 * 🚨 **This is the only correct existence oracle** — and the reason is subtle
 * enough to be worth stating precisely.
 *
 * 🔄 **`Workspace.open({path})` does NOT create anything.** Falsified against
 * 2.5.4: it creates nothing with `{path}`, nothing with `{path}, pw, false`,
 * nothing with a bare path string, and **nothing even with the third
 * positional `create` explicitly `true`**. The real rule is simpler and
 * narrower: `Workspace.open` writes a container **iff a password is
 * supplied** — `{path, password}` or `open(pathString, pw)`, 124–172 ms, after
 * which the directory holds `accounts/ asset/ config/ log/ network/`. So
 * `openLocked` is safe by construction and `createWorkspace` is the only
 * writer in this codebase.
 *
 * What does make a probe necessary is the second trap, which is real:
 *
 *  - `Workspace.open({path}, pw, false)` is **not** an existence probe: the
 *    positional password is ignored and it returns `locked: true,
 *    accounts: 0` for **both** a missing path and a real workspace —
 *    indistinguishable, in 0.04–0.05 ms warm.
 *  - `FileProvider` throws outright — `"FileProvider.constructor: not
 *    implemented in v2.0; use HybridProvider."`
 *
 * So `inspectContainer()` it is, at **0.06 ms warm and ~1.0 ms on the first
 * call in a fresh process** — the pre-flight pays the cold one. (For scale, the
 * number that actually dominates startup is importing `wative-core` at all:
 * ~230–264 ms.)
 *
 * It is three-way, and the collapsing is deliberate on the library's side:
 * *missing* and *exists-but-empty* both report `"empty"` (both mean "create
 * here"), and a non-empty non-workspace directory and a plain file both report
 * `"foreign"`. Verified all four cases.
 *
 * 🚨 **The provider instance never leaves this module, and that is a security
 * boundary, not tidiness.** `HybridProvider` is typed only on the
 * `wative-core/node` entry point while `Workspace` is exported only from the
 * root entry — and the two entry points ship **different classes**. Measured:
 * handing a `/node`-entry provider to the root `Workspace.open` throws
 * `PARAMETER_ERROR "Workspace.open received a Provider created by a different
 * entry point of this package."` `inspectContainer()` works from either entry,
 * so probing here is safe; passing this instance anywhere would not be.
 *
 * Rather than document that as a rule someone has to remember, this module
 * exports only the *answer*. A caller cannot misuse a provider it can never
 * obtain.
 */
import { HybridProvider } from "wative-core/node";
import type { ContainerState } from "wative-core";

import { safeMessage } from "./errors.js";

export type { ContainerState };

export interface Inspection {
  readonly state: ContainerState;
  /** Set when the probe itself failed — an unreadable path, a bad mount. */
  readonly failure?: string;
}

/**
 * What is at `path`, without creating anything and without a password.
 *
 * A probe failure is returned rather than thrown: this runs on the very first
 * screen, where there is no error surface yet and no workspace to fall back
 * on. `"foreign"` is the safe answer to report when we cannot tell, because it
 * is the one state the pre-flight refuses to write to.
 *
 * ⚠️ That branch is reachable, two ways — an unreadable directory gives a
 * plain `EACCES`, and a path whose parent is a file gives a `WativeError`
 * `PROVIDER_IO` whose message **contains the raw absolute path**. `failure` is
 * always `safeMessage`'d and never interpolates, so the path cannot escape
 * through it.
 */
export async function inspect(path: string): Promise<Inspection> {
  try {
    const provider = new HybridProvider(path);
    return { state: await provider.inspectContainer() };
  } catch (error) {
    return { state: "foreign", failure: safeMessage(error) };
  }
}
