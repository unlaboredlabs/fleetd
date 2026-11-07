//! "Sign in with boat" (W448): boat.dev's agent sign-in (boat.dev/auth.md, `service_auth`) in place of a pasted key.
//! The hub registers the person's email with boat, shows the link and code boat gives, and asks boat every few seconds
//! until they have signed in and typed the code. boat then hands the hub a full-access key (`*`, every environment, a
//! year). The hub uses it once: it finds the environment the pool makes machines in, makes the narrow key the setup
//! step lists scoped to it, checks boat made exactly that, seals it as a pasted key is sealed, and revokes the
//! full-access key whatever happened. Then it runs Test.
//!
//! boat answers the claim token with a new full-access key for a day after the first (W448's spike), so the claim token
//! lives only in the flow's task and goes with it. Nothing of the sign-in is stored, and no key or token is logged.
use std::sync::Arc;
use std::time::Duration;

use fleetd_contracts::cloud::{BoatSignIn, BoatSignInState};
use serde_json::{Value, json};
use zeroize::Zeroizing;

use super::Pool;
use super::ledger::SettingsChange;

/// The key's life. boat makes no key that outlives the one signing the request, and the sign-in's own lasts 365 days
/// from the sign-in: "a key it creates cannot expire later. Pass --ttl 364d or less".
pub const KEY_TTL: &str = "364d";
const TIMEOUT: Duration = Duration::from_secs(30);

/// The sign-in under way or last ended, with its run: a new sign-in or a stop ends the old run at its next step.
#[derive(Default)]
pub(super) struct SignIns {
    run: u64,
    view: Option<BoatSignIn>,
}

/// One sign-in, held by its task only.
pub(super) struct Flow {
    run: u64,
    pub(super) boat: Client,
    claim_token: Zeroizing<String>,
    /// boat's name for this sign-in's own key: `agent:<registration id>`, which an admin revokes by hand if boat
    /// didn't.
    registration: String,
    /// Seconds between asks; boat's `slow_down` adds 5.
    pub(super) interval: u64,
    deadline_ms: i64,
    email: String,
    environment: String,
    key_name: String,
}

/// boat's API and its sign-in endpoints beside it: `https://boat.dev/api/v1` and `https://boat.dev/api/box`.
pub(super) struct Client {
    http: reqwest::Client,
    api: String,
    auth: String,
}

/// What boat said to an ask for the token.
enum Poll {
    Pending,
    SlowDown,
    /// boat couldn't be reached, or answered a server error or a rate limit: ask again. boat may have made its key
    /// already, and the claim token gets the same one at the next ask.
    Transient(String),
    Token(Zeroizing<String>),
}

/// The key boat made.
struct Minted {
    id: String,
    secret: Zeroizing<String>,
}

/// boat's refusal in one line: its status, code and message.
fn said(status: u16, body: &Value) -> String {
    let text = |p: &str| body.pointer(p).and_then(Value::as_str);
    let code = text("/code")
        .or_else(|| text("/error/code"))
        .or_else(|| text("/error"))
        .unwrap_or("no code");
    match text("/message").or_else(|| text("/error_description")) {
        Some(message) => format!("boat.dev answered {status} {code}: {message}"),
        None => format!("boat.dev answered {status} {code}"),
    }
}

impl Client {
    pub(super) fn new(api: &str) -> Client {
        let api = api.trim_end_matches('/');
        Client {
            http: reqwest::Client::builder()
                .timeout(TIMEOUT)
                .user_agent("fleetd")
                .build()
                .unwrap_or_default(),
            auth: format!("{}/box", api.strip_suffix("/v1").unwrap_or(api)),
            api: api.to_owned(),
        }
    }

    async fn send(&self, req: reqwest::RequestBuilder) -> Result<(u16, Value), String> {
        let res = req
            .send()
            .await
            .map_err(|e| format!("boat.dev unreachable: {}", e.without_url()))?;
        let status = res.status().as_u16();
        let text = res
            .text()
            .await
            .map_err(|e| format!("boat.dev unreachable: {}", e.without_url()))?;
        Ok((status, serde_json::from_str(&text).unwrap_or(Value::Null)))
    }

    /// `POST /agent/identity`: boat sends nothing to the person; it answers the claim ceremony's link and code.
    async fn register(&self, email: &str) -> Result<(Value, Zeroizing<String>), String> {
        let (status, body) = self
            .send(
                self.http
                    .post(format!("{}/agent/identity", self.auth))
                    .json(&json!({"type": "service_auth", "login_hint": email})),
            )
            .await?;
        let token = body
            .get("claim_token")
            .and_then(Value::as_str)
            .map(|t| Zeroizing::new(t.to_owned()));
        match token {
            Some(token) if status == 200 => Ok((body, token)),
            _ => Err(said(status, &body)),
        }
    }

