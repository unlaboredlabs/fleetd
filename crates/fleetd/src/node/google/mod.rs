//! A Navi's Google connection on its node (`crate::google` in the contracts): the admin's OAuth client in
//! `<node home>/google/client.json` and each Navi's tokens in `<node home>/google/accounts/<project>.json`, both mode
//! 0600 in 0700 directories, outside every project's folder. The node trades a code from the app's loopback redirect
//! for tokens, revokes them on disconnect, and `fleetd google-mcp` (cli/google_mcp.rs) reads them here to serve the
//! Navi's Gmail, Calendar and Drive tools ([`tools`]), refreshing the access token in place. No token or secret leaves
//! these files: errors name what failed, never a value.
pub mod files;
pub mod mail;
pub mod tools;

#[cfg(test)]
mod tests;

use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD};
use fleetd_contracts::google::{GoogleAnswer, GoogleCall, GoogleClientCheck};
use fleetd_contracts::prim::Line;
use fleetd_contracts::secrets::SecretFingerprint;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use zeroize::{Zeroize, Zeroizing};

use super::identity::NodeBoxKey;
use super::secrets::{fingerprint_of, write_atomic};

pub(super) const DIR: &str = "google";

/// Each Google call, the token endpoint's included.
const TIMEOUT: Duration = Duration::from_secs(30);

/// Where Google answers. Tests point all three at one fake server.
#[derive(Clone, Debug)]
pub struct Endpoints {
    /// The token and revoke endpoints.
    pub oauth: String,
    pub gmail: String,
    /// Calendar, Drive and Drive's uploads.
    pub www: String,
    /// Pub/Sub, for Gmail's push notifications.
    pub pubsub: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Endpoints {
            oauth: "https://oauth2.googleapis.com".into(),
            gmail: "https://gmail.googleapis.com".into(),
            www: "https://www.googleapis.com".into(),
            pubsub: "https://pubsub.googleapis.com".into(),
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Client {
    client_id: String,
    client_secret: String,
}

impl Drop for Client {
    fn drop(&mut self) {
        self.client_secret.zeroize();
    }
}

/// One Navi's tokens.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Account {
    email: String,
    scopes: Vec<String>,
    refresh_token: String,
    access_token: String,
    /// When the access token stops working, in ms since the epoch.
    expires_ms: i64,
    /// Why Google refused the last refresh: the person connects again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    lapsed: Option<String>,
    /// The client the tokens were made with: once the admin saves another, they can't refresh.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    client_id: Option<String>,
}

impl Drop for Account {
    fn drop(&mut self) {
        self.refresh_token.zeroize();
        self.access_token.zeroize();
    }
}

fn client_path(home: &Path) -> PathBuf {
    home.join(DIR).join("client.json")
}

/// Where a Navi's tokens live: under the node's home, never under the project's folder.
pub fn account_path(home: &Path, project_id: &str) -> PathBuf {
    // A project id is the node's own, but never a path.
    let name = project_id.replace(['/', '\\'], "_");
    home.join(DIR)
        .join("accounts")
        .join(format!("{}.json", name.trim_start_matches('.')))
}

/// Deletes a Navi's tokens when its project goes from the node; the hub revoked them first when it could.
pub fn forget(home: &Path, project_id: &str) {
    let _ = remove(&mail::state_path(home, project_id));
    if let Err(e) = remove(&account_path(home, project_id)) {
        tracing::warn!(project_id, "Google tokens not removed: {e}");
    }
}

/// Whether the Navi has an account on this node.
pub fn connected(home: &Path, project_id: &str) -> bool {
    account_path(home, project_id).is_file()
}

pub(super) fn read<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Option<T>, String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => Zeroizing::new(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| format!("{} does not parse", path.display()))
}

pub(super) fn write<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        super::config::mkdir_private(dir)
            .map_err(|e| format!("cannot make {}: {e}", dir.display()))?;
    }
    let bytes = Zeroizing::new(serde_json::to_vec(value).map_err(|e| e.to_string())?);
    write_atomic(path, &bytes).map_err(|e| format!("cannot write {}: {e}", path.display()))
}

