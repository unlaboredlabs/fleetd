//! New mail for a Navi, on its node: Gmail's watch of the inbox (`users.watch`, telling the admin's Pub/Sub topic),
//! the read of that topic's subscription with a service account key (`<node home>/google/pubsub.json`, 0600), and the
//! check of one Navi's inbox since the last one (`history.list` from the history id in
//! `<node home>/google/mail/<project>.json`), kept to what matches the person's rule. The hub drives all three
//! (hub/google/mail.rs) and wakes the Navi.
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD};
use fleetd_contracts::google::{MailNotice, NewMail, PUBSUB_SCOPE};
use fleetd_contracts::secrets::SecretFingerprint;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use zeroize::{Zeroize, Zeroizing};

use super::super::identity::NodeBoxKey;
use super::super::secrets::fingerprint_of;
use super::tools::{gmail, header};
use super::{DIR, Endpoints, Session, now_ms, read, remove, write};

/// How long one read of the subscription waits for a notice.
pub const PULL_WAIT: Duration = Duration::from_secs(30);

/// The most new messages one check reads; more are counted, not read.
const CHECK_MAX: usize = 20;

#[derive(Serialize, Deserialize)]
struct Pubsub {
    subscription: String,
    /// The service account's JSON key, as Google gave it.
    key: String,
}

impl Drop for Pubsub {
    fn drop(&mut self) {
        self.key.zeroize();
    }
}

fn pubsub_path(home: &Path) -> PathBuf {
    home.join(DIR).join("pubsub.json")
}

