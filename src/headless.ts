#!/usr/bin/env node
/**
 * A minimal headless example: unlock a workspace through the same pre-flight an
 * interactive UI would use, make one `wative-core`-backed read, print it, and exit.
 *
 * It imports ONLY `bootstrap` + the `session` facade — no `ink`, no `react`, no
 * terminal-UI code — so it doubles as a runnable proof that the package is usable
 * with no UI at all. Not wired as a bin; run it with `node dist/headless.js` (or
 * `tsx src/headless.ts`).
 */
import { bootstrap } from "./bootstrap.js";
import { accounts } from "./core/session.js";

void bootstrap(async (ctx) => {
  const rows = accounts() ?? [];
  process.stdout.write(`opened ${ctx.opened.path}\n${rows.length} account(s)\n`);
  ctx.lock();
  process.exit(0);
});
