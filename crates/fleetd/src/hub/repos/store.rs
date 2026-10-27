//! Repo rows: `repos`, one per repo of a project, with the node checkout holding its files (`checkout_*`) and the
//! repo and base its work lands on.
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::prim::Line;
use fleetd_contracts::repos::{ProjectRepo, RepoId, RepoName};
use fleetd_contracts::work::RepoKey;
use rusqlite::{Connection, OptionalExtension, Row, params};

const COLUMNS: &str =
    "n, name, checkout_machine_id, checkout_project_id, repo_key, base, machine_id, project_id";

fn repo_of(row: &Row<'_>) -> rusqlite::Result<ProjectRepo> {
    Ok(ProjectRepo {
        repo_id: RepoId::unchecked(format!("R{}", row.get::<_, i64>(0)?)),
        name: RepoName::unchecked(row.get::<_, String>(1)?),
        checkout: ProjectRef {
            machine_id: MachineId::unchecked(row.get::<_, String>(2)?),
            project_id: ProjectId::unchecked(row.get::<_, String>(3)?),
        },
        repo_key: row.get::<_, Option<String>>(4)?.map(RepoKey::unchecked),
        base: row.get::<_, Option<String>>(5)?.map(Line::unchecked),
    })
}

fn project_of(row: &Row<'_>) -> rusqlite::Result<ProjectRef> {
    Ok(ProjectRef {
        machine_id: MachineId::unchecked(row.get::<_, String>(6)?),
        project_id: ProjectId::unchecked(row.get::<_, String>(7)?),
    })
}

/// The project's repos, oldest first.
pub fn of(db: &Connection, project: &ProjectRef) -> rusqlite::Result<Vec<ProjectRepo>> {
    db.prepare_cached(&format!(
        "SELECT {COLUMNS} FROM repos WHERE machine_id = ? AND project_id = ? ORDER BY n"
    ))?
    .query_map(
        params![project.machine_id.as_str(), project.project_id.as_str()],
        repo_of,
    )?
    .collect()
}

/// The repo and the project it is in.
pub fn get(
    db: &Connection,
    repo_id: &RepoId,
) -> rusqlite::Result<Option<(ProjectRef, ProjectRepo)>> {
    let Ok(n) = repo_id.as_str()[1..].parse::<i64>() else {
        return Ok(None);
    };
    db.prepare_cached(&format!("SELECT {COLUMNS} FROM repos WHERE n = ?"))?
        .query_row([n], |row| Ok((project_of(row)?, repo_of(row)?)))
        .optional()
}

pub fn by_name(
    db: &Connection,
    project: &ProjectRef,
    name: &RepoName,
) -> rusqlite::Result<Option<ProjectRepo>> {
    db.prepare_cached(&format!(
        "SELECT {COLUMNS} FROM repos WHERE machine_id = ? AND project_id = ? AND name = ?"
    ))?
    .query_row(
        params![
            project.machine_id.as_str(),
            project.project_id.as_str(),
            name.as_str()
        ],
        repo_of,
    )
    .optional()
}

/// The project's own repo: the one whose checkout is the project's directory.
pub fn own(db: &Connection, project: &ProjectRef) -> rusqlite::Result<Option<ProjectRepo>> {
    db.prepare_cached(&format!(
        "SELECT {COLUMNS} FROM repos WHERE machine_id = ?1 AND project_id = ?2
         AND checkout_machine_id = ?1 AND checkout_project_id = ?2"
    ))?
    .query_row(
        params![project.machine_id.as_str(), project.project_id.as_str()],
        repo_of,
    )
    .optional()
}

/// The repos whose files are in the checkout, each with its project.
pub fn holding(
    db: &Connection,
    checkout: &ProjectRef,
) -> rusqlite::Result<Vec<(ProjectRef, RepoId)>> {
    db.prepare_cached(&format!(
        "SELECT {COLUMNS} FROM repos WHERE checkout_machine_id = ? AND checkout_project_id = ? ORDER BY n"
    ))?
    .query_map(
        params![checkout.machine_id.as_str(), checkout.project_id.as_str()],
        |row| Ok((project_of(row)?, repo_of(row)?.repo_id)),
    )?
    .collect()
}

