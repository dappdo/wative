/**
 * Paths that are safe to paint, enforced by the type rather than by a comment.
 *
 * 🚨 A display surface that takes a plain `string` with a doc comment saying
 * "already masked by the caller — never a raw absolute path" stops nothing: a raw
 * workspace path or OS username reaching the screen lands in every screenshot,
 * every `script`/asciinema capture, and every scrollback pasted into an issue.
 *
 * So such a surface should demand a `MaskedPath`, which only `maskPath` can
 * produce — a raw `string` no longer typechecks there. That is the difference
 * between a type expressing intent and construction enforcing it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveDefaultWorkspacePath } from "wative-core/node";

declare const maskedBrand: unique symbol;

/**
 * A string that has been through `maskPath`.
 *
 * Nominal by construction: the brand is an unexported `unique symbol`, so it
 * cannot be forged from outside this module — not even by an object literal
 * that happens to carry the right shape.
 */
export type MaskedPath = string & { readonly [maskedBrand]: true };

/**
 * The shortest username worth substituting.
 *
 * A two-character username would turn unrelated text into nonsense — masking
 * `al` would rewrite "value" and "balance". The homedir and tmpdir prefixes
 * below do the real work; this is only a backstop for a path that lives
 * somewhere neither prefix covers (a mounted volume, a symlinked checkout),
 * and it is not worth corrupting legible output for.
 */
const MIN_MASKABLE_USERNAME = 3;

/** `os.userInfo()` throws when the uid has no passwd entry — some containers. */
function currentUsername(): string | undefined {
  try {
    const name = os.userInfo().username;
    return name.length >= MIN_MASKABLE_USERNAME ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every spelling of a directory that has to be masked.
 *
 * 🚨 **The `realpath` form is a separate string and it leaked.** On macOS the
 * system temp root reached through `/var` is a symlink to a path under
 * `/private`, so `os.tmpdir()` returns one spelling while anything that
 * resolves the path returns the other — and the resolved one keeps the
 * **per-user bootstrap hash directory** on screen. Measured: that spelling
 * passed through `maskPath` completely unchanged — a real leak shape the masker
 * must handle explicitly.
 */
function spellings(dir: string): readonly string[] {
  const forms = new Set<string>([dir]);
  try {
    forms.add(fs.realpathSync(dir));
  } catch {
    // A directory that does not exist has no real path, and that is fine.
  }
  // Cheap, and covers the case where the symlink resolves the other way.
  if (!dir.startsWith("/private")) forms.add(path.join("/private", dir));
  return [...forms];
}

/** Longest prefix first, so `$HOME` nested inside `$TMPDIR` cannot win. */
function prefixes(): readonly { readonly from: string; readonly to: string }[] {
  return [
    ...spellings(os.tmpdir()).map((from) => ({ from, to: "$TMPDIR" })),
    ...spellings(os.homedir()).map((from) => ({ from, to: "~" })),
  ].sort((a, b) => b.from.length - a.from.length);
}

/**
 * macOS and Windows compare paths case-insensitively, so a case variant is a
 * path that really opens the same directory while defeating a literal match.
 * Measured on APFS: upper-casing the user's own directory name in a home path
 * let it through `maskPath` unmasked, while still resolving to the real home
 * directory.
 */
const CASE_INSENSITIVE = process.platform === "darwin" || process.platform === "win32";

function sameStart(value: string, prefix: string): boolean {
  const a = CASE_INSENSITIVE ? value.toLowerCase() : value;
  const b = CASE_INSENSITIVE ? prefix.toLowerCase() : prefix;
  return a === b || a.startsWith(b + path.sep);
}

/**
 * Mask a path for display.
 *
 * Handles the three classes that actually leak on screen: an absolute path
 * under `$HOME`, one under `$TMPDIR` (which macOS puts beneath two levels of
 * per-user hash directory — both unreadable on screen and identifying), and
 * any remaining occurrence of the OS username as a token.
 *
 * A string that is not a path passes through unchanged and still comes back
 * branded, so a placeholder like `no workspace` needs no second entry point —
 * one function, one brand, nothing to forget.
 */
export function maskPath(value: string): MaskedPath {
  let out = value;

  for (const { from, to } of prefixes()) {
    if (from === "" || from === path.sep) continue;
    if (!sameStart(out, from)) continue;
    // Sliced by the prefix's own length so the original casing of the tail
    // survives — only the prefix is replaced.
    out = out.length === from.length ? to : to + out.slice(from.length);
  }

  const user = currentUsername();
  if (user !== undefined) {
    // Split-and-join rather than a regex: the username is arbitrary text and
    // could carry regex metacharacters, and building a pattern from it would
    // be one escaping mistake away from matching nothing.
    out = out.split(user).join("<user>");
  }

  return out as MaskedPath;
}

/**
 * Where the workspace lives when the user names no path.
 *
 * The library's own resolver, deliberately — `WATIVE_WORKSPACE_PATH` →
 * `./.wative2` → `~/.wative2`. Reimplementing those three steps would be easy
 * and would be wrong the moment they diverge: other tools open the same
 * containers through the same library, so "where the workspace is" must be one
 * answer — the library's.
 *
 * ⚠️ Cross-imported from the `/node` entry point, which is safe here and only
 * here: it is a **pure string function**, not a class, so the different-entry-
 * point identity trap that `container.ts` documents does not apply. Nothing
 * else may be taken from that entry.
 *
 * 🚨 This is called so that `Workspace.open` always receives an **explicit**
 * path. The no-argument form is never used anywhere in this repo, because it
 * would resolve to the developer's real `~/.wative2` from a test.
 */
export function defaultWorkspacePath(): string {
  return resolveDefaultWorkspacePath();
}

/**
 * Assert a path is a temp path, for test fixtures.
 *
 * 🚨 `Workspace.open()` with no path resolves `WATIVE_WORKSPACE_PATH` →
 * `./.wative2` → `~/.wative2`, and `~/.wative2` exists on a developer's
 * machine. Nothing in the library prevents a test from opening it and
 * mutating real accounts. Every fixture path goes through here first.
 */
export function assertTempPath(candidate: string): string {
  const resolved = path.resolve(candidate);

  // ⚠️ Compared against every spelling of `$TMPDIR`, not just the one
  // `os.tmpdir()` happens to return. Measured: a `/private`-form temp path was
  // **falsely rejected** by a literal comparison, so a CI runner whose
  // `TMPDIR` is already resolved could not create a fixture at all.
  if (spellings(os.tmpdir()).some((tmp) => sameStart(resolved, path.resolve(tmp)))) {
    return resolved;
  }

  // Being under `$TMPDIR` is the only test; a separate "and not under $HOME"
  // check would be unreachable, since a path that failed the first one has
  // already thrown — and a `TMPDIR` legitimately set inside `$HOME` would make
  // it refuse every valid fixture. `$HOME` only changes the wording, because
  // `~/.wative2` is the specific path worth naming.
  const underHome = spellings(os.homedir()).some((home) =>
    sameStart(resolved, path.resolve(home)),
  );
  throw new Error(
    underHome
      ? `refusing to use ${maskPath(resolved)}: it is under $HOME, not $TMPDIR`
      : `refusing to use ${maskPath(resolved)}: a workspace fixture must live under $TMPDIR`,
  );
}
