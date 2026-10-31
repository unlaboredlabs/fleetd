//! Navis' Telegram bridges on their node (W237; the wire types are `fleetd_contracts::telegram`). Each Navi with a bot
//! token has a poller here that long-polls the Bot API's getUpdates: no public URL, no webhook. It is the gate:
//!
//! - a Start with the code of a pairing link the hub opened (`pair`) makes that account the paired one;
//! - from then on only the paired account's private messages and button presses get through, into a short journal
//!   the hub takes (`take`, a long call); anyone else's are dropped without a word;
//! - a voice note, or anything else it can't carry, gets a plain line back and goes no further.
//!
//! The offset is saved after each update, so a restarted node goes on where it stopped. Telegram down or asking to
//! slow down backs it off; a revoked token stops it until a new one comes. Sends go to the paired account only.
mod api;
mod inbound;
pub mod store;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::ids::{ProjectId, Timestamp};
use fleetd_contracts::prim::{AnyInt, Line, Text};
use fleetd_contracts::telegram::{
    TELEGRAM_PAIR_SECS, TELEGRAM_PIECE_BYTES, TELEGRAM_SEND_MAX, TelegramAnswer, TelegramBot,
    TelegramButton, TelegramCall, TelegramEvent, TelegramNode, TelegramSend, TelegramState,
    TelegramStatus,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::{Notify, watch};

pub use api::TELEGRAM;
use api::{Api, ApiError};
use store::State;

/// How long the bridge waits: Telegram's long poll, and the backoff after a failure.
#[derive(Clone, Debug)]
pub struct Timing {
    pub poll_secs: u64,
    pub backoff_min: Duration,
    pub backoff_max: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            poll_secs: 50,
            backoff_min: Duration::from_secs(1),
            backoff_max: Duration::from_secs(60),
        }
    }
}

/// The most events one take returns.
const TAKE_MAX: usize = 50;
/// The longest wait on a rate limit while sending; a longer one fails the send.
const SEND_WAIT_MAX: u64 = 30;

pub(crate) fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub(crate) fn iso(ms: i64) -> Timestamp {
    Timestamp(
        chrono::DateTime::from_timestamp_millis(ms)
            .unwrap_or_default()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    )
}

fn sha256_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// One Navi's running bridge.
struct Bot {
    project: ProjectId,
    api: Api,
    state: tokio::sync::Mutex<State>,
    status: Mutex<TelegramStatus>,
    /// The journal's newest seq, for a take waiting on it.
    seq: watch::Sender<i64>,
    /// Pause, resume and a new pairing wake the poller.
    wake: Notify,
    stop: watch::Sender<bool>,
}

impl Bot {
    fn set_status(&self, state: TelegramState, error: Option<String>, retry_in: Option<Duration>) {
        let now = now_ms();
        let mut status = self.status.lock().unwrap();
        if status.state != state {
            status.state = state;
            status.since = iso(now);
        }
        if let Some(error) = error {
            tracing::warn!(project = %self.project, "telegram: {error}");
            status.error = Some(Text::unchecked(error.chars().take(500).collect::<String>()));
            status.error_at = Some(iso(now));
        }
        status.retry_at = retry_in.map(|d| iso(now + d.as_millis() as i64));
    }

    async fn save(&self, home: &Path, state: &State) {
        // A stopped poller's state is a replaced token's or a forgotten bridge's: it must not write over the new one.
        if *self.stop.borrow() {
            return;
        }
        if let Err(e) = store::write_state(home, &self.project, state) {
            tracing::warn!(project = %self.project, "telegram: {e}");
        }
    }
}

pub struct Telegram {
    home: PathBuf,
    base: String,
    timing: Timing,
    bots: Mutex<HashMap<ProjectId, Arc<Bot>>>,
}

