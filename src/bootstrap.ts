/**
 * The bootstrap — **the entry point of the `wative` package.** Pure logic, no UI.
 *
 * It arms the process lifecycle (diagnostics off, panic-lock, signal + crash
 * handling) BEFORE any secret can exist, runs the pre-flight to open + unlock a
 * workspace, and hands the opened workspace to a **pluggable** post-unlock
 * entrypoint via `ctx`. One such entrypoint is an interactive terminal UI; another
 * is a headless "unlock → call a contract → print" module (see this package's
 * `headless.ts`).
 *
 * There is NO `ink`/`react`/`figlet`/`chalk` (or any terminal-UI) import here, by
 * design: a headless consumer of `bootstrap` depends on zero terminal-UI code, and
 * the headless-purity test enforces it.
 *
 * 🚨 Secret-safety ordering is load-bearing: the exit, signal and crash handlers
 * (and `panicLock`) are armed FIRST — before `onStart` and before the pre-flight
 * reads a password — so a throw or a dropped pty during the pre-flight still clears
 * the secret.
 */
import { panicLock } from "./core/session.js";
import { runPreflight, type OpenedWorkspace } from "./preflight.js";

/** What the bootstrap hands a post-unlock entrypoint. */
export interface BootstrapContext {
  /** The opened, unlocked workspace. */
  readonly opened: OpenedWorkspace;
  /** Panic-lock the workspace now; also runs automatically on every exit path. */
  readonly lock: () => void;
  /**
   * Register a teardown run on every exit path, AFTER the lock — e.g. a UI unwinds
   * its terminal state (leave alt screen, disable bracketed paste) here.
   */
  readonly onCleanup: (fn: () => void) => void;
  /**
   * Declare that an interactive frame now owns stdin: a termination SIGNAL then
   * invokes `onSignalExit` (e.g. unmount the UI so the process exits cleanly)
   * instead of ending the process directly. Before this is set, a signal ends the
   * process — there is no frame to unwind.
   */
  readonly setFramed: (onSignalExit: () => void) => void;
}

export interface BootstrapOptions {
  /**
   * The workspace opener. Defaults to the real pre-flight; injected by tests and
   * by a headless caller that supplies the password another way.
   */
  readonly preflight?: () => Promise<OpenedWorkspace>;
  /**
   * Run after the lifecycle handlers are armed and before the pre-flight. A UI
   * entrypoint prints its (coloured) banner here, so this layer owns no banner.
   */
  readonly onStart?: () => void;
  /**
   * Test seam: skip registering process-level handlers (avoids listener leaks and
   * an in-process `process.exit`). Default false.
   */
  readonly bare?: boolean;
}

/**
 * Arm the lifecycle, open a workspace via the pre-flight, and run `entrypoint`
 * with the opened workspace. Returns the entrypoint's result.
 */
export async function bootstrap<T>(
  entrypoint: (ctx: BootstrapContext) => Promise<T>,
  opts: BootstrapOptions = {},
): Promise<T> {
  // Diagnostics off before anything else: `process.report` would otherwise write
  // the full environment + command line into a crash file.
  process.report.excludeEnv = true;

  const cleanups: Array<() => void> = [];
  let onSignalExit: (() => void) | undefined;

  const lock = (): void => panicLock();
  // Secret first, then best-effort teardown: a teardown throw (EPIPE on a closed
  // pty) must never leave the secret in memory.
  const cleanup = (): void => {
    lock();
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch {
        // best-effort; the lock already ran
      }
    }
  };

  if (opts.bare !== true) {
    process.on("exit", cleanup);
    const quit = (): void => {
      lock();
      // Before a frame owns stdin there is nothing to unwind — end the process.
      // After it, the frame's own teardown resolves and the process exits cleanly.
      if (onSignalExit) onSignalExit();
      else process.exit(130);
    };
    process.on("SIGINT", quit);
    process.on("SIGTERM", quit);
    process.on("SIGHUP", quit);
    process.stdin.on("end", quit);
    process.stdin.on("close", quit);
    // A crash must not print a stack: wative-core does not redact `Error.message`/
    // `Error.stack`, and a bad-mnemonic path can carry the phrase. One generic line.
    const bail =
      (what: string) =>
      (): void => {
        cleanup();
        process.stderr.write(`wative: ${what}.\n`);
        process.exit(1);
      };
    process.on("uncaughtException", bail("unexpected error"));
    process.on("unhandledRejection", bail("unexpected error"));
  }

  opts.onStart?.();

  const open = opts.preflight ?? runPreflight;
  let opened: OpenedWorkspace;
  try {
    opened = await open();
  } catch {
    // The pre-flight re-prompts on every expected failure, so a throw here is
    // genuinely unexpected. One generic line — no detail, which could carry a path.
    cleanup();
    process.stderr.write("wative: could not open the workspace.\n");
    process.exit(1);
  }

  return entrypoint({
    opened,
    lock,
    onCleanup: (fn) => cleanups.push(fn),
    setFramed: (fn) => {
      onSignalExit = fn;
    },
  });
}