    /// The claim grant: pending until the person typed the code, then the sign-in's own key (the same one at every ask
    /// after, until it is revoked).
    async fn poll(&self, claim_token: &str) -> Result<Poll, String> {
        let form = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("grant_type", "urn:workos:agent-auth:grant-type:claim")
            .append_pair("claim_token", claim_token)
            .finish();
        let (status, body) = match self
            .form(&format!("{}/oauth2/token", self.auth), form)
            .await
        {
            Ok(answer) => answer,
            Err(why) => return Ok(Poll::Transient(why)),
        };
        if let Some(token) = body.get("access_token").and_then(Value::as_str)
            && status == 200
        {
            return Ok(Poll::Token(Zeroizing::new(token.to_owned())));
        }
        match body.get("error").and_then(Value::as_str) {
            Some("authorization_pending") => Ok(Poll::Pending),
            Some("slow_down") => Ok(Poll::SlowDown),
            Some("expired_token") => {
                Err("The code lapsed before it was typed: sign in again.".into())
            }
            Some("rate_limited") => Ok(Poll::Transient(said(status, &body))),
            _ if status == 429 || status >= 500 => Ok(Poll::Transient(said(status, &body))),
            _ => Err(said(status, &body)),
        }
    }

    async fn form(&self, url: &str, form: String) -> Result<(u16, Value), String> {
        self.send(
            self.http
                .post(url)
                .header("content-type", "application/x-www-form-urlencoded")
                .body(form),
        )
        .await
    }

    /// `GET /me`: the account boat signed in, as boat names it; None when it doesn't say.
    async fn account(&self, token: &str) -> Option<String> {
        let (status, body) = self
            .send(self.http.get(format!("{}/me", self.api)).bearer_auth(token))
            .await
            .ok()?;
        let user = body.get("user").filter(|_| status == 200)?;
        ["email", "login"]
            .iter()
            .find_map(|k| user.get(*k).and_then(Value::as_str))
            .filter(|a| !a.is_empty())
            .map(str::to_owned)
    }

    /// The environment named `name`, which must be safe for third parties: its id.
    async fn environment(&self, token: &str, name: &str) -> Result<String, String> {
        let (status, body) = self
            .send(
                self.http
                    .get(format!("{}/environments", self.api))
                    .bearer_auth(token),
            )
            .await?;
        if status != 200 {
            return Err(format!(
                "The environments can't be read: {}",
                said(status, &body)
            ));
        }
        let found = body
            .get("environments")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|e| e.get("name").and_then(Value::as_str) == Some(name));
        let Some(env) = found else {
            return Err(format!(
                "boat.dev has no environment named {name}: make it, with Safe for third parties on, then sign in again."
            ));
        };
        if env.get("safeForThirdParties").and_then(Value::as_bool) != Some(true) {
            return Err(format!(
                "boat.dev's environment {name} isn't Safe for third parties: turn that on, then sign in again."
            ));
        }
        env.get("id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| format!("boat.dev's environment {name} has no id"))
    }

    /// `POST /api-keys/scoped`: the setup step's key, then a check that boat made exactly that. One it made broader is
    /// revoked at once.
    async fn mint(&self, token: &str, name: &str, environment_id: &str) -> Result<Minted, String> {
        let actions: Vec<&str> = crate::hub::setup::BOAT_KEY_ACTIONS.split(' ').collect();
        let (status, body) = self
            .send(
                self.http
                    .post(format!("{}/api-keys/scoped", self.api))
                    .bearer_auth(token)
                    .json(&json!({
                        "name": name,
                        "ttl": KEY_TTL,
                        "actions": actions,
                        "environmentIds": [environment_id],
                    })),
            )
            .await?;
        if status != 201 {
            return Err(format!(
                "The hub's key wasn't made: {}",
                said(status, &body)
            ));
        }
        let text = |p: &str| body.pointer(p).and_then(Value::as_str);
        let (Some(id), Some(secret)) = (text("/apiKey/id"), text("/secret")) else {
            return Err("The hub's key wasn't made: boat.dev's answer has no key".into());
        };
        let minted = Minted {
            id: id.to_owned(),
            secret: Zeroizing::new(secret.to_owned()),
        };
        let list = |p: &str| -> Vec<&str> {
            let mut v: Vec<&str> = body
                .pointer(p)
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            v.sort_unstable();
            v
        };
        let mut want = actions.clone();
        want.sort_unstable();
        let got = list("/apiKey/scope/actions");
        let narrow = got == want
            && list("/apiKey/scope/environments") == [environment_id]
            && minted.secret.starts_with("boat_");
        if !narrow {
            self.delete_key(token, &minted.id).await;
            return Err(format!(
                "boat.dev made a broader key than asked ({}): it was revoked, and nothing was saved.",
                got.join(" ")
            ));
        }
        Ok(minted)
    }

