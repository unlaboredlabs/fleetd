//! Phone notifications, end-to-end encrypted (D218, docs/design/push.md). Each person registers their phones (table
//! `push_devices`: a push token and an X25519 public key, tools.rs). [`run`] follows the event log and, for what the
//! hub already marks as needing a person (an event with `attention`), a Navi's or a lead's final chat message, and an
//! order that landed or stopped, seals a [`PushPayload`] to each of that person's devices and posts it to the hub's
//! push relay (`fleetd push-relay`, crate::push_relay; [`DEFAULT_RELAY`] until one is set), with the relay's key when
//! it takes one. The relay sees a token and ciphertext, never the content. A token the relay reports dead is dropped,
//! unless one notification would drop more than half of a person's phones that way: a relay set up wrong makes every
//! token look dead, so those are kept and logged. Each failure is logged once an hour at most.
//!
//! Who an event is for: a Navi's, its owner; another project's, the person who last wrote in its chat, else the hub's
//! owner; an event about no project, the hub's owners and admins.
pub mod tools;

#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::chat::{
    ChatAuthor, ChatMessage, ChatMessageId, ChatMessageState, ChatRequestId,
};
use fleetd_contracts::events::{Attention, HubEvent, HubEventType};
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::people::PersonId;
use fleetd_contracts::prim::Line;
use fleetd_contracts::push::{
    PUSH_PAYLOAD_MAX, PushDevice, PushDeviceId, PushKind, PushPayload, PushPlatform,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;
use sha2::Digest;

use crate::hub::api::Hub;
use crate::hub::store::{StoreError, iso_ms, now_ms};
use crate::push_relay::{RelayAnswer, RelayPush};

/// The longest body before the payload is cut to [`PUSH_PAYLOAD_MAX`].
const BODY_MAX: usize = 1000;
/// Chat messages already sent, so a final message announced again isn't sent twice.
const SENT_MEMORY: usize = 500;
/// How long a failure logged stays quiet.
const WARN_EVERY_MS: i64 = 60 * 60 * 1000;
const RELAY_TIMEOUT: Duration = Duration::from_secs(15);

/// A device's id: "pd_" and 8 base32 characters.
fn new_id() -> PushDeviceId {
    PushDeviceId::unchecked(format!(
        "pd_{}",
        crate::hub::auth::base32(&rand::random::<[u8; 5]>())
    ))
}

const COLUMNS: &str = "device_id, platform, name, created_ms, last_sent_ms";

fn read_device(row: &rusqlite::Row<'_>) -> rusqlite::Result<PushDevice> {
    let platform: String = row.get(1)?;
    let name: String = row.get(2)?;
    Ok(PushDevice {
        device_id: PushDeviceId::unchecked(row.get::<_, String>(0)?),
        platform: if platform == "android" {
            PushPlatform::Android
        } else {
            PushPlatform::Ios
        },
        name: Line::new(name).unwrap_or_else(|_| Line::unchecked("Phone")),
        created_at: iso_ms(row.get(3)?).into(),
        last_sent_at: row.get::<_, Option<i64>>(4)?.map(|ms| iso_ms(ms).into()),
    })
}

/// What `push_device_register` saves.
pub struct NewDevice<'a> {
    pub person: &'a PersonId,
    pub key_id: &'a str,
    pub platform: PushPlatform,
    pub token: &'a str,
    pub public_key: &'a [u8; 32],
    pub name: &'a str,
}

/// Saves a device, or updates the one with that token (moving it to `new.person`).
pub fn register(c: &Connection, new: &NewDevice<'_>, at_ms: i64) -> Result<PushDevice, StoreError> {
    c.prepare_cached(
        "INSERT INTO push_devices (device_id, person_id, key_id, platform, token, public_key, name, created_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (token) DO UPDATE SET person_id = excluded.person_id, key_id = excluded.key_id,
           platform = excluded.platform, public_key = excluded.public_key, name = excluded.name",
    )?
    .execute(params![
        new_id().as_str(),
        new.person.as_str(),
        new.key_id,
        new.platform.as_str(),
        new.token,
        B64.encode(new.public_key),
        new.name,
        at_ms
    ])?;
    Ok(c.prepare_cached(&format!(
        "SELECT {COLUMNS} FROM push_devices WHERE token = ?"
    ))?
    .query_row([new.token], read_device)?)
}

