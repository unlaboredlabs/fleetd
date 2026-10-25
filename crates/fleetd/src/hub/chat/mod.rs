//! The lead chat: one conversation per project, the main surface. This module keeps the messages (in order, deduped,
//! announced as `chat.message`), the needs-you state (`chat.waiting`) and the streamed text of the lead's replies.
//! `flow` delivers a human's message to the lead and mirrors the lead's replies back; `history` reads what came
//! before the chat (orders, steers, the retired asks) into it once per project; `tools` serves the MCP tools.
pub mod flow;
pub mod history;
pub mod tools;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use fleetd_contracts::chat::{
    AttachmentRef, ChatAuthor, ChatClient, ChatDelivery, ChatDelta, ChatHistorySource, ChatItem,
    ChatMessage, ChatMessageEventData, ChatMessageId, ChatMessageState, ChatRequestId,
    CommandApprovalState, ProjectChatState, SecretRequestState,
};
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{ProjectRef, Timestamp};
use fleetd_contracts::prim::{Count, Line, List, Text, js_len};
use rusqlite::{OptionalExtension, params};
use tokio::sync::broadcast;

use crate::clock::Clock;
use crate::hub::store::{EventLog, HubDb, NewEvent, StoreError, iso_ms, now_ms};

/// Event data stays under the log's 2 KB; a larger message is read with chat_history.
const EVENT_MESSAGE_MAX: usize = 1800;

/// A message to add. `source` names the record it was read from (a lead message, a history row), so reading it
/// again adds nothing; `request` is a human's clientRequestId, so a resend returns the same message.
#[derive(Clone, Debug, Default)]
pub struct NewMessage {
    pub author: Option<ChatAuthor>,
    pub text: String,
    pub attachments: Vec<AttachmentRef>,
    pub streaming: bool,
    pub request: Option<String>,
    pub source: Option<String>,
    pub item: Option<ChatItem>,
    pub history: Option<ChatHistorySource>,
    pub remembered: Option<fleetd_contracts::memory::RememberedItem>,
    pub by: Option<String>,
    pub client: Option<ChatClient>,
    pub delivery: Option<ChatDelivery>,
    /// A human message not yet in the lead's session.
    pub held: bool,
    /// Defaults to now.
    pub created_ms: Option<i64>,
}

fn key(r: &ProjectRef) -> String {
    format!("{}/{}", r.machine_id, r.project_id)
}

fn text_of(s: &str) -> Text<0, { fleetd_contracts::chat::CHAT_TEXT_MAX }> {
    let mut cut = s;
    while js_len(cut) > fleetd_contracts::chat::CHAT_TEXT_MAX {
        cut = &cut[..cut.char_indices().next_back().map_or(0, |(i, _)| i)];
    }
    Text::unchecked(cut)
}

fn line(s: &str) -> Option<Line<1, 120>> {
    Line::new(s.chars().take(120).collect::<String>()).ok()
}

/// Whether a lead message asks the human something: a line that ends with a question mark (past any closing
/// markdown), or a numbered item with one, as the lead asks: "1. Ship it today? I'd say yes." The lead asks in chat,
/// in plain lines; this is how the chat knows it waits.
pub fn asks_question(text: &str) -> bool {
    text.lines().any(|l| {
        let l = l.trim();
        let numbered = l.split_once(['.', ')']).is_some_and(|(n, _)| {
            !n.is_empty() && n.len() <= 2 && n.chars().all(|c| c.is_ascii_digit())
        });
        (numbered && l.contains('?'))
            || l.trim_end_matches(|c: char| {
                c.is_whitespace() || matches!(c, '*' | '_' | '`' | ')' | '"')
            })
            .ends_with('?')
    })
}

fn item_open(item: &ChatItem) -> bool {
    match item {
        ChatItem::SecretRequest(s) => s.state == SecretRequestState::Open,
        ChatItem::CommandApproval(c) => c.state == CommandApprovalState::Open,
    }
}

