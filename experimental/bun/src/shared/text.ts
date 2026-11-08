// Text helpers the hub's lines share (crates/fleetd/src/hub/leads/digest.rs `one_line`, `clip`).

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