/// A person's devices, oldest first.
pub fn list(c: &Connection, person: &PersonId) -> Result<Vec<PushDevice>, StoreError> {
    Ok(c.prepare_cached(&format!(
        "SELECT {COLUMNS} FROM push_devices WHERE person_id = ? ORDER BY created_ms, rowid"
    ))?
    .query_map([person.as_str()], read_device)?
    .collect::<rusqlite::Result<_>>()?)
}

/// Removes one of `person`'s devices; None when they have no such device.
pub fn remove(
    c: &Connection,
    person: &PersonId,
    id: &PushDeviceId,
) -> Result<Option<PushDevice>, StoreError> {
    let device = c
        .prepare_cached(&format!(
            "SELECT {COLUMNS} FROM push_devices WHERE device_id = ? AND person_id = ?"
        ))?
        .query_row(params![id.as_str(), person.as_str()], read_device)
        .optional()?;
    if device.is_some() {
        c.prepare_cached("DELETE FROM push_devices WHERE device_id = ?")?
            .execute([id.as_str()])?;
    }
    Ok(device)
}

/// The relay every hub sends through until `fleetd push-relay set` says otherwise (D225): the one holding the published
/// app's APNs and Firebase keys. It takes no key; the payload is sealed to the phone and the relay caps each device's rate.
pub const DEFAULT_RELAY: &str = "https://push.fleetd.sh";

/// The hub's push relay.
#[derive(Clone, Debug, PartialEq)]
pub struct RelaySetting {
    pub url: String,
    /// The relay's key, sealed to the hub's box key (standard base64).
    pub key_sealed: Option<String>,
}

/// The hub's push relay as set; None when never set, so `default` (normally [`DEFAULT_RELAY`]) applies without a key;
/// None too when pushes are turned off (a row with an empty URL).
pub fn relay(c: &Connection, default: &str) -> Result<Option<RelaySetting>, StoreError> {
    let set = c
        .prepare_cached("SELECT url, key_sealed FROM push_relay WHERE id = 1")?
        .query_row([], |row| {
            Ok(RelaySetting {
                url: row.get(0)?,
                key_sealed: row.get(1)?,
            })
        })
        .optional()?;
    Ok(match set {
        None => Some(RelaySetting {
            url: default.to_owned(),
            key_sealed: None,
        }),
        Some(r) if r.url.is_empty() => None,
        Some(r) => Some(r),
    })
}

/// Whether `url` points at the default relay's host. Whatever was set, the hub sends it no key and only over https: the
/// public relay takes none, and a key or a push sent there in the clear would only leak.
pub fn default_host(url: &str) -> bool {
    let host = |u: &str| {
        url::Url::parse(u)
            .ok()?
            .host_str()
            .map(str::to_ascii_lowercase)
    };
    host(url).is_some() && host(url) == host(DEFAULT_RELAY)
}

/// The sealed key to send `relay`, after [`default_host`]'s rule; Err when it can't be sent at all.
pub fn sendable(relay: &RelaySetting) -> Result<Option<&str>, String> {
    if !default_host(&relay.url) {
        return Ok(relay.key_sealed.as_deref());
    }
    if !relay.url.starts_with("https://") {
        return Err(format!(
            "{} is sent to over https only: set it again with `fleetd push-relay set {DEFAULT_RELAY}`",
            relay.url
        ));
    }
    Ok(None)
}

/// Sets the hub's push relay: None goes back to [`DEFAULT_RELAY`], an empty URL turns pushes off.
pub fn set_relay(c: &Connection, relay: Option<&RelaySetting>) -> Result<(), StoreError> {
    match relay {
        Some(r) => c
            .prepare_cached(
                "INSERT INTO push_relay (id, url, key_sealed) VALUES (1, ?, ?)
                 ON CONFLICT (id) DO UPDATE SET url = excluded.url, key_sealed = excluded.key_sealed",
            )?
            .execute(params![r.url, r.key_sealed])?,
        None => c.prepare_cached("DELETE FROM push_relay")?.execute([])?,
    };
    Ok(())
}