impl Telegram {
    /// The service, with a poller for each Navi whose token this node holds.
    pub fn start(home: &Path, base: &str, timing: Timing) -> Arc<Self> {
        let me = Arc::new(Self {
            home: home.to_owned(),
            base: base.to_owned(),
            timing,
            bots: Mutex::default(),
        });
        for project in store::projects(home) {
            if let Err(e) = me.run(&project) {
                tracing::warn!(%project, "telegram: not started: {e}");
            }
        }
        me
    }

    /// Starts (or starts again) the poller of `project`'s bridge from what is saved.
    fn run(self: &Arc<Self>, project: &ProjectId) -> Result<(), String> {
        let Some(token) = store::read_token(&self.home, project)? else {
            return Ok(());
        };
        let state = store::read_state(&self.home, project);
        let (stop, _) = watch::channel(false);
        let bot = Arc::new(Bot {
            project: project.clone(),
            api: Api::new(&self.base, token),
            seq: watch::channel(state.seq).0,
            status: Mutex::new(TelegramStatus {
                state: if state.paused {
                    TelegramState::Paused
                } else {
                    TelegramState::Connecting
                },
                since: iso(now_ms()),
                error: None,
                error_at: None,
                retry_at: None,
            }),
            state: tokio::sync::Mutex::new(state),
            wake: Notify::new(),
            stop,
        });
        if let Some(old) = self
            .bots
            .lock()
            .unwrap()
            .insert(project.clone(), bot.clone())
        {
            let _ = old.stop.send(true);
        }
        let me = self.clone();
        tokio::spawn(async move { me.poll(bot).await });
        Ok(())
    }

    fn bot(&self, project: &ProjectId) -> Option<Arc<Bot>> {
        self.bots.lock().unwrap().get(project).cloned()
    }

    fn stop(&self, project: &ProjectId) {
        if let Some(bot) = self.bots.lock().unwrap().remove(project) {
            let _ = bot.stop.send(true);
        }
    }

    /// Forgets `project`'s bridge (its Navi went).
    pub fn forget(&self, project: &ProjectId) {
        self.stop(project);
        if let Err(e) = store::forget(&self.home, project) {
            tracing::warn!(%project, "telegram: {e}");
        }
    }

    /// Stops every poller, as the node does.
    pub fn shutdown(&self) {
        for (_, bot) in self.bots.lock().unwrap().drain() {
            let _ = bot.stop.send(true);
        }
    }

    /// One call of the hub's: the answer, or why not in plain words.
    pub async fn call(
        self: &Arc<Self>,
        project: &ProjectId,
        call: TelegramCall,
    ) -> Result<TelegramAnswer, String> {
        if let TelegramCall::Token { sealed } = call {
            self.stop(project);
            let Some(sealed) = sealed else {
                store::forget(&self.home, project)?;
                return Ok(TelegramAnswer::Saved { fingerprint: None });
            };
            let home = self.home.clone();
            let p = project.clone();
            let fingerprint = tokio::task::spawn_blocking(move || {
                let box_key = crate::node::identity::load_or_create_box_key(&home).ok();
                store::save_token(&home, &p, &sealed, box_key.as_ref())
            })
            .await
            .map_err(|e| e.to_string())??;
            self.run(project)?;
            return Ok(TelegramAnswer::Saved {
                fingerprint: Some(fingerprint),
            });
        }
        let Some(bot) = self.bot(project) else {
            return Err(
                "this machine holds no Telegram bot token for this Navi: paste it again in its settings".into(),
            );
        };
        match call {
            TelegramCall::Token { .. } => unreachable!("handled above"),
            TelegramCall::Test => Ok(self.test(&bot).await),
            TelegramCall::Pair { code } => {
                let mut state = bot.state.lock().await;
                state.pairing = Some(store::Pairing {
                    code_sha256: sha256_hex(code.as_str()),
                    expires_ms: now_ms() + TELEGRAM_PAIR_SECS * 1000,
                });
                bot.save(&self.home, &state).await;
                drop(state);
                bot.wake.notify_waiters();
                Ok(self.state_answer(&bot).await)
            }
            TelegramCall::Unpair => {
                let mut state = bot.state.lock().await;
                state.paired = None;
                state.pairing = None;
                bot.save(&self.home, &state).await;
                drop(state);
                Ok(self.state_answer(&bot).await)
            }
            TelegramCall::Pause { paused } => {
                let mut state = bot.state.lock().await;
                state.paused = paused;
                bot.save(&self.home, &state).await;
                drop(state);
                if paused {
                    bot.set_status(TelegramState::Paused, None, None);
                }
                bot.wake.notify_waiters();
                Ok(self.state_answer(&bot).await)
            }
            TelegramCall::State => Ok(self.state_answer(&bot).await),
            TelegramCall::Take { after, wait_secs } => Ok(self.take(&bot, after, wait_secs).await),
            TelegramCall::Send { send } => self.send(&bot, send).await,
            TelegramCall::File { key, offset } => self.piece(&bot, key.as_str(), offset).await,
        }
    }

