// Reviews and comments the person left on a repo's git host, as touches (crates/fleetd/src/hub/metrics/host_acts.rs).
// A review's credit is estimated and marked so. A touch on a PR fleetd wrote counts toward minutes through fleetd; one
// on any other PR toward the outside figure.
import type { Database } from "bun:sqlite";
import type { HubDb } from "../store/db.ts";
import * as human from "./human.ts";
import * as store from "./store.ts";
import type { TouchRow } from "./store.ts";

/** The first read of a repo goes this far back. */
export const BACKFILL_MS = 90 * store.DAY_MS;
const FLEETD_BRANCH = "fleetd/";

/** One review (approve, request changes or comment) or a review comment or PR comment, as the host recorded it. */
export type HostAct = {
  kind: "review" | "comment";
  /** The host's id for it, unique in the repo for its kind. */
  id: string;
  prNumber: number;
  atMs: number;
  login?: string;
  /** Left by a bot account: not a touch. */
  bot: boolean;
  head?: string;
  /** The PR's changed lines, for a review's credit. */
  lines?: number;
};

/** Reads a repo's reviews and comments; `repo` is the metrics' remote key. Throws why the host could not be read. */
export interface HostActs {
  actsSince(repo: string, sinceMs: number): Promise<HostAct[]>;
}

/**
 * Reads `repo`'s acts since its cursor (90 days back the first time), writes the people's as touches and moves the
 * cursor to `nowMs`. Returns how many touches were written.
 */
export async function read(db: HubDb, reader: HostActs, repo: string, nowMs: number): Promise<number> {
  const cursor = db.conn
    .query<{ v: number | null }, [string]>("SELECT reviews_cursor_ms AS v FROM metric_repos WHERE repo = ?1")
    .get(repo)?.v;
  const since = cursor ?? nowMs - BACKFILL_MS;
  let acts: HostAct[];
  try {
    acts = await reader.actsSince(repo, since);
  } catch (error) {
    throw new Error(`the git host was not read: ${(error as Error).message}`);
  }
  return db.transaction((c) => {
    let n = 0;
    for (const act of acts) {
      if (act.bot) continue;
      store.upsertTouch(c, touch(c, repo, act));
      n++;
    }
    c.query("UPDATE metric_repos SET reviews_cursor_ms = MAX(COALESCE(reviews_cursor_ms, 0), ?2) WHERE repo = ?1").run(repo, nowMs);
    return n;
  });
}

type Owner = { fleetd: boolean; workstreamId?: string; project?: [string, string] };

/** The order a PR belongs to and the project that owns it, when fleetd wrote it. */
function owner(c: Database, repo: string, pr: number, head?: string): Owner {
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
  const digits = head?.startsWith(FLEETD_BRANCH) ? /^T(\d+)/.exec(head.slice(FLEETD_BRANCH.length))?.[1] : undefined;
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
  if (digits !== undefined) {
    const t = c
      .query<{ w: string; m: string; p: string }, [number]>("SELECT workstream_id AS w, machine_id AS m, project_id AS p FROM tasks WHERE n = ?1")
      .get(Number(digits));
    const project = t ? ([t.m, t.p] as [string, string]) : landed.project;
    return { fleetd: true, ...(t ? { workstreamId: t.w } : {}), ...(project ? { project } : {}) };
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
    creditMs: credit as number,
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
