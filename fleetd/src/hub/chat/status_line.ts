// A bot's status line (W950): the short line its lead writes on where things stand as a turn ends ("Need your yes on
// the Friday deck", `checklist`'s `status`), which the sidebar and the phone's chat list show under the bot's name in place of its newest
// message. One per bot, kept until the lead writes another; a person's message written after it sets it aside, so a
// line about what came before never stands over what they just said. Pure, so the cloud checks a line the same way.

/** The most characters a status line holds: one glance in a sidebar row. */
export const STATUS_LINE_MAX = 80;

/** What is wrong with `line` as a status line, for the lead to fix; undefined when it is fine. */
export function statusLineProblem(line: unknown): string | undefined {
  if (typeof line !== "string") return "status: give the line as a string.";
  const n = [...line.trim()].length;
  if (n === 0) return "status: say where things stand in a few words, such as \"Need your yes on the Friday deck\".";
  if (n > STATUS_LINE_MAX) return `status: keep it to ${String(STATUS_LINE_MAX)} characters, one glance; it is ${String(n)}.`;
  if (/[\r\n]/.test(line)) return "status: one line, no line breaks.";
  return undefined;
}

/**
 * The status line a chat state carries: the lead's, unless a person wrote in the chat since (`humanMs`, their newest
 * message's time), when the row falls back to the newest message.
 */
export function statusShown(status: { line: string; atMs: number } | undefined, humanMs: number | undefined): { line: string; atMs: number } | undefined {
  if (status === undefined) return undefined;
  return humanMs !== undefined && humanMs > status.atMs ? undefined : status;
}