    async fn node_state(&self, bot: &Bot, state: &State) -> TelegramNode {
        TelegramNode {
            fingerprint: state.fingerprint.clone(),
            bot: state.bot.clone(),
            paired: state.paired.clone(),
            pairing: state
                .pairing
                .as_ref()
                .is_some_and(|p| p.expires_ms > now_ms()),
            paused: state.paused,
            status: bot.status.lock().unwrap().clone(),
        }
    }

    async fn state_answer(&self, bot: &Bot) -> TelegramAnswer {
        let state = bot.state.lock().await;
        TelegramAnswer::State {
            state: self.node_state(bot, &state).await,
        }
    }

    /// getMe and the bot's photo, kept as the bot.
    async fn test(&self, bot: &Bot) -> TelegramAnswer {
        let me = match bot
            .api
            .call("getMe", json!({}), Duration::from_secs(20))
            .await
        {
            Ok(me) => me,
            Err(e) => {
                return TelegramAnswer::Tested {
                    bot: None,
                    error: Some(e.words()),
                };
            }
        };
        let (Some(id), Some(username)) = (me["id"].as_i64(), me["username"].as_str()) else {
            return TelegramAnswer::Tested {
                bot: None,
                error: Some("Telegram's answer named no bot".into()),
            };
        };
        let name = me["first_name"].as_str().unwrap_or(username);
        let photo = self.photo(bot, id).await;
        let found = TelegramBot {
            id: AnyInt::unchecked(id),
            username: Line::unchecked(username.chars().take(64).collect::<String>()),
            name: Line::new(name.chars().take(128).collect::<String>())
                .unwrap_or_else(|_| Line::unchecked(username.chars().take(64).collect::<String>())),
            photo: photo.map(Text::unchecked),
        };
        let mut state = bot.state.lock().await;
        state.bot = Some(found.clone());
        bot.save(&self.home, &state).await;
        TelegramAnswer::Tested {
            bot: Some(found),
            error: None,
        }
    }

    /// The bot's smallest profile photo as a data URL; none when it has none or it doesn't come.
    async fn photo(&self, bot: &Bot, id: i64) -> Option<String> {
        const MAX: usize = 48 * 1024;
        let photos = bot
            .api
            .call(
                "getUserProfilePhotos",
                json!({ "user_id": id, "limit": 1 }),
                Duration::from_secs(20),
            )
            .await
            .ok()?;
        let file_id = photos["photos"][0][0]["file_id"].as_str()?;
        let bytes = bot.api.file(file_id, MAX).await.ok()?;
        let mime = fleetd_contracts::mcp::AttachmentMime::of_image(&bytes)?;
        let mime = serde_json::to_value(mime).ok()?;
        Some(format!(
            "data:{};base64,{}",
            mime.as_str()?,
            B64.encode(bytes)
        ))
    }