/// A device a notification goes to.
#[derive(Clone, Debug, PartialEq)]
pub struct Target {
    pub device_id: String,
    pub platform: PushPlatform,
    pub token: String,
    pub public_key: [u8; 32],
}

/// `person`'s devices that may still get notifications: their key not revoked, the person still on the hub.
fn targets(c: &Connection, person: &PersonId) -> Result<Vec<Target>, StoreError> {
    let rows: Vec<(String, String, String, String)> = c
        .prepare_cached(
            "SELECT d.device_id, d.platform, d.token, d.public_key FROM push_devices d
             JOIN people p ON p.person_id = d.person_id AND p.removed_ms IS NULL
             JOIN agent_keys k ON k.key_id = d.key_id AND k.revoked_ms IS NULL
             WHERE d.person_id = ? ORDER BY d.created_ms, d.rowid",
        )?
        .query_map([person.as_str()], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows
        .into_iter()
        .filter_map(|(device_id, platform, token, key)| {
            Some(Target {
                device_id,
                platform: if platform == "android" {
                    PushPlatform::Android
                } else {
                    PushPlatform::Ios
                },
                token,
                public_key: B64.decode(key).ok()?.try_into().ok()?,
            })
        })
        .collect())
}

/// Seals `plain` to a device's X25519 public key: a libsodium sealed box (`crypto_box_seal`), standard base64.
pub fn seal(public_key: &[u8; 32], plain: &[u8]) -> String {
    let sealed = crypto_box::PublicKey::from(*public_key)
        .seal(&mut crypto_box::aead::OsRng, plain)
        .expect("sealing to a 32-byte key does not fail");
    B64.encode(sealed)
}

/// The payload's JSON, its body cut until it fits [`PUSH_PAYLOAD_MAX`].
pub fn payload_json(payload: &PushPayload) -> Vec<u8> {
    let mut payload = payload.clone();
    payload.body = cut(&payload.body, BODY_MAX);
    loop {
        let json = serde_json::to_vec(&payload).unwrap_or_default();
        let chars = payload.body.chars().count();
        if json.len() <= PUSH_PAYLOAD_MAX || chars == 0 {
            return json;
        }
        let over = json.len() - PUSH_PAYLOAD_MAX;
        payload.body = cut(&payload.body, chars.saturating_sub(over.max(8)));
    }
}

/// `text` on one line, at most `max` characters with "…" when cut.
fn cut(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        return flat;
    }
    let mut out: String = flat.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// A notification before it is addressed and sealed.
#[derive(Clone, Debug, PartialEq)]
pub struct Notice {
    pub payload: PushPayload,
    /// Who it is for.
    pub people: Vec<PersonId>,
    /// An opaque key a later notification about the same thing replaces this one under.
    pub collapse: Option<String>,
}

/// The project an event names: at its top level, or (chat events) in `data.projectRef`.
fn project_of(event: &HubEvent) -> Option<ProjectRef> {
    if let (Some(m), Some(p)) = (&event.machine_id, &event.project_id) {
        return Some(ProjectRef {
            machine_id: m.clone(),
            project_id: p.clone(),
        });
    }
    let r = event.data.as_ref()?.get("projectRef")?;
    serde_json::from_value(r.clone()).ok()
}

/// A short opaque key: the relay and Apple see it, so it names nothing.
fn collapse_key(what: &str) -> String {
    let digest = sha2::Sha256::digest(what.as_bytes());
    digest[..8].iter().map(|b| format!("{b:02x}")).collect()
}

fn final_lead_message(hub: &Hub, event: &HubEvent, r: &ProjectRef) -> Option<ChatMessage> {
    let data = event.data.as_ref()?;
    if data.get("author")? != &serde_json::json!(ChatAuthor::Lead)
        || data.get("state")? != &serde_json::json!(ChatMessageState::Final)
    {
        return None;
    }
    if let Some(m) = data.get("message").cloned() {
        return serde_json::from_value(m).ok();
    }
    // Too big for the event: read it from the chat.
    let seq = data.get("seq")?.as_i64()?;
    hub.db
        .with(|c| {
            Ok(c.prepare_cached(
                "SELECT data FROM chat_messages WHERE machine_id = ? AND project_id = ? AND seq = ?",
            )?
            .query_row(
                params![r.machine_id.as_str(), r.project_id.as_str(), seq],
                |row| row.get::<_, String>(0),
            )
            .optional()?)
        })
        .ok()
        .flatten()
        .and_then(|d| serde_json::from_str(&d).ok())
}

