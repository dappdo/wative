/**
 * A password-strength assessment — advisory, delegating the SCORING to
 * wative-core's `PasswordPolicy` (2.5.7) with this package's own presentation on
 * top.
 *
 * The design is to show **live strength with named weaknesses on create/reset
 * only, never on unlock** — guidance, not a gate. So this never rejects a password (the create flow still accepts whatever
 * the user confirms); it only reports how strong it is and what would make it
 * stronger. We use `PasswordPolicy.check()` (which returns a verdict and NEVER
 * throws), not `.enforce()` (which throws).
 *
 * 🚨 Pure + value-free. `check()` returns a 0–4 `score` and coded weaknesses.
 * We map each `PasswordWeaknessCode` to a FIXED, value-free, ASCII-only string —
 * we NEVER render the library's own `weakness.message`, because it may embed the
 * password (e.g. a forbidden word / username substring) or an ambiguous-width
 * glyph, which is both a plaintext leak and an ambiguous-width display hazard.
 * The caller runs this on its own transient buffer and renders only this verdict,
 * so the plaintext never leaves the field.
 *
 * This replaces a former hand-rolled length-and-variety heuristic: 2.5.7 ships
 * the scorer with zero added dependency, so this layer no longer maintains its
 * own. The library normalizes Unicode (NFC) and flags mixed-normalization and
 * invisible characters — stronger than the old code-point count — so a decomposed
 * password is scored against the form the KDF actually derives from.
 */
import { PasswordPolicy } from "wative-core";
import type { PasswordWeaknessCode } from "wative-core";

/** 0 = worst, 4 = best — the familiar five-step scale (maps 1:1 to `PasswordScore`). */
export type StrengthScore = 0 | 1 | 2 | 3 | 4;

export interface Strength {
  readonly score: StrengthScore;
  /** A one-word label for the score. */
  readonly label: "very weak" | "weak" | "fair" | "good" | "strong";
  /** Named, actionable, value-free suggestions — most important first, de-duplicated.
   * (A surface that shows only the first, like the pre-flight line, must see the
   * most important one — the library does not guarantee that order.) */
  readonly weaknesses: readonly string[];
}

const LABELS: Record<StrengthScore, Strength["label"]> = {
  0: "very weak",
  1: "weak",
  2: "fair",
  3: "good",
  4: "strong",
};

/** The most-abused passwords, handed to the policy as `forbiddenWords` so a
 * `FORBIDDEN_WORD` knocks the score to 0 — this package's specific blocklist on
 * top of the library's own common-password detection. A short, honest list. */
const COMMON = [
  "password",
  "password1",
  "password123",
  "123456",
  "12345678",
  "123456789",
  "qwerty",
  "qwertyuiop",
  "letmein",
  "iloveyou",
  "admin",
  "welcome",
  "monkey",
  "abc123",
  "111111",
  "000000",
];

/** Constructed once: advisory only, so no `require*`/`minScore` gates — we read
 * the score and weaknesses and never call `.enforce()`. */
const POLICY = new PasswordPolicy({ forbiddenWords: COMMON });

/**
 * Each `PasswordWeaknessCode` → a FIXED, value-free, ASCII-only suggestion. The
 * full set is mapped (exhaustive — TS enforces every code has an arm), though
 * some codes only fire with a username/history context or `require*` options
 * this policy does not set. ASCII punctuation only (`:`/`;`/`-`), never an
 * ambiguous-width glyph (a display-skew hazard). The four
 * class-deficiency codes share one message and de-duplicate at assembly.
 */
const WEAKNESS_MESSAGE: Record<PasswordWeaknessCode, string> = {
  TOO_SHORT: "Too short: use at least 12 characters.",
  NO_UPPERCASE: "Mix in upper- and lower-case, numbers, and symbols.",
  NO_LOWERCASE: "Mix in upper- and lower-case, numbers, and symbols.",
  NO_DIGIT: "Mix in upper- and lower-case, numbers, and symbols.",
  NO_SYMBOL: "Mix in upper- and lower-case, numbers, and symbols.",
  REPEATED_CHARS: "Avoid repeating the same character.",
  SEQUENTIAL_CHARS: "Avoid predictable runs of consecutive letters or numbers.",
  USERNAME_SUBSTRING: "Do not base your password on your username.",
  FORBIDDEN_WORD: "This is a commonly used password; pick something unique.",
  REUSED_FROM_HISTORY: "You have used this password before; pick a new one.",
  LEADING_TRAILING_WHITESPACE: "Remove the leading or trailing spaces.",
  MIXED_UNICODE_NORMALIZATION: "Use plain, consistent characters (avoid mixed Unicode forms).",
  INVISIBLE_CHARACTERS: "Remove the invisible or control characters.",
};

/**
 * Most-important-first priority for the weaknesses. The library tags each as
 * `critical`/`warning`/`info`, but ties within a tier (e.g. a common password is
 * BOTH `TOO_SHORT` and `FORBIDDEN_WORD`, both `critical`) need a deterministic
 * order so a first-only surface shows the headline problem. A known-bad or
 * identity/invisible issue outranks length, which outranks the pattern/variety
 * hints. A code not listed here sorts last (it still shows, just lower).
 */
const WEAKNESS_PRIORITY: readonly PasswordWeaknessCode[] = [
  "FORBIDDEN_WORD",
  "REUSED_FROM_HISTORY",
  "USERNAME_SUBSTRING",
  "INVISIBLE_CHARACTERS",
  "LEADING_TRAILING_WHITESPACE",
  "MIXED_UNICODE_NORMALIZATION",
  "TOO_SHORT",
  "NO_UPPERCASE",
  "NO_LOWERCASE",
  "NO_DIGIT",
  "NO_SYMBOL",
  "REPEATED_CHARS",
  "SEQUENTIAL_CHARS",
];

const rankOf = (code: PasswordWeaknessCode): number => {
  const i = WEAKNESS_PRIORITY.indexOf(code);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
};

/**
 * Assess a password's strength. Never throws, never echoes the value.
 */
export function assessPassword(value: string): Strength {
  if (value === "") {
    return { score: 0, label: LABELS[0], weaknesses: ["Enter a password."] };
  }

  const result = POLICY.check(value);
  const score = Math.max(0, Math.min(4, result.score)) as StrengthScore;

  // Order most-important-first, then map codes → fixed value-free strings,
  // de-duplicated. An unknown future code maps to nothing rather than leaking the
  // library's own (possibly value-bearing) message.
  const ordered = [...result.weaknesses].sort((a, b) => rankOf(a.code) - rankOf(b.code));
  const seen = new Set<string>();
  const weaknesses: string[] = [];
  for (const weakness of ordered) {
    const message = WEAKNESS_MESSAGE[weakness.code];
    if (message !== undefined && !seen.has(message)) {
      seen.add(message);
      weaknesses.push(message);
    }
  }

  return { score, label: LABELS[score], weaknesses };
}
