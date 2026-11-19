// Tailscale's row in Hub › Machines (Tailscale.tsx), as plain words from the hub's state (tailnet_get): its dot, the one
// line of state under its name (only what the person needs now), and whether its sign-in is under way.
import type { TailnetState } from "../../../shared/contracts";
import type { TextTone } from "../../ui";
import type { Mark } from "./parts";

export const HINT =
  "Hosted sandboxes reach your tailnet, its addresses and MagicDNS names, through one device the hub runs. Connect opens Tailscale's sign-in: approve it there.";

/** Whether the hub waits on the person (a sign-in, an approval) or on itself: the row reads its state again meanwhile. */
export const waiting = (s: TailnetState | undefined): boolean => s?.status === "login" || s?.status === "approve" || s?.status === "starting";

export function markOf(s: TailnetState): Mark {
  if (s.status === "connected") return s.problem === undefined ? "ready" : "needs";
  if (s.status === "failed") return "failed";
  if (waiting(s)) return "needs";
  return "off";
}

export function markLabel(s: TailnetState): string {
  if (s.status === "connected") return "Tailscale: connected";
  if (s.status === "failed") return "Tailscale: not working";
  if (waiting(s)) return "Tailscale: waiting for sign-in";
  return "Tailscale: not connected";
}

/** The line under its name: none at rest. */
export function lineOf(s: TailnetState): { text: string; tone: TextTone } | null {
  switch (s.status) {
    case "connected": {
      const where = [s.tailnet, s.device === undefined ? undefined : `as ${s.device}`].filter(Boolean).join(" · ") || "Connected";
      // Connected, but not kept across a restart (a locked vault): what to do.
      return s.problem === undefined ? { text: where, tone: "quiet" } : { text: `${where}. ${s.problem}.`, tone: "warning" };
    }
    case "login":
      return { text: "Waiting for you to sign in to Tailscale and approve the device.", tone: "quiet" };
    case "approve":
      return { text: "Signed in. An admin of your tailnet approves the device in Tailscale's admin console.", tone: "warning" };
    case "starting":
      return { text: "Starting…", tone: "quiet" };
    case "failed":
      return { text: s.problem ?? "Tailscale isn't working on the hub.", tone: "danger" };
    default:
      // Off where it can't run says why (and Connect is off): the hub's OS.
      return s.problem === undefined ? null : { text: `${s.problem}.`, tone: "quiet" };
  }
}

/** Whether Connect may be pressed: off or failed, on a hub that can run it. */
export const canConnect = (s: TailnetState): boolean => (s.status === "off" && s.problem === undefined) || s.status === "failed";

/** Tailscale's admin console, where a device waits for approval. */
export const MACHINES_URL = "https://login.tailscale.com/admin/machines";
