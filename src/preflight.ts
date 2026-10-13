/**
 * The pre-flight: the interactive stdin/stdout sequence that runs BEFORE any UI
 * mounts, and returns an opened, unlocked workspace.
 *
 * A classic inquirer-style sequence on plain stdout — keystore path →
 * (initialize?) → password — on readline, so a consumer can mount its own
 * interactive frame only once a workspace is open and unlocked. This module owns
 * no display: a consumer prints any banner, not here. There is no "trust this
 * folder" step: a non-wative directory is refused, not trusted into.
 *
 * The flow is `inspect → open-locked / create → unlock`:
 *
 *  - `inspect()` first — `Workspace.open` writes a container iff a password is
 *    supplied, so probing by opening is how a typo becomes an empty workspace.
 *  - **password on stdout, as the last step**, straight into `session.unlock` /
 *    `createWorkspace` and dropped. Never stored, never echoed (masked `*`).
 *  - Argon2 blocks the loop, but here it is simply a readline that returns
 *    slowly — no renderer exists yet to starve.
 *
 * 🚨 **The password never becomes anything that outlives the call.** It goes
 * from `promptSecret` straight into the library and is not retained — no retry
 * buffer, no variable past the `await`. On create, the first entry is held only
 * across the confirm compare (a local `const`).
 *
 * Testability: `runPreflight` takes an injectable `io` so the whole flow can be
 * driven with a scripted transcript against a throwaway workspace — no real TTY.
 * The default `io` (readline + a raw-mode masked secret reader) is the thin glue.
 */
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";

import { inspect, type ContainerState } from "./core/container.js";
import { safeMessage } from "./core/errors.js";
import { assessPassword } from "./core/passwordStrength.js";
import { defaultWorkspacePath, maskPath, type MaskedPath } from "./core/paths.js";
import { createWorkspace, openLocked, unlock } from "./core/session.js";

/** What the pre-flight hands the caller once a workspace is open + unlocked. */
export interface OpenedWorkspace {
  /** For the header. Masked, so a raw path cannot reach the screen. */
  readonly path: MaskedPath;
}

/** The three actions a probed container calls for. */
export type PreflightAction = "unlock" | "create" | "refuse";

/** Map a container state to the action the pre-flight takes for it. */
export function routeState(state: ContainerState): PreflightAction {
  switch (state) {
    case "workspace":
      return "unlock";
    case "empty":
      return "create";
    default:
      return "refuse"; // "foreign" — a non-empty non-wative directory or a file
  }
}

/**
 * The default path to show at the prompt: the cwd IFF it is already an
 * initialized workspace, else the library's OS default (`~/.wative2`).
 *
 * Pure in its dependencies (probe + osDefault injected) so it is testable, and
 * so a probe failure degrades to the OS default rather than throwing on the very
 * first line of the program.
 */
export async function computeDefaultPath(
  cwd: string,
  probe: (p: string) => Promise<{ readonly state: ContainerState }>,
  osDefault: () => string,
): Promise<string> {
  try {
    if ((await probe(cwd)).state === "workspace") return cwd;
  } catch {
    // Unreadable cwd, or anything else: fall through to the OS default.
  }
  // `osDefault()` is a pure string resolver, but it runs on the very first line
  // of the program, where a throw has nowhere to go — so even this degrades.
  try {
    return osDefault();
  } catch {
    return cwd;
  }
}

/** Expand a leading `~` and resolve to an absolute path. */
export function resolveInputPath(input: string, home = os.homedir()): string {
  const trimmed = input.trim();
  const expanded =
    trimmed === "~" ? home : trimmed.startsWith("~/") || trimmed.startsWith("~\\") ? path.join(home, trimmed.slice(2)) : trimmed;
  return path.resolve(expanded);
}

/** The phrases `checkFolder` appends after the masked path; `"ok"` means valid. */
export type FolderCheck = "ok" | "does not exist" | "is not a folder" | "cannot be read";

/**
 * Whether a resolved path is usable as a keystore location: it must ALREADY
 * EXIST and be a directory.
 *
 * `stat` (not `lstat`) so a symlink that points at a real directory is accepted
 * — it is a folder for every purpose here — while a broken symlink stats as
 * `ENOENT` and reads as "does not exist". A non-`ENOENT` error (a permission
 * denial, a path component that is a file giving `ENOTDIR`) is reported as
 * "cannot be read" rather than thrown: this is the first screen, with no error
 * surface but the prompt itself, so every outcome must loop back to a re-prompt.
 */