    /// The events after `after`, waiting up to `wait_secs` for one; what the hub has taken (up to `after`) is dropped,
    /// with its files.
    async fn take(&self, bot: &Bot, after: i64, wait_secs: i64) -> TelegramAnswer {
        let mut seen = bot.seq.subscribe();
        {
            let mut state = bot.state.lock().await;
            let before = state.journal.len();
            let (taken, kept): (Vec<TelegramEvent>, Vec<TelegramEvent>) =
                std::mem::take(&mut state.journal)
                    .into_iter()
                    .partition(|e| e.seq <= after);
            state.journal = kept;
            if state.journal.len() != before {
                for e in &taken {
                    inbound::remove_files(&self.home, &bot.project, e);
                }
                bot.save(&self.home, &state).await;
            }
        }
        let deadline =
            tokio::time::Instant::now() + Duration::from_secs(wait_secs.clamp(0, 60) as u64);
        loop {
            {
                let state = bot.state.lock().await;
                let events: Vec<TelegramEvent> = state
                    .journal
                    .iter()
                    .filter(|e| e.seq > after)
                    .take(TAKE_MAX)
                    .cloned()
                    .collect();
                if !events.is_empty() || tokio::time::Instant::now() >= deadline {
                    return TelegramAnswer::Taken {
                        events,
                        state: self.node_state(bot, &state).await,
                    };
                }
            }
            let mut stop = bot.stop.subscribe();
            tokio::select! {
                _ = tokio::time::sleep_until(deadline) => {}
                _ = seen.changed() => {}
                _ = stop.changed() => {}
            }
            if *bot.stop.borrow() {
                let state = bot.state.lock().await;
                return TelegramAnswer::Taken {
                    events: Vec::new(),
                    state: self.node_state(bot, &state).await,
                };
            }
        }
    }

    async fn piece(&self, bot: &Bot, key: &str, offset: u64) -> Result<TelegramAnswer, String> {
        let Some(path) = store::file_path(&self.home, &bot.project, key) else {
            return Err("no such file".into());
        };
        let bytes = tokio::fs::read(&path)
            .await
            .map_err(|_| "that file is gone from this machine".to_owned())?;
        let start = (offset as usize).min(bytes.len());
        let end = (start + TELEGRAM_PIECE_BYTES).min(bytes.len());
        if end == bytes.len() {
            let _ = tokio::fs::remove_file(&path).await;
        }
        Ok(TelegramAnswer::Piece {
            bytes: bytes.len() as u64,
            data_b64: B64.encode(&bytes[start..end]),
        })
    }

    /// Sends to the paired account: the message ids Telegram gave.
    async fn send(&self, bot: &Bot, send: TelegramSend) -> Result<TelegramAnswer, String> {
        let chat = {
            let state = bot.state.lock().await;
            if state.paused {
                return Err("the Telegram bridge is paused".into());
            }
            match &state.paired {
                Some(p) => p.user_id.get(),
                None => return Err("no Telegram account is paired".into()),
            }
        };
        let sent = match send {
            TelegramSend::Text { html, buttons } => {
                let mut params = json!({
                    "chat_id": chat, "text": html, "parse_mode": "HTML",
                    "link_preview_options": { "is_disabled": true },
                });
                if !buttons.is_empty() {
                    params["reply_markup"] = keyboard(&buttons);
                }
                self.with_plain_fallback(bot, "sendMessage", params, "text")
                    .await?
            }
            TelegramSend::Edit {
                message_id,
                html,
                buttons,
            } => {
                let mut params = json!({
                    "chat_id": chat, "message_id": message_id, "text": html, "parse_mode": "HTML",
                    "link_preview_options": { "is_disabled": true },
                });
                // Without reply_markup, the buttons go.
                params["reply_markup"] = keyboard(&buttons);
                match self
                    .with_plain_fallback(bot, "editMessageText", params, "text")
                    .await
                {
                    // Already shows this: nothing to change.
                    Err(why) if why.contains("message is not modified") => json!(true),
                    other => other?,
                }
            }
            TelegramSend::File {
                name,
                mime,
                data_b64,
                caption_html,
                photo,
            } => {
                let bytes = B64
                    .decode(data_b64.as_bytes())
                    .map_err(|_| "the file isn't base64".to_owned())?;
                if bytes.len() > TELEGRAM_SEND_MAX {
                    return Err("the file is too large for Telegram".into());
                }
                let (method, field) = if photo {
                    ("sendPhoto", "photo")
                } else {
                    ("sendDocument", "document")
                };
                let mut fields = vec![("chat_id", chat.to_string())];
                if let Some(caption) = caption_html {
                    fields.push(("caption", caption));
                    fields.push(("parse_mode", "HTML".to_owned()));
                }
                let mut tried = 0;
                loop {
                    match bot
                        .api
                        .upload(method, &fields, field, &name, &mime, &bytes)
                        .await
                    {
                        Err(ApiError::RateLimited(s)) if tried == 0 && s <= SEND_WAIT_MAX => {
                            tried += 1;
                            tokio::time::sleep(Duration::from_secs(s)).await;
                        }
                        other => break other.map_err(|e| e.words())?,
                    }
                }
            }
            TelegramSend::Typing => self
                .retrying(
                    bot,
                    "sendChatAction",
                    json!({ "chat_id": chat, "action": "typing" }),
                )
                .await
                .map_err(|e| e.words())?,
            TelegramSend::Answer { callback_id, text } => {
                let mut params = json!({ "callback_query_id": callback_id });
                if let Some(text) = text {
                    params["text"] = Value::String(text);
                }
                self.retrying(bot, "answerCallbackQuery", params)
                    .await
                    .map_err(|e| e.words())?
            }
        };
        Ok(TelegramAnswer::Sent {
            message_ids: sent["message_id"].as_i64().into_iter().collect(),
        })
    }

