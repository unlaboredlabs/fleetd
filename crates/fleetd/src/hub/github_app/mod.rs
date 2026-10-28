//! The hub's own GitHub App (D190, contracts `github_app`). The admin creates it through GitHub's manifest flow: a
//! loopback page (the desktop app's, or `fleetd github-app create`'s) posts [`manifest`] to GitHub, and GitHub sends
//! the admin back there with a code, which [`GithubApps::create`] trades for the App's id, private key and secrets.
//! They go from GitHub to the hub only, sealed at once to the hub's own box key (`<hub home>/box.key`) in the
//! `github_app` row; nothing returns or logs them.
//!
//! [`GithubApps::token_for`] gives the hub's `gh` an installation token for a repository the App is installed on
//! ([`gh::AppGh`]): it signs a JWT with the private key, reads the App's installations every few minutes, and mints
//! each installation's token an hour at a time. Any other repository, or no token to be had, leaves `gh` on the hub
//! machine's own login, as before the App; so does a run GitHub refuses to the App itself (gh.rs).
pub mod gh;
pub mod people;
pub mod sessions;
#[cfg(test)]
mod tests;
pub mod tools;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD};
use fleetd_contracts::github_app::{
    GITHUB_APP_PERMISSIONS, GithubApp, GithubAppTest, GithubInstallation,
};
use fleetd_contracts::ids::Timestamp;
use fleetd_contracts::prim::Line;
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use zeroize::Zeroizing;

use crate::clock::Clock;
use crate::hub::store::{HubDb, StoreError, iso_ms, now_ms};

/// Each call to GitHub.
const TIMEOUT: Duration = Duration::from_secs(30);
/// How often the App's installations and their repositories are read again: an install on more repositories shows
/// within this.
const REFRESH_MS: i64 = 10 * 60_000;
/// After a failed read, how long `gh` stays on the machine's login before the App is tried again.
const RETRY_MS: i64 = 60_000;
/// A token this close to its end is minted again.
const TOKEN_MARGIN_MS: i64 = 5 * 60_000;
/// The repositories read per installation with chosen ones: 10 pages of 100.
const REPO_PAGES: usize = 10;

/// Where the App's people sign in, once person sign-in comes: GitHub takes any port on a loopback callback.
pub const USER_CALLBACK: &str = "http://127.0.0.1/github/callback";

/// Where GitHub answers. Tests point both at one fake server.
#[derive(Clone, Debug)]
pub struct Endpoints {
    /// The REST API.
    pub api: String,
    /// github.com, for the pages a person opens.
    pub web: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Endpoints {
            api: "https://api.github.com".into(),
            web: "https://github.com".into(),
        }
    }
}

/// The manifest for an App named `name`, whose homepage is the hub and which sends the admin back to `redirect`.
/// Webhooks stay off: the hub polls (D192).
pub fn manifest(name: &str, hub_url: &str, redirect: &str) -> Value {
    let permissions: serde_json::Map<String, Value> = GITHUB_APP_PERMISSIONS
        .iter()
        .map(|(k, v)| ((*k).to_owned(), Value::from(*v)))
        .collect();
    json!({
        "name": name,
        "url": hub_url,
        "redirect_url": redirect,
        "callback_urls": [USER_CALLBACK],
        "request_oauth_on_install": false,
        "public": false,
        "default_permissions": permissions,
        "default_events": [],
    })
}

/// GitHub's page that takes the manifest: an organization's, or the admin's own account's.
pub fn new_app_page(web: &str, organization: Option<&str>) -> String {
    match organization {
        Some(org) => format!("{web}/organizations/{org}/settings/apps/new"),
        None => format!("{web}/settings/apps/new"),
    }
}

pub struct GithubAppStore<'a> {
    db: &'a HubDb,
}

impl HubDb {
    pub fn github_app(&self) -> GithubAppStore<'_> {
        GithubAppStore { db: self }
    }
}