    /// `DELETE /api-keys/{id}`: best effort, said in the log.
    async fn delete_key(&self, token: &str, id: &str) {
        let out = self
            .send(
                self.http
                    .delete(format!("{}/api-keys/{id}", self.api))
                    .bearer_auth(token),
            )
            .await;
        match out {
            Ok((200, _)) => {}
            Ok((status, body)) => {
                tracing::warn!(key = id, said = %said(status, &body), "cloud sign-in: a key wasn't revoked")
            }
            Err(e) => tracing::warn!(key = id, error = %e, "cloud sign-in: a key wasn't revoked"),
        }
    }

    /// `POST /oauth2/revoke`: the sign-in's own key.
    async fn revoke(&self, token: &str) -> Result<(), String> {
        let form = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("token", token)
            .append_pair("token_type_hint", "access_token")
            .finish();
        match self
            .form(&format!("{}/oauth2/revoke", self.auth), form)
            .await?
        {
            (200, _) => Ok(()),
            (status, body) => Err(said(status, &body)),
        }
    }
}

/// An email boat may take as the login hint.
pub fn email_ok(email: &str) -> bool {
    let (user, domain) = email.split_once('@').unwrap_or_default();
    !user.is_empty()
        && domain.contains('.')
        && email.len() <= 254
        && !email.chars().any(|c| c.is_whitespace() || c.is_control())
}

impl Pool {
    /// The admin's sign-in, since the hub started.
    pub fn sign_in(&self) -> Option<BoatSignIn> {
        self.sign_ins.lock().unwrap().view.clone()
    }

    /// Forgets the sign-in, under way or ended: a pasted key replaced what it made.
    pub fn sign_in_forget(&self) {
        let mut s = self.sign_ins.lock().unwrap();
        s.run += 1;
        s.view = None;
    }

    /// Shows `view` as the sign-in under way, for tests of what reads it.
    #[cfg(test)]
    pub fn sign_in_show(&self, view: BoatSignIn) {
        self.sign_ins.lock().unwrap().view = Some(view);
    }

    /// Stops the sign-in under way: its task drops the claim token at its next step. One that ended stays shown.
    pub fn sign_in_stop(&self) {
        let mut s = self.sign_ins.lock().unwrap();
        s.run += 1;
        if s.view
            .as_ref()
            .is_some_and(|v| v.state == BoatSignInState::Waiting)
        {
            s.view = None;
        }
    }

