// What the hub binds a project's work to: `work_projects`, the repo and base
// its work lands on.
import type { Database } from "bun:sqlite";
import type { Claim, ClaimId, LandingRoute, ProjectRef, RepoId, Task } from "../../shared/contracts.ts";
import { get as repoGet } from "../repos/store.ts";
import { parseMs } from "../store/time.ts";
import type { Landing } from "./landings.ts";
import type { WorkScope } from "./repo_key.ts";

export type { WorkScope } from "./repo_key.ts";

export function scopeOf(db: Database, project: ProjectRef): WorkScope | undefined {
  const row = db
    .query<{ repo_key: string; base: string }, [string, string]>(
      "SELECT repo_key, base FROM work_projects WHERE machine_id = ? AND project_id = ?",
    )
    .get(project.machineId, project.projectId);
  return row ? { repoKey: row.repo_key, base: row.base } : undefined;
}

// The rest of the work rows (store.rs): `work_claims` (the Claim as JSON in `data`, plus the columns queries filter
// on), `landings` (each commit on a watched base, as JSON) and `landing_watch` (how far each watched base was read).

const numberOf = (claimId: ClaimId) => Number.parseInt(claimId.slice(1), 10) || 0;

export const sameScope = (a: WorkScope | undefined, b: WorkScope | undefined) =>
  a !== undefined && b !== undefined && a.repoKey === b.repoKey && a.base === b.base;

const claimsOf = (rows: { data: string }[]) => rows.map((r) => JSON.parse(r.data) as Claim);

function write(db: Database, claim: Claim): void {
  const endedMs = claim.end ? (parseMs(claim.end.at) ?? null) : null;
  db.query("UPDATE work_claims SET state = ?, expires_ms = ?, ended_ms = ?, data = ? WHERE n = ?").run(
    claim.state,
    parseMs(claim.expiresAt) ?? 0,
    endedMs,
    JSON.stringify(claim),
    numberOf(claim.claimId),
  );
}

/** Numbers the claim (`C<n>`) and stores it. `claim.claimId` is ignored. */
export function insertClaim(db: Database, claim: Claim): Claim {
  const row = db
    .query<{ n: number }, [string, string, string, string]>(
      `INSERT INTO work_claims (repo_key, base, state, owner_key, expires_ms, data)
       VALUES (?, ?, ?, ?, 0, '') RETURNING n`,
    )
    .get(claim.repoKey, claim.base, claim.state, claim.owner.keyId);
  const numbered: Claim = { ...claim, claimId: `C${row?.n}` };
  write(db, numbered);
  return numbered;
}

export const putClaim = (db: Database, claim: Claim) => write(db, claim);

export function getClaim(db: Database, claimId: ClaimId): Claim | undefined {
  const row = db.query<{ data: string }, [number]>("SELECT data FROM work_claims WHERE n = ?").get(numberOf(claimId));
  return row ? (JSON.parse(row.data) as Claim) : undefined;
}

/** The scope's active claims, and those that expired after `expiredSinceMs`. Newest first. */
export function inScope(db: Database, scope: WorkScope, expiredSinceMs: number): Claim[] {
  return claimsOf(
    db
      .query<{ data: string }, [string, string, number]>(
        `SELECT data FROM work_claims WHERE repo_key = ?1 AND base = ?2
           AND (state = 'active' OR (state = 'expired' AND ended_ms > ?3))
         ORDER BY n DESC`,
      )
      .all(scope.repoKey, scope.base, expiredSinceMs),
  );
}

/** Active claims whose time ran out by `nowMs`, oldest first. */
export const due = (db: Database, nowMs: number) =>
  claimsOf(db.query<{ data: string }, [number]>("SELECT data FROM work_claims WHERE state = 'active' AND expires_ms <= ? ORDER BY n").all(nowMs));

/** The owner's active claims, oldest first. */
export const activeOfOwner = (db: Database, keyId: string) =>
  claimsOf(db.query<{ data: string }, [string]>("SELECT data FROM work_claims WHERE state = 'active' AND owner_key = ? ORDER BY n").all(keyId));

/** Records the repo and base the project's work lands on, replacing what it had. */
export function bind(db: Database, project: ProjectRef, scope: WorkScope, nowMs: number): void {
  db.query(
    `INSERT INTO work_projects (machine_id, project_id, repo_key, base, updated_ms) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (machine_id, project_id) DO UPDATE SET repo_key = ?3, base = ?4, updated_ms = ?5`,
  ).run(project.machineId, project.projectId, scope.repoKey, scope.base, nowMs);
}

/** Forgets the repo and base the project's work landed on. */
export function unbind(db: Database, project: ProjectRef): void {
  db.query("DELETE FROM work_projects WHERE machine_id = ? AND project_id = ?").run(project.machineId, project.projectId);
}

/** The repo and base the repo's work lands on; undefined for an unknown repo or one with no remote. */
export function scopeOfRepo(db: Database, repoId: RepoId): WorkScope | undefined {
  const repo = repoGet(db, repoId)?.repo;
  return repo?.repoKey !== undefined && repo.base !== undefined ? { repoKey: repo.repoKey, base: repo.base } : undefined;
}

/** The repo and base a project's task lands on: its repo's when that is one of the project's other repos, else the project's own. */
export function scopeOfTask(db: Database, task: Task): WorkScope | undefined {
  const project = task.projectRef;
  if (task.repoId !== undefined) {
    const found = repoGet(db, task.repoId);
    const sameProject = (a: ProjectRef, b: ProjectRef) => a.machineId === b.machineId && a.projectId === b.projectId;
    if (found && sameProject(found.project, project) && !sameProject(found.repo.checkout, project)) return scopeOfRepo(db, task.repoId);
  }
  return scopeOf(db, project);
}

