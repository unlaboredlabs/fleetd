// Repo rows: `repos`, one per repo of a project, with the node checkout holding its files (`checkout_*`) and the repo
// and base its work lands on.
import type { Database } from "bun:sqlite";
import type { ProjectRef, ProjectRepo, RepoId, RepoName } from "../../shared/contracts.ts";
import { scopeOf } from "../work/store.ts";
import { nameFor } from "./names.ts";

export { nameFor } from "./names.ts";

/** The checkout's directory comes from the node's row of it in `projects`. */
const COLUMNS = `n, name, checkout_machine_id, checkout_project_id, repo_key, base, machine_id, project_id,
     (SELECT json_extract(p.data, '$.workspaceRoot') FROM projects p
      WHERE p.machine_id = repos.checkout_machine_id AND p.project_id = repos.checkout_project_id) AS path`;

type Row = {
  n: number;
  name: string;
  checkout_machine_id: string;
  checkout_project_id: string;
  repo_key: string | null;
  base: string | null;
  machine_id: string;
  project_id: string;
  path: string | null;
};

function repoOf(row: Row): ProjectRepo {
  const repo: ProjectRepo = {
    repoId: `R${row.n}`,
    name: row.name,
    checkout: { machineId: row.checkout_machine_id, projectId: row.checkout_project_id },
  };
  if (row.repo_key !== null) repo.repoKey = row.repo_key;
  if (row.base !== null) repo.base = row.base;
  if (row.path !== null) repo.path = row.path;
  return repo;
}

const projectOf = (row: Row): ProjectRef => ({ machineId: row.machine_id, projectId: row.project_id });

/** The project's repos, oldest first. */
export function of(db: Database, project: ProjectRef): ProjectRepo[] {
  return db
    .query<Row, [string, string]>(`SELECT ${COLUMNS} FROM repos WHERE machine_id = ? AND project_id = ? ORDER BY n`)
    .all(project.machineId, project.projectId)
    .map(repoOf);
}

/** The repo's `n`: `R12` → 12. */
export function number(repoId: RepoId): number | undefined {
  const n = Number.parseInt(repoId.slice(1), 10);
  return Number.isNaN(n) ? undefined : n;
}

/** The repo and the project it is in. */
export function get(db: Database, repoId: RepoId): { project: ProjectRef; repo: ProjectRepo } | undefined {
  const n = number(repoId);
  if (n === undefined) return undefined;
  const row = db.query<Row, [number]>(`SELECT ${COLUMNS} FROM repos WHERE n = ?`).get(n);
  return row ? { project: projectOf(row), repo: repoOf(row) } : undefined;
}

export function byName(db: Database, project: ProjectRef, name: RepoName): ProjectRepo | undefined {
  const row = db
    .query<Row, [string, string, string]>(`SELECT ${COLUMNS} FROM repos WHERE machine_id = ? AND project_id = ? AND name = ?`)
    .get(project.machineId, project.projectId, name);
  return row ? repoOf(row) : undefined;
}

/** The project's own repo: the one whose checkout is the project's directory. */
export function own(db: Database, project: ProjectRef): ProjectRepo | undefined {
  const row = db
    .query<Row, [string, string]>(
      `SELECT ${COLUMNS} FROM repos WHERE machine_id = ?1 AND project_id = ?2
         AND checkout_machine_id = ?1 AND checkout_project_id = ?2`,
    )
    .get(project.machineId, project.projectId);
  return row ? repoOf(row) : undefined;
}

/** The repos whose files are in the checkout, each with its project. */
export function holding(db: Database, checkout: ProjectRef): { project: ProjectRef; repoId: RepoId }[] {
  return db
    .query<Row, [string, string]>(
      `SELECT ${COLUMNS} FROM repos WHERE checkout_machine_id = ? AND checkout_project_id = ? ORDER BY n`,
    )
    .all(checkout.machineId, checkout.projectId)
    .map((row) => ({ project: projectOf(row), repoId: `R${row.n}` }));
}

/**
 * Makes sure the project has its own repo when its directory is a git repo, and that the repo's key and base (and
 * those of every project's repo in this checkout) are the ones its work is bound to (`work_projects`). The directory
 * is known to be a git repo when `gitRoot`, where the caller saw it, is given, or when the hub has the project cached
 * and its work is bound (it has an origin). Otherwise the project stays as it is. Returns the own repo.
 */
