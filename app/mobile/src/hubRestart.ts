// Restart Hub from the phone, for admins (Settings › Hub): the desktop app's Restart hub (Settings › You › Hubs & devices).
// It asks first, the hub restarts in place (hub_restart) and the row says so until the link is live again. Members
// never see the row; the hub refuses them all the same. Pure, so tested.
import type { HubError, HubRestartOutput, HubState } from "./desktop";
import type { Restart } from "./store";

export const RESTART_TITLE = "Restart the hub?";
export const RESTART_NOTE = "It is back in about a second, and running agents carry on. A lead whose profile changed since it started comes back on the current one, with its chat, memory and open orders.";
/** Under the row, always. */
export const RESTART_FOOTER = "The hub is back in about a second. Agents carry on.";

/** How long a hub that took the restart may stay up before the row says it didn't restart. */
export const RESTART_WAIT_MS = 20_000;

export type RestartStep =
  | { readonly at: "idle" }
  | { readonly at: "asking"; readonly asked: number }
  /** The hub took it at about `asked` (epoch ms): `leads` of its leads start again on the current lead profile. */
  | { readonly at: "restarting"; readonly asked: number; readonly leads: number }
  | { readonly at: "done"; readonly leads: number }
  | { readonly at: "failed"; readonly message: string };

const sentence = (text: string): string => (/[.!?]$/u.test(text) ? text : `${text}.`);

/** The step after hub_restart's answer; a call the restart itself cut off counts as taken. */
export const afterAnswer = (asked: number, out: { readonly ok: true; readonly output: HubRestartOutput } | { readonly ok: false; readonly error: HubError }): RestartStep => {
  if (out.ok) return { at: "restarting", asked, leads: out.output.leads };
  if (out.error.code === "disconnected") return { at: "restarting", asked, leads: 0 };
  // A hub from before the tool.
  if (out.error.code === "not_found") return { at: "failed", message: "This hub runs a fleetd from before Restart Hub. Update fleetd on it first." };
  return { at: "failed", message: `${sentence(out.error.message)}${out.error.fix === undefined ? "" : ` ${sentence(out.error.fix)}`}` };
};

/**
 * The step as the link changes: restarting until the hub, away since it was asked, is live again (store.ts Restart);
 * one still up `RESTART_WAIT_MS` after it took the restart didn't restart.
 */
export const afterLink = (step: RestartStep, hub: HubState, restart: Restart | null, now: number): RestartStep => {
  if (step.at !== "restarting") return step;
  if (hub.phase === "live" && restart !== null && restart.t !== "down" && (restart.at ?? 0) >= step.asked) return { at: "done", leads: step.leads };
  const away = hub.phase !== "live" || (restart?.t === "down" && restart.since >= step.asked);
  if (!away && now - step.asked >= RESTART_WAIT_MS) return { at: "failed", message: "The hub took the restart but is still up. Try again, or restart its service on the hub's machine." };
  return step;
};

export interface RestartRow {
  /** Under the title: how many leads start again, or why it failed. */
  readonly detail: string | undefined;
  readonly value: string | undefined;
  /** Whether a tap asks to restart: not while one goes. */
  readonly canAsk: boolean;
}

/** The Restart Hub row, or null where there is none: not an admin, or no hub to ask and no restart going. */
export const restartRow = (admin: boolean | undefined, hub: HubState, step: RestartStep): RestartRow | null => {
  if (admin !== true) return null;
  switch (step.at) {
    case "asking":
    case "restarting":
      return { detail: undefined, value: "Restarting…", canAsk: false };
    case "done":
      if (hub.phase !== "live") return null;
      return {
        detail: step.leads === 0 ? undefined : `${step.leads === 1 ? "1 lead starts" : `${String(step.leads)} leads start`} again on the current lead profile, each once it is idle.`,
        value: "Restarted",
        canAsk: true,
      };
    case "failed":
      return { detail: step.message, value: undefined, canAsk: hub.phase === "live" };
    case "idle":
      return hub.phase === "live" ? { detail: undefined, value: undefined, canAsk: true } : null;
  }
};