    /// One call, waiting out one short rate limit.
    async fn retrying(&self, bot: &Bot, method: &str, params: Value) -> Result<Value, ApiError> {
        match bot
            .api
            .call(method, params.clone(), Duration::from_secs(30))
            .await
        {
            Err(ApiError::RateLimited(s)) if s <= SEND_WAIT_MAX => {
                tokio::time::sleep(Duration::from_secs(s)).await;
                bot.api.call(method, params, Duration::from_secs(30)).await
            }
            other => other,
        }
    }

    /// Sends HTML; when Telegram can't parse it, the same words once more as plain text.
    async fn with_plain_fallback(
        &self,
        bot: &Bot,
        method: &str,
        mut params: Value,
        field: &str,
    ) -> Result<Value, String> {
        match self.retrying(bot, method, params.clone()).await {
            Err(ApiError::Refused(why)) if why.contains("can't parse entities") => {
                let html = params[field].as_str().unwrap_or_default().to_owned();
                params[field] = Value::String(inbound::plain(&html));
                if let Some(o) = params.as_object_mut() {
                    o.remove("parse_mode");
                }
                self.retrying(bot, method, params)
                    .await
                    .map_err(|e| e.words())
            }
            other => other.map_err(|e| e.words()),
        }
    }

    /// The poller: getUpdates from the saved offset until stopped, each update handled and the offset saved after it.
    async fn poll(self: Arc<Self>, bot: Arc<Bot>) {
        let mut stop = bot.stop.subscribe();
        // A webhook makes getUpdates fail; the bridge never uses one.
        let _ = bot
            .api
            .call(
                "deleteWebhook",
                json!({ "drop_pending_updates": false }),
                Duration::from_secs(20),
            )
            .await;
        let mut backoff = self.timing.backoff_min;
        loop {
            if *stop.borrow() {
                return;
            }
            let (paused, offset) = {
                let state = bot.state.lock().await;
                (state.paused, state.offset)
            };
            if paused {
                bot.set_status(TelegramState::Paused, None, None);
                tokio::select! {
                    _ = bot.wake.notified() => {}
                    _ = stop.changed() => {}
                }
                continue;
            }
            let params = json!({
                "offset": offset,
                "timeout": self.timing.poll_secs,
                "allowed_updates": ["message", "callback_query"],
            });
            let wait = Duration::from_secs(self.timing.poll_secs + 15);
            let got = tokio::select! {
                got = bot.api.call("getUpdates", params, wait) => got,
                _ = stop.changed() => return,
            };
            let retry_in = match got {
                Ok(updates) => {
                    backoff = self.timing.backoff_min;
                    bot.set_status(TelegramState::Connected, None, None);
                    for update in updates.as_array().into_iter().flatten() {
                        if *stop.borrow() {
                            return;
                        }
                        self.handle(&bot, update).await;
                    }
                    continue;
                }
                Err(ApiError::RateLimited(s)) => {
                    let wait = Duration::from_secs(s);
                    bot.set_status(
                        TelegramState::Retrying,
                        Some(ApiError::RateLimited(s).words()),
                        Some(wait),
                    );
                    wait
                }
                Err(ApiError::Unauthorized) => {
                    bot.set_status(
                        TelegramState::Stopped,
                        Some(ApiError::Unauthorized.words()),
                        None,
                    );
                    // A new token starts a new poller; this one waits to be stopped.
                    let _ = stop.changed().await;
                    return;
                }
                Err(e) => {
                    let wait = backoff;
                    backoff = (backoff * 2).min(self.timing.backoff_max);
                    bot.set_status(TelegramState::Retrying, Some(e.words()), Some(wait));
                    wait
                }
            };
            tokio::select! {
                _ = tokio::time::sleep(retry_in) => {}
                _ = stop.changed() => return,
                _ = bot.wake.notified() => {}
            }
        }
    }

