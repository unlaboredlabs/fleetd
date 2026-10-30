//! The hub's own GitHub App (D190): one per hub, which its admin creates through GitHub's app-manifest flow, with
//! nothing to paste. The app (or `fleetd github-app create` on the hub machine) serves a page on a loopback address
//! that posts the hub's manifest to GitHub; GitHub sends the admin back there with a code, and the hub trades the code
//! for the App's id, keys and secrets (`POST /app-manifests/{code}/conversions`). The private key, client secret and
//! webhook secret go straight from GitHub to the hub, which seals them to its own box key: no person sees them.
//!
//! The hub mints the App's installation tokens, an hour at a time, for its own work on repositories the App is
//! installed on: the train's reads, rebases, statuses and merges, and the PR reads. A repository the App doesn't reach
//! falls back to the hub machine's `gh` login, as before. Webhooks stay off (D192): the hub polls.
//!
//! Each person connects their own GitHub account through the same App (`github_connect`): the app opens GitHub's
//! sign-in with a loopback redirect, and the hub trades the code for a user-to-server token, which it keeps sealed and
//! refreshes. An order's agents get its starter's token as `GH_TOKEN`, so the PRs they open are that person's (D187);
//! work nobody started gets the App's own. A writer whose starter hasn't connected is refused until they do: never
//! anyone else's account.
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

/// The variable an agent's `gh` takes its token from.
pub const GITHUB_TOKEN_ENV: &str = "GH_TOKEN";

/// The refusal for a writer whose order's starter hasn't connected GitHub, on a repository the App reaches.
pub const GITHUB_CONNECT_REFUSAL: &str = "Connect your GitHub to open this order's PRs.";

/// Where people sign in to GitHub through the App: each person's own loopback port, under this path.
pub const GITHUB_CALLBACK_PATH: &str = "/github/callback";

brand!(
    /// The code GitHub's manifest flow redirects with: an hour to trade it, once.
    GithubManifestCode,
    name = "GithubManifestCode",
    pattern = r"^[A-Za-z0-9_-]{1,200}$"
);

brand!(
    /// The code GitHub's sign-in redirects with.
    GithubCode,
    name = "GithubCode",
    pattern = r"^[A-Za-z0-9_-]{1,200}$"
);

brand!(
    /// A PKCE code verifier (RFC 7636): 43 to 128 unreserved characters.
    PkceVerifier,
    name = "PkceVerifier",
    pattern = r"^[A-Za-z0-9._~-]{43,128}$"
);

brand!(
    /// The loopback address the app serves the manifest page on: `http://127.0.0.1:<port>` and a path.
    LoopbackUri,
    name = "LoopbackUri",
    pattern = r"^http://127\.0\.0\.1:[1-9][0-9]{0,4}(/[A-Za-z0-9/._-]*)?$"
);

brand!(
    /// The loopback address the app caught GitHub's sign-in on: `http://127.0.0.1:<port>/github/callback`.
    GithubLoopback,
    name = "GithubLoopback",
    pattern = r"^http://127\.0\.0\.1:[1-9][0-9]{0,4}/github/callback$"
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

/// One person's GitHub, as an owner or admin sees it on People: absent `account` until they connect.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PersonGithub {
    pub person: crate::people::PersonRef,
    pub account: Option<GithubAccount>,
}

/// A person's own GitHub account, as the hub keeps it: no token.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GithubAccount {
    pub login: Line<1, 100>,
    pub user_id: i64,
    pub connected_at: Timestamp,
    /// GitHub no longer takes its refresh token (revoked, or six months unused): Connect again.
    pub lapsed: Option<bool>,
}