/// The notification `event` makes, if it is one a person is pushed for.
pub fn notice(hub: &Hub, event: &HubEvent) -> Result<Option<Notice>, StoreError> {
    let project = project_of(event);
    let data = event.data.as_ref();
    let text = |k: &str| data.and_then(|d| d.get(k)).and_then(Value::as_str);
    let mut message_id = None;
    let mut request_id = None;
    let mut collapse = None;
    let (kind, body) = match event.r#type {
        HubEventType::ChatMessage => {
            let Some(r) = &project else { return Ok(None) };
            let Some(m) = final_lead_message(hub, event, r) else {
                return Ok(None);
            };
            // An inline item (a command to approve, a secret to give) has no text: its request is pushed instead.
            if m.text.as_str().trim().is_empty() {
                return Ok(None);
            }
            message_id = Some(m.message_id.clone());
            (PushKind::Message, m.text.as_str().to_owned())
        }
        HubEventType::WorkstreamDone => (PushKind::Order, event.summary.to_string()),
        HubEventType::WorkstreamState if text("state") == Some("stopped") => {
            (PushKind::Order, event.summary.to_string())
        }
        _ if event.attention.is_some() => {
            if event.r#type == HubEventType::RequestOpened
                && let Some(id) = text("requestId")
            {
                request_id = Some(ChatRequestId::unchecked(id));
                collapse = Some(collapse_key(&format!("request/{id}")));
                (PushKind::Approval, event.summary.to_string())
            } else {
                (PushKind::Alert, event.summary.to_string())
            }
        }
        _ => return Ok(None),
    };
    let people = hub.db.with(|c| recipients(c, project.as_ref()))?;
    if people.is_empty() {
        return Ok(None);
    }
    let title = project
        .as_ref()
        .and_then(|r| hub.store.project_get(r).ok().flatten())
        .map(|p| p.title)
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| "fleetd".into());
    let urgent = event.attention == Some(Attention::Urgent);
    let (tz, quiet) =
        crate::hub::attention::quiet_policy(|k| hub.decisions.global_value(k).ok().flatten());
    let quiet = !urgent
        && crate::hub::attention::quiet_until(now_ms(hub.clock.as_ref()), tz, quiet).is_some();
    Ok(Some(Notice {
        payload: PushPayload {
            v: 1,
            kind,
            title: cut(&title, 80),
            body,
            hub: hub.config.url(),
            machine_id: project.as_ref().map(|r| r.machine_id.clone()),
            project_id: project.as_ref().map(|r| r.project_id.clone()),
            thread_id: event.thread_id.clone(),
            message_id,
            request_id,
            urgent: urgent.then_some(true),
            quiet: quiet.then_some(true),
            at: event.at.clone(),
        },
        people,
        collapse,
    }))
}

/// Who an event about `project` (None: about no project) is for.
pub fn recipients(
    c: &Connection,
    project: Option<&ProjectRef>,
) -> Result<Vec<PersonId>, StoreError> {
    let on_hub = "SELECT person_id FROM people WHERE person_id = ? AND removed_ms IS NULL";
    let Some(r) = project else {
        return Ok(c
            .prepare_cached(
                "SELECT person_id FROM people WHERE role IN ('owner', 'admin') AND removed_ms IS NULL
                 ORDER BY created_ms, rowid",
            )?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .map(PersonId::unchecked)
            .collect());
    };
    let (m, p) = (r.machine_id.as_str(), r.project_id.as_str());
    let navi_owner: Option<Option<String>> = c
        .prepare_cached(
            "SELECT owner_person FROM assistants WHERE machine_id = ? AND project_id = ?",
        )?
        .query_row(params![m, p], |row| row.get(0))
        .optional()?;
    let person = match navi_owner {
        // A Navi is its owner's alone.
        Some(owner) => owner,
        None => c
            .prepare_cached(
                "SELECT json_extract(data, '$.person.personId') FROM chat_messages
                 WHERE machine_id = ? AND project_id = ? AND json_extract(data, '$.author') = 'human'
                   AND json_extract(data, '$.person.personId') IS NOT NULL
                 ORDER BY seq DESC LIMIT 1",
            )?
            .query_row(params![m, p], |row| row.get::<_, String>(0))
            .optional()?
            .or(crate::hub::people::owner_on(c)?.map(|o| o.person_id.to_string())),
    };
    let Some(person) = person else {
        return Ok(Vec::new());
    };
    Ok(c.prepare_cached(on_hub)?
        .query_row([&person], |row| row.get::<_, String>(0))
        .optional()?
        .map(PersonId::unchecked)
        .into_iter()
        .collect())
}

