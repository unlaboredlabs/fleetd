// Landings (crates/fleetd/src/hub/work/landings.rs): every commit that reaches a watched base, however it got there,
// as a `landings` row, and the store others read them through. The scanner that records them comes in its own change.
import type { LandingRoute } from "../../shared/contracts.ts";
import type { Landed } from "./elsewhere.ts";
import type { Landings } from "./index.ts";
import { landingsSince, type WorkScope } from "./store.ts";
import type { Database } from "bun:sqlite";
import { parseMs } from "../store/time.ts";

/** The most paths a landing keeps. */
export const LANDING_PATHS_MAX = 200;

/** One commit on the first-parent line of a watched base, whoever made it and however it got there: a `landings` row. */
export type Landing = {
  repoKey: string;
  base: string;
  sha: string;
  /** The commit's committer time. */
  at: string;
  /** When the scanner saw it. */
  seenAt: string;
  route: LandingRoute;
  /** The PR or merge request it came from, when the merge message or the host names one. */
  prNumber?: number;
  prUrl?: string;
  /** The branch it came from, when the merge message or the host names one. */
  headBranch?: string;
  subject: string;
  authorEmail?: string;
  /** What it changed against its first parent; the first LANDING_PATHS_MAX. */
  paths: string[];
  /** The Change it is, or merged. */
  changeId?: string;
  /** The write task whose work it is. */
  taskId?: string;
  /** The claims it ended. */
  claimIds: string[];
};

/** A landing as the lead reads it. */
export function landed(l: Landing): Landed {
  const pr = l.prUrl ?? (l.prNumber !== undefined ? `#${l.prNumber}` : undefined);
  return {
    sha: l.sha,
    atMs: parseMs(l.at) ?? 0,
    route: l.route,
    ...(pr !== undefined ? { pr } : {}),
    subject: l.subject,
    ...(l.authorEmail !== undefined ? { authorEmail: l.authorEmail } : {}),
    covers: [...(l.taskId !== undefined ? [l.taskId] : []), ...l.claimIds],
  };
}

/** The landings table, as the digest and work_list read it. */
export const landingStore = (db: Database): Landings => ({
  outside: (scope: WorkScope, sinceMs: number, limit: number) => landingsSince(db, scope, sinceMs, limit, true).map(landed),
});
