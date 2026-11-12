// An order's GitHub token at its agents, without the hub (sessions.ts hands it over): the placeholders that take it
// back, what a task started without one is told, how long one lasts before it is renewed, and the lead's line when it
// is taken back.

/** The node capability an `order:` sink needs (contracts `CAP_ORDER_ENV`). */
export const CAP_ORDER_ENV = "order_env";

/** What an order's agents hold as `GH_TOKEN` once their person's token is taken back: GitHub refuses it. */
export const BLOCKED_TOKEN = "fleetd-github-not-connected-connect-it-in-settings";
/** What an order's agents hold as `GH_TOKEN` once theirs ended before the hub could renew it. */
export const UNRENEWED_TOKEN = "fleetd-github-token-not-renewed-ask-your-lead";

/** What a task launched while GitHub gave no token for its order is told, after its prompt: it starts anyway. */
export const TOKEN_PENDING =
  "GitHub gave fleetd no token for this order when you started (GitHub may be unreachable from the hub), so GH_TOKEN " +
  "doesn't work yet and gh and git push fail. fleetd tries again every 5 minutes, and the token reaches your next " +
  "command once GitHub answers: go on with what doesn't need GitHub, keep your work committed, and push once gh works.";

/** A token handed to an agent's sessions has at least this long left: one this close to its end is refreshed first. */
export const SESSION_MARGIN_MS = 2 * 60 * 60_000;

/** Why a token is taken back: its person disconnected, or the hub couldn't renew it. */
export type Block = { kind: "disconnected" } | { kind: "not_renewed"; why: string };

/** What the lead hears when an order's token is taken back from its agents: `name` is the person whose token it was. */
export function blockedLine(order: string, name: string, why: Block): string {
  return why.kind === "disconnected"
    ? `${order}: ${name}'s GitHub is no longer connected, so its agents' gh fails (GitHub says bad credentials) rather than ` +
      `use anyone else's account. Ask ${name} to connect GitHub in Settings › Your accounts › GitHub; their agents get the token back ` +
      "at their next command."
    : `${order}: its agents' GitHub token ended and the hub couldn't renew it (${why.why}), so their gh fails (GitHub says bad ` +
      "credentials) rather than use the machine's own login. The hub tries again every 5 minutes and the agents " +
      "get the new token at their next command; if it keeps failing, an admin runs Test in Settings › Hub " +
      "accounts › GitHub.";
}