export async function checkFolder(root: string): Promise<FolderCheck> {
  try {
    return (await stat(root)).isDirectory() ? "ok" : "is not a folder";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "does not exist" : "cannot be read";
  }
}

/** The I/O surface the flow drives, injectable for tests. */
export interface PreflightIO {
  /** Write a line (a trailing newline is added if missing). */
  readonly out: (line: string) => void;
  /**
   * A plain line prompt. Returns the typed answer, or an empty string when the
   * user just hits Enter — the CALLER supplies the default, so the displayed
   * hint (`display`) can be a masked path while the empty-Enter value stays raw.
   */
  readonly promptLine: (question: string, display?: string) => Promise<string>;
  /** A masked prompt; the value is never echoed in clear and never retained here. */
  readonly promptSecret: (question: string) => Promise<string>;
}

/**
 * Run the whole pre-flight and return the opened workspace. Loops on a foreign
 * path and on a wrong password (re-prompt, never exit — a wrong password is the
 * single most likely thing to happen here).
 */
export async function runPreflight(io: PreflightIO = defaultIO(), cwd: string = process.cwd()): Promise<OpenedWorkspace> {
  // A consumer prints any banner/version line; this module owns no display and
  // begins at the path prompt.
  const def = await computeDefaultPath(cwd, inspect, defaultWorkspacePath);

  for (;;) {
    // The default is DISPLAYED masked (it lands in screenshots / `script`
    // captures), but the empty-Enter value is the raw path — the caller owns the
    // substitution, so `~/.wative2` is shown while the real path resolves.
    const answer = await io.promptLine("Keystore storage located in", maskPath(def));
    const root = resolveInputPath(answer === "" ? def : answer);

    // 🚨 The path must already be an existing FOLDER:
    // a workspace is only ever opened or initialized INSIDE a directory that
    // already exists — the pre-flight never conjures one. This runs BEFORE the
    // container probe so a missing path or a file gets a precise reason ("does
    // not exist" / "is not a folder") instead of the probe's generic "not a
    // wative workspace", and so a missing path can no longer silently auto-create
    // a directory (previously it routed to create). `maskPath` keeps the path out
    // of the message.
    const folder = await checkFolder(root);
    if (folder !== "ok") {
      io.out(`  ${maskPath(root)} ${folder}. Enter the path to an existing folder.`);
      continue;
    }

    const found = await inspect(root);

    switch (routeState(found.state)) {
      case "refuse":
        io.out(`  ${maskPath(root)} holds something that is not a wative workspace. Choose another path.`);
        continue;

      case "create": {
        io.out(`  No wative workspace at ${maskPath(root)} yet.`);
        const yes = await io.promptLine("Initialize a workspace here? (Y/n)", "Y");
        if (!isYes(yes)) continue; // let the user pick a different path
        const password = await createPassword(io);
        try {
          await createWorkspace(root, password);
        } catch (error) {
          // A rare race (a foreign file or a differently-keyed workspace
          // appearing between inspect and create) — re-prompt.
          io.out(`  ${safeMessage(error)} Choose another path.`);
          continue;
        }
        return { path: maskPath(root) };
      }

      case "unlock": {
        try {
          await openLocked(root);
        } catch (error) {
          io.out(`  ${safeMessage(error)} Choose another path.`);
          continue;
        }
        for (;;) {
          const password = await io.promptSecret("Workspace password");
          try {
            await unlock(password);
            return { path: maskPath(root) };
          } catch (error) {
            // Re-prompt, never exit — a wrong password is the likeliest outcome.
            // `safeMessage` discards the library message, so no path can leak here.
            io.out(`  ${safeMessage(error)} Try again.`);
          }
        }
      }
    }
  }
}

/** A yes to the initialize prompt: empty (the default is `Y`), `y`, or `yes`. */
function isYes(answer: string): boolean {
  const a = answer.trim().toLowerCase();
  return a === "" || a === "y" || a === "yes";
}

