// Tailscale's row in Connections (connections/ConnectionsSheet.tsx), as plain words from the hub's state
// (tailnet_get): the word beside its name, the one line under it (only what the person needs now), whether Connect may
// be pressed, and whether its sign-in is under way.
import type { TailnetState } from "../../../shared/contracts";

type Tone = "quiet" | "warning" | "danger";

/** Whether the hub waits on the person (a sign-in, an approval) or on itself: the row reads its state again meanwhile. */
export const waiting = (s: TailnetState | undefined): boolean => s?.status === "login" || s?.status === "approve" || s?.status === "starting";

/** The word beside its name: Connected (the tailnet's name in its hover), what it waits on, or that it isn't working.
 * None when off. */
export function wordOf(s: TailnetState): { text: string; tone: Tone; hint?: string } | null {
  switch (s.status) {
    case "connected":
      return { text: "Connected", tone: "quiet", ...(s.tailnet === undefined ? {} : { hint: s.tailnet }) };
    case "login":
      return { text: "Waiting for sign-in", tone: "warning" };
    case "approve":
      return { text: "Waiting for approval", tone: "warning" };
    case "starting":
      return { text: "Starting…", tone: "quiet" };
    case "failed":
      return { text: "Not working", tone: "danger" };
    default:
      return null;
  }
}

const sentence = (text: string): string => (/[.!?]$/u.test(text) ? text : `${text}.`);

/**
 * The line under it: why it failed, why it won't last a restart, why Connect is off where it can't run, that an admin
 * of the tailnet approves the device, or (to anyone else) that an admin connects it. None at rest.
 */
export function lineOf(s: TailnetState, admin: boolean): { text: string; tone: Tone } | null {
  if (s.status === "failed") return { text: sentence(s.problem ?? "Tailscale isn't working on the workspace"), tone: "danger" };
  if (s.status === "approve") return { text: "An admin of your tailnet approves the device in Tailscale's admin console.", tone: "quiet" };
  if (s.problem !== undefined) return { text: sentence(s.problem), tone: s.status === "connected" ? "warning" : "quiet" };
  if (!admin && s.status === "off") return { text: "An admin connects Tailscale.", tone: "quiet" };
  return null;
}

/** Whether Connect may be pressed: off or failed, on a hub that can run it. */
export const canConnect = (s: TailnetState): boolean => (s.status === "off" && s.problem === undefined) || s.status === "failed";

/** Tailscale's admin console, where a device waits for approval. */
export const MACHINES_URL = "https://login.tailscale.com/admin/machines";
