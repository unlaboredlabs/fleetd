//! The hub's own GitHub App (D190): one per hub, which its admin creates through GitHub's app-manifest flow, with
//! nothing to paste. The app (or `fleetd github-app create` on the hub machine) serves a page on a loopback address
//! that posts the hub's manifest to GitHub; GitHub sends the admin back there with a code, and the hub trades the code
//! for the App's id, keys and secrets (`POST /app-manifests/{code}/conversions`). The private key, client secret and
//! webhook secret go straight from GitHub to the hub, which seals them to its own box key: no person sees them.
//!
//! The hub mints the App's installation tokens, an hour at a time, for its own work on repositories the App is
//! installed on: the train's reads, rebases, statuses and merges, and the PR reads. A repository the App doesn't reach
//! falls back to the hub machine's `gh` login, as before. Webhooks stay off (D192): the hub polls.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::brand;
use crate::ids::Timestamp;
use crate::prim::Line;

/// What the App asks for on each repository it is installed on, as the manifest's `default_permissions`: contents and
/// pull requests to rebase and merge, issues to find and label PRs (`fleetd:next`: labels and the labelled list go
/// through the issues endpoints), workflows to merge changes to `.github/workflows`, statuses to post `fleetd/train`,
/// actions to re-run CI, and checks to read it. Metadata is always read. A test holds the train's and PR pages' API
/// calls to this list (hub/github_app/tests.rs).
pub const GITHUB_APP_PERMISSIONS: &[(&str, &str)] = &[
    ("contents", "write"),
    ("pull_requests", "write"),
    ("issues", "write"),
    ("workflows", "write"),
    ("statuses", "write"),
    ("actions", "write"),
    ("checks", "read"),
    ("metadata", "read"),
];

brand!(
    /// The code GitHub's manifest flow redirects with: an hour to trade it, once.
    GithubManifestCode,
    name = "GithubManifestCode",
    pattern = r"^[A-Za-z0-9_-]{1,200}$"
);

brand!(
    /// A GitHub account or organization login.
    GithubLogin,
    name = "GithubLogin",
    pattern = r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$"
);

brand!(
    /// An App's name as GitHub takes it: at most 34 characters.
    GithubAppName,
    name = "GithubAppName",
    pattern = r"^[^\r\n]{1,34}$"
);

/// The hub's App, as the hub keeps it: no key and no secret.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GithubApp {
    pub app_id: i64,
    /// From GitHub's answer, never from the name proposed: the admin may rename it on GitHub's form.
    pub slug: Line<1, 100>,
    pub name: Line<1, 100>,
    /// What people sign in through it with (not a secret).
    pub client_id: Line<1, 100>,
    /// The account or organization that owns it.
    pub owner: Line<1, 100>,
    /// Its public page on GitHub.
    pub html_url: Line<1, 500>,
    /// Its settings on GitHub, under its owner's: where it is changed or deleted.
    pub settings_url: Line<1, 500>,
    pub created_at: Timestamp,
    /// Where it is installed, as the last Test (or token) read them.
    #[serde(default)]
    pub installations: Vec<GithubInstallation>,
    pub last_test: Option<GithubAppTest>,
}

/// One installation of the App: an account or organization, and the repositories it reaches there.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GithubInstallation {
    pub installation_id: i64,
    pub account: Line<1, 100>,
    /// Every repository of the account, now and later.
    pub all_repositories: bool,
    /// How many it reaches.
    pub repository_count: i64,
    /// With chosen repositories: their `owner/name`, the first 100.
    #[serde(default)]
    pub repositories: Vec<Line<1, 200>>,
}

/// What the last Test said.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GithubAppTest {
    pub at: Timestamp,
    pub ok: bool,
    /// In a line a person can act on.
    pub said: Line<1, 1000>,
}