export function ensureOwn(db: Database, project: ProjectRef, gitRoot?: string): ProjectRepo | undefined {
  const scope = scopeOf(db, project);
  const repoKey = scope?.repoKey ?? null;
  const base = scope?.base ?? null;
  if (own(db, project)) {
    db.query(
      `UPDATE repos SET repo_key = ?3, base = ?4 WHERE checkout_machine_id = ?1 AND checkout_project_id = ?2
             AND (repo_key IS NOT ?3 OR base IS NOT ?4)`,
    ).run(project.machineId, project.projectId, repoKey, base);
    return own(db, project);
  }
  let root: string;
  if (gitRoot !== undefined) root = gitRoot;
  else if (scope) {
    const cached = db
      .query<{ root: string | null }, [string, string]>(
        "SELECT json_extract(data, '$.workspaceRoot') AS root FROM projects WHERE machine_id = ? AND project_id = ?",
      )
      .get(project.machineId, project.projectId);
    if (!cached) return undefined;
    root = cached.root ?? "";
  } else return undefined;
  const name = freeName(db, project, nameFor(repoKey ?? root));
  db.query(
    `INSERT INTO repos (machine_id, project_id, name, checkout_machine_id, checkout_project_id, repo_key, base)
         VALUES (?1, ?2, ?3, ?1, ?2, ?4, ?5)`,
  ).run(project.machineId, project.projectId, name, repoKey, base);
  return own(db, project);
}


/** `name`, or `name-2`, `name-3`… when the project already has a repo by that name. */
export function freeName(db: Database, project: ProjectRef, name: RepoName): RepoName {
  let candidate = name;
  for (let k = 2; byName(db, project, candidate); k++) {
    const suffix = `-${k}`;
    candidate = `${name.slice(0, Math.min(name.length, 32 - suffix.length)).replace(/-+$/, "")}${suffix}`;
  }
  return candidate;
}

/** Adds a repo to the project, its files in `checkout`, its key and base those the checkout's work is bound to. */
export function attach(db: Database, project: ProjectRef, name: RepoName, checkout: ProjectRef): ProjectRepo {
  const scope = scopeOf(db, checkout);
  db.query(
    `INSERT INTO repos (machine_id, project_id, name, checkout_machine_id, checkout_project_id, repo_key, base)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    project.machineId,
    project.projectId,
    name,
    checkout.machineId,
    checkout.projectId,
    scope?.repoKey ?? null,
    scope?.base ?? null,
  );
  return byName(db, project, name) as ProjectRepo;
}

/** Takes the repo out of the project; its checkout stays as it is. */
export function detach(db: Database, project: ProjectRef, name: RepoName): boolean {
  return (
    db
      .query("DELETE FROM repos WHERE machine_id = ? AND project_id = ? AND name = ?")
      .run(project.machineId, project.projectId, name).changes > 0
  );
}

/** The other projects holding the checkout as one of their repos, each with that repo. */
export function holders(db: Database, checkout: ProjectRef): { project: ProjectRef; repo: ProjectRepo }[] {
  return db
    .query<Row, [string, string]>(
      `SELECT ${COLUMNS} FROM repos WHERE checkout_machine_id = ?1 AND checkout_project_id = ?2
         AND NOT (machine_id = ?1 AND project_id = ?2) ORDER BY n`,
    )
    .all(checkout.machineId, checkout.projectId)
    .map((row) => ({ project: projectOf(row), repo: repoOf(row) }));
}

/** Forgets the project's repos and every repo whose files were in it: its node no longer has it. */
export function removeProject(db: Database, project: ProjectRef): void {
  db.query(
    `DELETE FROM repos WHERE (machine_id = ?1 AND project_id = ?2)
         OR (checkout_machine_id = ?1 AND checkout_project_id = ?2)`,
  ).run(project.machineId, project.projectId);
}

type RefRow = { machine_id: string; project_id: string };
const refOf = (r: RefRow): ProjectRef => ({ machineId: r.machine_id, projectId: r.project_id });

/** The projects the hub has cached whose repos, or own directory's work, are on `repoKey`. */
export function withKey(db: Database, repoKey: string): ProjectRef[] {
  return db
    .query<RefRow, [string]>(
      `SELECT machine_id, project_id FROM projects p
         WHERE EXISTS (SELECT 1 FROM repos r
                       WHERE r.machine_id = p.machine_id AND r.project_id = p.project_id AND r.repo_key = ?1)
            OR EXISTS (SELECT 1 FROM work_projects w
                       WHERE w.machine_id = p.machine_id AND w.project_id = p.project_id AND w.repo_key = ?1)
         ORDER BY machine_id, project_id`,
    )
    .all(repoKey)
    .map(refOf);
}

/** Every project the hub has cached. */
export function cachedProjects(db: Database): ProjectRef[] {
  return db.query<RefRow, []>("SELECT machine_id, project_id FROM projects ORDER BY machine_id, project_id").all().map(refOf);
}
