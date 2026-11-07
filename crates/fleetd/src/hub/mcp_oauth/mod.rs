//! MCP servers that sign in with OAuth, as MCP's authorization spec has it, with no fleetd-run OAuth app: the hub
//! registers itself with the service where it may (dynamic client registration), else takes the person's own client.
//!
//! `mcp_oauth_start` discovers where a saved server signs in ([`oauth::discover`]) and hands the app the service's
//! sign-in page, opened with PKCE and a redirect to a page the hub serves (`<hub>/oauth/callback`, [`callback`]), so it
//! works from any machine that reaches the hub. The callback trades the code for the tokens ([`finish`]). The hub keeps
//! them sealed to its own box key in `mcp_oauth`, and seals each access token to the project's machine as the server's
//! `Authorization` header ([`push`]), where the node keeps it as it keeps a typed key. [`run_renew`] renews a token
//! before it ends and hands the node the new one; a service that refuses to renew signs the server out
//! ([`McpOauthStatus::SignedOut`]): agents go without it, the app shows Reconnect with the reason, and the project's
//! chat says so once. Disconnecting revokes the token where the service offers it.
pub mod callback;
pub mod oauth;
#[cfg(test)]
mod tests;
pub mod tools;

use std::sync::{Arc, LazyLock};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef, Timestamp};
use fleetd_contracts::mcp_servers::{
    McpField, McpOauth, McpOauthStatus, McpScope, McpSealedOn, McpSecretKey, McpSecretSet,
    McpServer, McpServerName, McpTransport, McpValue, McpValueName, OAUTH_HEADER,
};
use fleetd_contracts::project_settings::EnvVarKind;
use fleetd_contracts::secrets::SealedSecret;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::json;
use zeroize::Zeroizing;

use crate::hub::api::Hub;
use crate::hub::store::{HubDb, NewEvent, StoreError, iso_ms, now_ms};

/// How long a sign-in waits for the person to finish it in their browser.
pub const PENDING_MS: i64 = 15 * 60_000;
/// How often [`run_renew`] looks.
pub const RENEW_TICK: Duration = Duration::from_secs(30);
/// A token is renewed once it has half its life left, and never later than this before it ends: an agent's claude
/// keeps the token it started with until it next starts.
const MARGIN_MAX_MS: i64 = 30 * 60_000;
/// A token whose life the service didn't say is renewed this long before it ends.
const MARGIN_UNKNOWN_MS: i64 = 5 * 60_000;
/// After a renewal that failed for a reason other than a refusal, the next try waits this long.
const RETRY_MS: i64 = 2 * 60_000;

/// One token change at a time, hub-wide: a renewal and a sign-in of one server would each replace the other's tokens.
static ONE: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

/// A client of one service: where it signs in, and as which app.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Client {
    /// The MCP server, as the tokens' audience.
    pub resource: String,
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub revocation_endpoint: Option<String>,
    pub scope: Option<String>,
    pub client_id: String,
    /// fleetd registered it itself, for `redirect_uri`; false: the person's own.
    pub registered: bool,
    pub redirect_uri: String,
    /// Its secret, sealed to the hub's own box key (standard base64); none for a public client.
    pub sealed_secret: Option<String>,
    /// `client_secret_basic` or `client_secret_post`, with a secret.
    pub token_auth: Option<String>,
}

/// A sign-in waiting for its callback: the client it was opened with (which replaces the one before only once it
/// works), and its PKCE verifier.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub client: Client,
    pub verifier: String,
    pub started_ms: i64,
}

/// What the hub keeps of a server's sign-in besides its sealed tokens (`mcp_oauth.data`).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    /// The client the tokens were issued to: they are renewed and revoked with it. None before the first sign-in.
    pub client: Option<Client>,
    pub expires_ms: Option<i64>,
    /// How long the last access token was given for.
    pub lifetime_ms: Option<i64>,
    /// The project's machine holds the current access token.
    #[serde(default)]
    pub pushed: bool,
    /// Renewing has failed since then for a reason other than a refusal.
    pub failing_since_ms: Option<i64>,
    /// No renewal is tried before then.
    pub retry_ms: Option<i64>,
    /// The project's chat was told the token ended while renewing failed.
    #[serde(default)]
    pub told: bool,
    pub pending: Option<Pending>,
}

