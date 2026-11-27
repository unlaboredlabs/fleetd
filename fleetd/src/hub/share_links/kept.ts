// What a machine keeps past its agents' sessions (decision product.share-link-outlives-agent): the open links agents
// made on it, sent as `share_kept` each time one of them is made, renewed or stopped, the feature is switched, and as
// the machine links. The node keeps each port's dev server until the link's end, and stops it once it is no longer
// listed (node/share/keep.ts). A person's link keeps nothing: it names no session, so no process is the link's own.
import { CAP_SHARE_KEPT, type KeptLink } from "../../shared/share_kept.ts";
import type { Hub } from "../api/hub.ts";
import { link } from "../link/index.ts";
import { shareLinks } from "./store.ts";

/** The agents' open links on `machineId`, as `share_kept` lists them: none while share links are off. */
export function keptOn(hub: Hub, machineId: string): KeptLink[] {
  const sl = shareLinks(hub);
  if (!sl.enabled()) return [];
  return sl
    .open()
    .filter((l) => l.machineId === machineId && l.threadId !== undefined && l.createdBy.kind === "agent")
    .map((l) => ({ thread: l.threadId!, port: l.port, untilMs: l.expiresMs }));
}

/** Tells `machineId` what it keeps now, when its node keeps anything (an older one doesn't). */
export function sendKept(hub: Hub, machineId: string): void {
  const nodes = link(hub);
  if (!nodes.can(machineId, CAP_SHARE_KEPT)) return;
  nodes.send(machineId, { t: "share_kept", links: keptOn(hub, machineId) });
}

/** Each machine is told as it links: what it kept through its node's restart, and what ended meanwhile. */
export function start(hub: Hub): void {
  link(hub).onLinked(({ machineId }) => sendKept(hub, machineId));
}
