/**
 * The PURE masked-secret input reducer + terminal escape-scrub, lifted out of the
 * Node pre-flight's raw-mode reader so the same keystroke semantics can back a
 * browser secret field. It holds NOTHING: it is a pure transition over an
 * accumulated value, returning the new value plus the display effects to apply.
 * The Node reader (`preflight.ts`) keeps the stdin / raw-mode / `StringDecoder`
 * glue and applies these effects to `process.stdout`.
 *
 * ⚠️ SCOPE — the escape-scrub here strips TERMINAL escape sequences (CSI / two-byte
 * `Fe`), which is sufficient for a Node TTY where bracketed paste is off before any
 * frame. It does NOT scrub zero-width / bidi invisibles or bracketed-paste markers.
 * A BROWSER consumer (where paste is always on) MUST strengthen the scrub before
 * feeding chunks in — do not assume this is paste-safe outside a pre-frame TTY.
 */

/** CSI escape sequence (arrow/nav keys, stray bracketed-paste markers like
 * `ESC[200~`): ESC `[`, params, intermediates, a final byte. */
export const CSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
/** A two-byte escape (ESC + a single `Fe` byte): SS2/SS3, Alt-combos, etc. */
export const TWO_BYTE_ESCAPE = /\u001b[@-_]/g;

/** Strip the terminal escape sequences a raw-mode reader must not inject into the
 * value. (Node-TTY-sufficient; a browser must add zero-width / bidi / paste
 * scrubbing on top.) */
export function scrubEscapes(chunk: string): string {
  return chunk.replace(CSI_SEQUENCE, "").replace(TWO_BYTE_ESCAPE, "");
}

/** A display effect the caller applies to its own output surface. */
export type SecretInputEffect =
  | { readonly kind: "echo"; readonly text: string } // write the mask char(s) for a visible code point
  | { readonly kind: "backspace" } //                   erase one echoed char (e.g. "\b \b")
  | { readonly kind: "submit" } //                      Enter: the value is complete
  | { readonly kind: "end" } //                         Ctrl+D: end-of-input, value complete
  | { readonly kind: "cancel" }; //                     Ctrl+C: abort

export interface SecretInputStep {
  /** The accumulated secret after folding in this chunk. */
  readonly value: string;
  /** Effects to apply, in order; a terminator (submit/end/cancel) is always last. */
  readonly effects: readonly SecretInputEffect[];
  /** True once a submit/end/cancel terminator was seen (stop reading). */
  readonly done: boolean;
}

/**
 * Fold one decoded input `chunk` into the accumulated `value`, returning the new
 * value, the display effects, and whether input is complete. Pure — keeps nothing.
 * `mask` is echoed per visible code point (default `*`).
 *
 * The chunk is escape-scrubbed first; then each code point is classified: Enter →
 * submit, Ctrl+C → cancel, Ctrl+D → end, Backspace/DEL → drop one CODE POINT (so
 * backspacing an astral character leaves no orphaned lone surrogate), any char
 * `>= " "` → append + echo, any other control character → ignored.
 */
export function stepSecretInput(value: string, chunk: string, mask = "*"): SecretInputStep {
  const effects: SecretInputEffect[] = [];
  let next = value;
  for (const ch of scrubEscapes(chunk)) {
    if (ch === "\r" || ch === "\n") return { value: next, effects: [...effects, { kind: "submit" }], done: true };
    if (ch === "\u0003") return { value: next, effects: [...effects, { kind: "cancel" }], done: true };
    if (ch === "\u0004") return { value: next, effects: [...effects, { kind: "end" }], done: true };
    if (ch === "\u007f" || ch === "\b") {
      if (next.length > 0) {
        next = [...next].slice(0, -1).join("");
        effects.push({ kind: "backspace" });
      }
      continue;
    }
    if (ch >= " ") {
      next += ch;
      effects.push({ kind: "echo", text: mask });
    }
    // any other control character is ignored
  }
  return { value: next, effects, done: false };
}