/// What became of one push.
#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    Sent,
    /// APNs or FCM no longer knows the token: the device was dropped.
    Dead,
    Failed(String),
}

/// Posts one sealed notification to the relay, with its key when it has one.
pub async fn post(
    http: &reqwest::Client,
    relay: &str,
    key: Option<&str>,
    push: &RelayPush,
) -> Outcome {
    let url = format!("{}/v1/push", relay.trim_end_matches('/'));
    let mut request = http.post(&url).json(push);
    if let Some(key) = key {
        request = request.bearer_auth(key);
    }
    let answer = match request.send().await {
        Ok(answer) => answer,
        Err(e) => return Outcome::Failed(format!("the relay can't be reached: {e}")),
    };
    let status = answer.status();
    match answer.json::<RelayAnswer>().await {
        Ok(RelayAnswer::Sent) if status.is_success() => Outcome::Sent,
        Ok(RelayAnswer::Dead) => Outcome::Dead,
        Ok(RelayAnswer::Failed { error }) => Outcome::Failed(format!("{status}: {error}")),
        _ => Outcome::Failed(format!("the relay answered {status}")),
    }
}

/// The loop's memory between pages.
pub struct Follow {
    sent: HashSet<ChatMessageId>,
    order: VecDeque<ChatMessageId>,
    /// Each failure logged, and when.
    warned: HashMap<String, i64>,
    /// Where pushes go when no relay is set: [`DEFAULT_RELAY`], a fake one in tests.
    default_relay: String,
}

impl Default for Follow {
    fn default() -> Self {
        Self {
            sent: HashSet::new(),
            order: VecDeque::new(),
            warned: HashMap::new(),
            default_relay: DEFAULT_RELAY.to_owned(),
        }
    }
}

impl Follow {
    /// False when `id` was sent already; remembers it otherwise.
    fn first(&mut self, id: &ChatMessageId) -> bool {
        if !self.sent.insert(id.clone()) {
            return false;
        }
        self.order.push_back(id.clone());
        if self.order.len() > SENT_MEMORY
            && let Some(old) = self.order.pop_front()
        {
            self.sent.remove(&old);
        }
        true
    }

    /// Logs `why` unless it was logged in the last hour: a relay set up wrong fails every push the same way, and the
    /// log says it once, with what to fix. Never with a token or ciphertext. True when it logged.
    fn warn_once(&mut self, why: String, now_ms: i64) -> bool {
        self.warned
            .retain(|_, at| now_ms.saturating_sub(*at) < WARN_EVERY_MS);
        if self.warned.contains_key(&why) {
            return false;
        }
        tracing::warn!("push: {why}");
        self.warned.insert(why, now_ms);
        true
    }
}