/// Makes sure the project has its own repo when its directory is a git repo, and that the repo's key and base are the
/// ones its work is bound to (`work_projects`). The directory is known to be a git repo when `git_root`, where the
/// caller saw it, is given, or when the hub has the project cached and its work is bound (it has an origin). Otherwise
/// the project stays as it is: a plain directory has no repo, and a removed project gets none back. Returns the own
/// repo.
pub fn ensure_own(
    db: &Connection,
    project: &ProjectRef,
    git_root: Option<&str>,
) -> rusqlite::Result<Option<ProjectRepo>> {
    let scope = crate::hub::work::store::scope_of(db, project)?;
    let repo_key = scope.as_ref().map(|s| s.repo_key.as_str());
    let base = scope.as_ref().map(|s| s.base.as_str());
    if own(db, project)?.is_some() {
        db.prepare_cached(
            "UPDATE repos SET repo_key = ?3, base = ?4 WHERE machine_id = ?1 AND project_id = ?2
             AND checkout_machine_id = ?1 AND checkout_project_id = ?2 AND (repo_key IS NOT ?3 OR base IS NOT ?4)",
        )?
        .execute(params![project.machine_id.as_str(), project.project_id.as_str(), repo_key, base])?;
        return own(db, project);
    }
    let root = match git_root {
        Some(root) => root.to_owned(),
        None if scope.is_some() => {
            let cached = db
                .prepare_cached(
                    "SELECT json_extract(data, '$.workspaceRoot') FROM projects WHERE machine_id = ? AND project_id = ?",
                )?
                .query_row(
                    params![project.machine_id.as_str(), project.project_id.as_str()],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()?;
            let Some(root) = cached else {
                return Ok(None);
            };
            root.unwrap_or_default()
        }
        None => return Ok(None),
    };
    let name = free_name(db, project, &name_for(repo_key.or(Some(&root))))?;
    db.prepare_cached(
        "INSERT INTO repos (machine_id, project_id, name, checkout_machine_id, checkout_project_id, repo_key, base)
         VALUES (?1, ?2, ?3, ?1, ?2, ?4, ?5)",
    )?
    .execute(params![
        project.machine_id.as_str(),
        project.project_id.as_str(),
        name.as_str(),
        repo_key,
        base
    ])?;
    own(db, project)
}

/// A repo's name from the last part of its repo key or folder: `github.com/acme/My_Shop` → `my-shop`; `repo` when
/// nothing is left.
pub fn name_for(path: Option<&str>) -> RepoName {
    let last = path
        .map(|p| p.trim_end_matches('/'))
        .and_then(|p| p.rsplit('/').next())
        .unwrap_or("");
    let mut name = String::new();
    for c in last.to_lowercase().chars() {
        let c = if c.is_ascii_alphanumeric() { c } else { '-' };
        if !(c == '-' && (name.is_empty() || name.ends_with('-'))) {
            name.push(c);
        }
    }
    name.truncate(32);
    let name = name.trim_end_matches('-');
    RepoName::new(if name.is_empty() { "repo" } else { name }).expect("a slug")
}

/// `name`, or `name-2`, `name-3`… when the project already has a repo by that name.
fn free_name(db: &Connection, project: &ProjectRef, name: &RepoName) -> rusqlite::Result<RepoName> {
    let mut candidate = name.clone();
    let mut k = 2;
    while by_name(db, project, &candidate)?.is_some() {
        let suffix = format!("-{k}");
        let stem = &name.as_str()[..name.as_str().len().min(32 - suffix.len())];
        candidate =
            RepoName::new(format!("{}{suffix}", stem.trim_end_matches('-'))).expect("a slug");
        k += 1;
    }
    Ok(candidate)
}

/// Forgets the project's repos and every repo whose files were in it: its node no longer has it.
pub fn remove_project(db: &Connection, project: &ProjectRef) -> rusqlite::Result<()> {
    db.prepare_cached(
        "DELETE FROM repos WHERE (machine_id = ?1 AND project_id = ?2)
         OR (checkout_machine_id = ?1 AND checkout_project_id = ?2)",
    )?
    .execute(params![
        project.machine_id.as_str(),
        project.project_id.as_str()
    ])?;
    Ok(())
}

/// Every project the hub has cached.
pub fn cached_projects(db: &Connection) -> rusqlite::Result<Vec<ProjectRef>> {
    db.prepare_cached(
        "SELECT machine_id, project_id FROM projects ORDER BY machine_id, project_id",
    )?
    .query_map([], |row| {
        Ok(ProjectRef {
            machine_id: MachineId::unchecked(row.get::<_, String>(0)?),
            project_id: ProjectId::unchecked(row.get::<_, String>(1)?),
        })
    })?
    .collect()
}