    /// Starts a sign-in to `email`'s boat account, for a key named `key_name` scoped to `environment`, and its task,
    /// which asks boat every few seconds until the code lapses.
    pub async fn sign_in_start(
        self: &Arc<Self>,
        email: &str,
        environment: String,
        key_name: String,
    ) -> Result<(), String> {
        let mut flow = self
            .sign_in_begin(&self.api, email, environment, key_name)
            .await?;
        let pool = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(flow.interval)).await;
                if pool.sign_in_step(&mut flow).await {
                    break;
                }
            }
        });
        Ok(())
    }

    /// Registers with boat and shows its link and code.
    pub(super) async fn sign_in_begin(
        &self,
        api: &str,
        email: &str,
        environment: String,
        key_name: String,
    ) -> Result<Flow, String> {
        let boat = Client::new(api);
        let (body, claim_token) = boat.register(email).await?;
        let text = |p: &str| body.pointer(p).and_then(Value::as_str).map(str::to_owned);
        let num = |p: &str| body.pointer(p).and_then(Value::as_u64);
        let (Some(uri), Some(code)) = (text("/claim/verification_uri"), text("/claim/user_code"))
        else {
            return Err("boat.dev's answer has no sign-in link".into());
        };
        let deadline_ms = self.now() + num("/claim/expires_in").unwrap_or(600) as i64 * 1000;
        let mut s = self.sign_ins.lock().unwrap();
        s.run += 1;
        s.view = Some(BoatSignIn {
            state: BoatSignInState::Waiting,
            email: email.to_owned(),
            verification_uri: Some(uri),
            user_code: Some(code),
            expires_at_ms: Some(deadline_ms),
            said: None,
        });
        Ok(Flow {
            run: s.run,
            boat,
            claim_token,
            registration: format!("agent:{}", text("/registration_id").unwrap_or_default()),
            interval: num("/claim/interval").unwrap_or(5).max(1),
            deadline_ms,
            email: email.to_owned(),
            environment,
            key_name,
        })
    }

    /// One ask of boat for the sign-in, and once the person typed the code, the hub's key made from it. True once the
    /// flow ended: done, failed, lapsed or stopped.
    pub(super) async fn sign_in_step(&self, flow: &mut Flow) -> bool {
        if self.sign_ins.lock().unwrap().run != flow.run {
            return true;
        }
        if self.now() > flow.deadline_ms {
            self.sign_in_end(
                flow,
                Err("The code lapsed before it was typed: sign in again.".into()),
            );
            return true;
        }
        match flow.boat.poll(&flow.claim_token).await {
            Ok(Poll::Pending) => false,
            Ok(Poll::Transient(why)) => {
                tracing::warn!(said = %why, "cloud sign-in: boat's answer didn't come, asking again");
                false
            }
            Ok(Poll::SlowDown) => {
                flow.interval += 5;
                false
            }
            Ok(Poll::Token(token)) => {
                let result = self.sign_in_finish(flow, &token).await;
                self.sign_in_end(flow, result);
                true
            }
            Err(why) => {
                self.sign_in_end(flow, Err(why));
                true
            }
        }
    }

    /// The hub's key from the sign-in's: made, checked and sealed, then the sign-in's revoked (also when the key
    /// wasn't made), then Test.
    async fn sign_in_finish(&self, flow: &Flow, token: &str) -> Result<String, String> {
        let boat = &flow.boat;
        let account = boat.account(token).await;
        let made = async {
            let environment_id = boat.environment(token, &flow.environment).await?;
            let key = boat.mint(token, &flow.key_name, &environment_id).await?;
            if let Err(why) = self.set_key(&key.secret) {
                boat.delete_key(token, &key.id).await;
                return Err(why);
            }
            Ok(())
        }
        .await;
        let revoked = boat.revoke(token).await.map_err(|why| {
            tracing::warn!(said = %why, "cloud sign-in: the sign-in's key wasn't revoked");
            format!(
                "boat.dev didn't revoke the sign-in's own full-access key ({why}): revoke {} in boat.dev › API keys.",
                flow.registration
            )
        });
        made.map_err(|why| match &revoked {
            Ok(()) => why.clone(),
            Err(also) => format!("{why} {also}"),
        })?;
        // Machines are made where the key reaches.
        if let Ok(s) = self.ledger.settings()
            && s.environment.as_deref() != Some(flow.environment.as_str())
            && let Err(e) = self.ledger.change_settings(&SettingsChange {
                enabled: s.enabled,
                pool_size: s.pool_size,
                machine_type: s.machine_type.clone(),
                day_budget: s.day_budget,
                month_budget: s.month_budget,
                projects: s.projects.clone(),
                environment: Some(flow.environment.clone()),
            })
        {
            tracing::warn!(error = %e, "cloud sign-in: the environment wasn't saved");
        }
        self.test().await;
        let key = format!(
            "hub's key {} is sealed, scoped to {} for 364 days.",
            flow.key_name, flow.environment
        );
        // The account boat signed in, which needn't be the email typed; unnamed when boat doesn't say.
        let line = match account {
            Some(account) => format!("Signed in as {account}: the {key}"),
            None => format!("The {key}"),
        };
        Ok(match revoked {
            Ok(()) => format!("{line} The sign-in's own key is revoked."),
            Err(also) => format!("{line} {also}"),
        })
    }

    fn sign_in_end(&self, flow: &Flow, result: Result<String, String>) {
        let mut s = self.sign_ins.lock().unwrap();
        if s.run != flow.run {
            return;
        }
        let (state, line) = match result {
            Ok(line) => (BoatSignInState::Done, line),
            Err(why) => (BoatSignInState::Failed, why),
        };
        s.view = Some(BoatSignIn {
            state,
            email: flow.email.clone(),
            verification_uri: None,
            user_code: None,
            expires_at_ms: None,
            said: Some(line),
        });
    }
}
