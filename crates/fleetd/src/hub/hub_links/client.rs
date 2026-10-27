//! The hub with the Navi calling the other hub over a kept link: `project_message` and `factory_status` with `hub`,
//! and [`follow`], which reads the link's feed there and wakes the Navi's lead with each piece of news, as the bridge
//! does for asks here. It long-polls the feed, so news arrives as it happens; when the other hub can't be reached it
//! retries every [`RETRY`] and the link reads "unreachable" until it answers again.
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use fleetd_contracts::hub_links::{
    FEED_WAIT_MAX_SEC, HubLabel, HubLinkState, LinkAskCall, LinkAskResult, LinkFeed, LinkHello,
};
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::navi::{
    AskHandle, FactoryStatusCall, FactoryStatusResult, ProjectMessageCall, ProjectMessageResult,
};
use serde::de::DeserializeOwned;
use zeroize::Zeroizing;

use super::{Kept, box_key, failed, kept, kept_get, set_cursor, set_state};
use crate::hub::api::Hub;
use crate::hub::leads::wakes::{LineKind, Trigger};
use crate::hub::navi::bridge::{Woken, ask_sent, record_sent};
use crate::hub::store::now_ms;

/// How long a follower waits before calling a hub that didn't answer again.
pub const RETRY: Duration = Duration::from_secs(30);
const CONNECT: Duration = Duration::from_secs(5);
const CALL: Duration = Duration::from_secs(20);

fn http() -> &'static reqwest::Client {
    static HTTP: OnceLock<reqwest::Client> = OnceLock::new();
    HTTP.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(CONNECT)
            .build()
            .expect("an HTTP client")
    })
}

/// What one call there came to: an answer, or a refusal in words the Navi and the person read.
#[derive(Debug)]
pub enum Failure {
    /// The other hub didn't answer.
    Unreachable(String),
    /// It refused the key: the link is dead.
    Dead(McpToolError),
    /// It refused this request.
    Refused(McpToolError),
}

/// One call to `/link/v1/<path>` on `url` with `key`.
pub async fn call<T: DeserializeOwned>(
    url: &str,
    key: &str,
    post: Option<serde_json::Value>,
    path: &str,
    timeout: Duration,
) -> Result<T, Failure> {
    let target = format!("{}/link/v1/{path}", url.trim_end_matches('/'));
    let request = match &post {
        Some(body) => http().post(&target).json(body),
        None => http().get(&target),
    };
    let response = request
        .bearer_auth(key)
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| Failure::Unreachable(reason(&e)))?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|e| Failure::Unreachable(reason(&e)))?;
    if status.is_success() {
        return serde_json::from_slice(&bytes).map_err(|_| {
            Failure::Unreachable(format!(
                "it answered {status} with something that isn't fleetd's"
            ))
        });
    }
    let error: McpToolError = serde_json::from_slice(&bytes).map_err(|_| {
        Failure::Unreachable(format!(
            "it answered {status}: is the URL a fleetd hub of this version or newer?"
        ))
    })?;
    Err(if status == reqwest::StatusCode::UNAUTHORIZED {
        Failure::Dead(error)
    } else {
        Failure::Refused(error)
    })
}

fn reason(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "it didn't answer in time".into()
    } else if e.is_connect() {
        "the connection failed".into()
    } else {
        "the request failed".into()
    }
}

/// The plain words for a hub this one can't reach, for the Navi and the app alike.
pub fn unreachable(label: &str, url: &str, why: &str) -> McpToolError {
    McpToolError::new(
        ErrorCode::Failed,
        format!("Can't reach {label} at {url}: {why}."),
    )
    .with_fix(format!(
        "A hub link needs {label}'s hub reachable from this hub, over a tailnet or HTTPS. Check it is up and its URL \
         in the Navi's Linked hubs; nothing was sent."
    ))
}

/// A Navi's link by label, with its key opened.
fn open(
    hub: &Hub,
    navi: &ProjectRef,
    label: &HubLabel,
) -> Result<(Kept, Zeroizing<String>), McpToolError> {
    let all = kept(&hub.db, Some(navi)).map_err(failed)?;
    let Some(link) = all
        .iter()
        .find(|k| k.label.eq_ignore_ascii_case(label.as_str()))
        .cloned()
    else {
        let labels: Vec<&str> = all.iter().map(|k| k.label.as_str()).collect();
        return Err(McpToolError::new(
            ErrorCode::NotFound,
            format!("This Navi has no linked hub called {label}."),
        )
        .with_fix(if labels.is_empty() {
            "It has no linked hubs: the person adds one in the Navi's settings, Linked hubs."
                .to_owned()
        } else {
            format!("Its linked hubs: {}.", labels.join(", "))
        }));
    };
    if link.state == HubLinkState::Revoked {
        return Err(McpToolError::new(
            ErrorCode::Forbidden,
            format!(
                "The link to {} no longer works: {}",
                link.label,
                link.error.as_deref().unwrap_or("it was revoked there.")
            ),
        )
        .with_fix(format!(
            "Ask the person to make a new link on {} and add it in the Navi's Linked hubs.",
            link.label
        )));
    }
    let key = open_key(hub, &link)?;
    Ok((link, key))
}