pub(super) fn remove(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            Err(format!("cannot remove {}: {e}", path.display()))
        }
        _ => Ok(()),
    }
}

pub(super) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

pub(super) fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .unwrap_or_default()
}

/// Keeps the client, its secret opened with the node's box key; no `sealed` forgets it. The secret's fingerprint.
pub fn client_set(
    home: &Path,
    client_id: &str,
    sealed: Option<&str>,
    box_key: Option<&NodeBoxKey>,
) -> Result<Option<SecretFingerprint>, String> {
    let Some(sealed) = sealed else {
        remove(&client_path(home))?;
        return Ok(None);
    };
    let box_key = box_key.ok_or("this node takes no secrets: it has no box key")?;
    let boxed = Zeroizing::new(B64.decode(sealed).unwrap_or_default());
    let plain = box_key.open(&boxed).ok_or(
        "the client secret was not sealed to this machine's current box key: seal it to its boxPubKey again",
    )?;
    let secret = std::str::from_utf8(&plain)
        .ok()
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.len() <= 512 && !s.contains(['\r', '\n', '\0']))
        .ok_or("the client secret is empty, too long or not one line of text")?;
    let client = Client {
        client_id: client_id.to_owned(),
        client_secret: secret.to_owned(),
    };
    write(&client_path(home), &client)?;
    Ok(Some(SecretFingerprint::unchecked(fingerprint_of(
        secret.as_bytes(),
    ))))
}

fn client(home: &Path) -> Result<Client, String> {
    read(&client_path(home))?.ok_or_else(|| {
        "this machine holds no Google OAuth client: the hub's admin saves it in Administration › Google".to_owned()
    })
}

/// Google's error code and description from a token endpoint's answer.
fn oauth_error(body: &Value) -> (String, String) {
    let code = body["error"].as_str().unwrap_or("unknown").to_owned();
    let said = body["error_description"].as_str().unwrap_or("").to_owned();
    (code, said)
}

pub(super) async fn token_call(
    ep: &Endpoints,
    form: &[(&str, &str)],
) -> Result<Value, (String, String)> {
    let answer = http()
        .post(format!("{}/token", ep.oauth))
        .form(form)
        .send()
        .await
        .map_err(|e| {
            (
                "unreachable".to_owned(),
                format!("Google can't be reached: {e}"),
            )
        })?;
    let ok = answer.status().is_success();
    let body: Value = answer.json().await.unwrap_or_default();
    if ok {
        Ok(body)
    } else {
        Err(oauth_error(&body))
    }
}

/// Asks the token endpoint to trade a code that can't work: `invalid_grant` means Google knows the client and its
/// secret.
pub async fn client_test(home: &Path, ep: &Endpoints) -> GoogleClientCheck {
    let client = match client(home) {
        Ok(c) => c,
        Err(problem) => {
            return GoogleClientCheck {
                ok: false,
                problem: Some(problem),
            };
        }
    };
    let form = [
        ("grant_type", "authorization_code"),
        ("code", "fleetd-test"),
        ("client_id", client.client_id.as_str()),
        ("client_secret", client.client_secret.as_str()),
        ("redirect_uri", "http://127.0.0.1:1/"),
        (
            "code_verifier",
            "fleetd-test-fleetd-test-fleetd-test-fleetd-test",
        ),
    ];
    let problem = match token_call(ep, &form).await {
        Ok(_) => None,
        Err((code, _)) if code == "invalid_grant" => None,
        Err((code, _)) if code == "invalid_client" || code == "unauthorized_client" => Some(
            "Google doesn't know this client id and secret: copy both again from Google Auth Platform › Clients"
                .to_owned(),
        ),
        Err((code, _)) if code == "redirect_uri_mismatch" => Some(
            "the client takes no loopback address: make a client of the Desktop app type".to_owned(),
        ),
        Err((code, said)) if code == "unreachable" => Some(said),
        Err((code, said)) => Some(format!("Google answered {code}: {said}")),
    };
    GoogleClientCheck {
        ok: problem.is_none(),
        problem,
    }
}