/// The needs-you rule: an inline item waits for an answer, or any lead message since the human last wrote asks
/// something. A question stays asked through the lead's later status lines and fleetd's own lines, and while the lead
/// works; only the human's reply clears it. History and a reply still streaming don't count.
pub fn needs_you(messages: &[ChatMessage]) -> bool {
    if messages
        .iter()
        .any(|m| m.item.as_ref().is_some_and(item_open))
    {
        return true;
    }
    let since = messages
        .iter()
        .rposition(|m| m.author == ChatAuthor::Human && m.history.is_none())
        .map_or(0, |i| i + 1);
    messages[since..].iter().any(|m| {
        m.author == ChatAuthor::Lead
            && m.history.is_none()
            && m.state == ChatMessageState::Final
            && asks_question(&m.text)
    })
}

pub struct Chat {
    db: Arc<HubDb>,
    events: Arc<EventLog>,
    clock: Arc<dyn Clock>,
    deltas: broadcast::Sender<ChatDelta>,
    /// What `chat.waiting` last said per project, so it fires only on a change.
    said: Mutex<HashMap<String, (bool, bool)>>,
    /// One history read per project at a time.
    reading: tokio::sync::Mutex<()>,
    /// When each agent key wrote its messages of the last minute.
    agent_sends: Mutex<HashMap<String, Vec<i64>>>,
}

impl Chat {
    pub fn new(db: Arc<HubDb>, events: Arc<EventLog>, clock: Arc<dyn Clock>) -> Arc<Self> {
        let (deltas, _) = broadcast::channel(256);
        Arc::new(Self {
            db,
            events,
            clock,
            deltas,
            said: Mutex::default(),
            reading: tokio::sync::Mutex::new(()),
            agent_sends: Mutex::default(),
        })
    }

    fn now(&self) -> i64 {
        now_ms(self.clock.as_ref())
    }

    /// Counts a new message from agent key `key_id` and says whether it is within the minute's allowance.
    pub fn allow_agent(&self, key_id: &str) -> bool {
        let now = self.now();
        let mut sends = self.agent_sends.lock().unwrap();
        sends.retain(|_, at| {
            at.retain(|t| now - t < 60_000);
            !at.is_empty()
        });
        let at = sends.entry(key_id.to_owned()).or_default();
        if at.len() >= flow::AGENT_PER_MINUTE {
            return false;
        }
        at.push(now);
        true
    }

    /// Every streamed append, for the app connections subscribed to a chat.
    pub fn subscribe(&self) -> broadcast::Receiver<ChatDelta> {
        self.deltas.subscribe()
    }