/// One server's row, its tokens still sealed.
pub struct Row {
    pub scope: McpScope,
    pub name: McpServerName,
    pub record: Record,
    pub state: Option<String>,
    pub access: Option<Vec<u8>>,
    pub refresh: Option<Vec<u8>>,
}

impl Row {
    pub fn project(&self) -> Option<ProjectRef> {
        match &self.scope {
            McpScope::Project {
                machine_id,
                project_id,
            } => Some(ProjectRef {
                machine_id: machine_id.clone(),
                project_id: project_id.clone(),
            }),
            McpScope::Global => None,
        }
    }
}

const COLUMNS: &str = "machine_id, project_id, name, data, state, sealed_access, sealed_refresh";

fn row_of(r: &rusqlite::Row<'_>) -> rusqlite::Result<Option<Row>> {
    let (m, p, name, data): (String, String, String, String) =
        (r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?);
    let scope = match (m.as_str(), p.as_str()) {
        ("", "") => McpScope::Global,
        _ => match (MachineId::new(m), ProjectId::new(p)) {
            (Ok(machine_id), Ok(project_id)) => McpScope::Project {
                machine_id,
                project_id,
            },
            _ => return Ok(None),
        },
    };
    let (Ok(name), Ok(record)) = (
        McpServerName::new(name),
        serde_json::from_str::<Record>(&data),
    ) else {
        return Ok(None);
    };
    Ok(Some(Row {
        scope,
        name,
        record,
        state: r.get(4)?,
        access: r.get(5)?,
        refresh: r.get(6)?,
    }))
}

pub fn get(db: &HubDb, scope: &McpScope, name: &McpServerName) -> Result<Option<Row>, StoreError> {
    let (m, p) = crate::hub::mcp_servers::scope_key(scope);
    db.with(|c| {
        Ok(c.query_row(
            &format!("SELECT {COLUMNS} FROM mcp_oauth WHERE machine_id = ? AND project_id = ? AND name = ?"),
            params![m, p, name.as_str()],
            row_of,
        )
        .optional()?
        .flatten())
    })
}

fn by_state(db: &HubDb, state: &str) -> Result<Option<Row>, StoreError> {
    db.with(|c| {
        Ok(c.query_row(
            &format!("SELECT {COLUMNS} FROM mcp_oauth WHERE state = ?"),
            params![state],
            row_of,
        )
        .optional()?
        .flatten())
    })
}

fn all(db: &HubDb) -> Result<Vec<Row>, StoreError> {
    db.with(|c| {
        let mut stmt = c.prepare_cached(&format!("SELECT {COLUMNS} FROM mcp_oauth"))?;
        let rows = stmt
            .query_map([], row_of)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows.into_iter().flatten().collect())
    })
}

fn put(db: &HubDb, row: &Row) -> Result<(), StoreError> {
    let (m, p) = crate::hub::mcp_servers::scope_key(&row.scope);
    let data = serde_json::to_string(&row.record)?;
    db.with(|c| {
        c.execute(
            "INSERT INTO mcp_oauth (machine_id, project_id, name, data, state, sealed_access, sealed_refresh)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (machine_id, project_id, name) DO UPDATE SET data = excluded.data, state = excluded.state,
               sealed_access = excluded.sealed_access, sealed_refresh = excluded.sealed_refresh",
            params![m, p, row.name.as_str(), data, row.state, row.access, row.refresh],
        )?;
        Ok(())
    })
}

fn remove(db: &HubDb, scope: &McpScope, name: &McpServerName) -> Result<(), StoreError> {
    let (m, p) = crate::hub::mcp_servers::scope_key(scope);
    db.with(|c| {
        c.execute(
            "DELETE FROM mcp_oauth WHERE machine_id = ? AND project_id = ? AND name = ?",
            params![m, p, name.as_str()],
        )?;
        Ok(())
    })
}

fn now(hub: &Hub) -> i64 {
    now_ms(hub.clock.as_ref())
}

fn seal_own(hub: &Hub, plain: &str) -> Result<Vec<u8>, String> {
    crate::hub::hub_links::box_key(hub)
        .map_err(|e| format!("the hub's box key can't be read: {e}"))?
        .seal(plain.as_bytes())
        .ok_or_else(|| "sealing failed".to_owned())
}