/// The address in an ID token's claims, read without checking its signature: it came straight from Google's token
/// endpoint over TLS.
fn id_token_email(id_token: &str) -> Option<String> {
    let claims = id_token.split('.').nth(1)?;
    let claims: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(claims).ok()?).ok()?;
    claims["email"].as_str().map(str::to_owned)
}

/// Trades the app's code for the Navi's tokens, keeps them, and answers with the account's address.
pub async fn connect(
    home: &Path,
    ep: &Endpoints,
    project_id: &str,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
    in_use: &[&str],
) -> Result<(String, Vec<String>), String> {
    let client = client(home)?;
    let form = [
        ("grant_type", "authorization_code"),
        ("code", code),
        ("client_id", client.client_id.as_str()),
        ("client_secret", client.client_secret.as_str()),
        ("redirect_uri", redirect_uri),
        ("code_verifier", verifier),
    ];
    let mut body = token_call(ep, &form).await.map_err(|(code, said)| match code.as_str() {
        "invalid_grant" => "Google refused the code: it was used or is too old. Connect again.".to_owned(),
        "invalid_client" => {
            "Google doesn't know the hub's OAuth client: the admin checks it in Administration › Google".to_owned()
        }
        _ => format!("Google answered {code}: {said}"),
    })?;
    let take = |body: &mut Value, key: &str| -> String {
        match body.get_mut(key).map(Value::take) {
            Some(Value::String(s)) => s,
            _ => String::new(),
        }
    };
    let refresh_token = take(&mut body, "refresh_token");
    let access_token = take(&mut body, "access_token");
    let id_token = Zeroizing::new(take(&mut body, "id_token"));
    if refresh_token.is_empty() || access_token.is_empty() {
        return Err(
            "Google sent no refresh token: remove this app from the account's third-party access, then connect again"
                .into(),
        );
    }
    let scopes: Vec<String> = body["scope"]
        .as_str()
        .unwrap_or_default()
        .split_whitespace()
        .map(str::to_owned)
        .collect();
    let mut account = Account {
        email: String::new(),
        scopes,
        refresh_token,
        access_token,
        expires_ms: now_ms() + body["expires_in"].as_i64().unwrap_or(3600) * 1000,
        lapsed: None,
        client_id: Some(client.client_id.clone()),
    };
    account.email = match id_token_email(&id_token) {
        Some(email) => email,
        None => gmail_address(ep, &account.access_token).await?,
    };
    let path = account_path(home, project_id);
    let before = read::<Account>(&path).ok().flatten();
    write(&path, &account)?;
    // Google revokes a whole grant, the token just made included: the one replaced goes only when it was another
    // account's, which no other Navi uses.
    if let Some(before) = before
        && !before.email.eq_ignore_ascii_case(&account.email)
        && !in_use.iter().any(|e| e.eq_ignore_ascii_case(&before.email))
    {
        revoke(ep, &before.refresh_token).await;
    }
    Ok((account.email.clone(), account.scopes.clone()))
}

/// Revokes a refresh token at Google; whether Google confirmed.
async fn revoke(ep: &Endpoints, refresh_token: &str) -> bool {
    http()
        .post(format!("{}/revoke", ep.oauth))
        .form(&[("token", refresh_token)])
        .send()
        .await
        .is_ok_and(|a| a.status().is_success())
}

async fn gmail_address(ep: &Endpoints, access_token: &str) -> Result<String, String> {
    let body: Value = http()
        .get(format!("{}/gmail/v1/users/me/profile", ep.gmail))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("Google can't be reached: {e}"))?
        .json()
        .await
        .unwrap_or_default();
    body["emailAddress"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| "Google didn't say which account this is".to_owned())
}