/// Where a Navi's last checked history id is kept.
pub fn state_path(home: &Path, project_id: &str) -> PathBuf {
    let name = project_id.replace(['/', '\\'], "_");
    home.join(DIR)
        .join("mail")
        .join(format!("{}.json", name.trim_start_matches('.')))
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct State {
    history_id: u64,
}

/// Keeps the service account key, opened with the node's box key; no `sealed` forgets it. The key's fingerprint.
pub fn pubsub_set(
    home: &Path,
    subscription: &str,
    sealed: Option<&str>,
    box_key: Option<&NodeBoxKey>,
) -> Result<Option<SecretFingerprint>, String> {
    let Some(sealed) = sealed else {
        remove(&pubsub_path(home))?;
        return Ok(None);
    };
    let box_key = box_key.ok_or("this node takes no secrets: it has no box key")?;
    let boxed = Zeroizing::new(B64.decode(sealed).unwrap_or_default());
    let plain = box_key.open(&boxed).ok_or(
        "the key was not sealed to this machine's current box key: seal it to its boxPubKey again",
    )?;
    let key = std::str::from_utf8(&plain).map_err(|_| "the key is not text")?;
    let parsed: Value = serde_json::from_str(key).map_err(|_| {
        "that isn't a service account's JSON key: download it from IAM › Service accounts › Keys"
    })?;
    if parsed["type"] != "service_account"
        || parsed["client_email"].as_str().is_none()
        || parsed["private_key"].as_str().is_none()
    {
        return Err(
            "that isn't a service account's JSON key: download it from IAM › Service accounts › Keys".into(),
        );
    }
    signer(&Zeroizing::new(
        parsed["private_key"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
    ))?;
    let pubsub = Pubsub {
        subscription: subscription.to_owned(),
        key: key.to_owned(),
    };
    write(&pubsub_path(home), &pubsub)?;
    Ok(Some(SecretFingerprint::unchecked(fingerprint_of(&plain))))
}

/// The RSA key of a service account's PEM `private_key` (PKCS #8).
fn signer(pem: &str) -> Result<ring::signature::RsaKeyPair, String> {
    let body: String = pem
        .lines()
        .filter(|l| !l.starts_with("-----"))
        .collect::<Vec<_>>()
        .concat();
    let der = Zeroizing::new(
        B64.decode(body.trim())
            .map_err(|_| "the key's private_key isn't PEM")?,
    );
    ring::signature::RsaKeyPair::from_pkcs8(&der)
        .map_err(|_| "the key's private_key isn't an RSA key Google made".to_owned())
}

/// A Pub/Sub access token for the service account: a signed JWT traded at the token endpoint (RFC 7523).
async fn service_token(ep: &Endpoints, key: &str) -> Result<Zeroizing<String>, String> {
    let key: Value =
        serde_json::from_str(key).map_err(|_| "the service account key doesn't parse")?;
    let pem = Zeroizing::new(key["private_key"].as_str().unwrap_or_default().to_owned());
    let pair = signer(&pem)?;
    let now = now_ms() / 1000;
    let token_url = format!("{}/token", ep.oauth);
    let head = URL_SAFE_NO_PAD.encode(json!({ "alg": "RS256", "typ": "JWT" }).to_string());
    let claims = URL_SAFE_NO_PAD.encode(
        json!({
            "iss": key["client_email"], "scope": PUBSUB_SCOPE, "aud": token_url,
            "iat": now, "exp": now + 3600,
        })
        .to_string(),
    );
    let signed = format!("{head}.{claims}");
    let mut signature = vec![0; pair.public().modulus_len()];
    pair.sign(
        &ring::signature::RSA_PKCS1_SHA256,
        &ring::rand::SystemRandom::new(),
        signed.as_bytes(),
        &mut signature,
    )
    .map_err(|_| "the service account key couldn't sign")?;
    let assertion = format!("{signed}.{}", URL_SAFE_NO_PAD.encode(signature));
    let form = [
        ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
        ("assertion", assertion.as_str()),
    ];
    let mut body = super::token_call(ep, &form)
        .await
        .map_err(|(code, said)| {
            format!("Google refused the service account ({code}): {said}. Make a new key for it and save it again")
        })?;
    match body.get_mut("access_token").map(Value::take) {
        Some(Value::String(t)) if !t.is_empty() => Ok(Zeroizing::new(t)),
        _ => Err("Google sent the service account no access token".into()),
    }
}

/// One read of the subscription: Pub/Sub holds it open until a notice comes or [`PULL_WAIT`] passes. Acknowledges the
/// notices and says each one's address and history id.
pub async fn pull(home: &Path, ep: &Endpoints) -> Result<Vec<MailNotice>, String> {
    let pubsub: Pubsub = read(&pubsub_path(home))?.ok_or(
        "this machine holds no Pub/Sub key: the admin saves it in Administration › Google",
    )?;
    let token = service_token(ep, &pubsub.key).await?;
    let http = reqwest::Client::builder()
        .timeout(PULL_WAIT)
        .build()
        .unwrap_or_default();
    let url = format!("{}/v1/{}", ep.pubsub, pubsub.subscription);
    let answer = match http
        .post(format!("{url}:pull"))
        .bearer_auth(token.as_str())
        .json(&json!({ "maxMessages": 100 }))
        .send()
        .await
    {
        Ok(a) => a,
        // Nothing came while it waited.
        Err(e) if e.is_timeout() => return Ok(Vec::new()),
        Err(e) => return Err(format!("Pub/Sub can't be reached: {e}")),
    };
    let status = answer.status();
    let body: Value = answer.json().await.unwrap_or_default();
    if !status.is_success() {
        let said = body["error"]["message"]
            .as_str()
            .unwrap_or("no reason given");
        return Err(match status.as_u16() {
            403 => format!(
                "the service account may not read {}: give it Pub/Sub Subscriber on it ({said})",
                pubsub.subscription
            ),
            404 => format!("there is no subscription {}", pubsub.subscription),
            n => format!("Pub/Sub answered {n}: {said}"),
        });
    }
    let messages = body["receivedMessages"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let ack: Vec<&str> = messages
        .iter()
        .filter_map(|m| m["ackId"].as_str())
        .collect();
    if !ack.is_empty() {
        http.post(format!("{url}:acknowledge"))
            .bearer_auth(token.as_str())
            .json(&json!({ "ackIds": ack }))
            .send()
            .await
            .map_err(|e| format!("Pub/Sub can't be reached: {e}"))?;
    }
    Ok(messages
        .iter()
        .filter_map(|m| {
            let data = B64.decode(m["message"]["data"].as_str()?).ok()?;
            let notice: Value = serde_json::from_slice(&data).ok()?;
            let history_id = match &notice["historyId"] {
                Value::Number(n) => n.as_u64()?,
                Value::String(s) => s.parse().ok()?,
                _ => return None,
            };
            Some(MailNotice {
                email: notice["emailAddress"].as_str()?.to_owned(),
                history_id,
            })
        })
        .collect())
}

/// Asks Gmail to tell `topic` of new inbox mail for 7 days; when that ends, in ms since the epoch. The first watch
/// also marks where checks start.
pub async fn watch(s: &Session, topic: &str) -> Result<i64, String> {
    let watched = s
        .post(
            &gmail(s, "watch"),
            &json!({ "topicName": topic, "labelIds": ["INBOX"], "labelFilterBehavior": "include" }),
        )
        .await
        .map_err(|e| {
            if e.contains("403") || e.contains("permission") {
                format!(
                    "{e}. Give gmail-api-push@system.gserviceaccount.com the Pub/Sub Publisher role on the topic"
                )
            } else {
                e
            }
        })?;
    let path = state_path(&s.home, &s.project_id);
    if read::<State>(&path)?.is_none()
        && let Some(history_id) = number(&watched["historyId"])
    {
        write(&path, &State { history_id })?;
    }
    number(&watched["expiration"])
        .map(|e| e as i64)
        .ok_or_else(|| "Gmail didn't say when the watch ends".into())
}

/// Gmail's ids come as strings or numbers.
fn number(v: &Value) -> Option<u64> {
    match v {
        Value::Number(n) => n.as_u64(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

async fn latest_history(s: &Session) -> Result<u64, String> {
    let profile = s.get(&gmail(s, "profile"), &[]).await?;
    number(&profile["historyId"]).ok_or_else(|| "Gmail didn't say where the mailbox is".into())
}

/// The Navi's new inbox mail since the last check, matching `query` when given, at most [`CHECK_MAX`] read. The first
/// check, and one after Gmail forgot the last history id, only marks where the next one starts.
pub async fn check(s: &Session, query: Option<&str>) -> Result<Checked, String> {
    let path = state_path(&s.home, &s.project_id);
    // A push's check and a minute's can meet as the hub moves between them: the second waits, then starts where the
    // first stopped, so no message is told twice.
    let lock = CHECKS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .entry(path.clone())
        .or_default()
        .clone();
    let _turn = lock.lock().await;
    let Some(state) = read::<State>(&path)? else {
        let history_id = latest_history(s).await?;
        write(&path, &State { history_id })?;
        return Ok(Checked::default());
    };
    let mut added: Vec<(String, String)> = Vec::new();
    let mut latest = state.history_id;
    let mut page: Option<String> = None;
    for _ in 0..5 {
        let mut q = vec![
            ("startHistoryId", state.history_id.to_string()),
            ("historyTypes", "messageAdded".to_owned()),
            ("labelId", "INBOX".to_owned()),
        ];
        if let Some(p) = &page {
            q.push(("pageToken", p.clone()));
        }
        let history = match s.get(&gmail(s, "history"), &q).await {
            Ok(h) => h,
            // Gmail keeps about a week of history: start again from now.
            Err(e) if e.starts_with("Google answered 404") => {
                let history_id = latest_history(s).await?;
                write(&path, &State { history_id })?;
                return Ok(Checked::default());
            }
            Err(e) => return Err(e),
        };
        latest = latest.max(number(&history["historyId"]).unwrap_or(latest));
        for h in history["history"].as_array().into_iter().flatten() {
            for m in h["messagesAdded"].as_array().into_iter().flatten() {
                let m = &m["message"];
                let labels: Vec<&str> = m["labelIds"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect();
                let inbox = labels.contains(&"INBOX")
                    && !labels.contains(&"SENT")
                    && !labels.contains(&"DRAFT");
                if let (true, Some(id), Some(thread)) =
                    (inbox, m["id"].as_str(), m["threadId"].as_str())
                    && !added.iter().any(|(i, _)| i == id)
                {
                    added.push((id.to_owned(), thread.to_owned()));
                }
            }
        }
        page = history["nextPageToken"].as_str().map(str::to_owned);
        if page.is_none() {
            break;
        }
    }
    if let Some(query) = query.filter(|q| !q.trim().is_empty())
        && !added.is_empty()
    {
        let matched = s
            .get(
                &gmail(s, "messages"),
                &[
                    ("q", format!("({query}) newer_than:7d")),
                    ("maxResults", "500".to_owned()),
                ],
            )
            .await?;
        let ids: BTreeSet<&str> = matched["messages"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|m| m["id"].as_str())
            .collect();
        added.retain(|(id, _)| ids.contains(id.as_str()));
    }
    let mut mails = Vec::new();
    for (id, thread) in added.iter().take(CHECK_MAX) {
        let m = s
            .get(
                &gmail(s, &format!("messages/{id}")),
                &[
                    ("format", "metadata".into()),
                    ("metadataHeaders", "From".into()),
                    ("metadataHeaders", "Subject".into()),
                ],
            )
            .await?;
        mails.push(NewMail {
            message_id: id.clone(),
            thread_id: thread.clone(),
            from: header(&m, "From").map(str::to_owned),
            subject: header(&m, "Subject").map(str::to_owned),
            snippet: m["snippet"].as_str().map(str::to_owned),
        });
    }
    // Saved last: a check that failed reads the same mail next time.
    write(&path, &State { history_id: latest })?;
    Ok(Checked {
        more: added.len().saturating_sub(CHECK_MAX),
        mails,
    })
}

/// What a check found: the messages it read, and how many more it only counted.
#[derive(Default)]
pub struct Checked {
    pub mails: Vec<NewMail>,
    pub more: usize,
}

/// One turn at a time per Navi's state file.
static CHECKS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<PathBuf, std::sync::Arc<tokio::sync::Mutex<()>>>>,
> = std::sync::LazyLock::new(Default::default);

/// The signer, for the fake Google in tests that checks the assertion's signature.
#[cfg(test)]
pub fn tests_signer(pem: &str) -> ring::signature::RsaKeyPair {
    signer(pem).unwrap()
}