fn open_own(hub: &Hub, sealed: &[u8]) -> Result<Zeroizing<String>, String> {
    let plain = crate::hub::hub_links::box_key(hub)
        .map_err(|e| format!("the hub's box key can't be read: {e}"))?
        .open(sealed)
        .ok_or("a token was sealed to another box key: the hub's home changed. Sign in again")?;
    String::from_utf8(plain.to_vec())
        .map(Zeroizing::new)
        .map_err(|_| "a sealed token isn't text".to_owned())
}

/// A client's secret, opened.
fn client_secret(hub: &Hub, client: &Client) -> Result<Option<Zeroizing<String>>, String> {
    client
        .sealed_secret
        .as_deref()
        .map(|b64| {
            let sealed = B64
                .decode(b64)
                .map_err(|_| "a client secret isn't base64")?;
            open_own(hub, &sealed)
        })
        .transpose()
}

/// Changes the server's row in one step, so a save in between isn't lost; the server as it is now, or none when it
/// is gone.
fn update_server(
    db: &HubDb,
    scope: &McpScope,
    name: &McpServerName,
    change: impl FnOnce(&mut McpServer),
) -> Result<Option<McpServer>, StoreError> {
    let (m, p) = crate::hub::mcp_servers::scope_key(scope);
    db.transaction(|c| {
        let data: Option<String> = c
            .query_row(
                "SELECT data FROM mcp_servers WHERE machine_id = ? AND project_id = ? AND name = ?",
                params![m, p, name.as_str()],
                |r| r.get(0),
            )
            .optional()?;
        let Some(mut server) = data.and_then(|d| serde_json::from_str::<McpServer>(&d).ok()) else {
            return Ok(None);
        };
        change(&mut server);
        c.execute(
            "UPDATE mcp_servers SET data = ? WHERE machine_id = ? AND project_id = ? AND name = ?",
            params![serde_json::to_string(&server)?, m, p, name.as_str()],
        )?;
        Ok(Some(server))
    })
}

/// Sets the server's sign-in as the app sees it, and tells the app.
fn show(hub: &Hub, row: &Row, change: impl FnOnce(&mut McpOauth)) -> Result<(), StoreError> {
    let issuer = row
        .record
        .pending
        .as_ref()
        .map(|p| &p.client)
        .or(row.record.client.as_ref())
        .map(|c| c.issuer.clone())
        .unwrap_or_default();
    let updated = update_server(&hub.db, &row.scope, &row.name, |server| {
        let mut oauth = server.oauth.take().unwrap_or(McpOauth {
            status: McpOauthStatus::SignedOut,
            issuer,
            client_id: None,
            signing_in: false,
            signed_in_at: None,
            expires_at: None,
            problem: None,
        });
        change(&mut oauth);
        server.oauth = Some(oauth);
    })?;
    let Some(server) = updated else {
        return Ok(());
    };
    let status = server.oauth.as_ref().map(|o| o.status);
    let project = row.project();
    hub.events.append(NewEvent {
        at: iso_ms(now(hub)).into(),
        r#type: HubEventType::McpOauth,
        machine_id: project.as_ref().map(|r| r.machine_id.clone()),
        project_id: project.as_ref().map(|r| r.project_id.clone()),
        thread_id: None,
        summary: format!("{}'s sign-in changed", row.name),
        data: Some(json!({ "projectRef": project, "name": row.name, "status": status })),
        attention: None,
    })?;
    Ok(())
}

/// A line in the project's chat.
fn say(hub: &Hub, row: &Row, text: &str) {
    if let Some(r) = row.project()
        && let Err(error) = hub.chat.system_line(&r, text)
    {
        tracing::warn!(%error, server = %row.name, "an MCP sign-in line was not said in the chat");
    }
}

fn ts(ms: i64) -> Timestamp {
    Timestamp(iso_ms(ms))
}

/// The URL and transport kind of a server that can sign in.
pub fn url_of(server: &McpServer) -> Option<(&str, bool)> {
    match &server.transport {
        McpTransport::Http { url } => Some((url.as_str(), false)),
        McpTransport::Sse { url } => Some((url.as_str(), true)),
        McpTransport::Stdio { .. } => None,
    }
}

