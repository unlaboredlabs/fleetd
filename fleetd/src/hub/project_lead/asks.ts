// One project's ask of another, without the hub (bridge.ts carries them): what its lead is told at the end, how long
// the same words count as a retry, how many asks project_asks lists, and how many texts two leads may trade an hour.
import type { LeadText } from "../../shared/contracts.ts";

/** How long the same words to the same project count as a retry of the first ask, not a new one. */
export const RETRY_MS = 10 * 60 * 1000;
/** The most asks project_asks lists. */
export const ASKS_MAX = 100;
/** The most texts two bots' leads on this hub trade in an hour, both ways together: past it, the next is refused. */
export const PAIR_PER_HOUR = 10;
export const HOUR_MS = 60 * 60 * 1000;

/** What a project's lead is told at the end of an ask. */
export const askFooter = (handle: string) =>
  `(Ask ${handle}. If you open an order for it, pass asked: "${handle}" to brief, so the asker hears when it lands. If you fold it into an order already open, call brief with that workstreamId and asked: "${handle}".)`;

/** What a lead is told at the end of another bot's lead's text: what it is, how to answer it, and how to open work for it. */
export function leadFooter(from: string, lead: LeadText): string {
  const h = lead.handle;
  const what = lead.reply !== undefined ? `${from}'s reply to your ${lead.reply}, as ${h}` : `Text ${h} from the lead of ${from}`;
  return `(${what}. Answer with project_message reply: "${h}" only when the work needs an answer; a heads-up, a thanks or an agreement needs none. If you judge it worth an order, pass asked: "${h}" to brief, so ${from} hears when it lands. The human sees this exchange in your chat already: never retell it, and end the turn with (quiet) unless they must act or decide.)`;
}
