// What a lead reads of the work that isn't its own: the digest's "Elsewhere"
// lines (claims, other projects' writers and Changes on the same repo and base, and recent landings outside the train).
import type { ClaimOwner, LandingRoute, ProjectRef, WorkItem, WorkKey } from "../../shared/contracts.ts";
import { oneLine } from "../leads/text.ts";
import type { WorkScope } from "./repo_key.ts";

/** Landings the digest shows: the newest this many outside the train, from the last `LANDINGS_SHOWN_MS`. */
export const LANDINGS_SHOWN = 5;
export const LANDINGS_SHOWN_MS = 24 * 3_600_000;
/** Each line is cut to this many characters. */
const LINE_MAX = 200;

/** A commit that reached a base, as the lead reads it. */
export type Landed = {
  sha: string;
  atMs: number;
  route: LandingRoute;
  /** The PR it merged as, when its message or the host names one: "#57", or its URL. */
  pr?: string;
  subject: string;
  authorEmail?: string;
  /** The work it matched exactly: "T12", "C7". */
  covers: string[];
};

/** How it reached the base, for a person: "pushed straight to main, outside fleetd". */
export function how(landed: Landed, base: string): string {
  switch (landed.route) {
    case "train":
      return "merged by the train";
    case "pr_outside":
      return landed.pr !== undefined ? `PR ${landed.pr} merged outside fleetd` : "merged outside fleetd";
    default:
      return `pushed straight to ${base}, outside fleetd`;
  }
}

export const shortSha = (sha: string) => sha.slice(0, 7);

function landingLine(landed: Landed, base: string): string {
  const by = landed.authorEmail !== undefined ? ` by ${landed.authorEmail}` : "";
  const covers = landed.covers.length > 0 ? ` · covers ${landed.covers.join(", ")}` : "";
  return oneLine(`- ${shortSha(landed.sha)} ${how(landed, base)}${by}: ${landed.subject}${covers}`, LINE_MAX);
}

function ownerText(owner: ClaimOwner): string {
  const who = owner.kind === "human_session" ? "a person" : owner.kind === "agent_key" ? "an agent key" : "the lead of";
  if (owner.kind === "lead") return `${who} ${owner.keyId}`;
  return owner.label !== undefined ? `${who} (${owner.label})` : who;
}

const keyText = (key: WorkKey) => ("issue" in key ? key.issue : "pr" in key ? key.pr : `branch ${key.branch}`);

const projectText = (r: ProjectRef | undefined) => (r ? `${r.machineId}/${r.projectId}` : "another project");

function itemLine(item: WorkItem): string {
  let what: string;
  if (item.kind === "claim") what = `${item.state === "expired" ? "expired claim" : "claimed"} by ${item.owner ? ownerText(item.owner) : ""}`;
  else if (item.kind === "task") what = `writer of ${projectText(item.projectRef)}, ${item.state}`;
  else if (item.kind === "change") what = `PR of ${projectText(item.projectRef)}, ${item.state}`;
  else what = `open PR, ${item.state}`;
  const keys = item.keys.map(keyText);
  const on = item.kind === "claim" && keys.length > 0 ? ` · on ${keys.join(", ")}` : "";
  return oneLine(`- ${item.id} ${what}: ${item.title}${on}`, LINE_MAX);
}

/** Whether the item is the lead's own work: its project's writers and Changes, and claims its lead holds. */
function own(item: WorkItem, r: ProjectRef): boolean {
  if (item.kind === "claim") return item.owner?.kind === "lead" && item.owner.keyId === `${r.machineId}/${r.projectId}`;
  return item.projectRef?.machineId === r.machineId && item.projectRef.projectId === r.projectId;
}

/** What the digest says of the lines it cut: they go from the end. */
export const CUT_FIRST = "expired claims, then landings, are cut first";

/**
 * The digest's Elsewhere lines, most important first, as the digest cuts from the end: a person's active claims, then
 * other active claims and other projects' writers and Changes (in the view's order), then landings outside the train
 * (newest first), then expired claims.
 */
export function lines(r: ProjectRef, scope: WorkScope, inFlight: WorkItem[], landings: Landed[]): string[] {
  const rank = (i: WorkItem) => (i.kind === "claim" && i.state === "expired" ? 2 : i.kind === "claim" && i.owner?.kind === "human_session" ? 0 : 1);
  // A stable sort, as Rust's sort_by_key.
  const items = inFlight.filter((i) => !own(i, r)).sort((a, b) => rank(a) - rank(b));
  const landed = landings
    .filter((l) => l.route !== "train")
    .slice(0, LANDINGS_SHOWN)
    .map((l) => landingLine(l, scope.base));
  const live = items.filter((i) => rank(i) < 2);
  const gone = items.filter((i) => rank(i) >= 2);
  return [...live.map(itemLine), ...landed, ...gone.map(itemLine)];
}