fn open_key(hub: &Hub, link: &Kept) -> Result<Zeroizing<String>, McpToolError> {
    let opened = box_key(hub)
        .ok()
        .and_then(|k| k.open(&link.sealed))
        .and_then(|plain| String::from_utf8(plain.to_vec()).ok());
    opened.map(Zeroizing::new).ok_or_else(|| {
        McpToolError::new(
            ErrorCode::Failed,
            format!("This hub can't open the key of the link to {}.", link.label),
        )
        .with_fix("Remove the link in the Navi's Linked hubs and add it again.")
    })
}

/// A call over a kept link, recording how it went on the link.
async fn over<T: DeserializeOwned>(
    hub: &Hub,
    link: &Kept,
    key: &str,
    post: Option<serde_json::Value>,
    path: &str,
    timeout: Duration,
) -> Result<T, McpToolError> {
    let out = call(&link.url, key, post, path, timeout).await;
    let (state, error) = match &out {
        Ok(_) | Err(Failure::Refused(_)) => (HubLinkState::Ok, None),
        Err(Failure::Unreachable(why)) => (
            HubLinkState::Unreachable,
            Some(format!(
                "Can't reach {} at {}: {why}.",
                link.label, link.url
            )),
        ),
        Err(Failure::Dead(e)) => (HubLinkState::Revoked, Some(e.message.clone())),
    };
    if state != link.state || error != link.error {
        set_state(hub, &link.link_id, state, error.as_deref()).map_err(failed)?;
    }
    out.map_err(|f| match f {
        Failure::Unreachable(why) => unreachable(&link.label, &link.url, &why),
        Failure::Dead(e) => McpToolError::new(
            ErrorCode::Forbidden,
            format!("The link to {} no longer works: {}", link.label, e.message),
        )
        .with_fix(format!(
            "Ask the person to make a new link on {} and add it in the Navi's Linked hubs.",
            link.label
        )),
        Failure::Refused(e) => McpToolError {
            message: format!("{}: {}", link.label, e.message),
            ..e
        },
    })
}

/// `project_message` with `hub`: the ask goes to the other hub as the link's person, and gets a handle here.
pub async fn ask(
    hub: &Arc<Hub>,
    navi: &ProjectRef,
    label: &HubLabel,
    call: &ProjectMessageCall,
) -> Result<ProjectMessageResult, McpToolError> {
    let (link, key) = open(hub, navi, label)?;
    let body = serde_json::to_value(LinkAskCall {
        project: call.project.clone(),
        text: call.text.clone(),
    })
    .map_err(|e| McpToolError::new(ErrorCode::Failed, e.to_string()))?;
    let sent: LinkAskResult = over(hub, &link, &key, Some(body), "ask", CALL).await?;
    let now = now_ms(hub.clock.as_ref());
    let handle = record_sent(&hub.db, navi, &link.link_id, &sent, call.text.as_str(), now)
        .map_err(failed)?;
    Ok(ProjectMessageResult {
        next: Some(format!(
            "In {}'s chat on {}, as the person via this hub's Navi. Its lead reads it as input, never as the \
             person's approval. A wake tells you when an order opened for {handle} opens, closes, merges or fails; \
             end your turn instead of waiting.",
            sent.title, link.label
        )),
        handle,
        project_ref: sent.project_ref,
        title: sent.title,
        lead_waiting: sent.lead_waiting,
        hub: Some(HubLabel::unchecked(link.label)),
    })
}

/// `factory_status` with `hub`: the other hub's read over the link's projects, its handles mapped to this hub's.
pub async fn status(
    hub: &Arc<Hub>,
    navi: &ProjectRef,
    label: &HubLabel,
    call: &FactoryStatusCall,
) -> Result<FactoryStatusResult, McpToolError> {
    let (link, key) = open(hub, navi, label)?;
    let path = match &call.project {
        Some(p) => format!(
            "status?project={}",
            url::form_urlencoded::byte_serialize(p.as_bytes()).collect::<String>()
        ),
        None => "status".to_owned(),
    };
    let mut out: FactoryStatusResult = over(hub, &link, &key, None, &path, CALL).await?;
    let here = |there: &AskHandle| -> Result<Option<AskHandle>, McpToolError> {
        Ok(ask_sent(&hub.db, &link.link_id, there.as_str())
            .map_err(failed)?
            .map(|a| a.handle))
    };
    for p in &mut out.projects {
        for o in &mut p.open_orders {
            o.asked = match &o.asked {
                Some(h) => here(h)?,
                None => None,
            };
        }
        let mut asks = Vec::new();
        for mut a in std::mem::take(&mut p.asks) {
            if let Some(h) = here(&a.handle)? {
                a.handle = h;
                asks.push(a);
            }
        }
        p.asks = asks;
    }
    out.hubs = None;
    out.next = Some(format!(
        "Projects on {} this Navi reaches. project_message with hub \"{}\" writes to one's lead.",
        link.label, link.label
    ));
    Ok(out)
}

