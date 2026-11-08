// The digest's text helpers (crates/fleetd/src/hub/leads/digest.rs `one_line`, `clip`): the contracts' text limits
// count UTF-16 units, as JavaScript strings do.

/** `text` cut to `max` UTF-16 units, the last one "…". */
export function clip(text: string, max: number): string {
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

/** `text` on one line (runs of whitespace one space), clipped to `max`. */
export const oneLine = (text: string, max: number) => clip(text.split(/\s+/u).filter(Boolean).join(" "), max);
