// One project's ask of another, without the hub (bridge.ts carries them): what its lead is told at the end, how long
// the same words count as a retry, and how many asks navi_asks lists.

/** How long the same words to the same project count as a retry of the first ask, not a new one. */
export const RETRY_MS = 10 * 60 * 1000;
/** The most asks navi_asks lists. */
export const NAVI_ASKS_MAX = 100;

/** What a project's lead is told at the end of an ask. */
export const askFooter = (handle: string) =>
  `(Ask ${handle}. If you open an order for it, pass asked: "${handle}" to brief, so the asker hears when it lands. If you fold it into an order already open, call brief with that workstreamId and asked: "${handle}".)`;
