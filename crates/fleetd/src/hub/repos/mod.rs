//! A project's repos (W79). A project is a lead and its own directory (its `ProjectRef`), with zero or more git repos.
//! Its own repo, whose checkout is the project's directory, exists once the hub knows that directory is a git repo:
//! adding it saw one, or its work is bound to a remote. Every project the hub has cached gets it at start, and again
//! whenever its node reports it, its work is bound, or its repos are read. A plain directory has none.
//!
//! The hub stores them, serves them in `ProjectSummary.repos`, and keeps a repo's own `setup` on its row
//! (`projects::settings`). `project_repo_add` and `project_repo_remove` (`projects::repos`) add and remove the others:
//! each a node checkout of its own, which stops showing as a project while another project holds it.
use std::sync::Arc;

use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::repos::{ProjectRepo, RepoId, RepoName};

use rusqlite::OptionalExtension;

use crate::hub::api::Hub;
use crate::hub::store::{HubDb, StoreError};

pub mod store;
#[cfg(test)]
mod tests;

pub struct Repos {
    db: Arc<HubDb>,
}

impl Repos {
    pub fn new(db: Arc<HubDb>) -> Arc<Self> {
        Arc::new(Self { db })
    }

    /// The project's repos, oldest first (its own repo first): none for a plain directory.
    pub fn repos_of(&self, project: &ProjectRef) -> Result<Vec<ProjectRepo>, StoreError> {
        self.db.transaction(|c| {
            store::ensure_own(c, project, None)?;
            Ok(store::of(c, project)?)
        })
    }

    /// The repo and the project it is in.
    pub fn repo(&self, repo_id: &RepoId) -> Result<Option<(ProjectRef, ProjectRepo)>, StoreError> {
        self.db.with(|c| Ok(store::get(c, repo_id)?))
    }

    pub fn repo_by_name(
        &self,
        project: &ProjectRef,
        name: &RepoName,
    ) -> Result<Option<ProjectRepo>, StoreError> {
        self.db.transaction(|c| {
            store::ensure_own(c, project, None)?;
            Ok(store::by_name(c, project, name)?)
        })
    }

    /// The repo whose checkout is the project's own directory; none for a plain directory.
    pub fn own(&self, project: &ProjectRef) -> Result<Option<ProjectRepo>, StoreError> {
        self.db
            .transaction(|c| Ok(store::ensure_own(c, project, None)?))
    }

    /// The repos whose files are in the node checkout, each with its project.
    pub fn checkout_owners(
        &self,
        checkout: &ProjectRef,
    ) -> Result<Vec<(ProjectRef, RepoId)>, StoreError> {
        self.db.with(|c| Ok(store::holding(c, checkout)?))
    }

    /// Adds the checkout to the project as a repo named `name`, else one from its remote or folder made unique in the
    /// project.
    pub fn attach(
        &self,
        project: &ProjectRef,
        name: Option<&RepoName>,
        checkout: &ProjectRef,
        folder: &str,
    ) -> Result<ProjectRepo, StoreError> {
        self.db.transaction(|c| {
            let name = match name {
                Some(name) => name.clone(),
                None => {
                    let key = crate::hub::work::store::scope_of(c, checkout)?.map(|s| s.repo_key);
                    let from = key.as_ref().map(|k| k.as_str()).unwrap_or(folder);
                    store::free_name(c, project, &store::name_for(Some(from)))?
                }
            };
            Ok(store::attach(c, project, &name, checkout)?)
        })
    }

    /// Takes the repo out of the project: true when it was in it.
    pub fn detach(&self, project: &ProjectRef, name: &RepoName) -> Result<bool, StoreError> {
        self.db.with(|c| Ok(store::detach(c, project, name)?))
    }

    /// [`store::holders`]: the other projects holding the checkout, each with that repo.
    pub fn holders(
        &self,
        checkout: &ProjectRef,
    ) -> Result<Vec<(ProjectRef, ProjectRepo)>, StoreError> {
        self.db.with(|c| Ok(store::holders(c, checkout)?))
    }

    /// [`store::ensure_own`]: `git_root` when the caller saw a git repo at the project's directory.
    pub fn ensure_own(
        &self,
        project: &ProjectRef,
        git_root: Option<&str>,
    ) -> Result<Option<ProjectRepo>, StoreError> {
        self.db
            .transaction(|c| Ok(store::ensure_own(c, project, git_root)?))
    }

    /// Gives every cached project whose work is bound its own repo; again is a no-op. Returns how many have one.
    pub fn backfill(&self) -> Result<usize, StoreError> {
        self.db.transaction(|c| {
            let mut own = 0;
            for project in store::cached_projects(c)? {
                own += usize::from(store::ensure_own(c, &project, None)?.is_some());
            }
            Ok(own)
        })
    }
}

/// The first other project holding the checkout as a repo, with that repo: while there is one, the checkout's own
/// project is archived read-only (its chat and history stay; its lead doesn't run and takes no message).
pub fn holder(
    db: &HubDb,
    checkout: &ProjectRef,
) -> Result<Option<(ProjectRef, ProjectRepo)>, StoreError> {
    db.with(|c| Ok(store::holders(c, checkout)?.into_iter().next()))
}

/// When `thread` is the lead of an archived project: the project holding its checkout, with that repo.
pub fn archived_lead(
    db: &HubDb,
    thread: &fleetd_contracts::ids::ThreadRef,
) -> Result<Option<(ProjectRef, ProjectRepo)>, StoreError> {
    db.with(|c| {
        let project: Option<String> = c
            .prepare_cached("SELECT project_id FROM leads WHERE machine_id = ? AND thread_id = ?")?
            .query_row(
                rusqlite::params![thread.machine_id.as_str(), thread.thread_id.as_str()],
                |row| row.get(0),
            )
            .optional()?;
        let Some(project_id) = project else {
            return Ok(None);
        };
        let checkout = ProjectRef {
            machine_id: thread.machine_id.clone(),
            project_id: fleetd_contracts::ids::ProjectId::unchecked(project_id),
        };
        Ok(store::holders(c, &checkout)?.into_iter().next())
    })
}

/// Why an archived project refuses, and the fix.
pub fn archived_note(holder: &ProjectRef, repo: &ProjectRepo) -> (String, String) {
    (
        format!(
            "This project is archived: its directory is repo {} of project {} on {}.",
            repo.name, holder.project_id, holder.machine_id
        ),
        "Write to that project's lead instead; project_repo_remove takes the repo out of it and brings this project \
         back."
            .to_owned(),
    )
}

/// At hub start: the backfill, for projects cached before the hub had repos.
pub fn backfill(hub: &Hub) {
    match hub.repos.backfill() {
        Ok(own) => tracing::debug!(own, "repos: projects' own repos backfilled"),
        Err(error) => tracing::warn!(%error, "repos: projects' own repos not backfilled"),
    }
}