/// The person's own client, its secret opened.
pub struct OwnClient {
    pub id: String,
    pub secret: Option<Zeroizing<String>>,
}

/// What [`start`] found.
pub enum Started {
    /// Open this in the person's browser.
    SignIn { authorize_url: String },
    /// The service lets no app register itself, and the person gave no client: they make one that allows the
    /// redirect, at `issuer`.
    NeedsClient { issuer: String },
}

/// Opens a sign-in for a saved HTTP or SSE server of a project: where it signs in, which client (the one the server
/// signed in with before, the person's own, or one fleetd registers now for `redirect`), and the sign-in page to
/// open. The server's tokens, if it has any, stay in use until the new sign-in finishes. Errors are for the person.
pub async fn start(
    hub: &Hub,
    server: &McpServer,
    redirect: &str,
    own: Option<OwnClient>,
) -> Result<Started, String> {
    let (url, sse) = url_of(server).ok_or("only a server reached by URL signs in")?;
    let found = oauth::discover(url, sse).await?;
    let before = get(&hub.db, &server.scope, &server.name).map_err(|e| e.to_string())?;
    let earlier = before.as_ref().and_then(|row| {
        row.record
            .pending
            .as_ref()
            .map(|p| &p.client)
            .or(row.record.client.as_ref())
            .filter(|c| c.issuer == found.issuer)
            .cloned()
    });
    let client = match (own, earlier) {
        (Some(own), _) => {
            let sealed_secret = own
                .secret
                .as_ref()
                .map(|s| seal_own(hub, s).map(|b| B64.encode(b)))
                .transpose()?;
            Client {
                token_auth: sealed_secret
                    .as_ref()
                    .map(|_| oauth::token_auth_for(&found.auth_methods)),
                client_id: own.id,
                registered: false,
                redirect_uri: redirect.to_owned(),
                sealed_secret,
                ..client_of(&found)
            }
        }
        // The person's own client keeps the redirect they gave it; a registered one is fleetd's for its redirect.
        (None, Some(earlier)) if !earlier.registered || earlier.redirect_uri == redirect => {
            Client {
                client_id: earlier.client_id,
                registered: earlier.registered,
                redirect_uri: earlier.redirect_uri,
                sealed_secret: earlier.sealed_secret,
                token_auth: earlier.token_auth,
                ..client_of(&found)
            }
        }
        (None, _) if found.registration_endpoint.is_some() => {
            let registered = oauth::register(&found, redirect).await?;
            let sealed_secret = registered
                .client_secret
                .as_ref()
                .map(|s| seal_own(hub, s).map(|b| B64.encode(b)))
                .transpose()?;
            Client {
                client_id: registered.client_id,
                registered: true,
                redirect_uri: redirect.to_owned(),
                sealed_secret,
                token_auth: registered.token_auth,
                ..client_of(&found)
            }
        }
        (None, _) => {
            return Ok(Started::NeedsClient {
                issuer: found.issuer,
            });
        }
    };
    let (verifier, challenge) = oauth::pkce();
    let state = oauth::state();
    let authorize_url = oauth::authorize_url(
        &client.authorization_endpoint,
        &client.client_id,
        &client.redirect_uri,
        &challenge,
        &state,
        client.scope.as_deref(),
        &client.resource,
    )?;
    let _one = ONE.lock().await;
    let mut row = get(&hub.db, &server.scope, &server.name)
        .map_err(|e| e.to_string())?
        .unwrap_or(Row {
            scope: server.scope.clone(),
            name: server.name.clone(),
            record: Record::default(),
            state: None,
            access: None,
            refresh: None,
        });
    let own_id = (!client.registered).then(|| client.client_id.clone());
    row.record.pending = Some(Pending {
        client,
        verifier: verifier.to_string(),
        started_ms: now(hub),
    });
    row.state = Some(state);
    put(&hub.db, &row).map_err(|e| e.to_string())?;
    show(hub, &row, |o| {
        o.signing_in = true;
        o.issuer = found.issuer.clone();
        o.client_id = own_id;
        o.problem = None;
    })
    .map_err(|e| e.to_string())?;
    Ok(Started::SignIn { authorize_url })
}

