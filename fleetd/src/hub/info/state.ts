// The hub's release channel, what it is doing now to the Change at the head of a queue, and how many busy items it
// lists, and a busy item's line (index.ts reads the rest).
import type { Change, HubBusyItem, HubBusyKind, ProjectRef } from "../../shared/contracts.ts";
import { jsTake } from "../chat/rules.ts";
import { edgeStamp } from "../../update/version.ts";

/** `HubInfoOutput.busy`'s cap. */
export const BUSY_MAX = 50;

/** Edge when the version says so (or nightly), stable for any other release build, none for a local build. */
export function channel(version: string, releaseBuild: boolean): "edge" | "stable" | undefined {
  if (edgeStamp(version) !== undefined) return "edge";
  return releaseBuild ? "stable" : undefined;
}

/** What the hub itself is doing to the Change at the head of its repo's queue, when a restart would cut it off. */
export function hubStep(change: Change): string | undefined {
  if (change.state === "rebasing") return `updating PR #${change.prNumber} in ${change.repo} before it merges`;
  if (change.state === "merging") return `merging PR #${change.prNumber} into ${change.repo}`;
  return undefined;
}

/** One line of at most 280 UTF-16 units, its whitespace collapsed. */
export function text(s: string): string {
  const flat = jsTake(s.split(/\s+/u).filter((w) => w !== "").join(" "), 280);
  return flat === "" ? "something is running" : flat;
}

export const item = (kind: HubBusyKind, t: string, r: ProjectRef, since?: string): HubBusyItem => ({
  kind,
  machineId: r.machineId,
  projectRef: r,
  ...(since === undefined ? {} : { since }),
  text: text(t),
});
