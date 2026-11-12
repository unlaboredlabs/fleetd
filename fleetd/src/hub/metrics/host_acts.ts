// Reviews and comments the person left on a repo's git host, as touches.
// The host sweep reads them through HostActs (GitHub first) and calls `read` per repo. A review's credit is estimated
// and marked so. A touch on a PR fleetd wrote (a Change's, or a `fleetd/` head) counts toward minutes through fleetd;
// one on any other PR toward the outside figure.
import type { Database } from "bun:sqlite";
import type { HubDb } from "../store/db.ts";
import * as human from "./human.ts";
import { type HostAct, type HostActs, HostError } from "./source.ts";
import { BACKFILL_MS } from "./rules.ts";

export { BACKFILL_MS } from "./rules.ts";

export type { HostAct, HostActKind, HostActs } from "./source.ts";
import * as store from "./store.ts";
import type { TouchRow } from "./store.ts";

/** The branches fleetd's write tasks push. */
const FLEETD_BRANCH = "fleetd/";

/** The host was not read; the message is the host's own words. */
export class HostReadError extends HostError {
  constructor(readonly why: string) {
    super(`the git host was not read: ${why}`);
  }
}

/**
 * Reads `repo`'s acts since its cursor (90 days back the first time), writes the people's as touches and moves the
 * cursor to `nowMs`. The repo must be one the metrics know. Returns how many touches were written.
 */
export async function read(db: HubDb, reader: HostActs, repo: string, nowMs: number): Promise<number> {
  const since = store.reviewsCursor(db.conn, repo) ?? nowMs - BACKFILL_MS;
  let acts: HostAct[];
  try {
    acts = await reader.actsSince(repo, since);
  } catch (error) {
    throw new HostReadError(error instanceof Error ? error.message : String(error));
  }
  return db.transaction((c) => {
    let n = 0;
    for (const act of acts.filter((a) => !a.bot)) {
      store.upsertTouch(c, touch(c, repo, act));
      n++;
    }
    store.setReviewsCursor(c, repo, nowMs);
    return n;
  });
}

/**
 * The order a PR belongs to and the project that owns it, when fleetd wrote it: its Change's, or the task its
 * `fleetd/T<n>-…` head names, or a landed change already routed as fleetd's.
 */
type Owner = { fleetd: boolean; workstreamId?: string; project?: [string, string] };

function owner(c: Database, repo: string, pr: number, head: string | undefined): Owner {
  const trainRepo = store.trainRepo(repo);
  if (trainRepo !== undefined) {
    const change = c
      .query<{ w: string | null; m: string; p: string }, [string, number]>(
        `SELECT json_extract(data, '$.workstreamId') AS w, machine_id AS m, project_id AS p FROM changes
         WHERE repo = ?1 AND pr_number = ?2 ORDER BY n DESC LIMIT 1`,
      )
      .get(trainRepo.toLowerCase(), pr);
    if (change) return { fleetd: true, ...(change.w === null ? {} : { workstreamId: change.w }), project: [change.m, change.p] };
  }
  const task = head?.startsWith(FLEETD_BRANCH) ? /^T(\d+)/.exec(head.slice(FLEETD_BRANCH.length))?.[1] : undefined;
  const row = c
    .query<{ route: string; w: string | null; m: string | null; p: string | null }, [string, string]>(
      "SELECT route, workstream_id AS w, machine_id AS m, project_id AS p FROM metric_merges WHERE repo = ?1 AND unit_key = ?2",
    )
    .get(repo, `pr:${pr}`);
  const landed: Owner = row
    ? {
        fleetd: row.route === "train" || row.route === "fleetd_by_hand",
        ...(row.w === null ? {} : { workstreamId: row.w }),
        ...(row.m !== null && row.p !== null ? { project: [row.m, row.p] as [string, string] } : {}),
      }
    : { fleetd: false };
  if (task !== undefined) {
    const t = c
      .query<{ w: string | null; m: string; p: string }, [number]>("SELECT workstream_id AS w, machine_id AS m, project_id AS p FROM tasks WHERE n = ?1")
      .get(Number(task));
    const project = t ? ([t.m, t.p] as [string, string]) : landed.project;
    return { fleetd: true, ...(t?.w ? { workstreamId: t.w } : {}), ...(project ? { project } : {}) };
  }
  return landed;
}

function touch(c: Database, repo: string, act: HostAct): TouchRow {
  const [kind, credit] = act.kind === "review" ? ["host.review", human.reviewMs(act.lines)] : ["host.comment", human.COMMENT_MS];
  const o = owner(c, repo, act.prNumber, act.head);
  const t: TouchRow = {
    src: "host",
    srcKey: `${repo}#${kind}:${act.id}`,
    kind,
    atMs: act.atMs,
    creditMs: credit,
    repo,
    prNumber: act.prNumber,
    estimated: true,
    outside: !o.fleetd,
  };
  if (o.project) [t.machineId, t.projectId] = o.project;
  if (o.workstreamId !== undefined) t.workstreamId = o.workstreamId;
  if (act.login !== undefined) t.keyId = act.login;
  return t;
}