    /// Whether the project's history was read in already.
    pub fn history_read(&self, r: &ProjectRef) -> Result<bool, StoreError> {
        self.db.with(|c| {
            Ok(c.query_row(
                "SELECT 1 FROM chat_projects WHERE machine_id = ?1 AND project_id = ?2",
                params![r.machine_id.as_str(), r.project_id.as_str()],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
        })
    }

    /// Reads the project's past into the chat once: `entries` in time order, then the mark. Concurrent callers wait;
    /// the second finds the mark and adds nothing.
    pub async fn read_history<F, Fut>(&self, r: &ProjectRef, entries: F) -> Result<(), StoreError>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Vec<NewMessage>>,
    {
        if self.history_read(r)? {
            return Ok(());
        }
        let _held = self.reading.lock().await;
        if self.history_read(r)? {
            return Ok(());
        }
        let mut entries = entries().await;
        entries.sort_by_key(|e| e.created_ms.unwrap_or(0));
        for e in entries {
            self.insert_quiet(r, e)?;
        }
        let now = self.now();
        self.db.with(|c| {
            c.execute(
                "INSERT OR IGNORE INTO chat_projects (machine_id, project_id, history_ms) VALUES (?1, ?2, ?3)",
                params![r.machine_id.as_str(), r.project_id.as_str(), now],
            )?;
            Ok(())
        })
    }

    /// When the project's history was read: messages of records older than this are history.
    pub fn history_ms(&self, r: &ProjectRef) -> Result<Option<i64>, StoreError> {
        self.db.with(|c| {
            Ok(c.query_row(
                "SELECT history_ms FROM chat_projects WHERE machine_id = ?1 AND project_id = ?2",
                params![r.machine_id.as_str(), r.project_id.as_str()],
                |row| row.get(0),
            )
            .optional()?)
        })
    }

    /// Adds a message without announcing it; the same request or source returns the stored one. True when new.
    fn insert_quiet(
        &self,
        r: &ProjectRef,
        new: NewMessage,
    ) -> Result<(ChatMessage, bool), StoreError> {
        let created_ms = new.created_ms.unwrap_or_else(|| self.now());
        self.db.transaction(|c| {
            let existing: Option<String> = c
                .query_row(
                    "SELECT data FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2
                     AND ((request IS NOT NULL AND request = ?3) OR (source IS NOT NULL AND source = ?4))",
                    params![
                        r.machine_id.as_str(),
                        r.project_id.as_str(),
                        new.request,
                        new.source
                    ],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(data) = existing {
                return Ok((serde_json::from_str(&data)?, false));
            }
            let seq: i64 = c.query_row(
                "SELECT COALESCE(MAX(seq), 0) + 1 FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2",
                params![r.machine_id.as_str(), r.project_id.as_str()],
                |row| row.get(0),
            )?;
            c.execute(
                "INSERT INTO chat_messages (machine_id, project_id, seq, created_ms, request, source, held, data)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '{}')",
                params![
                    r.machine_id.as_str(),
                    r.project_id.as_str(),
                    seq,
                    created_ms,
                    new.request,
                    new.source,
                    new.held
                ],
            )?;
            let n = c.last_insert_rowid();
            let message = ChatMessage {
                message_id: ChatMessageId::unchecked(format!("m{n}")),
                project_ref: r.clone(),
                seq: Count::unchecked(seq),
                author: new.author.unwrap_or(ChatAuthor::System),
                text: text_of(&new.text),
                attachments: List::unchecked(new.attachments.into_iter().take(8).collect()),
                created_at: iso_ms(created_ms).into(),
                updated_at: None,
                state: if new.streaming {
                    ChatMessageState::Streaming
                } else {
                    ChatMessageState::Final
                },
                client_request_id: new
                    .request
                    .as_deref()
                    .and_then(|r| fleetd_contracts::prim::NonEmpty::new(r).ok()),
                delivery: new.delivery,
                by: new.by.as_deref().and_then(line),
                client: new.client,
                item: new.item,
                history: new.history,
                remembered: new.remembered,
            };
            c.execute(
                "UPDATE chat_messages SET data = ?1 WHERE n = ?2",
                params![serde_json::to_string(&message)?, n],
            )?;
            Ok((message, true))
        })
    }

    /// Adds a message and announces it. The same request or source returns the stored message, announced once.
    pub fn add(&self, r: &ProjectRef, new: NewMessage) -> Result<(ChatMessage, bool), StoreError> {
        let (message, created) = self.insert_quiet(r, new)?;
        if created {
            self.announce(&message)?;
        }
        Ok((message, created))
    }

    /// One author=system line, for fleetd's own events in a project's chat.
    pub fn system_line(&self, r: &ProjectRef, text: &str) -> Result<ChatMessage, StoreError> {
        Ok(self
            .add(
                r,
                NewMessage {
                    author: Some(ChatAuthor::System),
                    text: text.to_owned(),
                    ..Default::default()
                },
            )?
            .0)
    }

    /// An inline item (a secret to enter, a command to approve) as a lead message.
    pub fn item(&self, r: &ProjectRef, item: ChatItem) -> Result<ChatMessage, StoreError> {
        let source = format!("item:{}", item_request(&item));
        Ok(self
            .add(
                r,
                NewMessage {
                    author: Some(ChatAuthor::Lead),
                    item: Some(item),
                    source: Some(source),
                    ..Default::default()
                },
            )?
            .0)
    }

    /// An item's new state, in place.
    pub fn update_item(
        &self,
        request_id: &ChatRequestId,
        item: ChatItem,
    ) -> Result<Option<ChatMessage>, StoreError> {
        let source = format!("item:{request_id}");
        let Some(mut message) = self.by_source_anywhere(&source)? else {
            return Ok(None);
        };
        if message.item.as_ref() == Some(&item) {
            return Ok(Some(message));
        }
        message.item = Some(item);
        message.updated_at = Some(self.now_ts());
        self.put(&message)?;
        self.announce(&message)?;
        Ok(Some(message))
    }

    /// A remembered line's new state, in place.
    pub fn set_remembered(
        &self,
        mut message: ChatMessage,
        remembered: fleetd_contracts::memory::RememberedItem,
    ) -> Result<ChatMessage, StoreError> {
        message.remembered = Some(remembered);
        message.updated_at = Some(self.now_ts());
        self.put(&message)?;
        self.announce(&message)?;
        Ok(message)
    }

    fn now_ts(&self) -> Timestamp {
        iso_ms(self.now()).into()
    }

    /// The message a human's request stored, if any.
    pub fn by_request(
        &self,
        r: &ProjectRef,
        request: &str,
    ) -> Result<Option<ChatMessage>, StoreError> {
        self.db.with(|c| {
            let data: Option<String> = c
                .query_row(
                    "SELECT data FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2 AND request = ?3",
                    params![r.machine_id.as_str(), r.project_id.as_str(), request],
                    |row| row.get(0),
                )
                .optional()?;
            Ok(data.map(|d| serde_json::from_str(&d)).transpose()?)
        })
    }

    /// A human message waits for the project's lead to start.
    pub fn hold(&self, message: &ChatMessage) -> Result<(), StoreError> {
        self.set_held(message, true)
    }

    /// The held message went to the lead.
    pub fn release(&self, message: &ChatMessage) -> Result<(), StoreError> {
        self.set_held(message, false)
    }

    fn set_held(&self, message: &ChatMessage, held: bool) -> Result<(), StoreError> {
        let n: i64 = message.message_id.as_str()[1..].parse().unwrap_or(0);
        self.db.with(|c| {
            c.execute(
                "UPDATE chat_messages SET held = ?1 WHERE n = ?2",
                params![held, n],
            )?;
            Ok(())
        })
    }

    pub fn is_held(&self, message: &ChatMessage) -> Result<bool, StoreError> {
        let n: i64 = message.message_id.as_str()[1..].parse().unwrap_or(0);
        self.db.with(|c| {
            Ok(
                c.query_row("SELECT held FROM chat_messages WHERE n = ?1", [n], |row| {
                    row.get(0)
                })
                .optional()?
                .unwrap_or(false),
            )
        })
    }

    /// A message by its id ("m<n>").
    pub fn by_id(&self, id: &str) -> Result<Option<ChatMessage>, StoreError> {
        let n: i64 = id
            .strip_prefix('m')
            .and_then(|n| n.parse().ok())
            .unwrap_or(0);
        self.db.with(|c| {
            let data: Option<String> = c
                .query_row("SELECT data FROM chat_messages WHERE n = ?1", [n], |row| {
                    row.get(0)
                })
                .optional()?;
            Ok(data.map(|d| serde_json::from_str(&d)).transpose()?)
        })
    }

    /// The requests whose inline item still reads open or approved: the ones a missed event could leave stale.
    pub fn unsettled_requests(&self) -> Result<Vec<String>, StoreError> {
        self.db.with(|c| {
            Ok(c.prepare_cached(
                "SELECT DISTINCT json_extract(data, '$.item.requestId') FROM chat_messages
                     WHERE json_extract(data, '$.item.state') IN ('open', 'approved')",
            )?
            .query_map([], |row| row.get::<_, Option<String>>(0))?
            .filter_map(|r| r.ok().flatten())
            .collect())
        })
    }

    /// The projects with a held message.
    pub fn held_projects(&self) -> Result<Vec<ProjectRef>, StoreError> {
        self.db.with(|c| {
            let rows: Vec<(String, String)> = c
                .prepare_cached(
                    "SELECT DISTINCT machine_id, project_id FROM chat_messages WHERE held = 1",
                )?
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?;
            Ok(rows
                .into_iter()
                .map(|(m, p)| ProjectRef {
                    machine_id: fleetd_contracts::ids::MachineId::unchecked(m),
                    project_id: fleetd_contracts::ids::ProjectId::unchecked(p),
                })
                .collect())
        })
    }

    /// The project's held messages, oldest first.
    pub fn held(&self, r: &ProjectRef) -> Result<Vec<ChatMessage>, StoreError> {
        self.db.with(|c| {
            let rows: Vec<String> = c
                .prepare_cached(
                    "SELECT data FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2 AND held = 1 ORDER BY seq",
                )?
                .query_map(params![r.machine_id.as_str(), r.project_id.as_str()], |row| {
                    row.get(0)
                })?
                .collect::<rusqlite::Result<_>>()?;
            Ok(rows
                .into_iter()
                .filter_map(|d| serde_json::from_str(&d).ok())
                .collect())
        })
    }

    /// The project's messages still streaming whose source starts with `prefix`.
    pub fn streaming_from(
        &self,
        r: &ProjectRef,
        prefix: &str,
    ) -> Result<Vec<ChatMessage>, StoreError> {
        self.db.with(|c| {
            let rows: Vec<String> = c
                .prepare_cached(
                    "SELECT data FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2
                     AND substr(source, 1, length(?3)) = ?3 AND json_extract(data, '$.state') = 'streaming'
                     ORDER BY seq",
                )?
                .query_map(
                    params![r.machine_id.as_str(), r.project_id.as_str(), prefix],
                    |row| row.get(0),
                )?
                .collect::<rusqlite::Result<_>>()?;
            Ok(rows
                .into_iter()
                .filter_map(|d| serde_json::from_str(&d).ok())
                .collect())
        })
    }

    pub fn put(&self, message: &ChatMessage) -> Result<(), StoreError> {
        let n: i64 = message.message_id.as_str()[1..].parse().unwrap_or(0);
        self.db.with(|c| {
            c.execute(
                "UPDATE chat_messages SET data = ?1 WHERE n = ?2",
                params![serde_json::to_string(message)?, n],
            )?;
            Ok(())
        })
    }

    fn by_source_anywhere(&self, source: &str) -> Result<Option<ChatMessage>, StoreError> {
        self.db.with(|c| {
            let data: Option<String> = c
                .query_row(
                    "SELECT data FROM chat_messages WHERE source = ?1 ORDER BY n DESC LIMIT 1",
                    [source],
                    |row| row.get(0),
                )
                .optional()?;
            Ok(data.map(|d| serde_json::from_str(&d)).transpose()?)
        })
    }

    pub fn by_source(
        &self,
        r: &ProjectRef,
        source: &str,
    ) -> Result<Option<ChatMessage>, StoreError> {
        self.db.with(|c| {
            let data: Option<String> = c
                .query_row(
                    "SELECT data FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2 AND source = ?3",
                    params![r.machine_id.as_str(), r.project_id.as_str(), source],
                    |row| row.get(0),
                )
                .optional()?;
            Ok(data.map(|d| serde_json::from_str(&d)).transpose()?)
        })
    }

    /// Appends streamed text to a streaming message and sends it to subscribers, with the length it had before.
    pub fn append(&self, message: &mut ChatMessage, append: &str) -> Result<(), StoreError> {
        if append.is_empty() {
            return Ok(());
        }
        // The turn may have ended (and the message been finished) since the caller read it.
        match self.by_id(message.message_id.as_str())? {
            Some(now) if now.state == ChatMessageState::Streaming => *message = now,
            _ => return Ok(()),
        }
        let offset = js_len(message.text.as_str());
        message.text = text_of(&format!("{}{append}", message.text.as_str()));
        message.updated_at = Some(self.now_ts());
        self.put(message)?;
        let mut rest = append;
        let mut at = offset;
        // Frames carry at most 4000 UTF-16 units.
        while !rest.is_empty() {
            let mut cut = rest.len();
            while js_len(&rest[..cut]) > 4000 {
                cut = rest[..cut].char_indices().next_back().map_or(0, |(i, _)| i);
            }
            let part = &rest[..cut];
            let _ = self.deltas.send(ChatDelta {
                project_ref: message.project_ref.clone(),
                message_id: message.message_id.clone(),
                seq: message.seq,
                offset: Count::unchecked(at as i64),
                append: Text::unchecked(part),
            });
            at += js_len(part);
            rest = &rest[cut..];
        }
        Ok(())
    }

    /// A streamed message is complete: its final text, announced.
    pub fn finish(&self, message: &mut ChatMessage, text: &str) -> Result<(), StoreError> {
        message.text = text_of(text);
        message.state = ChatMessageState::Final;
        message.updated_at = Some(self.now_ts());
        self.put(message)?;
        self.announce(message)
    }

    /// The project's title, as everything a person reads names it; never its id.
    fn title(&self, r: &ProjectRef) -> Result<Option<String>, StoreError> {
        self.db.with(|c| {
            Ok(c.prepare_cached(
                "SELECT json_extract(data, '$.title') FROM projects WHERE machine_id = ?1 AND project_id = ?2",
            )?
            .query_row(params![r.machine_id.as_str(), r.project_id.as_str()], |row| {
                row.get::<_, Option<String>>(0)
            })
            .optional()?
            .flatten()
            .filter(|t| !t.trim().is_empty()))
        })
    }

    fn announce(&self, message: &ChatMessage) -> Result<(), StoreError> {
        let r = &message.project_ref;
        let full = serde_json::to_string(message)?;
        let data = ChatMessageEventData {
            project_ref: r.clone(),
            message_id: message.message_id.clone(),
            seq: message.seq,
            author: message.author,
            state: message.state,
            message: (full.len() <= EVENT_MESSAGE_MAX).then(|| message.clone()),
        };
        let who = match message.author {
            ChatAuthor::Human => "You",
            ChatAuthor::Lead => "The lead",
            ChatAuthor::Agent => "An agent",
            _ => "fleetd",
        };
        self.events.append(NewEvent {
            at: self.now_ts(),
            r#type: HubEventType::ChatMessage,
            machine_id: Some(r.machine_id.clone()),
            project_id: Some(r.project_id.clone()),
            thread_id: None,
            summary: match self.title(r)? {
                Some(title) => format!(
                    "{who} in the chat of {}",
                    title.chars().take(60).collect::<String>()
                ),
                None => format!("{who} in a project's chat"),
            },
            data: Some(serde_json::to_value(data)?),
            attention: None,
        })?;
        Ok(())
    }

    /// A page of the chat, oldest first, and whether more lies before and after it.
    pub fn page(
        &self,
        r: &ProjectRef,
        before: Option<i64>,
        after: Option<i64>,
        limit: usize,
    ) -> Result<(Vec<ChatMessage>, bool, bool), StoreError> {
        let limit = limit.clamp(1, fleetd_contracts::chat::CHAT_PAGE_MAX) as i64;
        self.db.with(|c| {
            let (m, p) = (r.machine_id.as_str(), r.project_id.as_str());
            let rows: Vec<(i64, String)> = if let Some(after) = after {
                c.prepare_cached(
                    "SELECT seq, data FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2 AND seq > ?3
                     AND seq < ?4 ORDER BY seq ASC LIMIT ?5",
                )?
                .query_map(params![m, p, after, before.unwrap_or(i64::MAX), limit], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })?
                .collect::<rusqlite::Result<_>>()?
            } else {
                let mut rows: Vec<(i64, String)> = c
                    .prepare_cached(
                        "SELECT seq, data FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2 AND seq < ?3
                         ORDER BY seq DESC LIMIT ?4",
                    )?
                    .query_map(params![m, p, before.unwrap_or(i64::MAX), limit], |row| {
                        Ok((row.get(0)?, row.get(1)?))
                    })?
                    .collect::<rusqlite::Result<_>>()?;
                rows.reverse();
                rows
            };
            let last: i64 = c.query_row(
                "SELECT COALESCE(MAX(seq), 0) FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2",
                params![m, p],
                |row| row.get(0),
            )?;
            let first_seq = rows.first().map(|(s, _)| *s);
            let last_seq = rows.last().map(|(s, _)| *s);
            let more_before = match first_seq {
                Some(s) => s > 1,
                None => after.is_some_and(|a| a > 0) && last > 0,
            };
            let more_after = match last_seq {
                Some(s) => s < last,
                None => before.is_some_and(|b| b <= last),
            };
            let messages = rows
                .into_iter()
                .map(|(_, d)| serde_json::from_str(&d))
                .collect::<Result<Vec<ChatMessage>, _>>()?;
            Ok((messages, more_before, more_after))
        })
    }

    /// The project's chat state; `lead_working` is the lead's own (the flow reads it off its thread).
    pub fn state(
        &self,
        r: &ProjectRef,
        lead_working: bool,
    ) -> Result<ProjectChatState, StoreError> {
        let (recent, _, _) = self.page(r, None, None, 1)?;
        // Everything since the human's last message (however many status lines followed), and every open item.
        let mut considered = self.since_human(r)?;
        considered.extend(self.open_items(r)?);
        let last = recent.last();
        Ok(ProjectChatState {
            project_ref: r.clone(),
            needs_you: needs_you(&considered),
            lead_working,
            last_seq: last.map_or_else(Count::default, |m| m.seq),
            last_message_at: last.map(|m| m.created_at.clone()),
        })
    }

    /// The lead's messages after the human's last one written in the chat, oldest first. History is left out: on a
    /// migrated project the human has not written in yet, that would be the whole past on every state read.
    pub(super) fn since_human(&self, r: &ProjectRef) -> Result<Vec<ChatMessage>, StoreError> {
        self.db.with(|c| {
            let (m, p) = (r.machine_id.as_str(), r.project_id.as_str());
            let after: i64 = c.query_row(
                "SELECT COALESCE(MAX(seq), 0) FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2
                 AND json_extract(data, '$.author') = 'human' AND json_extract(data, '$.history') IS NULL",
                params![m, p],
                |row| row.get(0),
            )?;
            let rows: Vec<String> = c
                .prepare_cached(
                    "SELECT data FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2 AND seq > ?3
                     AND json_extract(data, '$.author') = 'lead' AND json_extract(data, '$.history') IS NULL
                     ORDER BY seq",
                )?
                .query_map(params![m, p, after], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            Ok(rows
                .into_iter()
                .filter_map(|d| serde_json::from_str(&d).ok())
                .collect())
        })
    }

    fn open_items(&self, r: &ProjectRef) -> Result<Vec<ChatMessage>, StoreError> {
        self.db.with(|c| {
            let rows: Vec<String> = c
                .prepare_cached(
                    "SELECT data FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2
                     AND json_extract(data, '$.item.state') = 'open' ORDER BY seq LIMIT 20",
                )?
                .query_map(
                    params![r.machine_id.as_str(), r.project_id.as_str()],
                    |row| row.get(0),
                )?
                .collect::<rusqlite::Result<_>>()?;
            Ok(rows
                .into_iter()
                .filter_map(|d| serde_json::from_str(&d).ok())
                .collect())
        })
    }

    /// Announces `chat.waiting` when the project's needs-you or working state changed since it last did.
    pub fn tell_state(&self, state: &ProjectChatState) -> Result<(), StoreError> {
        let now = (state.needs_you, state.lead_working);
        let k = key(&state.project_ref);
        if self.said.lock().unwrap().insert(k, now) == Some(now) {
            return Ok(());
        }
        let r = &state.project_ref;
        self.events.append(NewEvent {
            at: self.now_ts(),
            r#type: HubEventType::ChatWaiting,
            machine_id: Some(r.machine_id.clone()),
            project_id: Some(r.project_id.clone()),
            thread_id: None,
            summary: if state.needs_you {
                "The lead waits on you".into()
            } else if state.lead_working {
                "The lead is working".into()
            } else {
                "The lead is idle".into()
            },
            data: Some(serde_json::to_value(state)?),
            attention: None,
        })?;
        Ok(())
    }
}

fn item_request(item: &ChatItem) -> &str {
    match item {
        ChatItem::SecretRequest(s) => s.request_id.as_str(),
        ChatItem::CommandApproval(c) => c.request_id.as_str(),
    }
}

#[cfg(test)]
mod tests;