    /// One update: what it is decides what comes of it; the offset moves past it either way.
    async fn handle(&self, bot: &Bot, update: &Value) {
        let Some(id) = update["update_id"].as_i64() else {
            return;
        };
        let decided = {
            let state = bot.state.lock().await;
            inbound::decide(&state, update, now_ms())
        };
        let mut reply = None;
        let mut event = None;
        match decided {
            inbound::Decision::Drop => {}
            inbound::Decision::Reply(text) => reply = Some(text),
            inbound::Decision::Pair(person) => {
                event = Some(fleetd_contracts::telegram::TelegramEventKind::Paired {
                    person: person.clone(),
                });
                reply = Some(inbound::PAIRED);
                let mut state = bot.state.lock().await;
                state.paired = Some(person);
                state.pairing = None;
            }
            inbound::Decision::Button(kind) => event = Some(kind),
            inbound::Decision::Message(message) => {
                let (kind, said) =
                    inbound::fetch(&self.home, &bot.project, &bot.api, id, message).await;
                reply = said;
                event = kind;
            }
        }
        let mut state = bot.state.lock().await;
        if let Some(event) = event {
            state.seq += 1;
            let seq = state.seq;
            state.journal.push(TelegramEvent {
                seq,
                at: iso(now_ms()),
                event,
            });
            let over = state.journal.len().saturating_sub(store::JOURNAL_MAX);
            for e in state.journal.drain(..over).collect::<Vec<_>>() {
                inbound::remove_files(&self.home, &bot.project, &e);
            }
            bot.seq.send_replace(seq);
        }
        state.offset = state.offset.max(id + 1);
        bot.save(&self.home, &state).await;
        let chat = state.paired.as_ref().map(|p| p.user_id.get());
        drop(state);
        if let (Some(text), Some(chat)) = (reply, chat) {
            let params = json!({ "chat_id": chat, "text": text });
            if let Err(e) = self.retrying(bot, "sendMessage", params).await {
                tracing::warn!(project = %bot.project, "telegram: a reply didn't go: {}", e.words());
            }
        }
    }
}

/// Telegram's inline keyboard for button rows.
fn keyboard(rows: &[Vec<TelegramButton>]) -> Value {
    json!({
        "inline_keyboard": rows
            .iter()
            .map(|row| row
                .iter()
                .map(|b| json!({ "text": b.text, "callback_data": b.data }))
                .collect::<Vec<_>>())
            .collect::<Vec<_>>()
    })
}
