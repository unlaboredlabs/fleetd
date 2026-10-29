// What an approval card shows of a character that hides or reorders text: a visible mark such as ⟨U+202E⟩ in its
// place, so what a person reads is what runs or goes out (D183/D193). The characters are those the hub's
// push::plain refuses on a notification that offers Approve, so the hub, the notification and the cards agree. Shared
// by the desktop's cards and the phone's (app/mobile/src/desktop.ts); only how a text shows changes, never the text.

/** Whether `c`, one code point, hides or reorders text: as push::plain's class, character for character. */
export const isHidden = (c: string): boolean => {
  const n = c.codePointAt(0) ?? 0;
  return (
    // Control characters (Rust's char::is_control): \t, \n, \r, ESC, DEL, NEL and the rest of C0 and C1.
    n <= 0x1f ||
    (n >= 0x7f && n <= 0x9f) ||
    // Line and paragraph separators.
    n === 0x2028 ||
    n === 0x2029 ||
    // Bidi marks, embeddings, overrides and isolates.
    n === 0x200e ||
    n === 0x200f ||
    n === 0x061c ||
    (n >= 0x202a && n <= 0x202e) ||
    (n >= 0x2066 && n <= 0x2069) ||
    // Zero-width spaces, joiners, the word joiner and invisible operators, the BOM, the Mongolian vowel separator,
    // soft hyphen and other default-ignorable fillers, variation selectors and tag characters.
    (n >= 0x200b && n <= 0x200d) ||
    (n >= 0x2060 && n <= 0x2064) ||
    n === 0xfeff ||
    n === 0x180e ||
    n === 0x00ad ||
    n === 0x034f ||
    n === 0x115f ||
    n === 0x1160 ||
    n === 0x3164 ||
    n === 0xffa0 ||
    n === 0x17b4 ||
    n === 0x17b5 ||
    (n >= 0xfe00 && n <= 0xfe0f) ||
    (n >= 0xe0000 && n <= 0xe007f)
  );
};

/** The mark shown in a hidden character's place: ⟨U+202E⟩. */
export const markOf = (c: string): string => `⟨U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}⟩`;

const between = (n: number, from: number, to: number): boolean => n >= from && n <= to;

/** A pictographic emoji, close to Extended_Pictographic without a property escape (Hermes lacks the emoji ones). */
const emoji = (c: string | undefined): boolean => {
  const n = c?.codePointAt(0) ?? 0;
  return between(n, 0x1f000, 0x1faff) || between(n, 0x2600, 0x27bf) || between(n, 0x2300, 0x23ff) || between(n, 0x2b00, 0x2bff) || n === 0x00a9 || n === 0x00ae || n === 0x203c || n === 0x2049 || n === 0x2122;
};

/** A skin tone after an emoji: 👋🏽. */
const skinTone = (c: string | undefined): boolean => between(c?.codePointAt(0) ?? 0, 0x1f3fb, 0x1f3ff);

/** A letter of a script whose words join or break with ZWJ and ZWNJ: Arabic, Syriac, N'Ko, Mongolian, the Indic scripts. */
const joining = (c: string | undefined): boolean => {
  if (c === undefined || isHidden(c) || !/[\p{L}\p{M}]/u.test(c)) return false;
  const n = c.codePointAt(0) ?? 0;
  return between(n, 0x0600, 0x07ff) || between(n, 0x0840, 0x08ff) || between(n, 0x0900, 0x0dff) || between(n, 0x1800, 0x18af) || between(n, 0xfb50, 0xfdff) || between(n, 0xfe70, 0xfefe);
};

/**
 * Whether the hidden character at `i` is part of ordinary writing, which shows as written: the joiner inside an emoji
 * (👩‍💻), the emoji selector after one (❤️, 1️⃣), and ZWJ or ZWNJ inside a Persian or Hindi word. Each draws what is
 * there; none hides a word. Anything else, a tag character in a flag among them, is marked.
 */
const natural = (cs: readonly string[], i: number): boolean => {
  const c = cs[i];
  const prev = cs[i - 1];
  const next = cs[i + 1];
  if (c === "‍" || c === "‌") {
    if (joining(prev) && joining(next)) return true;
    if (c === "‌") return false;
    const base = prev === "️" ? cs[i - 2] : prev;
    return (emoji(base) || skinTone(base)) && emoji(next);
  }
  if (c === "️" || c === "︎") return emoji(prev) || (prev !== undefined && /^[0-9#*]$/u.test(prev) && next === "⃣");
  return false;
};

export type Piece = { readonly text: string; readonly mark?: undefined } | { readonly text: string; readonly mark: string };

/**
 * `text` as runs of what shows as written and, for each hidden character, its mark (`text` keeps the character).
 * `lines`: a body or a block of lines, whose \n breaks the line as written; anywhere else a \n is marked.
 */
export const pieces = (text: string, lines = false): Piece[] => {
  const cs = Array.from(text);
  const out: Piece[] = [];
  let run = "";
  cs.forEach((c, i) => {
    if (!isHidden(c) || (lines && c === "\n") || natural(cs, i)) {
      run += c;
      return;
    }
    if (run !== "") out.push({ text: run });
    run = "";
    out.push({ text: c, mark: markOf(c) });
  });
  if (run !== "") out.push({ text: run });
  return out;
};

/** Whether `text` holds a character its card marks. */
export const hasHidden = (text: string, lines = false): boolean => pieces(text, lines).some((p) => p.mark !== undefined);

/** `text` with each hidden character as its mark: for a line that is one string, such as a folded row. */
export const marked = (text: string, lines = false): string =>
  pieces(text, lines)
    .map((p) => p.mark ?? p.text)
    .join("");

/** One argument of a command as a person can read and paste it, quoted only when it needs it. */
export const shellWord = (a: string): string => (/^[\w@%+=:,./-]+$/u.test(a) ? a : `'${a.replace(/'/gu, `'\\''`)}'`);

/** The warning a card shows once any of its fields holds a marked character. */
export const HIDDEN_WARNING = "Contains hidden characters";