/// Sends the notifications of the events after `cursor`: (the cursor to resume from, whether more are ready, what
/// each push came to, by device).
pub async fn step(
    hub: &Hub,
    http: &reqwest::Client,
    follow: &mut Follow,
    cursor: i64,
) -> Result<(i64, bool, Vec<(String, Outcome)>), StoreError> {
    let page = hub.events.page(cursor, None, None)?;
    let mut outcomes = Vec::new();
    let Some(relay) = hub.db.with(|c| relay(c, &follow.default_relay))? else {
        return Ok((page.cursor, page.more, outcomes));
    };
    let sealed = match sendable(&relay) {
        Ok(sealed) => sealed,
        Err(why) => {
            follow.warn_once(why, now_ms(hub.clock.as_ref()));
            return Ok((page.cursor, page.more, outcomes));
        }
    };
    let key = match sealed {
        None => None,
        Some(sealed) => match open_key(hub, sealed) {
            Some(key) => Some(key),
            None => {
                follow.warn_once(
                    "the push relay's key can't be opened with this hub's box key: set it again with \
                     `fleetd push-relay set <url> --relay-key-file <path>`"
                        .into(),
                    now_ms(hub.clock.as_ref()),
                );
                return Ok((page.cursor, page.more, outcomes));
            }
        },
    };
    for event in &page.events {
        let Some(notice) = notice(hub, event)? else {
            continue;
        };
        if let Some(id) = &notice.payload.message_id
            && !follow.first(id)
        {
            continue;
        }
        let plain = payload_json(&notice.payload);
        for person in &notice.people {
            let mut posted = Vec::new();
            for target in hub.db.with(|c| targets(c, person))? {
                let push = RelayPush {
                    platform: target.platform,
                    token: target.token.clone(),
                    ciphertext: seal(&target.public_key, &plain),
                    collapse_key: notice.collapse.clone(),
                };
                let outcome =
                    post(http, &relay.url, key.as_deref().map(String::as_str), &push).await;
                posted.push((target.device_id, outcome));
            }
            // A relay set up wrong answers every token dead: one notification never drops most of a person's phones.
            let dead = posted.iter().filter(|(_, o)| *o == Outcome::Dead).count();
            if dead * 2 > posted.len() {
                let why = format!(
                    "the push relay says {dead} of {person}'s {} phones are gone at once: kept them, as a relay set \
                     up wrong (APNs environment or bundle id, Firebase project) is the likelier cause; check its log",
                    posted.len()
                );
                for (_, outcome) in &mut posted {
                    if *outcome == Outcome::Dead {
                        *outcome = Outcome::Failed(why.clone());
                    }
                }
            }
            let now = now_ms(hub.clock.as_ref());
            for (device_id, outcome) in &posted {
                if let Outcome::Failed(why) = outcome {
                    follow.warn_once(why.clone(), now);
                }
                hub.db.with(|c| {
                    match outcome {
                        Outcome::Sent => c
                            .prepare_cached(
                                "UPDATE push_devices SET last_sent_ms = ? WHERE device_id = ?",
                            )?
                            .execute(params![now, device_id])?,
                        Outcome::Dead => c
                            .prepare_cached("DELETE FROM push_devices WHERE device_id = ?")?
                            .execute([device_id])?,
                        Outcome::Failed(_) => 0,
                    };
                    Ok(())
                })?;
            }
            outcomes.extend(posted);
        }
    }
    Ok((page.cursor, page.more, outcomes))
}

/// The relay's key, opened with the hub's box key.
fn open_key(hub: &Hub, sealed: &str) -> Option<zeroize::Zeroizing<String>> {
    let sealed = B64.decode(sealed).ok()?;
    let plain = crate::hub::hub_links::box_key(hub).ok()?.open(&sealed)?;
    String::from_utf8(plain.to_vec())
        .ok()
        .map(zeroize::Zeroizing::new)
}

/// Follows the event log from its head at the hub's start: what happened while the hub was down is old news.
pub async fn run(hub: Arc<Hub>) {
    let http = reqwest::Client::builder()
        .timeout(RELAY_TIMEOUT)
        .build()
        .unwrap_or_default();
    let mut head = hub.events.subscribe();
    let mut cursor = hub.events.head();
    let mut follow = Follow::default();
    loop {
        head.borrow_and_update();
        match step(&hub, &http, &mut follow, cursor).await {
            Ok((next, more, _)) => {
                cursor = next;
                if more {
                    continue;
                }
            }
            Err(e) => {
                tracing::error!(error = %e, "push: events not followed");
                tokio::select! {
                    () = hub.shutdown.wait() => return,
                    () = hub.clock.sleep(Duration::from_secs(5)) => {}
                }
                continue;
            }
        }
        tokio::select! {
            () = hub.shutdown.wait() => return,
            changed = head.changed() => if changed.is_err() { return },
        }
    }
}