fn client_of(found: &oauth::Discovered) -> Client {
    Client {
        resource: found.resource.clone(),
        issuer: found.issuer.clone(),
        authorization_endpoint: found.authorization_endpoint.clone(),
        token_endpoint: found.token_endpoint.clone(),
        revocation_endpoint: found.revocation_endpoint.clone(),
        scope: found.scope.clone(),
        client_id: String::new(),
        registered: false,
        redirect_uri: String::new(),
        sealed_secret: None,
        token_auth: None,
    }
}

/// How a callback ended, for its page.
pub enum Finished {
    /// Signed in; `on_machine` false when the machine was offline and gets the token once it is back.
    Connected {
        name: McpServerName,
        on_machine: bool,
    },
    Failed {
        name: Option<McpServerName>,
        problem: String,
    },
}

/// The service sent the browser back with `state` and a `code`, or an `error`: trades the code for the tokens,
/// keeps them, and hands the access token to the project's machine.
pub async fn finish(hub: &Hub, state: &str, code: Option<&str>, error: Option<String>) -> Finished {
    let _one = ONE.lock().await;
    let row = match by_state(&hub.db, state) {
        Ok(Some(row)) => row,
        Ok(None) => {
            return Finished::Failed {
                name: None,
                problem: "This sign-in link was already used, or replaced by a newer one. Start the sign-in again \
                          from fleetd."
                    .into(),
            };
        }
        Err(e) => {
            return Finished::Failed {
                name: None,
                problem: format!("The hub can't read its sign-ins: {e}"),
            };
        }
    };
    let name = row.name.clone();
    match exchange(hub, row, code, error).await {
        Ok(on_machine) => Finished::Connected { name, on_machine },
        Err(problem) => Finished::Failed {
            name: Some(name),
            problem,
        },
    }
}

async fn exchange(
    hub: &Hub,
    mut row: Row,
    code: Option<&str>,
    error: Option<String>,
) -> Result<bool, String> {
    let Some(pending) = row.record.pending.take() else {
        return Err("This sign-in was already finished. Start it again from fleetd.".into());
    };
    row.state = None;
    let host = oauth::host_of(&pending.client.issuer);
    let outcome = async {
        if now(hub) - pending.started_ms > PENDING_MS {
            return Err(
                "This sign-in took over 15 minutes. Start it again from fleetd.".to_owned(),
            );
        }
        if let Some(error) = error {
            return Err(format!("{host} didn't sign you in ({error})."));
        }
        let code =
            code.ok_or_else(|| format!("{host} sent the browser back without a sign-in code."))?;
        let secret = client_secret(hub, &pending.client)?;
        let client = oauth::Client {
            id: &pending.client.client_id,
            secret: secret.as_deref().map(String::as_str),
            auth: pending.client.token_auth.as_deref(),
        };
        oauth::token(
            &pending.client.token_endpoint,
            &client,
            &pending.client.resource,
            &[
                ("grant_type", "authorization_code"),
                ("code", code),
                ("redirect_uri", &pending.client.redirect_uri),
                ("code_verifier", &pending.verifier),
            ],
        )
        .await
        .map_err(|e| match e {
            oauth::TokenError::Refused(words) => {
                format!("{host} refused the sign-in ({words}). Start it again.")
            }
            oauth::TokenError::Failed(words) => format!("Signing in failed: {words}."),
        })
    }
    .await;
    let tokens = match outcome {
        Ok(tokens) => tokens,
        Err(problem) => {
            put(&hub.db, &row).map_err(|e| e.to_string())?;
            show(hub, &row, |o| {
                o.signing_in = false;
                o.problem = Some(problem.clone());
            })
            .map_err(|e| e.to_string())?;
            return Err(problem);
        }
    };
    let at = now(hub);
    row.record.client = Some(pending.client);
    keep_tokens(hub, &mut row, &tokens, at)?;
    put(&hub.db, &row).map_err(|e| e.to_string())?;
    // The token goes to the machine first: the app tests the server as soon as it reads Connected, and a session
    // starting then gets it with its header.
    let on_machine = match push(hub, &mut row).await {
        Ok(()) => true,
        Err(why) => {
            tracing::info!(server = %row.name, "a signed-in MCP server's token waits for its machine: {why}");
            false
        }
    };
    let expires_ms = row.record.expires_ms;
    show(hub, &row, |o| {
        o.status = McpOauthStatus::Connected;
        o.signing_in = false;
        o.signed_in_at = Some(ts(at));
        o.expires_at = expires_ms.map(ts);
        o.problem = None;
    })
    .map_err(|e| e.to_string())?;
    Ok(on_machine)
}