impl GithubAppStore<'_> {
    pub fn get(&self) -> Result<Option<GithubApp>, StoreError> {
        let data: Option<String> = self.db.with(|c| {
            Ok(
                c.query_row("SELECT data FROM github_app WHERE id = 1", [], |row| {
                    row.get(0)
                })
                .optional()?,
            )
        })?;
        Ok(data.and_then(|d| serde_json::from_str(&d).ok()))
    }

    /// The App with its private key, still sealed.
    fn with_key(&self) -> Result<Option<(GithubApp, Vec<u8>)>, StoreError> {
        let row: Option<(String, Vec<u8>)> = self.db.with(|c| {
            Ok(c.query_row(
                "SELECT data, sealed_key FROM github_app WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?)
        })?;
        Ok(row.and_then(|(d, key)| Some((serde_json::from_str(&d).ok()?, key))))
    }

    fn put(&self, app: &GithubApp, sealed: &Sealed) -> Result<(), StoreError> {
        let data = serde_json::to_string(app)?;
        self.db.with(|c| {
            c.execute(
                "INSERT INTO github_app (id, data, sealed_key, sealed_client_secret, sealed_webhook_secret)
                 VALUES (1, ?, ?, ?, ?)
                 ON CONFLICT (id) DO UPDATE SET data = excluded.data, sealed_key = excluded.sealed_key,
                   sealed_client_secret = excluded.sealed_client_secret,
                   sealed_webhook_secret = excluded.sealed_webhook_secret",
                params![
                    data,
                    sealed.key,
                    sealed.client_secret,
                    sealed.webhook_secret
                ],
            )?;
            Ok(())
        })
    }

    /// Updates what the hub read about the same App; false when it is gone or another took its place meanwhile.
    fn update(&self, app: &GithubApp) -> Result<bool, StoreError> {
        let data = serde_json::to_string(app)?;
        self.db.transaction(|c| {
            let now: Option<String> = c
                .query_row("SELECT data FROM github_app WHERE id = 1", [], |row| {
                    row.get(0)
                })
                .optional()?;
            let same = now
                .and_then(|d| serde_json::from_str::<GithubApp>(&d).ok())
                .is_some_and(|a| a.app_id == app.app_id);
            if same {
                c.execute("UPDATE github_app SET data = ? WHERE id = 1", params![data])?;
            }
            Ok(same)
        })
    }

    pub fn remove(&self) -> Result<Option<GithubApp>, StoreError> {
        let app = self.get()?;
        self.db.with(|c| {
            c.execute("DELETE FROM github_app WHERE id = 1", [])?;
            Ok(())
        })?;
        Ok(app)
    }
}

/// What GitHub handed over, each sealed to the hub's box key.
struct Sealed {
    key: Vec<u8>,
    client_secret: Option<Vec<u8>>,
    webhook_secret: Option<Vec<u8>>,
}

struct Token {
    value: Zeroizing<String>,
    expires_ms: i64,
}

struct Install {
    id: i64,
    /// Lowercase, as repositories are matched.
    account: String,
    all: bool,
    /// `owner/name`, lowercase.
    repos: HashSet<String>,
    token: Option<Token>,
}

#[derive(Default)]
struct Cache {
    app_id: Option<i64>,
    read_ms: i64,
    failed_ms: Option<i64>,
    installs: Vec<Install>,
}

/// The hub's App: creating it, and its tokens.
pub struct GithubApps {
    db: Arc<HubDb>,
    home: PathBuf,
    clock: Arc<dyn Clock>,
    ep: RwLock<Endpoints>,
    cache: tokio::sync::Mutex<Cache>,
    /// One read of the installations at a time.
    refreshing: tokio::sync::Mutex<()>,
    /// One change to people's tokens at a time: a refresh renews the refresh token too.
    accounts: tokio::sync::Mutex<()>,
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        .user_agent("fleetd")
        .build()
        .unwrap_or_default()
}

/// GitHub's own words for a refusal: its `message`, else the status.
fn said(status: reqwest::StatusCode, body: &Value) -> String {
    body["message"]
        .as_str()
        .filter(|m| !m.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("HTTP {}", status.as_u16()))
}

/// GitHub's RFC 3339 `expires_at`, in milliseconds.
fn expires_ms(body: &Value) -> Option<i64> {
    crate::hub::store::parse_ms(body["expires_at"].as_str()?)
}

/// The RSA key of the App's PEM private key: PKCS #1, as GitHub makes it, or PKCS #8.
fn signer(pem: &str) -> Result<ring::signature::RsaKeyPair, String> {
    let body: String = pem
        .lines()
        .filter(|l| !l.starts_with("-----"))
        .collect::<Vec<_>>()
        .concat();
    let der = Zeroizing::new(
        B64.decode(body.trim())
            .map_err(|_| "the App's private key isn't PEM")?,
    );
    ring::signature::RsaKeyPair::from_der(&der)
        .or_else(|_| ring::signature::RsaKeyPair::from_pkcs8(&der))
        .map_err(|_| "the App's private key isn't an RSA key GitHub made".to_owned())
}

/// The App's JWT (RS256), good for nine minutes from a minute ago, as GitHub asks.
pub fn jwt(pem: &str, app_id: i64, now_s: i64) -> Result<Zeroizing<String>, String> {
    let pair = signer(pem)?;
    let head = URL_SAFE_NO_PAD.encode(json!({ "alg": "RS256", "typ": "JWT" }).to_string());
    let claims = URL_SAFE_NO_PAD.encode(
        json!({ "iat": now_s - 60, "exp": now_s + 540, "iss": app_id.to_string() }).to_string(),
    );
    let signed = format!("{head}.{claims}");
    let mut signature = vec![0; pair.public().modulus_len()];
    pair.sign(
        &ring::signature::RSA_PKCS1_SHA256,
        &ring::rand::SystemRandom::new(),
        signed.as_bytes(),
        &mut signature,
    )
    .map_err(|_| "the App's private key couldn't sign")?;
    Ok(Zeroizing::new(format!(
        "{signed}.{}",
        URL_SAFE_NO_PAD.encode(signature)
    )))
}

impl GithubApps {
    pub fn new(db: Arc<HubDb>, home: PathBuf, clock: Arc<dyn Clock>) -> Arc<Self> {
        Arc::new(Self {
            db,
            home,
            clock,
            ep: RwLock::new(Endpoints::default()),
            cache: tokio::sync::Mutex::new(Cache::default()),
            refreshing: tokio::sync::Mutex::new(()),
            accounts: tokio::sync::Mutex::new(()),
        })
    }

    /// Points every call at other endpoints: a fake GitHub in tests.
    pub fn set_endpoints(&self, ep: Endpoints) {
        *self.ep.write().unwrap_or_else(|e| e.into_inner()) = ep;
    }

    /// The App as the hub keeps it.
    pub fn get(&self) -> Result<Option<GithubApp>, StoreError> {
        self.db.github_app().get()
    }

    pub fn endpoints(&self) -> Endpoints {
        self.ep.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn now_ms(&self) -> i64 {
        now_ms(self.clock.as_ref())
    }

    fn box_key(&self) -> Result<crate::node::identity::NodeBoxKey, String> {
        crate::node::identity::load_or_create_box_key(&self.home).map_err(|e| {
            tracing::error!(error = %e, "hub box key");
            "the hub can't read its box key: check the hub's home directory".to_owned()
        })
    }

    /// One call to GitHub's API: the answer's JSON, or GitHub's reason.
    async fn call(
        &self,
        method: reqwest::Method,
        path: &str,
        bearer: Option<&str>,
    ) -> Result<Value, String> {
        let url = format!("{}{path}", self.endpoints().api);
        let mut request = http()
            .request(method, url)
            .header("accept", "application/vnd.github+json")
            .header("x-github-api-version", "2022-11-28");
        if let Some(b) = bearer {
            request = request.bearer_auth(b);
        }
        let answer = request
            .send()
            .await
            .map_err(|e| format!("GitHub can't be reached: {e}"))?;
        let status = answer.status();
        let body: Value = answer.json().await.unwrap_or_default();
        if status.is_success() {
            Ok(body)
        } else {
            Err(format!(
                "GitHub refused ({}): {}",
                status.as_u16(),
                said(status, &body)
            ))
        }
    }

    /// Trades the manifest flow's code for the App, keeps it with its secrets sealed to the hub's box key, and says
    /// what it keeps. A new App replaces the one before.
    pub async fn create(&self, code: &str) -> Result<GithubApp, String> {
        let path = format!("/app-manifests/{code}/conversions");
        let mut body = self
            .call(reqwest::Method::POST, &path, None)
            .await
            .map_err(|e| {
                if e.contains("(404)") {
                    "GitHub doesn't know that code: each one is used once, within an hour. Create the App again"
                        .to_owned()
                } else {
                    e
                }
            })?;
        let take = |body: &mut Value, k: &str| match body.get_mut(k).map(Value::take) {
            Some(Value::String(s)) if !s.is_empty() => Some(Zeroizing::new(s)),
            _ => None,
        };
        let pem = take(&mut body, "pem").ok_or("GitHub sent the App without its private key")?;
        let client_secret = take(&mut body, "client_secret");
        let webhook_secret = take(&mut body, "webhook_secret");
        // Proves the key before keeping it: one that can't sign would only fail later, unseen.
        signer(&pem)?;
        let text = |k: &str| body[k].as_str().unwrap_or_default().to_owned();
        let app_id = body["id"]
            .as_i64()
            .ok_or("GitHub sent the App without its id")?;
        let owner = body["owner"]["login"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let web = self.endpoints().web;
        let settings_url = if body["owner"]["type"].as_str() == Some("Organization") {
            format!("{web}/organizations/{owner}/settings/apps/{}", text("slug"))
        } else {
            format!("{web}/settings/apps/{}", text("slug"))
        };
        let app = GithubApp {
            app_id,
            slug: Line::new(text("slug")).map_err(|_| "GitHub sent the App without its slug")?,
            name: Line::new(text("name")).map_err(|_| "GitHub sent the App without its name")?,
            client_id: Line::new(text("client_id"))
                .map_err(|_| "GitHub sent the App without its client ID")?,
            owner: Line::new(owner).map_err(|_| "GitHub sent the App without its owner")?,
            html_url: Line::new(text("html_url"))
                .map_err(|_| "GitHub sent the App without its page")?,
            settings_url: Line::unchecked(settings_url),
            created_at: Timestamp(iso_ms(self.now_ms())),
            installations: Vec::new(),
            last_test: None,
        };
        let key = self.box_key()?;
        let seal = |v: &Zeroizing<String>| key.seal(v.as_bytes()).ok_or("sealing failed");
        let sealed = Sealed {
            key: seal(&pem)?,
            client_secret: client_secret.as_ref().map(seal).transpose()?,
            webhook_secret: webhook_secret.as_ref().map(seal).transpose()?,
        };
        let mut cache = self.cache.lock().await;
        self.db
            .github_app()
            .put(&app, &sealed)
            .map_err(|e| e.to_string())?;
        *cache = Cache::default();
        Ok(app)
    }

    /// The App and its private key, opened; none without an App.
    fn opened(&self) -> Result<Option<(GithubApp, Zeroizing<String>)>, String> {
        let Some((app, sealed)) = self.db.github_app().with_key().map_err(|e| e.to_string())?
        else {
            return Ok(None);
        };
        let plain = self.box_key()?.open(&sealed).ok_or(
            "the App's key was sealed to another box key: the hub's home changed. Create the App again",
        )?;
        let pem = String::from_utf8(plain.to_vec()).map_err(|_| "the App's key isn't text")?;
        Ok(Some((app, Zeroizing::new(pem))))
    }

    fn jwt_for(&self, app: &GithubApp, pem: &str) -> Result<Zeroizing<String>, String> {
        jwt(pem, app.app_id, self.now_ms() / 1000)
    }

    async fn mint(&self, jwt: &str, id: i64) -> Result<Token, String> {
        let path = format!("/app/installations/{id}/access_tokens");
        let mut body = self.call(reqwest::Method::POST, &path, Some(jwt)).await?;
        let expires_ms = expires_ms(&body).unwrap_or(self.now_ms() + 60 * 60_000);
        match body.get_mut("token").map(Value::take) {
            Some(Value::String(t)) if !t.is_empty() => Ok(Token {
                value: Zeroizing::new(t),
                expires_ms,
            }),
            _ => Err("GitHub sent no installation token".into()),
        }
    }

    /// Reads the App's installations, mints each one's token and reads the repositories each reaches, without the
    /// cache's lock: a slow GitHub holds up no `gh` run meanwhile. An installation GitHub refuses (suspended, or
    /// uninstalled mid-read) is left out and said, and the others are kept.
    async fn read_installs(
        &self,
        app: &GithubApp,
        pem: &str,
    ) -> Result<(Vec<Install>, GithubApp, Vec<String>), String> {
        let jwt = self.jwt_for(app, pem)?;
        let listed = self
            .call(
                reqwest::Method::GET,
                "/app/installations?per_page=100",
                Some(&jwt),
            )
            .await?;
        let mut installs = Vec::new();
        let mut seen = Vec::new();
        let mut skipped = Vec::new();
        for i in listed.as_array().map(Vec::as_slice).unwrap_or_default() {
            let Some(id) = i["id"].as_i64() else { continue };
            let account = i["account"]["login"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
            let all = i["repository_selection"].as_str() == Some("all");
            let read = async {
                let token = self.mint(&jwt, id).await?;
                let mut repos = Vec::new();
                let mut count = 0;
                for page in 1..=REPO_PAGES {
                    let path = format!("/installation/repositories?per_page=100&page={page}");
                    let body = self
                        .call(reqwest::Method::GET, &path, Some(token.value.as_str()))
                        .await?;
                    count = body["total_count"].as_i64().unwrap_or_default();
                    let names: Vec<String> = body["repositories"]
                        .as_array()
                        .map(Vec::as_slice)
                        .unwrap_or_default()
                        .iter()
                        .filter_map(|r| r["full_name"].as_str().map(str::to_owned))
                        .collect();
                    let last = names.len() < 100;
                    repos.extend(names);
                    if last || all {
                        break;
                    }
                }
                Ok::<_, String>((token, repos, count))
            }
            .await;
            let (token, repos, count) = match read {
                Ok(read) => read,
                Err(e) => {
                    tracing::warn!("github app: installation on {account} not read: {e}");
                    skipped.push(format!("{account} ({e})"));
                    continue;
                }
            };
            seen.push(GithubInstallation {
                installation_id: id,
                account: Line::unchecked(account.clone()),
                all_repositories: all,
                repository_count: count,
                repositories: if all {
                    Vec::new()
                } else {
                    repos
                        .iter()
                        .take(100)
                        .map(|r| Line::unchecked(r.clone()))
                        .collect()
                },
            });
            installs.push(Install {
                id,
                account: account.to_lowercase(),
                all,
                repos: repos.iter().map(|r| r.to_lowercase()).collect(),
                token: Some(token),
            });
        }
        let read = GithubApp {
            installations: seen,
            ..app.clone()
        };
        Ok((installs, read, skipped))
    }

    /// Keeps what [`Self::read_installs`] read: in the cache, and on the App.
    async fn keep(&self, app_id: i64, installs: Vec<Install>, read: &GithubApp) {
        *self.cache.lock().await = Cache {
            app_id: Some(app_id),
            read_ms: self.now_ms(),
            failed_ms: None,
            installs,
        };
        if let Err(e) = self.db.github_app().update(read) {
            tracing::warn!(error = %e, "github app: installations not kept");
        }
    }

    /// An installation token for `repo` (`owner/name`) when the App is installed on it; none otherwise, or when
    /// GitHub can't be asked, so `gh` goes on with the machine's own login.
    pub async fn token_for(&self, repo: &str) -> Option<Zeroizing<String>> {
        self.installation_token(repo, TOKEN_MARGIN_MS)
            .await
            .map(|(token, _)| token)
    }

    /// [`Self::token_for`] with at least `margin_ms` left, and when it ends.
    pub async fn installation_token(
        &self,
        repo: &str,
        margin_ms: i64,
    ) -> Option<(Zeroizing<String>, i64)> {
        let repo = repo.to_lowercase();
        let (owner, _) = repo.split_once('/')?;
        let (app, pem) = match self.opened() {
            Ok(Some(o)) => o,
            Ok(None) => {
                *self.cache.lock().await = Cache::default();
                return None;
            }
            Err(e) => {
                tracing::warn!("github app: {e}");
                return None;
            }
        };
        let now = self.now_ms();
        let due = {
            let cache = self.cache.lock().await;
            let stale = cache.app_id != Some(app.app_id) || now - cache.read_ms > REFRESH_MS;
            stale && !cache.failed_ms.is_some_and(|at| now - at < RETRY_MS)
        };
        // One read at a time; the others go on with what the cache holds, or the machine's login.
        if due && let Ok(_one) = self.refreshing.try_lock() {
            match self.read_installs(&app, &pem).await {
                Ok((installs, read, _)) => self.keep(app.app_id, installs, &read).await,
                Err(e) => {
                    tracing::warn!("github app: installations not read: {e}");
                    self.cache.lock().await.failed_ms = Some(now);
                }
            }
        }
        let id = {
            let cache = self.cache.lock().await;
            if cache.app_id != Some(app.app_id) {
                return None;
            }
            let install = cache
                .installs
                .iter()
                .find(|i| i.account == owner && (i.all || i.repos.contains(&repo)))?;
            match &install.token {
                Some(t) if t.expires_ms - now > margin_ms => {
                    return Some((Zeroizing::new(t.value.to_string()), t.expires_ms));
                }
                _ => install.id,
            }
        };
        let minted = match self.jwt_for(&app, &pem) {
            Ok(jwt) => self.mint(&jwt, id).await,
            Err(e) => Err(e),
        };
        let mut cache = self.cache.lock().await;
        let install = cache.installs.iter_mut().find(|i| i.id == id)?;
        match minted {
            Ok(t) => {
                let value = (Zeroizing::new(t.value.to_string()), t.expires_ms);
                install.token = Some(t);
                Some(value)
            }
            Err(e) => {
                tracing::warn!("github app: no token for {repo}: {e}");
                install.token = None;
                None
            }
        }
    }

    /// Whether the App reaches `repo` (`owner/name`), as its installations were last read: with no call to GitHub,
    /// from the token cache's whole list (up to 1000 repositories an installation) when it holds this App's, else from
    /// the first 100 the App keeps.
    pub fn reaches(&self, repo: &str) -> bool {
        let Ok(Some(app)) = self.get() else {
            return false;
        };
        let repo = repo.to_lowercase();
        let Some((owner, _)) = repo.split_once('/') else {
            return false;
        };
        if let Ok(cache) = self.cache.try_lock()
            && cache.app_id == Some(app.app_id)
        {
            return cache
                .installs
                .iter()
                .any(|i| i.account == owner && (i.all || i.repos.contains(&repo)));
        }
        app.installations.iter().any(|i| {
            i.account.to_lowercase() == owner
                && (i.all_repositories || i.repositories.iter().any(|r| r.to_lowercase() == repo))
        })
    }

    /// Tests the App: GitHub knows it and takes its key, and where it is installed, with a token minted for each
    /// installation. Keeps and returns what it found, with a line that says it.
    pub async fn test(&self) -> Result<Option<GithubApp>, String> {
        let _one = self.refreshing.lock().await;
        let Some((app, pem)) = self.opened()? else {
            return Ok(None);
        };
        let checked = async {
            let jwt = self.jwt_for(&app, &pem)?;
            self.call(reqwest::Method::GET, "/app", Some(&jwt)).await?;
            self.read_installs(&app, &pem).await
        }
        .await;
        let at = Timestamp(iso_ms(self.now_ms()));
        let (mut app, ok, said) = match checked {
            Ok((installs, read, skipped)) => {
                self.keep(app.app_id, installs, &read).await;
                let mut line = installed_line(&read);
                if !skipped.is_empty() {
                    line.push_str(&format!(
                        " GitHub refused its installation on {}.",
                        skipped.join(", ")
                    ));
                }
                let ok = !read.installations.is_empty() && skipped.is_empty();
                (read, ok, line)
            }
            Err(e) => {
                self.cache.lock().await.failed_ms = Some(self.now_ms());
                (app, false, format!("{e}."))
            }
        };
        app.last_test = Some(GithubAppTest {
            at,
            ok,
            said: Line::unchecked(said.chars().take(1000).collect::<String>()),
        });
        self.db
            .github_app()
            .update(&app)
            .map_err(|e| e.to_string())?;
        Ok(Some(app))
    }

    /// Forgets the App: its row and its tokens. GitHub keeps it until the admin deletes it there.
    /// People's connections and the orders' tokens were the App's too: they go with it, so a new App never passes
    /// for them.
    pub async fn remove(&self) -> Result<Option<GithubApp>, String> {
        let mut cache = self.cache.lock().await;
        *cache = Cache::default();
        let _one = self.accounts.lock().await;
        self.db
            .with(|c| {
                c.execute_batch("DELETE FROM github_accounts; DELETE FROM github_order_tokens;")?;
                Ok(())
            })
            .map_err(|e| e.to_string())?;
        self.db.github_app().remove().map_err(|e| e.to_string())
    }
}

/// What a passing Test says: where the App is installed and that its tokens work.
fn installed_line(app: &GithubApp) -> String {
    if app.installations.is_empty() {
        return format!(
            "GitHub knows \"{}\", but it isn't installed anywhere yet: install it on the repositories fleetd works on.",
            app.name
        );
    }
    let places: Vec<String> = app
        .installations
        .iter()
        .map(|i| {
            let n = i.repository_count;
            let what = if i.all_repositories {
                format!("all {n} repositories")
            } else if n == 1 {
                "1 repository".to_owned()
            } else {
                format!("{n} repositories")
            };
            format!("{} ({what})", i.account)
        })
        .collect();
    format!(
        "\"{}\" is installed on {}, and its tokens work.",
        app.name,
        places.join(", ")
    )
}
