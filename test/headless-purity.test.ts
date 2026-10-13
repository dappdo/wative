/**
 * Headless-purity guard — the structural proof the `wative` package stays pure
 * logic.
 *
 * A headless or embedding consumer depends on ZERO terminal-UI code. typecheck and
 * build stay green even if a future edit pulled `ink`/`react`/`figlet`/`chalk` back
 * in, so this closes that gap directly: it transitively walks the import graph from
 * the package's entrypoints and fails if any reachable module imports a display
 * package. Pure static analysis — no runtime, no transpile.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(fileURLToPath(import.meta.url), "../../src");

/** The package's headless entrypoints the guard walks. */
const ROOTS = ["bootstrap.ts", "headless.ts"];

/** Bare display/UI packages the package must never import. */
function isForbiddenPackage(spec: string): boolean {
  return (
    spec === "ink" ||
    spec === "figlet" ||
    spec === "chalk" ||
    spec === "react" ||
    spec.startsWith("react/") ||
    spec.startsWith("react-")
  );
}

/** Every import/export/dynamic-import specifier in a source file (comments stripped
 *  so a doc-comment mentioning `from "ink"` can't false-trip the guard). */
function specifiersOf(file: string): string[] {
  const text = readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/(^|[^:])\/\/.*$/gm, "$1"); // line comments (but not `://` in a URL)
  const out: string[] = [];
  const re = /(?:\bfrom\s*|\bimport\s*|\bimport\(\s*)["']([^"']+)["']/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const spec = m[1];
    if (spec !== undefined) out.push(spec);
  }
  return out;
}

/** Resolve a relative `.js`-style ESM specifier to its on-disk .ts/.tsx source. */
function resolveLocal(fromFile: string, spec: string): string | undefined {
  const base = path.resolve(path.dirname(fromFile), spec.replace(/\.js$/, ""));
  for (const cand of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    try {
      readFileSync(cand);
      return cand;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

test("the package's headless entrypoints and their whole graph import no ink/react/figlet/chalk", () => {
  const visited = new Set<string>();
  const violations: string[] = [];
  const queue = ROOTS.map((r) => path.join(SRC, r));

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (visited.has(file)) continue;
    visited.add(file);
    for (const spec of specifiersOf(file)) {
      if (spec.startsWith(".")) {
        const resolved = resolveLocal(file, spec);
        if (resolved === undefined) continue; // unresolvable (e.g. a .d.ts-only path): skip
        queue.push(resolved);
      } else if (isForbiddenPackage(spec)) {
        violations.push(`${path.relative(SRC, file)} → ${spec}  (display package)`);
      }
      // other bare specifiers (node:*, wative-core, …) are allowed and not walked
    }
  }

  assert.deepEqual(violations, [], `the package must stay UI-free — leaks found:\n${violations.join("\n")}`);
  // Sanity (independent oracle): prove the walk actually traversed the domain
  // bundle rather than silently matching nothing (bootstrap→preflight→core/*).
  assert.ok(visited.size >= 5, `expected the walk to reach the domain bundle; visited only ${visited.size} files`);
});