/**
 * The create-password step: set + confirm, with an advisory strength hint
 * (guidance, not a gate; only an empty password is refused, which is the only
 * value the library itself hard-refuses). The first entry lives only across the
 * confirm compare.
 */
async function createPassword(io: PreflightIO): Promise<string> {
  for (;;) {
    const first = await io.promptSecret("Set a password");
    if (first === "") {
      io.out("  A workspace password cannot be empty.");
      continue;
    }
    const strength = assessPassword(first);
    io.out(`  Strength: ${strength.label}.${strength.weaknesses.length > 0 ? ` ${strength.weaknesses[0]}` : ""}`);

    const second = await io.promptSecret("Confirm password");
    if (second !== first) {
      io.out("  The passwords did not match. Try again.");
      continue;
    }
    return first;
  }
}

/** The real stdout/stdin I/O: readline for lines, raw-mode masking for secrets. */
function defaultIO(): PreflightIO {
  return {
    out: (line) => process.stdout.write(line.endsWith("\n") ? line : `${line}\n`),
    promptLine,
    promptSecret,
  };
}

function promptLine(question: string, display?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = display !== undefined ? ` (default: ${display})` : "";
  return new Promise((resolve) => {
    // Ctrl+C at a readline prompt: in terminal mode readline eats the byte and
    // emits SIGINT rather than letting the OS kill us, and no UI is mounted yet
    // to catch it — so end the process here, mirroring promptSecret.
    rl.on("SIGINT", () => {
      rl.close();
      process.stdout.write("\n");
      process.exit(130);
    });
    rl.question(`? ${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** CSI escape sequence (arrow/nav keys, stray bracketed-paste markers like
 * `ESC[200~`): ESC `[`, params, intermediates, a final byte. */
const CSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
/** A two-byte escape (ESC + a single `Fe` byte): SS2/SS3, Alt-combos, etc. */
const TWO_BYTE_ESCAPE = /\u001b[@-_]/g;

/**
 * A masked secret prompt on raw-mode stdin. Echoes `*` per code point, handles
 * Backspace, Enter, Ctrl+C (exit) and Ctrl+D (end). The value is built in a
 * local and returned; nothing here keeps it.
 *
 * Bracketed paste is NOT enabled yet at pre-flight time (a UI enables it only
 * when its frame mounts), so a paste arrives as raw characters — no marker to
 * strip.
 *
 * ⚠️ Scope note: this strips terminal escape sequences (below) but does NOT yet
 * scrub zero-width / bidi invisibles or disclose a removed-count — acceptable
 * here because bracketed paste is off before any frame and the common case is an
 * ASCII password typed, not pasted.
 */
function promptSecret(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const out = process.stdout;
    out.write(`? ${question}: `);

    const wasRaw = stdin.isRaw ?? false;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();

    // A StringDecoder carries a multi-byte UTF-8 sequence split across chunks
    // (a fast paste arrives in several), so a non-ASCII password is not corrupted.
    const decoder = new StringDecoder("utf8");
    let value = "";
    const cleanup = (): void => {
      stdin.removeListener("data", onData);
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
      stdin.pause();
    };
    const onData = (buf: Buffer): void => {
      // Strip terminal escape sequences before reading (the raw-input scrub
      // discipline): an arrow key is `ESC[D`, whose trailing `[D` are otherwise
      // printable and would be injected into the password. scrubChunk() is not
      // used wholesale because it also strips the line-editing control bytes
      // (Backspace, Ctrl+C/D) this reader must see.
      const chunk = decoder.write(buf).replace(CSI_SEQUENCE, "").replace(TWO_BYTE_ESCAPE, "");
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          out.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          // Ctrl+C — the only way out of the prompt other than answering.
          cleanup();
          out.write("\n");
          process.exit(130);
        }
        if (ch === "\u0004") {
          // Ctrl+D — treat as end-of-input for this prompt.
          cleanup();
          out.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          if (value.length > 0) {
            // Drop one CODE POINT, not one UTF-16 unit, so backspacing an astral
            // character (emoji) leaves no orphaned lone surrogate.
            value = [...value].slice(0, -1).join("");
            out.write("\b \b");
          }
          continue;
        }
        if (ch >= " ") {
          value += ch;
          out.write("*");
        }
        // Any other control character is ignored.
      }
    };
    stdin.on("data", onData);
  });
}
