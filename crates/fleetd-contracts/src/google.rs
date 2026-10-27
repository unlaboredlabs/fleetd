//! fleetd's own Google connection for a Navi: Gmail, Calendar and Drive (hub/google, node/google, `fleetd
//! google-mcp`). The hub's admin brings one Google OAuth client of the "Desktop app" type; its secret is sealed in the
//! app to each machine's box key, like a global MCP server's. A person connects their own Google account to a Navi from
//! the app: the app opens Google's consent page with PKCE and catches the answer on a loopback address
//! (`http://127.0.0.1:<port>`), and the Navi's node trades the code for tokens and keeps them in its home, outside the
//! Navi's folder. The hub keeps the client id, fingerprints and each connection's address, never a secret or a token.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::brand;
use crate::ids::{ProjectId, ProjectRef, Timestamp};
use crate::mcp_servers::McpSealedOn;
use crate::prim::Line;
use crate::secrets::{SealedSecret, SecretFingerprint};

/// The native server's name in a Navi lead's `--mcp-config`: claude shows its tools as `mcp__google__<tool>`.
pub const GOOGLE_SERVER: &str = "google";

/// `fleetd google-mcp`: the command the hub gives a session for the native server; its node runs its own binary.
pub const GOOGLE_MCP_ARG: &str = "google-mcp";

/// Google's consent page.
pub const GOOGLE_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";

/// The least a Navi's tools need: the account's address; reading mail (`gmail.readonly`) and drafting and sending it
/// (`gmail.compose`, which can't delete or relabel); calendar events; and Drive, whole, because searching, reading and
/// sharing the person's own files reach files fleetd didn't create (`drive.file` covers only those).
pub const GOOGLE_SCOPES: &[&str] = &[
    "openid",
    "email",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/drive",
];

brand!(
    /// A Google OAuth client id: `<number>-<letters>.apps.googleusercontent.com`.
    GoogleClientId,
    name = "GoogleClientId",
    pattern = r"^[A-Za-z0-9._-]{1,200}\.apps\.googleusercontent\.com$"
);

brand!(
    /// An authorization code from Google's redirect.
    GoogleCode,
    name = "GoogleCode",
    pattern = r"^[A-Za-z0-9/._~+-]{1,2048}$"
);

brand!(
    /// A PKCE code verifier (RFC 7636): 43 to 128 unreserved characters.
    PkceVerifier,
    name = "PkceVerifier",
    pattern = r"^[A-Za-z0-9._~-]{43,128}$"
);

brand!(
    /// The loopback address the app caught Google's answer on: `http://127.0.0.1:<port>` and a path.
    LoopbackUri,
    name = "LoopbackUri",
    pattern = r"^http://127\.0\.0\.1:[1-9][0-9]{0,4}(/[A-Za-z0-9/._-]*)?$"
);

/// The hub's admin's OAuth client, as the hub keeps it: no secret.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GoogleClient {
    pub client_id: GoogleClientId,
    /// Each machine whose node holds its secret, with that node's fingerprint of it.
    #[serde(default)]
    pub sealed_on: Vec<McpSealedOn>,
    pub updated_at: Timestamp,
}

/// One Navi's Google account.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GoogleAccount {
    pub project_ref: ProjectRef,
    /// The account's address, as Gmail names it.
    pub email: Line<1, 320>,
    /// What the person granted: Google lets them untick some.
    pub scopes: Vec<Line<1, 200>>,
    pub connected_at: Timestamp,
    /// Google stopped taking the connection (revoked, or a testing app's 7 days ran out): why, as the Navi's node last
    /// saw it. The app offers Reconnect.
    pub lapsed: Option<String>,
}

/// Test: whether Google takes the client's id and secret, asked with a code that can't work. Google answers
/// `invalid_grant` for a client it knows and `invalid_client` for one it doesn't.
#[skip_serializing_none]
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct GoogleClientCheck {
    pub ok: bool,
    /// What's wrong, in a line a person can act on.
    pub problem: Option<String>,
}

/// Hub -> node (`SessionCall::Google`). Only nodes listing [`crate::node_link::CAP_GOOGLE`] get it.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum GoogleCall {
    /// Keep the client: its id and its secret opened with the node's box key. No `sealed`: forget the client.
    #[serde(rename_all = "camelCase")]
    ClientSet {
        client_id: GoogleClientId,
        sealed: Option<SealedSecret>,
    },
    /// Ask Google whether it takes the client this node holds.
    ClientTest,
    /// Trade a code for the project's tokens and keep them in place of any it had; the answer has the account's
    /// address. Google revokes a whole grant (one account, one client) at once, so the grant replaced is revoked only
    /// when it was another account's that no address in `in_use` names.
    #[serde(rename_all = "camelCase")]
    Connect {
        project_id: ProjectId,
        code: GoogleCode,
        code_verifier: PkceVerifier,
        redirect_uri: LoopbackUri,
        /// The addresses other Navis on the hub are connected to.
        #[serde(default)]
        in_use: Vec<Line<1, 320>>,
    },
    /// Whether the project's tokens still work, as the last refresh found.
    #[serde(rename_all = "camelCase")]
    Status { project_id: ProjectId },
    /// Delete the project's tokens. `revoke`: no other Navi on the hub uses the account, so its grant is revoked at
    /// Google first; otherwise only this Navi's tokens go.
    #[serde(rename_all = "camelCase")]
    Disconnect { project_id: ProjectId, revoke: bool },
}

/// Node -> hub, the answer to a [`GoogleCall`].
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum GoogleAnswer {
    /// The secret's fingerprint; none once forgotten.
    ClientSaved {
        fingerprint: Option<SecretFingerprint>,
    },
    ClientTested(GoogleClientCheck),
    Connected {
        email: Line<1, 320>,
        scopes: Vec<Line<1, 200>>,
    },
    /// No `connected`: the node holds no tokens for it. `lapsed`: Google refused its last refresh, and why.
    Status {
        connected: bool,
        lapsed: Option<String>,
    },
    /// Whether Google confirmed the revoke; the tokens are deleted either way.
    Disconnected {
        revoked: bool,
    },
}

/// The redirect the admin's client takes: any loopback port, which a "Desktop app" client accepts unregistered.
pub const GOOGLE_REDIRECT: &str = "http://127.0.0.1";
