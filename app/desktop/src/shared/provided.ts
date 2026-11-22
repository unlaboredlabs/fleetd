// fleetd's computers as a fleetd cloud team's Machines page words them (admin/Provided.tsx, settings/Places.tsx, the
// phone's Machines): What runs where's Linux machine between the team's own machines and fleetd's computers, the Mac
// machine's line, and the fleetd's computers group's words. Apart from providers.ts and billing.ts, which the web app's
// first load carries, so only the Settings that shows them loads them.
import { hours, money, topLine, type BillingState } from "./billing";
import { FLEETD_COMPUTERS, YOURS, type Choice } from "./providers";

/** A fleetd cloud team's provider (SandboxState.provided): fleetd's own computers, never its provider's name. */
export const FLEETD = FLEETD_COMPUTERS;

/**
 * The Linux machine's choices on a fleetd cloud team (sandbox_get's `provided`): with a machine of the team's that runs
 * agents, Your machines, Your machines first then fleetd's computers, or fleetd's computers only, each `value` the
 * cloud's own (`ours_only`, `ours_first`, its provider's id); with none, fleetd's computers alone, which the cloud then
 * answers whatever was picked: not a choice, a plain value.
 */
export const providedChoices = (provider: string, machines: boolean): Choice[] =>
  machines
    ? [
        { value: "ours_only", label: YOURS },
        { value: "ours_first", label: `${YOURS} first, then ${FLEETD}` },
        { value: provider, label: `${FLEETD} only` },
      ]
    : [{ value: provider, label: FLEETD }];

/**
 * The Linux machine on a fleetd cloud team whose cloud doesn't answer the pick yet (sandbox_get not found): each bot
 * runs where New bot made it, so it is where the team's bots can be, as a plain value.
 */
export const providedValue = (machines: boolean): string => (machines ? `${YOURS} and ${FLEETD}` : FLEETD);

/** The Mac machine's line on a fleetd cloud team: Macs are the team's own only. */
export const MAC_OWN_ONLY = `${FLEETD} don't run Macs`;

/** How many of fleetd's computers run now of what the team's plan allows; null while its credits or cap hold them all. */
export const atOnceWord = (hosted: ReadonlyArray<{ readonly limit: number; readonly running?: number | undefined }>): string | null => {
  const limit = hosted.reduce((n, h) => n + h.limit, 0);
  const running = hosted.reduce((n, h) => n + (h.running ?? 0), 0);
  return limit === 0 ? null : `${String(running)} of ${String(limit)} at once`;
};

/** A bot's computer on fleetd's computers: its lead's awake or asleep, and its agents at work in boxes of their own. */
export const computerStateWord = (asleep: boolean, agents = 0): string =>
  [asleep ? "Asleep" : "Awake", ...(agents > 0 ? [agents === 1 ? "1 agent" : `${String(agents)} agents`] : [])].join(" · ");

/**
 * This period's computer time against what the plan includes: "12 h · $4.20 of $20 included", or with no plan its
 * hours and cost alone.
 */
export const usedWord = (state: BillingState): string => {
  const used = `${hours(state.usage.seconds)} · ${money(state.usage.cents, state.currency)}`;
  return state.plan === null ? used : `${used} of ${money(state.plan.creditsCents, state.currency)} included`;
};

/**
 * Why fleetd's computers run nothing now, where they are listed (Machines): the page's own top line for its reason
 * (the cap reached, no credits, a declined card), so the fix said is the one that holds.
 */
export const heldLine = (state: BillingState): string => topLine(state)?.message ?? "Nothing runs on fleetd's computers right now: Billing says why.";
