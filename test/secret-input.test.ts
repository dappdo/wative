/**
 * The pure masked-secret input reducer (extracted from the pre-flight raw-mode
 * reader). Previously this logic lived inside the untested stdin glue; now that it
 * is a pure transition it can be pinned directly — including the two subtle
 * invariants: terminal escape sequences are scrubbed (never injected into the
 * secret), and Backspace removes a whole CODE POINT (astral-safe).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { stepSecretInput, scrubEscapes } from "../src/core/secretInput.js";

test("visible chars append to the value and echo the mask per code point", () => {
  const step = stepSecretInput("", "abc");
  assert.equal(step.value, "abc");
  assert.equal(step.done, false);
  assert.deepEqual(step.effects, [
    { kind: "echo", text: "*" },
    { kind: "echo", text: "*" },
    { kind: "echo", text: "*" },
  ]);
});

test("Enter submits (value complete, done); Ctrl+C cancels; Ctrl+D ends", () => {
  const enter = stepSecretInput("pw", "\r");
  assert.equal(enter.done, true);
  assert.equal(enter.value, "pw");
  assert.equal(enter.effects.at(-1)?.kind, "submit");
  assert.equal(stepSecretInput("x", "\u0003").effects.at(-1)?.kind, "cancel");
  assert.equal(stepSecretInput("x", "\u0004").effects.at(-1)?.kind, "end");
});

test("Backspace drops one whole CODE POINT (astral-safe) and emits a backspace effect", () => {
  const typed = stepSecretInput("", "a\u{1F600}"); // "a" + 😀 (astral)
  assert.equal(typed.value, "a\u{1F600}");
  const back = stepSecretInput(typed.value, "\u007f");
  assert.equal(back.value, "a", "the whole astral code point is removed — no lone surrogate");
  assert.deepEqual(back.effects, [{ kind: "backspace" }]);
});

test("Backspace on an empty value is a no-op (no effect)", () => {
  const step = stepSecretInput("", "\u007f");
  assert.equal(step.value, "");
  assert.deepEqual(step.effects, []);
});

test("terminal escape sequences are scrubbed, not injected into the value", () => {
  const step = stepSecretInput("", "a\u001b[Db"); // arrow key ESC[D between two chars
  assert.equal(step.value, "ab", "the ESC[D is stripped, leaving only the typed chars");
  assert.equal(scrubEscapes("\u001b[200~"), "", "a bracketed-paste CSI marker is stripped");
});

test("a chunk mixing input then a terminator stops at the terminator", () => {
  const step = stepSecretInput("", "ab\rc");
  assert.equal(step.value, "ab", "chars after Enter are not consumed");
  assert.equal(step.done, true);
  assert.equal(step.effects.at(-1)?.kind, "submit");
});
