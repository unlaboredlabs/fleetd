//! A project's repos. A project is a workspace: a lead and its own directory on its home machine (its `ProjectRef`),
//! with zero or more git repos in it. A plain directory with no git has none; a project added from a checkout has that
//! checkout as its one repo. Records that name no repo (`Task.repoId` absent, as on everything an older hub stored)
//! mean the project's own directory.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::brand;
use crate::ids::ProjectRef;
use crate::work::{BranchName, RepoKey};

brand!(
    /// "R" plus a positive integer, unique per hub and never reused, e.g. "R3".
    RepoId, name = "RepoId", pattern = r"^R[1-9][0-9]*$"
);

brand!(
    /// What a person or an agent picks a repo by, unique within its project, e.g. "api".
    RepoName, name = "RepoName", pattern = r"^[a-z0-9-]{1,32}$", description = "Repo name, [a-z0-9-]{1,32}"
);

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRepo {
    pub repo_id: RepoId,
    pub name: RepoName,
    /// The node's directory holding its files: the project's own `ProjectRef` when the project's directory is this
    /// repo.
    pub checkout: ProjectRef,
    /// Its origin remote, shortened; absent for a repo with no remote, or before fleetd has read it.
    pub repo_key: Option<RepoKey>,
    /// The branch its work lands on; absent until fleetd knows it.
    pub base: Option<BranchName>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn repo_id_is_r_plus_a_positive_integer() {
        for id in ["R1", "R42"] {
            assert!(RepoId::new(id).is_ok(), "{id}");
        }
        for id in ["R0", "R01", "r1", "T1", "R", "R1a"] {
            assert!(RepoId::new(id).is_err(), "{id}");
        }
    }

    #[test]
    fn repo_name_is_a_short_lowercase_slug() {
        for name in ["api", "web-client", "r2", &"a".repeat(32)] {
            assert!(RepoName::new(name).is_ok(), "{name}");
        }
        for name in ["", "Api", "web_client", "a b", "api/", &"a".repeat(33)] {
            assert!(RepoName::new(name).is_err(), "{name}");
        }
    }

    #[test]
    fn a_repo_round_trips_and_needs_no_remote() {
        let repo = json!({
            "repoId": "R1",
            "name": "api",
            "checkout": { "machineId": "devbox", "projectId": "p1" },
            "repoKey": "github.com/acme/api",
            "base": "main",
        });
        let decoded: ProjectRepo = serde_json::from_value(repo.clone()).unwrap();
        assert_eq!(serde_json::to_value(&decoded).unwrap(), repo);
        // A local repo with no remote, before fleetd knows its base.
        let local = json!({
            "repoId": "R2",
            "name": "notes",
            "checkout": { "machineId": "devbox", "projectId": "p2" },
        });
        let decoded: ProjectRepo = serde_json::from_value(local.clone()).unwrap();
        assert_eq!(decoded.repo_key, None);
        assert_eq!(serde_json::to_value(&decoded).unwrap(), local);
        assert!(
            serde_json::from_value::<ProjectRepo>(
                json!({ "repoId": "R3", "name": "Bad", "checkout": local["checkout"] })
            )
            .is_err()
        );
    }

    #[test]
    fn a_project_may_hold_no_repo() {
        use crate::model::ProjectSummary;
        // What a node and an older hub send, and a plain directory with no git: no repos, and none on the wire.
        let plain = json!({
            "machineId": "devbox",
            "projectId": "p1",
            "title": "notes",
            "workspaceRoot": "/home/me/notes",
            "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 },
            "lastActivityAt": "2026-10-17T10:00:00.000Z",
        });
        let decoded: ProjectSummary = serde_json::from_value(plain.clone()).unwrap();
        assert!(decoded.repos.is_empty());
        assert_eq!(serde_json::to_value(&decoded).unwrap(), plain);
        let mut two = plain.clone();
        two["repos"] = json!([
            { "repoId": "R1", "name": "api", "checkout": { "machineId": "devbox", "projectId": "p1" }, "repoKey": "github.com/acme/api", "base": "main" },
            { "repoId": "R4", "name": "web", "checkout": { "machineId": "devbox", "projectId": "p9" } },
        ]);
        let decoded: ProjectSummary = serde_json::from_value(two.clone()).unwrap();
        assert_eq!(decoded.repos.len(), 2);
        assert_eq!(serde_json::to_value(&decoded).unwrap(), two);
    }
}