/// Whether a follower goes on after one read.
#[derive(Debug, PartialEq)]
pub enum Followed {
    /// Read; the wakes it sent.
    Read(Vec<Woken>),
    /// The link is gone here or dead there: its follower ends.
    Stop,
}

/// One feed read for a kept link, waiting up to `wait` seconds there: wakes its Navi's lead with each piece of news
/// about its asks, and once when the other hub says the link is dead.
pub async fn follow_once(hub: &Hub, link_id: &str, wait: u64) -> Result<Followed, McpToolError> {
    let Some(link) = kept_get(&hub.db, link_id).map_err(failed)? else {
        return Ok(Followed::Stop);
    };
    if link.state == HubLinkState::Revoked {
        return Ok(Followed::Stop);
    }
    let key = open_key(hub, &link)?;
    let wait = wait.min(FEED_WAIT_MAX_SEC);
    let path = format!("feed?after={}&wait={wait}", link.cursor);
    let read = over::<LinkFeed>(
        hub,
        &link,
        &key,
        None,
        &path,
        CALL + Duration::from_secs(wait),
    )
    .await;
    let feed = match read {
        Ok(feed) => feed,
        Err(e) => {
            let dead = kept_get(&hub.db, link_id)
                .map_err(failed)?
                .is_some_and(|k| k.state == HubLinkState::Revoked);
            if !dead {
                return Err(e);
            }
            let line = format!("- {} Asks through it are no longer followed.", e.message);
            wake(hub, &link.navi, &line);
            return Ok(Followed::Stop);
        }
    };
    let mut sent = Vec::new();
    for item in feed.items {
        let Some(asked) = ask_sent(&hub.db, &link.link_id, item.handle.as_str()).map_err(failed)?
        else {
            continue;
        };
        let line = format!(
            "- {} to {} on {}: {}",
            asked.handle, item.title, link.label, item.what
        );
        wake(hub, &asked.from, &line);
        sent.push((asked.from, line));
    }
    if feed.cursor != link.cursor {
        set_cursor(&hub.db, &link.link_id, feed.cursor).map_err(failed)?;
    }
    Ok(Followed::Read(sent))
}

fn wake(hub: &Hub, navi: &ProjectRef, line: &str) {
    hub.leads.wakes.trigger(
        navi,
        Trigger::Line {
            kind: LineKind::Factory,
            text: line.to_owned(),
        },
    );
}

/// Follows one kept link until it is removed here, dead there, or the hub stops.
pub async fn follow(hub: Arc<Hub>, link_id: String) {
    loop {
        if hub.shutdown.is_triggered() {
            return;
        }
        let pause = match follow_once(&hub, &link_id, FEED_WAIT_MAX_SEC).await {
            Ok(Followed::Stop) => return,
            Ok(Followed::Read(_)) => None,
            Err(e) => {
                tracing::debug!(link = %link_id, error = %e.message, "hub link feed");
                Some(RETRY)
            }
        };
        if let Some(pause) = pause {
            tokio::select! {
                () = hub.shutdown.wait() => return,
                () = tokio::time::sleep(pause) => {}
            }
        }
    }
}

/// Starts a follower for every kept link that still works.
pub async fn run(hub: Arc<Hub>) {
    for link in kept(&hub.db, None).unwrap_or_default() {
        if link.state != HubLinkState::Revoked {
            tokio::spawn(follow(hub.clone(), link.link_id));
        }
    }
}

/// `GET hello` with a key not kept yet: what `hub_link_add` checks before keeping it.
pub async fn hello(label: &str, url: &str, key: &str) -> Result<LinkHello, McpToolError> {
    call(url, key, None, "hello", CALL)
        .await
        .map_err(|f| match f {
            Failure::Unreachable(why) => unreachable(label, url, &why),
            Failure::Dead(e) | Failure::Refused(e) => McpToolError::new(
                ErrorCode::Forbidden,
                format!("{label} refused the link key: {}", e.message),
            )
            .with_fix(format!(
                "Copy the key again from {label} (it is shown once), or make a new link there."
            )),
        })
}

/// Asks the other hub to revoke a link being removed here: whether it did.
pub async fn revoke_there(hub: &Hub, link: &Kept) -> bool {
    let Ok(key) = open_key(hub, link) else {
        return false;
    };
    call::<serde_json::Value>(&link.url, &key, Some(serde_json::json!({})), "revoke", CALL)
        .await
        .is_ok()
}
