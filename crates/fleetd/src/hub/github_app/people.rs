//! Each person's own GitHub account through the hub's App (D187): the app opens GitHub's sign-in with PKCE and a
//! loopback redirect, and [`GithubApps::connect`] trades the code, with the App's client secret, for a user-to-server
//! token (eight hours) and its refresh token (six months, renewed with each refresh). Both are sealed to the hub's box
//! key in `github_accounts`; [`GithubApps::user_token`] refreshes the pair before the access token ends. Disconnecting
//! revokes the token at GitHub and forgets it.
use fleetd_contracts::github_app::{GithubAccount, GithubApp};
use fleetd_contracts::ids::Timestamp;
use fleetd_contracts::people::PersonId;
use fleetd_contracts::prim::Line;
use rusqlite::{OptionalExtension, params};
use serde_json::Value;
use zeroize::Zeroizing;

use super::GithubApps;
use crate::hub::store::{StoreError, iso_ms};

/// A token handed to an agent's sessions has at least this long left: one this close to its end is refreshed first.
pub const SESSION_MARGIN_MS: i64 = 2 * 60 * 60_000;

/// A person's tokens as kept, still sealed.
struct Kept {
    account: GithubAccount,
    access: Vec<u8>,
    access_expires_ms: i64,
    refresh: Option<Vec<u8>>,
}

/// What GitHub's token endpoint answered: the pair, each with when it ends.
struct Pair {
    access: Zeroizing<String>,
    access_expires_ms: i64,
    refresh: Option<Zeroizing<String>>,
    refresh_expires_ms: Option<i64>,
}

impl GithubApps {
    /// The person's account, as kept: no token.
    pub fn account(&self, person: &PersonId) -> Result<Option<GithubAccount>, StoreError> {
        Ok(self.kept(person)?.map(|k| k.account))
    }

