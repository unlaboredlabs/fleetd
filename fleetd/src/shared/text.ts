// Text helpers the hub's lines share (`clip`).

/** `text` cut to `max` UTF-16 units, the last one "…": the contracts' text limits count in those. */
export function ellipsize(text: string, max: number): string {
  if (text.length <= max) return text;
  let used = 0;
  let out = "";
  for (const c of text) {
    used += c.length;
    if (used >= max) break;
    out += c;
  }
  return `${out}…`;
}

/** The text on one line, its whitespace runs one space, cut to `max`. */
export const oneLine = (text: string, max: number) => ellipsize(text.split(/\s+/).filter(Boolean).join(" "), max);

/** `"text"`, on one line and at most 300 units, as lead event lines quote it. */
export const quote = (text: string) => `"${oneLine(text, 300)}"`;

/** The first `max` UTF-16 units of `s`, never splitting a character (JS `slice(0, max)` that keeps pairs whole). */
export function jsPrefix(s: string, max: number): string {
  if (s.length <= max) return s;
  let units = 0;
  let out = "";
  for (const c of s) {
    units += c.length;
    if (units > max) return out;
    out += c;
  }
  return s;
}

/** The longest suffix of `s` with at most `max` UTF-16 units. */
export function jsSuffix(s: string, max: number): string {
  if (s.length <= max) return s;
  const chars = [...s];
  let units = 0;
  let i = chars.length;
  while (i > 0) {
    units += (chars[i - 1] as string).length;
    if (units > max) break;
    i--;
  }
  return chars.slice(i).join("");
}

/** `text` if it fits in `max` UTF-16 units, else "…" and its last `max - 1`. */
export const keepTail = (text: string, max: number) => (text.length <= max ? text : `…${jsSuffix(text, max - 1)}`);

/** Standard base64 with its padding, as Rust's `STANDARD` engine decodes it. */
export const isBase64 = (text: string) => text.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(text);