/// Seals new tokens in the row: a refresh token the service didn't replace stays.
fn keep_tokens(hub: &Hub, row: &mut Row, tokens: &oauth::Tokens, at: i64) -> Result<(), String> {
    row.access = Some(seal_own(hub, &tokens.access)?);
    if let Some(refresh) = &tokens.refresh {
        row.refresh = Some(seal_own(hub, refresh)?);
    }
    row.record.lifetime_ms = tokens.expires_in.map(|s| s * 1000);
    row.record.expires_ms = tokens.expires_in.map(|s| at + s * 1000);
    row.record.pushed = false;
    row.record.failing_since_ms = None;
    row.record.retry_ms = None;
    Ok(())
}

/// Seals the access token to the project's machine as the server's `Authorization` header, keeping its other
/// secrets there, and records the fingerprint the node answers.
pub async fn push(hub: &Hub, row: &mut Row) -> Result<(), String> {
    let r = row.project().ok_or("a global server doesn't sign in")?;
    let m = &r.machine_id;
    crate::hub::mcp_servers::tools::node_ready(hub, m).map_err(|e| e.message)?;
    let access = open_own(hub, row.access.as_deref().ok_or("no token to hand over")?)?;
    let box_key = hub
        .store
        .machine_get(m)
        .map_err(|e| e.to_string())?
        .and_then(|m| m.box_pub_key)
        .ok_or_else(|| format!("{m} has no box key to seal the token to"))?;
    let public: [u8; 32] = B64
        .decode(box_key.as_str())
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| format!("{m}'s box key isn't 32 bytes"))?;
    let value = Zeroizing::new(format!("Bearer {}", access.as_str()));
    let sealed = crypto_box::PublicKey::from(public)
        .seal(&mut crypto_box::aead::OsRng, value.as_bytes())
        .map_err(|e| e.to_string())?;
    let sealed = SealedSecret::new(B64.encode(sealed)).map_err(|_| "the token is too long")?;
    let server = hub
        .db
        .mcp_servers()
        .get(&row.scope, &row.name)
        .map_err(|e| e.to_string())?
        .ok_or("the server was removed")?;
    let header = McpValueName::unchecked(OAUTH_HEADER);
    let keep: Vec<McpSecretKey> = server
        .values()
        .filter(|(f, v)| {
            v.kind == EnvVarKind::Secret
                && !(*f == McpField::Header && v.name.eq_ignore_ascii_case(OAUTH_HEADER))
                && v.sealed_on.iter().any(|s| &s.machine_id == m)
        })
        .map(|(field, v)| McpSecretKey {
            field,
            name: v.name.clone(),
        })
        .collect();
    let saved = hub
        .executors
        .mcp_secrets(
            m,
            crate::hub::mcp_servers::secret_scope(&row.scope),
            row.name.clone(),
            vec![McpSecretSet {
                field: McpField::Header,
                name: header.clone(),
                sealed,
            }],
            keep,
        )
        .await
        .map_err(|e| crate::hub::executor::tools::from_executor(e).message)?;
    let fingerprint = saved
        .into_iter()
        .find(|s| s.field == McpField::Header && s.name == header)
        .map(|s| s.fingerprint)
        .ok_or("the machine didn't keep the token")?;
    update_server(&hub.db, &row.scope, &row.name, |server| {
        server
            .headers
            .retain(|v| !v.name.eq_ignore_ascii_case(OAUTH_HEADER));
        server.headers.push(McpValue {
            name: header.clone(),
            kind: EnvVarKind::Secret,
            value: None,
            sealed_on: vec![McpSealedOn {
                machine_id: m.clone(),
                fingerprint,
            }],
        });
    })
    .map_err(|e| e.to_string())?;
    row.record.pushed = true;
    put(&hub.db, row).map_err(|e| e.to_string())
}

