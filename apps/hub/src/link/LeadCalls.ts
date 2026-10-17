import path from "node:path";
import type { LeadCall, LeadCallResult, MachineId, McpToolError, ProjectRef, ProjectSummary } from "@fleetd/contracts";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";

/** Who a lead-side call came from, as decided by the hub from the node link and the caller's cwd. */
export interface LeadCaller {
  readonly projectRef: ProjectRef;
  /** `lead:<machineId>/<projectId>`, recorded as `by` on whatever the call writes. */
  readonly by: string;
  readonly cwd: string;
}

/** The hub said no; `fix` tells the lead what to do instead. Sent to the CLI as the result frame's error. */
export class LeadCallRefused extends Data.TaggedError("LeadCallRefused")<McpToolError> {}

/** Port for the lead-side calls. The ledger (asks, decisions) and leads (briefs, status) services implement it. */
export interface LeadCallHandler {
  readonly handle: (caller: LeadCaller, call: LeadCall) => Effect.Effect<LeadCallResult, LeadCallRefused>;
}

export const leadBy = (ref: ProjectRef) => `lead:${ref.machineId}/${ref.projectId}`;

/** Lexical normal form without a trailing slash. The hub cannot see the node's filesystem, so symlinks stay as given. */
const normalize = (p: string) => {
  const normal = path.posix.normalize(p);
  return normal.length > 1 && normal.endsWith("/") ? normal.slice(0, -1) : normal;
};

const contains = (root: string, cwd: string) => cwd === root || cwd.startsWith(root === "/" ? "/" : `${root}/`);

/**
 * The project whose workspace root is `cwd` or one of its ancestors, so worktrees under the root count. With nested
 * roots the deepest wins; with equal roots, the first in `projects` (newest activity first from the store).
 */
export const projectForCwd = (projects: ReadonlyArray<ProjectSummary>, cwd: string): ProjectSummary | undefined => {
  const target = normalize(cwd);
  let best: { readonly project: ProjectSummary; readonly depth: number } | undefined;
  for (const project of projects) {
    const root = normalize(project.workspaceRoot);
    if (!root.startsWith("/") || !contains(root, target)) continue;
    if (best === undefined || root.length > best.depth) best = { project, depth: root.length };
  }
  return best?.project;
};

const MAX_LISTED_ROOTS = 5;

/** Refusal for a cwd outside every project on the machine. */
export const outsideEveryProject = (machineId: MachineId, cwd: string, projects: ReadonlyArray<ProjectSummary>) => {
  if (projects.length === 0) {
    return new LeadCallRefused({
      code: "forbidden",
      message: `the hub knows no projects on ${machineId} yet, so it cannot tell which project ${cwd} belongs to`,
      fix: `check that T3 is up on ${machineId} (fleetd_status), then run the command again`,
    });
  }
  const roots = projects.slice(0, MAX_LISTED_ROOTS).map((project) => project.workspaceRoot);
  const more = projects.length > MAX_LISTED_ROOTS ? ` and ${projects.length - MAX_LISTED_ROOTS} more` : "";
  return new LeadCallRefused({
    code: "forbidden",
    message: `${cwd} is not inside any project workspace on ${machineId}`,
    fix: `run fleetd from the project's workspace or a worktree under it (${roots.join(", ")}${more})`,
  });
};
