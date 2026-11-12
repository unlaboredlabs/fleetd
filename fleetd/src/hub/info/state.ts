// The hub's release channel, what it is doing now to the Change at the head of a queue, and how many busy items it
// lists (index.ts reads the rest).
import type { Change } from "../../shared/contracts.ts";
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