/// Deletes the Navi's tokens, revoking its grant at Google first when `revoke_grant` (no other Navi uses the account),
/// whatever Google answers. Whether Google confirmed a revoke.
pub async fn disconnect(
    home: &Path,
    ep: &Endpoints,
    project_id: &str,
    revoke_grant: bool,
) -> Result<bool, String> {
    let path = account_path(home, project_id);
    let Some(account) = read::<Account>(&path)? else {
        return Ok(false);
    };
    let revoked = revoke_grant && revoke(ep, &account.refresh_token).await;
    remove(&path)?;
    let _ = remove(&mail::state_path(home, project_id));
    Ok(revoked)
}

/// The node's answer to the hub's `google` call. `folder`: the project's, for a call that reads in it.
pub async fn answer(
    home: &Path,
    ep: &Endpoints,
    call: GoogleCall,
    box_key: Option<&NodeBoxKey>,
    folder: Option<PathBuf>,
) -> Result<GoogleAnswer, String> {
    Ok(match call {
        GoogleCall::ClientSet { client_id, sealed } => GoogleAnswer::ClientSaved {
            fingerprint: client_set(
                home,
                client_id.as_str(),
                sealed.as_ref().map(|s| s.as_str()),
                box_key,
            )?,
        },
        GoogleCall::ClientTest => GoogleAnswer::ClientTested(client_test(home, ep).await),
        GoogleCall::Connect {
            project_id,
            code,
            code_verifier,
            redirect_uri,
            in_use,
        } => {
            let in_use: Vec<&str> = in_use.iter().map(|e| e.as_str()).collect();
            let (email, scopes) = connect(
                home,
                ep,
                project_id.as_str(),
                code.as_str(),
                code_verifier.as_str(),
                redirect_uri.as_str(),
                &in_use,
            )
            .await?;
            GoogleAnswer::Connected {
                email: Line::new(email).map_err(|_| "Google named no usable address".to_owned())?,
                scopes: scopes
                    .into_iter()
                    .filter_map(|s| Line::new(s).ok())
                    .collect(),
            }
        }
        GoogleCall::Status { project_id } => {
            let (connected, lapsed) = status(home, project_id.as_str())?;
            GoogleAnswer::Status { connected, lapsed }
        }
        GoogleCall::Disconnect { project_id, revoke } => GoogleAnswer::Disconnected {
            revoked: disconnect(home, ep, project_id.as_str(), revoke).await?,
        },
        GoogleCall::PubsubSet {
            subscription,
            sealed,
        } => GoogleAnswer::PubsubSaved {
            fingerprint: mail::pubsub_set(
                home,
                subscription.as_str(),
                sealed.as_ref().map(|s| s.as_str()),
                box_key,
            )?,
        },
        GoogleCall::MailPull => GoogleAnswer::Pulled {
            notices: mail::pull(home, ep).await?,
        },
        GoogleCall::MailWatch { project_id, topic } => {
            let s = Session::new(home.to_path_buf(), project_id.to_string(), ep.clone());
            GoogleAnswer::Watching {
                expires_ms: mail::watch(&s, topic.as_str()).await?,
            }
        }
        GoogleCall::MailCheck { project_id, query } => {
            let s = Session::new(home.to_path_buf(), project_id.to_string(), ep.clone());
            let checked = mail::check(&s, query.as_ref().map(|q| q.as_str())).await?;
            GoogleAnswer::NewMail {
                mails: checked.mails,
                more: (checked.more > 0).then_some(checked.more as u32),
            }
        }
        GoogleCall::MailFiles { paths, .. } => {
            let folder = folder.ok_or("the project has no folder on this machine")?;
            GoogleAnswer::MailFiles {
                files: tokio::task::spawn_blocking(move || files::inspect(&folder, &paths))
                    .await
                    .map_err(|e| e.to_string())??,
            }
        }
    })
}

