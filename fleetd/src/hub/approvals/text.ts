// Text helpers approvals shares with the rest of its area (approvals'
// `shown_argv`).

/** At most `max` characters (code points), the last one "…" when cut. */
export function clip(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  return `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

const PLAIN_WORD = /^[\p{L}\p{M}\p{N}\p{Pc}./:=@%+-]+$/u;

/** argv as one readable line: JSON quoting only for words that need it. */
export const shownArgv = (argv: readonly string[]) => argv.map((w) => (PLAIN_WORD.test(w) ? w : JSON.stringify(w))).join(" ");