/// Whether the token should be renewed now: half its life left, at most [`MARGIN_MAX_MS`].
fn due(record: &Record, at: i64) -> bool {
    let Some(expires) = record.expires_ms else {
        return false;
    };
    let margin = record
        .lifetime_ms
        .map_or(MARGIN_UNKNOWN_MS, |l| l / 2)
        .min(MARGIN_MAX_MS);
    expires - at <= margin
}

/// The service won't renew: agents go without the server until the person signs in again, the app shows why with
/// Reconnect, and the chat says so.
fn sign_out(hub: &Hub, row: &mut Row, problem: String) -> Result<(), String> {
    row.access = None;
    row.refresh = None;
    row.record.expires_ms = None;
    row.record.pushed = false;
    row.record.failing_since_ms = None;
    row.record.retry_ms = None;
    row.record.told = false;
    put(&hub.db, row).map_err(|e| e.to_string())?;
    show(hub, row, |o| {
        o.status = McpOauthStatus::SignedOut;
        o.expires_at = None;
        o.problem = Some(problem.clone());
    })
    .map_err(|e| e.to_string())?;
    say(
        hub,
        row,
        &format!(
            "{} is signed out: {problem} Navi can't use it until you press Reconnect on it in Navi's settings › \
             Integrations.",
            row.name
        ),
    );
    Ok(())
}

/// Whether a renewal left the server with a working token.
#[derive(Debug, PartialEq, Eq)]
pub enum Renewed {
    Yes,
    /// It failed this time; it is tried again.
    Later,
    SignedOut,
}

/// Renews the server's access token with its refresh token, and hands the new one to the machine.
pub async fn renew(hub: &Hub, row: &mut Row) -> Result<Renewed, String> {
    let at = now(hub);
    let Some(client) = row.record.client.clone() else {
        return Ok(Renewed::SignedOut);
    };
    let host = oauth::host_of(&client.issuer);
    let Some(sealed) = row.refresh.clone() else {
        if row.record.expires_ms.is_some_and(|e| e <= at) {
            sign_out(
                hub,
                row,
                format!("its sign-in ended, and {host} gives no way to renew it."),
            )?;
            return Ok(Renewed::SignedOut);
        }
        return Ok(Renewed::Later);
    };
    let refresh = open_own(hub, &sealed)?;
    let secret = client_secret(hub, &client)?;
    let answer = oauth::token(
        &client.token_endpoint,
        &oauth::Client {
            id: &client.client_id,
            secret: secret.as_deref().map(String::as_str),
            auth: client.token_auth.as_deref(),
        },
        &client.resource,
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh.as_str()),
        ],
    )
    .await;
    match answer {
        Ok(tokens) => {
            let told = row.record.told;
            keep_tokens(hub, row, &tokens, at)?;
            row.record.told = false;
            put(&hub.db, row).map_err(|e| e.to_string())?;
            let expires_ms = row.record.expires_ms;
            show(hub, row, |o| {
                o.expires_at = expires_ms.map(ts);
                o.problem = None;
            })
            .map_err(|e| e.to_string())?;
            if told {
                say(
                    hub,
                    row,
                    &format!("{} works again: the lead can use it.", row.name),
                );
            }
            if let Err(why) = push(hub, row).await {
                tracing::info!(server = %row.name, "a renewed MCP token waits for its machine: {why}");
            }
            Ok(Renewed::Yes)
        }
        Err(oauth::TokenError::Refused(words)) => {
            sign_out(
                hub,
                row,
                format!("{host} ended the sign-in ({words}), so you need to sign in again."),
            )?;
            Ok(Renewed::SignedOut)
        }
        Err(oauth::TokenError::Failed(words)) => {
            row.record.failing_since_ms.get_or_insert(at);
            row.record.retry_ms = Some(at + RETRY_MS);
            let ended = row.record.expires_ms.is_some_and(|e| e <= at);
            let tell = ended && !row.record.told;
            if tell {
                row.record.told = true;
            }
            put(&hub.db, row).map_err(|e| e.to_string())?;
            if tell {
                let problem = format!("fleetd can't renew its sign-in: {words}. It keeps trying.");
                show(hub, row, |o| o.problem = Some(problem.clone())).map_err(|e| e.to_string())?;
                say(
                    hub,
                    row,
                    &format!(
                        "{} isn't working: {problem} the lead can't use it until then.",
                        row.name
                    ),
                );
            }
            Ok(Renewed::Later)
        }
    }
}