    fn kept(&self, person: &PersonId) -> Result<Option<Kept>, StoreError> {
        type Row = (String, Vec<u8>, i64, Option<Vec<u8>>);
        let row: Option<Row> = self.db.with(|c| {
            Ok(c.query_row(
                "SELECT data, sealed_access, access_expires_ms, sealed_refresh FROM github_accounts
                 WHERE person_id = ?",
                params![person.as_str()],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?)
        })?;
        Ok(row.and_then(|(data, access, access_expires_ms, refresh)| {
            Some(Kept {
                account: serde_json::from_str(&data).ok()?,
                access,
                access_expires_ms,
                refresh,
            })
        }))
    }

    fn put_account(
        &self,
        person: &PersonId,
        account: &GithubAccount,
        pair: &Pair,
    ) -> Result<(), String> {
        let key = self.box_key()?;
        let seal = |v: &Zeroizing<String>| key.seal(v.as_bytes()).ok_or("sealing failed");
        let access = seal(&pair.access)?;
        let refresh = pair.refresh.as_ref().map(seal).transpose()?;
        let data = serde_json::to_string(account).map_err(|e| e.to_string())?;
        self.db
            .with(|c| {
                c.execute(
                    "INSERT INTO github_accounts
                       (person_id, data, sealed_access, access_expires_ms, sealed_refresh, refresh_expires_ms)
                     VALUES (?, ?, ?, ?, ?, ?)
                     ON CONFLICT (person_id) DO UPDATE SET data = excluded.data,
                       sealed_access = excluded.sealed_access, access_expires_ms = excluded.access_expires_ms,
                       sealed_refresh = excluded.sealed_refresh, refresh_expires_ms = excluded.refresh_expires_ms",
                    params![
                        person.as_str(),
                        data,
                        access,
                        pair.access_expires_ms,
                        refresh,
                        pair.refresh_expires_ms
                    ],
                )?;
                Ok(())
            })
            .map_err(|e| e.to_string())
    }

    fn forget_account(&self, person: &PersonId) -> Result<(), String> {
        self.db
            .with(|c| {
                c.execute(
                    "DELETE FROM github_accounts WHERE person_id = ?",
                    params![person.as_str()],
                )?;
                Ok(())
            })
            .map_err(|e| e.to_string())
    }

    /// The App with its client secret, opened; none without an App.
    fn client(&self) -> Result<Option<(GithubApp, Zeroizing<String>)>, String> {
        let row: Option<(String, Option<Vec<u8>>)> = self
            .db
            .with(|c| {
                Ok(c.query_row(
                    "SELECT data, sealed_client_secret FROM github_app WHERE id = 1",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?)
            })
            .map_err(|e| e.to_string())?;
        let Some((data, sealed)) = row else {
            return Ok(None);
        };
        let app: GithubApp = serde_json::from_str(&data).map_err(|e| e.to_string())?;
        let sealed =
            sealed.ok_or("GitHub sent the App without its client secret: create the App again")?;
        let plain = self.box_key()?.open(&sealed).ok_or(
            "the App's client secret was sealed to another box key: the hub's home changed. Create the App again",
        )?;
        let secret =
            String::from_utf8(plain.to_vec()).map_err(|_| "the App's client secret isn't text")?;
        Ok(Some((app, Zeroizing::new(secret))))
    }

    /// One call to GitHub's token endpoint with the App's client.
    async fn token_call(&self, form: &[(&str, &str)]) -> Result<Pair, String> {
        let url = format!("{}/login/oauth/access_token", self.endpoints().web);
        let answer = super::http()
            .post(url)
            .header("accept", "application/json")
            .form(form)
            .send()
            .await
            .map_err(|e| format!("GitHub can't be reached: {e}"))?;
        let status = answer.status();
        let mut body: Value = answer.json().await.unwrap_or_default();
        // GitHub says a refusal with 200 and an `error`.
        if let Some(error) = body["error"].as_str() {
            let said = body["error_description"].as_str().unwrap_or(error);
            return Err(format!("GitHub refused ({error}): {said}"));
        }
        if !status.is_success() {
            return Err(format!("GitHub refused ({})", status.as_u16()));
        }
        let now = self.now_ms();
        let secs = |k: &str| body[k].as_i64().map(|s| now + s * 1000);
        let access_expires_ms = secs("expires_in").unwrap_or(now + 8 * 60 * 60_000);
        let refresh_expires_ms = secs("refresh_token_expires_in");
        let mut take = |k: &str| match body.get_mut(k).map(Value::take) {
            Some(Value::String(s)) if !s.is_empty() => Some(Zeroizing::new(s)),
            _ => None,
        };
        let access = take("access_token").ok_or("GitHub sent no token")?;
        let refresh = take("refresh_token");
        Ok(Pair {
            access,
            access_expires_ms,
            refresh,
            refresh_expires_ms,
        })
    }

    /// Trades the sign-in's code for the person's tokens, reads who they are, and keeps it all. A new connection
    /// replaces the one before.
    pub async fn connect(
        &self,
        person: &PersonId,
        code: &str,
        verifier: &str,
        redirect: &str,
    ) -> Result<GithubAccount, String> {
        let (app, secret) = self.client()?.ok_or(
            "This hub has no GitHub App yet: an admin creates it in Administration › GitHub",
        )?;
        let pair = self
            .token_call(&[
                ("client_id", app.client_id.as_str()),
                ("client_secret", secret.as_str()),
                ("code", code),
                ("code_verifier", verifier),
                ("redirect_uri", redirect),
            ])
            .await?;
        let user = self
            .call(reqwest::Method::GET, "/user", Some(pair.access.as_str()))
            .await?;
        let account = GithubAccount {
            login: Line::new(user["login"].as_str().unwrap_or_default())
                .map_err(|_| "GitHub didn't say who signed in")?,
            user_id: user["id"].as_i64().unwrap_or_default(),
            connected_at: Timestamp(iso_ms(self.now_ms())),
            lapsed: None,
        };
        let _one = self.accounts.lock().await;
        self.put_account(person, &account, &pair)?;
        Ok(account)
    }

    /// The person's access token with at least [`SESSION_MARGIN_MS`] left, refreshed first when it has less, and when
    /// it ends. None when they haven't connected. A refresh GitHub refuses marks the account lapsed.
    pub async fn user_token(
        &self,
        person: &PersonId,
    ) -> Result<Option<(Zeroizing<String>, i64)>, String> {
        let _one = self.accounts.lock().await;
        let Some(kept) = self.kept(person).map_err(|e| e.to_string())? else {
            return Ok(None);
        };
        if kept.account.lapsed == Some(true) {
            return Err(format!(
                "GitHub no longer takes {}'s connection: connect GitHub again in Settings › GitHub",
                kept.account.login
            ));
        }
        let key = self.box_key()?;
        let open = |sealed: &[u8]| {
            key.open(sealed)
                .and_then(|p| String::from_utf8(p.to_vec()).ok())
                .map(Zeroizing::new)
                .ok_or("a GitHub token was sealed to another box key: connect GitHub again")
        };
        if kept.access_expires_ms - self.now_ms() > SESSION_MARGIN_MS {
            return Ok(Some((open(&kept.access)?, kept.access_expires_ms)));
        }
        let Some(sealed) = &kept.refresh else {
            return Ok(Some((open(&kept.access)?, kept.access_expires_ms)));
        };
        let refresh = open(sealed)?;
        let (app, secret) = self.client()?.ok_or("This hub's GitHub App was removed")?;
        let pair = match self
            .token_call(&[
                ("client_id", app.client_id.as_str()),
                ("client_secret", secret.as_str()),
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh.as_str()),
            ])
            .await
        {
            Ok(pair) => pair,
            // Only GitHub's word for a dead refresh token lapses it: a rate limit or an outage passes.
            Err(e) if e.contains("bad_refresh_token") => {
                let lapsed = GithubAccount {
                    lapsed: Some(true),
                    ..kept.account.clone()
                };
                let data = serde_json::to_string(&lapsed).map_err(|e| e.to_string())?;
                self.db
                    .with(|c| {
                        c.execute(
                            "UPDATE github_accounts SET data = ? WHERE person_id = ?",
                            params![data, person.as_str()],
                        )?;
                        Ok(())
                    })
                    .map_err(|e| e.to_string())?;
                return Err(format!(
                    "GitHub no longer takes {}'s connection ({e}): connect GitHub again in Settings › GitHub",
                    kept.account.login
                ));
            }
            Err(e) => return Err(e),
        };
        self.put_account(person, &kept.account, &pair)?;
        Ok(Some((pair.access, pair.access_expires_ms)))
    }

    /// Revokes the person's token at GitHub (best effort) and forgets it. True when GitHub confirmed the revoke.
    pub async fn disconnect(&self, person: &PersonId) -> Result<bool, String> {
        let _one = self.accounts.lock().await;
        let Some(kept) = self.kept(person).map_err(|e| e.to_string())? else {
            return Ok(false);
        };
        let revoked = match (self.client(), self.box_key()) {
            (Ok(Some((app, secret))), Ok(key)) => {
                match key.open(&kept.access) {
                    Some(token) => {
                        let url = format!(
                            "{}/applications/{}/grant",
                            self.endpoints().api,
                            app.client_id
                        );
                        super::http()
                        .delete(url)
                        .basic_auth(app.client_id.as_str(), Some(secret.as_str()))
                        .header("accept", "application/vnd.github+json")
                        .json(&serde_json::json!({ "access_token": String::from_utf8_lossy(&token) }))
                        .send()
                        .await
                        .is_ok_and(|a| a.status().is_success())
                    }
                    None => false,
                }
            }
            _ => false,
        };
        self.forget_account(person)?;
        Ok(revoked)
    }
}