/// What the Navi is told when Google stops taking its connection; the app shows the person Reconnect.
pub const LAPSED: &str = "Google no longer accepts this Navi's connection (it was revoked, it lapsed, or the hub's \
     Google client changed). Tell the person plainly: they connect Google to this Navi again in the app. Nothing was \
     sent.";

/// Whether the Navi holds tokens, and why Google refused their last refresh.
pub fn status(home: &Path, project_id: &str) -> Result<(bool, Option<String>), String> {
    Ok(match read::<Account>(&account_path(home, project_id))? {
        Some(a) => (true, a.lapsed.clone()),
        None => (false, None),
    })
}

/// One Navi's signed-in Google: what [`tools`] call with. The access token is refreshed when it has under a minute
/// left, and the new one written back.
pub struct Session {
    pub home: PathBuf,
    pub project_id: String,
    /// The Navi's folder, the only place its email attaches files from ([`files`]); none: it attaches none.
    pub folder: Option<PathBuf>,
    pub ep: Endpoints,
    pub http: reqwest::Client,
}

impl Session {
    pub fn new(home: PathBuf, project_id: String, ep: Endpoints) -> Self {
        Session {
            home,
            project_id,
            folder: None,
            ep,
            http: http(),
        }
    }

    /// A working access token.
    pub async fn token(&self) -> Result<Zeroizing<String>, String> {
        let path = account_path(&self.home, &self.project_id);
        let mut account = read::<Account>(&path)?.ok_or(
            "this Navi has no Google account: the person connects one in the app, on the Navi's Integrations",
        )?;
        if account.lapsed.is_some() {
            return Err(LAPSED.into());
        }
        if account.expires_ms - now_ms() > 60_000 {
            return Ok(Zeroizing::new(account.access_token.clone()));
        }
        let client = client(&self.home)?;
        let form = [
            ("grant_type", "refresh_token"),
            ("refresh_token", account.refresh_token.as_str()),
            ("client_id", client.client_id.as_str()),
            ("client_secret", client.client_secret.as_str()),
        ];
        let mut body = match token_call(&self.ep, &form).await {
            Ok(body) => body,
            // The client refused as it is now: a secret saved wrong lapses nothing, and the first refresh after the
            // admin fixes it works again.
            Err((code, _))
                if ["invalid_client", "unauthorized_client"].contains(&code.as_str())
                    && account
                        .client_id
                        .as_ref()
                        .is_none_or(|c| *c == client.client_id) =>
            {
                return Err(
                    "Google refused the hub's OAuth client (its secret may be wrong): the hub's admin checks it and \
                     saves it again. Nothing was sent."
                        .into(),
                );
            }
            // Revoked or expired; or made with a client the admin has since replaced.
            Err((code, said))
                if ["invalid_grant", "invalid_client", "unauthorized_client"]
                    .contains(&code.as_str()) =>
            {
                account.lapsed = Some(if said.is_empty() { code } else { said });
                write(&path, &account)?;
                return Err(LAPSED.into());
            }
            Err((code, said)) => return Err(format!("Google answered {code}: {said}")),
        };
        match body.get_mut("access_token").map(Value::take) {
            Some(Value::String(t)) if !t.is_empty() => account.access_token = t,
            _ => return Err("Google sent no access token".into()),
        }
        // Google may rotate the refresh token.
        if let Some(Value::String(r)) = body.get_mut("refresh_token").map(Value::take)
            && !r.is_empty()
        {
            account.refresh_token = r;
        }
        account.expires_ms = now_ms() + body["expires_in"].as_i64().unwrap_or(3600) * 1000;
        write(&path, &account)?;
        Ok(Zeroizing::new(account.access_token.clone()))
    }

    /// The account's address, for the tools' answers.
    pub fn email(&self) -> Option<String> {
        read::<Account>(&account_path(&self.home, &self.project_id))
            .ok()
            .flatten()
            .map(|a| a.email.clone())
    }
}