/// One round of [`run_renew`]: ends sign-ins left unfinished, renews tokens near their end, and hands a machine back
/// online the token it missed.
pub async fn renew_due(hub: &Hub) {
    let rows = match all(&hub.db) {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!("MCP sign-ins not read: {e}");
            return;
        }
    };
    for row in rows {
        let _one = ONE.lock().await;
        // Read again under the lock: a callback may have changed it.
        let Ok(Some(mut row)) = get(&hub.db, &row.scope, &row.name) else {
            continue;
        };
        if let Err(why) = renew_one(hub, &mut row).await {
            tracing::warn!(server = %row.name, "MCP sign-in not renewed: {why}");
        }
    }
}

async fn renew_one(hub: &Hub, row: &mut Row) -> Result<(), String> {
    let at = now(hub);
    if row
        .record
        .pending
        .as_ref()
        .is_some_and(|p| at - p.started_ms > PENDING_MS)
    {
        row.record.pending = None;
        row.state = None;
        put(&hub.db, row).map_err(|e| e.to_string())?;
        show(hub, row, |o| {
            o.signing_in = false;
            o.problem =
                Some("The sign-in wasn't finished within 15 minutes. Start it again.".into());
        })
        .map_err(|e| e.to_string())?;
    }
    if row.access.is_none() {
        return Ok(());
    }
    if due(&row.record, at) && row.record.retry_ms.is_none_or(|r| r <= at) {
        renew(hub, row).await?;
    }
    if row.access.is_some() && !row.record.pushed {
        // A machine offline now gets it on a later round.
        let _ = push(hub, row).await;
    }
    Ok(())
}

/// [`renew_due`] every [`RENEW_TICK`], until the hub stops.
pub async fn run_renew(hub: Arc<Hub>) {
    loop {
        renew_due(&hub).await;
        hub.clock.sleep(RENEW_TICK).await;
    }
}

/// The server was removed, or no longer signs in (its URL changed, or a key replaced the sign-in): forgets its
/// sign-in, and revokes the token where the service offers it.
pub async fn forget(hub: &Hub, scope: &McpScope, name: &McpServerName) {
    let _one = ONE.lock().await;
    let row = match get(&hub.db, scope, name) {
        Ok(Some(row)) => row,
        Ok(None) => return,
        Err(e) => {
            tracing::warn!(server = %name, "MCP sign-in not read: {e}");
            return;
        }
    };
    if let Err(e) = remove(&hub.db, scope, name) {
        tracing::warn!(server = %name, "MCP sign-in not forgotten: {e}");
        return;
    }
    let Some(client) = &row.record.client else {
        return;
    };
    let Some(endpoint) = &client.revocation_endpoint else {
        return;
    };
    let (token, hint) = match (&row.refresh, &row.access) {
        (Some(t), _) => (t, "refresh_token"),
        (None, Some(t)) => (t, "access_token"),
        (None, None) => return,
    };
    let (Ok(token), Ok(secret)) = (open_own(hub, token), client_secret(hub, client)) else {
        return;
    };
    let client = oauth::Client {
        id: &client.client_id,
        secret: secret.as_deref().map(String::as_str),
        auth: client.token_auth.as_deref(),
    };
    if !oauth::revoke(endpoint, &client, &token, hint).await {
        tracing::info!(server = %name, "the service didn't confirm the MCP token's revocation");
    }
}

/// Renews the server's token now, as when the server turned the token away before it was due.
pub async fn renew_now(
    hub: &Hub,
    scope: &McpScope,
    name: &McpServerName,
) -> Result<Renewed, String> {
    let _one = ONE.lock().await;
    let Some(mut row) = get(&hub.db, scope, name).map_err(|e| e.to_string())? else {
        return Ok(Renewed::SignedOut);
    };
    if row.access.is_none() {
        return Ok(Renewed::SignedOut);
    }
    renew(hub, &mut row).await
}
