//! A project's repos (W79). A project is a lead and its own directory (its `ProjectRef`), with zero or more git repos.
//! Its own repo, whose checkout is the project's directory, exists once the hub knows that directory is a git repo:
//! adding it saw one, or its work is bound to a remote. Every project the hub has cached gets it at start, and again
//! whenever its node reports it, its work is bound, or its repos are read. A plain directory has none.
//!
//! Nothing acts on repos yet: the hub stores them and serves them in `ProjectSummary.repos`.
use std::sync::Arc;

use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::repos::{ProjectRepo, RepoId, RepoName};

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

/// At hub start: the backfill, for projects cached before the hub had repos.
pub fn backfill(hub: &Hub) {
    match hub.repos.backfill() {
        Ok(own) => tracing::debug!(own, "repos: projects' own repos backfilled"),
        Err(error) => tracing::warn!(%error, "repos: projects' own repos not backfilled"),
    }
}