/** Every project whose work lands on the scope, in a stable order: by its own repo, or by another of its repos. */
export function projectsIn(db: Database, scope: WorkScope): ProjectRef[] {
  return db
    .query<{ machine_id: string; project_id: string }, [string, string]>(
      `SELECT machine_id, project_id FROM work_projects WHERE repo_key = ?1 AND base = ?2
       UNION SELECT machine_id, project_id FROM repos WHERE repo_key = ?1 AND base = ?2
         AND NOT (checkout_machine_id = machine_id AND checkout_project_id = project_id)
       ORDER BY machine_id, project_id`,
    )
    .all(scope.repoKey, scope.base)
    .map((r) => ({ machineId: r.machine_id, projectId: r.project_id }));
}

/** How far a watched base has been read: its newest commit seen, and when the watch started. */
export type Watch = { lastSha: string; sinceMs: number };

export function watch(db: Database, scope: WorkScope): Watch | undefined {
  const row = db
    .query<{ last_sha: string; since_ms: number }, [string, string]>("SELECT last_sha, since_ms FROM landing_watch WHERE repo_key = ? AND base = ?")
    .get(scope.repoKey, scope.base);
  return row ? { lastSha: row.last_sha, sinceMs: row.since_ms } : undefined;
}

/** Starts the watch at `lastSha`, or moves it there. */
export function watchAt(db: Database, scope: WorkScope, lastSha: string, nowMs: number): void {
  db.query(
    `INSERT INTO landing_watch (repo_key, base, last_sha, since_ms) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (repo_key, base) DO UPDATE SET last_sha = ?3`,
  ).run(scope.repoKey, scope.base, lastSha, nowMs);
}

/**
 * A landing as the Rust hub writes its `data`: every field in `Landing`'s order, an absent one as null (it has no
 * skip_serializing_none), so a row reads the same whichever hub wrote it.
 */
export function encodeLanding(l: Landing): string {
  return JSON.stringify({
    repoKey: l.repoKey,
    base: l.base,
    sha: l.sha,
    at: l.at,
    seenAt: l.seenAt,
    route: l.route,
    prNumber: l.prNumber ?? null,
    prUrl: l.prUrl ?? null,
    headBranch: l.headBranch ?? null,
    subject: l.subject,
    authorEmail: l.authorEmail ?? null,
    paths: l.paths,
    changeId: l.changeId ?? null,
    taskId: l.taskId ?? null,
    claimIds: l.claimIds,
  });
}

/** A landing's `data` as either hub wrote it: the Rust hub's nulls are absent fields. */
export const decodeLanding = (data: string): Landing => JSON.parse(data, (_key, value) => (value === null ? undefined : value)) as Landing;

/** Stores the landing with what a rebase keeps of its commit; false when the commit was already recorded on that base. */
export function insertLanding(db: Database, landing: Landing, rewriteKey: string): boolean {
  const added = db
    .query(
      `INSERT OR IGNORE INTO landings (repo_key, base, sha, at_ms, route, pr_number, rewrite_key, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      landing.repoKey,
      landing.base,
      landing.sha,
      parseMs(landing.at) ?? 0,
      landing.route satisfies LandingRoute,
      landing.prNumber ?? null,
      rewriteKey,
      encodeLanding(landing),
    ).changes;
  return added === 1;
}

/** Whether a commit with this rewrite key, or from this PR, already landed on the scope's base. */
export function rewriteOf(db: Database, scope: WorkScope, rewriteKey: string, prNumber: number | undefined): boolean {
  return !!db
    .query("SELECT 1 FROM landings WHERE repo_key = ?1 AND base = ?2 AND (rewrite_key = ?3 OR pr_number = ?4) LIMIT 1")
    .get(scope.repoKey, scope.base, rewriteKey, prNumber ?? null);
}

export const hasLanding = (db: Database, scope: WorkScope, sha: string) =>
  !!db.query("SELECT 1 FROM landings WHERE repo_key = ? AND base = ? AND sha = ?").get(scope.repoKey, scope.base, sha);

/** The scope's landings committed at or after `sinceMs`, newest first; with `outside`, only those not through the train. */
export function landingsSince(db: Database, scope: WorkScope, sinceMs: number, limit: number, outside: boolean): Landing[] {
  return db
    .query<{ data: string }, [string, string, number, number, number]>(
      `SELECT data FROM landings WHERE repo_key = ? AND base = ? AND at_ms >= ? AND (? = 0 OR route != 'train')
       ORDER BY at_ms DESC, rowid DESC LIMIT ?`,
    )
    .all(scope.repoKey, scope.base, sinceMs, outside ? 1 : 0, limit)
    .map((r) => decodeLanding(r.data));
}

/** The newest write task of one of `projects` on `branch`, in any state. */
export function taskOnBranch(db: Database, projects: ProjectRef[], branch: string): Task | undefined {
  const query = db.query<{ data: string }, [string, string, string]>(
    `SELECT data FROM tasks WHERE machine_id = ? AND project_id = ? AND json_extract(data, '$.kind') = 'write'
       AND json_extract(data, '$.branch') = ?
     ORDER BY n DESC LIMIT 1`,
  );
  for (const p of projects) {
    const row = query.get(p.machineId, p.projectId, branch);
    if (row) return JSON.parse(row.data) as Task;
  }
  return undefined;
}

/** The bases the repo's projects land on, most recently bound first. */
export const basesOf = (db: Database, repoKey: string) =>
  db
    .query<{ base: string }, [string]>("SELECT base FROM work_projects WHERE repo_key = ? GROUP BY base ORDER BY max(updated_ms) DESC")
    .all(repoKey)
    .map((r) => r.base);

