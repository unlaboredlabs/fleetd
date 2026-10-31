//! The hub's half of each Telegram bridge, from the hub's start until it stops.
//!
//! In: one long `take` after another on the Navi's node ([`take_once`]). A message becomes the owner's own message in
//! the Navi's chat, marked as from Telegram (a forward with who it came from, which the lead reads as untrusted), its
//! photo or file pulled from the node into the chat's attachments. Approve or Deny on a card answers the request as the
//! owner; a choice on a question block is their reply. The journal seq handled is kept, so nothing comes in twice.
//!
//! Out: whatever the Navi says in its chat after the bridge's last sent seq ([`send_once`]): its replies as Telegram
//! HTML (split when long) with their images and files, approval cards with exactly what approving runs and Approve /
//! Deny buttons, and a line pointing to the app for a secret. A card is edited once the request is answered, wherever
//! that was. While the Navi works on a message sent from Telegram, the chat there shows "typing…".
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::blocks::BlockBody;
use fleetd_contracts::chat::{
    ChatAuthor, ChatClient, ChatItem, ChatMessage, ChatMessageId, ChatMessageState, ChatReplyTo,
    CommandApprovalState, SecretRequestState,
};
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::ledger::RequestState;
use fleetd_contracts::mcp::{AttachmentId, AttachmentMime, ErrorCode};
use fleetd_contracts::prim::Count;
use fleetd_contracts::telegram::{
    TELEGRAM_SEND_MAX, TELEGRAM_TAKE_WAIT_SECS, TelegramAnswer, TelegramBridge, TelegramButton,
    TelegramCall, TelegramEvent, TelegramEventKind, TelegramFile, TelegramSend,
};
use rusqlite::params;
use tokio::sync::Notify;
use tokio::task::JoinHandle;

use super::format;
use super::{Row, merged, node_call, put_bridge, row, rows, set_sent, set_taken};
use crate::hub::api::{Hub, ToolError};
use crate::hub::store::{StoreError, now_ms, parse_ms};

/// A reply older than this when the bridge could send it stays in the app: Telegram would get a day's backlog.
const STALE_MS: i64 = 3600 * 1000;
/// A reply still streaming this long is passed over.
const STREAM_STUCK_MS: i64 = 10 * 60 * 1000;
/// "typing…" lasts five seconds on Telegram: sent again this often while the Navi works.
const TYPING_EVERY_MS: i64 = 4500;
/// Typing shows while the Navi works on a Telegram message at most this long after it came.
const TYPING_FOR_MS: i64 = 10 * 60 * 1000;
/// A message that fails this often is passed over, so one Telegram refuses doesn't hold up the rest.
const TRIES: u32 = 3;
const SEND_WAIT: Duration = Duration::from_secs(60);
const CALL_WAIT: Duration = Duration::from_secs(30);
/// Back off this long when a take fails (the node offline or too old).
const TAKE_RETRY: Duration = Duration::from_secs(5);

/// The bridges' shared state on the hub.
#[derive(Default)]
pub struct Bridges {
    wake: Notify,
    /// When each bridge last sent "typing…".
    typing: Mutex<HashMap<ProjectRef, i64>>,
    /// The seq each bridge is stuck on, and how often it failed.
    tries: Mutex<HashMap<ProjectRef, (i64, u32)>>,
}

impl Bridges {
    /// Something changed (a bridge set up, paused or removed, a card answered): look again now.
    pub fn wake(&self) {
        self.wake.notify_waiters();
    }
}

/// Runs every bridge until the hub stops.
pub async fn run(hub: Arc<Hub>) {
    let mut takers: HashMap<ProjectRef, JoinHandle<()>> = HashMap::new();
    let mut head = hub.events.subscribe();
    loop {
        head.borrow_and_update();
        let all = rows(&hub.db).unwrap_or_else(|e| {
            tracing::warn!(error = %e, "telegram: bridges not read");
            Vec::new()
        });
        takers.retain(|r, h| {
            let keep = all.iter().any(|row| &row.navi == r) && !h.is_finished();
            if !keep {
                h.abort();
            }
            keep
        });
        for row in &all {
            takers.entry(row.navi.clone()).or_insert_with(|| {
                let (hub, r) = (hub.clone(), row.navi.clone());
                tokio::spawn(async move { follow(hub, r).await })
            });
        }
        for row in &all {
            if let Err(e) = send_once(&hub, &row.navi).await {
                tracing::debug!(navi = %row.navi.project_id, "telegram: not sent yet: {}", e.message);
            }
            typing(&hub, row).await;
        }
        tokio::select! {
            () = hub.shutdown.wait() => {
                for (_, h) in takers {
                    h.abort();
                }
                return;
            }
            _ = head.changed() => {}
            () = hub.telegram.wake.notified() => {}
            () = hub.clock.sleep(Duration::from_secs(2)) => {}
        }
    }
}

/// Takes from one bridge's journal until the hub stops or the bridge goes.
async fn follow(hub: Arc<Hub>, r: ProjectRef) {
    loop {
        match take_once(&hub, &r, TELEGRAM_TAKE_WAIT_SECS).await {
            Ok(Some(_)) => {}
            Ok(None) => return,
            Err(e) => {
                tracing::debug!(navi = %r.project_id, "telegram: take: {}", e.message);
                tokio::select! {
                    () = hub.shutdown.wait() => return,
                    () = hub.clock.sleep(TAKE_RETRY) => {}
                }
            }
        }
    }
}

/// One take: what came in since the last one, handled in order. How many; none when the bridge is gone.
pub async fn take_once(
    hub: &Arc<Hub>,
    r: &ProjectRef,
    wait_secs: i64,
) -> Result<Option<usize>, ToolError> {
    let Some(before) = row(&hub.db, r)? else {
        return Ok(None);
    };
    let answer = node_call(
        hub,
        r,
        TelegramCall::Take {
            after: before.taken,
            wait_secs,
        },
        Duration::from_secs(wait_secs as u64 + 15),
    )
    .await?;
    let TelegramAnswer::Taken { events, state } = answer else {
        return Err(ToolError::new(
            ErrorCode::Failed,
            "The node's answer to take was no journal.",
        ));
    };
    // The token may have been replaced meanwhile: that bridge's row is a new one.
    let Some(now) = row(&hub.db, r)? else {
        return Ok(None);
    };
    if state.fingerprint.as_ref() != Some(&now.bridge.fingerprint) {
        return Ok(Some(0));
    }
    let bridge = merged(&now.bridge, &state);
    if bridge != now.bridge {
        put_bridge(&hub.db, r, &bridge)?;
    }
    let n = events.len();
    for e in events.into_iter().filter(|e| e.seq > now.taken) {
        handle(hub, r, &bridge, &e).await?;
        set_taken(&hub.db, r, e.seq)?;
    }
    Ok(Some(n))
}

fn owner(hub: &Hub, r: &ProjectRef) -> Option<fleetd_contracts::people::PersonRef> {
    let owner = crate::hub::navi::of(&hub.db, r).ok()??.owner?;
    crate::hub::people::People::new(hub.db.clone(), hub.clock.clone())
        .person_ref(&owner)
        .ok()?
}

async fn handle(
    hub: &Arc<Hub>,
    r: &ProjectRef,
    bridge: &TelegramBridge,
    e: &TelegramEvent,
) -> Result<(), ToolError> {
    match &e.event {
        TelegramEventKind::Message {
            text,
            forwarded_from,
            files,
            ..
        } => {
            let mut ids = Vec::new();
            let mut missing = Vec::new();
            for f in files {
                match pull(hub, r, f).await {
                    Ok(id) => ids.push(id),
                    Err(why) => {
                        tracing::warn!(navi = %r.project_id, "telegram: {} not kept: {}", f.name, why.message);
                        missing.push(f.name.clone());
                    }
                }
            }
            let mut text = text.clone();
            if !missing.is_empty() {
                text.push_str(&format!(
                    "\n\n[Sent on Telegram, but it didn't arrive: {}]",
                    missing.join(", ")
                ));
            }
            if text.trim().is_empty() && ids.is_empty() {
                return Ok(());
            }
            crate::hub::chat::flow::send_from_telegram(
                hub,
                r,
                crate::hub::chat::flow::FromTelegram {
                    text,
                    attachments: ids,
                    forwarded_from: forwarded_from.clone(),
                    reply_to: None,
                    person: owner(hub, r),
                    request: format!("telegram:{}:{}", e.seq, e.at.as_str()),
                },
            )
            .await?;
        }
        TelegramEventKind::Button {
            callback_id,
            data,
            message_id,
        } => {
            let said = press(hub, r, data, *message_id, &e.seq, e.at.as_str()).await;
            let _ = node_call(
                hub,
                r,
                TelegramCall::Send {
                    send: TelegramSend::Answer {
                        callback_id: callback_id.clone(),
                        text: Some(said),
                    },
                },
                CALL_WAIT,
            )
            .await;
            hub.telegram.wake();
        }
        TelegramEventKind::Paired { person } => {
            // What the Navi said before the pairing stays in the app: Telegram picks up from here.
            set_sent(&hub.db, r, super::chat_head(&hub.db, r)?)?;
            let handle = person
                .username
                .as_ref()
                .map(|u| format!(" (@{})", u.as_str()))
                .unwrap_or_default();
            let bot = bridge
                .bot
                .as_ref()
                .map(|b| format!(" through @{}", b.username.as_str()))
                .unwrap_or_default();
            hub.chat.system_line(
                r,
                &format!(
                    "Telegram paired with {}{handle}{bot}: messages there reach this Navi, and its replies go there too.",
                    person.name.as_str()
                ),
            )?;
        }
    }
    Ok(())
}

/// A file that came in, pulled from the node in pieces into the chat's attachments.
async fn pull(hub: &Hub, r: &ProjectRef, f: &TelegramFile) -> Result<AttachmentId, ToolError> {
    let mut data = Vec::new();
    loop {
        let answer = node_call(
            hub,
            r,
            TelegramCall::File {
                key: f.key.clone(),
                offset: data.len() as u64,
            },
            CALL_WAIT,
        )
        .await?;
        let TelegramAnswer::Piece { bytes, data_b64 } = answer else {
            return Err(ToolError::new(
                ErrorCode::Failed,
                "The node sent no piece of the file.",
            ));
        };
        let piece = B64
            .decode(data_b64.as_bytes())
            .map_err(|_| ToolError::new(ErrorCode::Failed, "The file's piece isn't base64."))?;
        if piece.is_empty() && (data.len() as u64) < bytes
            || bytes > fleetd_contracts::telegram::TELEGRAM_FILE_MAX as u64
        {
            return Err(ToolError::new(
                ErrorCode::Failed,
                "The file changed while it was read.",
            ));
        }
        data.extend_from_slice(&piece);
        if data.len() as u64 >= bytes {
            break;
        }
    }
    // The node judged the type; an image's bytes must still say so.
    if f.mime != AttachmentMime::Pdf
        && f.mime != AttachmentMime::Text
        && AttachmentMime::of_image(&data) != Some(f.mime)
    {
        return Err(ToolError::new(
            ErrorCode::Failed,
            "The image's bytes aren't of its type.",
        ));
    }
    let name = crate::hub::intake::attachments::safe_name(&f.name);
    let by = format!("telegram:{}/{}", r.machine_id, r.project_id);
    let (id, _, _) = crate::hub::intake::attachments::store(hub, data, &name, f.mime, &by).await?;
    Ok(id)
}

/// A button press of the paired account: an approval answered as the Navi's owner, or a question block's choice sent
/// as their reply. The toast it gets.
async fn press(
    hub: &Arc<Hub>,
    r: &ProjectRef,
    data: &str,
    message_id: i64,
    seq: &i64,
    at: &str,
) -> String {
    if let Some((verb, id)) = data.split_once(':')
        && (verb == "a" || verb == "d")
    {
        let Some(request) = hub.approvals.get(id).filter(|q| &q.project_ref == r) else {
            return "That approval is gone.".into();
        };
        if request.state != RequestState::Open {
            return format!("Already {}.", request.state.as_str());
        }
        let person = owner(hub, r);
        let name = format!(
            "{} on Telegram",
            person.as_ref().map_or("the owner", |p| p.name.as_str())
        );
        let anywhere = |_: &str| true;
        let who = crate::hub::approvals::Caller {
            human: true,
            name: &name,
            person: person.as_ref(),
            allows_operate: &anywhere,
        };
        return match hub.approvals.answer(&who, id, verb == "a", None).await {
            Ok(_) if verb == "a" => "Approved.".into(),
            Ok(_) => "Denied.".into(),
            Err(e) => e.message,
        };
    }
    // k:<message>:<part>:<choice>
    let mut words = data.split(':');
    if words.next() == Some("k")
        && let (Some(m), Some(part), Some(choice)) = (words.next(), words.next(), words.next())
        && let (Ok(part), Ok(choice)) = (part.parse::<usize>(), choice.parse::<usize>())
        && let Ok(Some(message)) = hub.chat.by_id(m)
        && &message.project_ref == r
        && message.author == ChatAuthor::Lead
        && let Some(label) = ask_label(&message, part, choice)
    {
        let sent = crate::hub::chat::flow::send_from_telegram(
            hub,
            r,
            crate::hub::chat::flow::FromTelegram {
                text: label.clone(),
                attachments: Vec::new(),
                forwarded_from: None,
                reply_to: Some(ChatReplyTo {
                    message_id: ChatMessageId::unchecked(m),
                    part: Count::unchecked(part as i64),
                }),
                person: owner(hub, r),
                request: format!("telegram:{seq}:{at}"),
            },
        )
        .await;
        if sent.is_ok() {
            let question = ask_question(&message, part).unwrap_or_default();
            let _ = node_call(
                hub,
                r,
                TelegramCall::Send {
                    send: TelegramSend::Edit {
                        message_id,
                        html: format!(
                            "<b>{}</b>\n→ {}",
                            format::escape(&question),
                            format::escape(&label)
                        ),
                        buttons: Vec::new(),
                    },
                },
                CALL_WAIT,
            )
            .await;
            return "Sent.".into();
        }
    }
    "That button no longer does anything.".into()
}

fn ask_of(message: &ChatMessage, part: usize) -> Option<&fleetd_contracts::blocks::AskBlock> {
    match &message.parts.as_ref()?.get(part)?.block.as_ref()?.body {
        BlockBody::Ask(ask) => Some(ask),
        _ => None,
    }
}

fn ask_options(ask: &fleetd_contracts::blocks::AskBlock) -> Vec<String> {
    match &ask.options {
        Some(options) => options.iter().map(|o| o.as_str().to_owned()).collect(),
        None => vec!["Approve".into(), "Deny".into()],
    }
}

fn ask_label(message: &ChatMessage, part: usize, choice: usize) -> Option<String> {
    ask_options(ask_of(message, part)?).get(choice).cloned()
}

fn ask_question(message: &ChatMessage, part: usize) -> Option<String> {
    Some(ask_of(message, part)?.question.as_str().to_owned())
}

/// The chat's messages after `after`, oldest first.
fn after(hub: &Hub, r: &ProjectRef, after: i64) -> Result<Vec<ChatMessage>, StoreError> {
    let datas: Vec<String> = hub.db.with(|c| {
        let mut stmt = c.prepare_cached(
            "SELECT data FROM chat_messages WHERE machine_id = ? AND project_id = ? AND seq > ? ORDER BY seq LIMIT 20",
        )?;
        let rows = stmt
            .query_map(params![r.machine_id.as_str(), r.project_id.as_str(), after], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    })?;
    Ok(datas
        .iter()
        .filter_map(|d| serde_json::from_str(d).ok())
        .collect())
}

/// Whether the bridge sends now: paired, not paused, its node online.
fn sending(hub: &Hub, row: &Row) -> bool {
    row.bridge.paired.is_some()
        && !row.bridge.paused
        && hub.executors.is_connected(&row.navi.machine_id)
        && hub.link.node_can(
            &row.navi.machine_id,
            fleetd_contracts::node_link::CAP_TELEGRAM,
        )
}

fn title(hub: &Hub, r: &ProjectRef) -> String {
    hub.store
        .project_get(r)
        .ok()
        .flatten()
        .map(|p| p.title.to_string())
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| "Your Navi".to_owned())
}

/// Sends what the Navi said since the last send, and updates the cards answered since.
pub async fn send_once(hub: &Arc<Hub>, r: &ProjectRef) -> Result<(), ToolError> {
    let Some(row) = row(&hub.db, r)? else {
        return Ok(());
    };
    if !sending(hub, &row) {
        return Ok(());
    }
    let navi = title(hub, r);
    let now = now_ms(hub.clock.as_ref());
    for m in after(hub, r, row.sent)? {
        let at = parse_ms(m.created_at.as_str()).unwrap_or(now);
        if m.state == ChatMessageState::Streaming {
            if now - at < STREAM_STUCK_MS {
                break;
            }
            set_sent(&hub.db, r, m.seq.get())?;
            continue;
        }
        if m.author != ChatAuthor::Lead || m.history.is_some() || now - at > STALE_MS {
            set_sent(&hub.db, r, m.seq.get())?;
            continue;
        }
        let went = match &m.item {
            None => reply(hub, r, &m).await,
            Some(ChatItem::CommandApproval(c)) if c.state == CommandApprovalState::Open => {
                card(hub, r, &navi, c).await
            }
            Some(ChatItem::SecretRequest(s)) if s.state == SecretRequestState::Open => text(
                hub,
                r,
                &format!(
                    "<b>{} needs a secret: {}</b>\nSecrets are entered only in the fleetd app, never here. Open the Navi there to enter it.",
                    format::escape(&navi),
                    format::escape(s.text.as_str())
                ),
                Vec::new(),
            )
            .await
            .map(|_| ()),
            Some(_) => Ok(()),
        };
        match went {
            Ok(()) => {
                hub.telegram.tries.lock().unwrap().remove(r);
                set_sent(&hub.db, r, m.seq.get())?;
            }
            Err(e) => {
                let mut tries = hub.telegram.tries.lock().unwrap();
                let entry = tries.entry(r.clone()).or_insert((m.seq.get(), 0));
                if entry.0 != m.seq.get() {
                    *entry = (m.seq.get(), 0);
                }
                entry.1 += 1;
                if entry.1 >= TRIES {
                    tracing::warn!(navi = %r.project_id, "telegram: a reply was passed over: {}", e.message);
                    tries.remove(r);
                    drop(tries);
                    set_sent(&hub.db, r, m.seq.get())?;
                    continue;
                }
                return Err(e);
            }
        }
    }
    answered(hub, r, &navi).await
}

async fn send(hub: &Hub, r: &ProjectRef, send: TelegramSend) -> Result<Vec<i64>, ToolError> {
    match node_call(hub, r, TelegramCall::Send { send }, SEND_WAIT).await? {
        TelegramAnswer::Sent { message_ids } => Ok(message_ids),
        _ => Err(ToolError::new(
            ErrorCode::Failed,
            "The node didn't say it sent.",
        )),
    }
}

async fn text(
    hub: &Hub,
    r: &ProjectRef,
    html: &str,
    buttons: Vec<Vec<TelegramButton>>,
) -> Result<Vec<i64>, ToolError> {
    send(
        hub,
        r,
        TelegramSend::Text {
            html: html.to_owned(),
            buttons,
        },
    )
    .await
}

/// One of the Navi's replies: its text in as many messages as it takes, its images and files, its question blocks
/// with their choices as buttons.
async fn reply(hub: &Hub, r: &ProjectRef, m: &ChatMessage) -> Result<(), ToolError> {
    let mut md = String::new();
    let count = m.parts.as_ref().map_or(1, |p| p.len());
    for i in 0..count {
        let block = m
            .parts
            .as_ref()
            .and_then(|p| p.get(i))
            .and_then(|p| p.block.as_ref());
        let Some(block) = block else {
            if let Some(bubble) = crate::hub::chat::parts::bubble(m, i) {
                md.push_str(&bubble);
                md.push_str("\n\n");
            }
            continue;
        };
        match &block.body {
            BlockBody::Image(a) | BlockBody::Clip(a) => {
                flush(hub, r, &mut md).await?;
                file(
                    hub,
                    r,
                    &a.attachment_id,
                    a.caption.as_ref().map(|c| c.as_str()),
                )
                .await?;
            }
            BlockBody::Ask(ask) => {
                flush(hub, r, &mut md).await?;
                let buttons = ask_options(ask)
                    .into_iter()
                    .enumerate()
                    .map(|(n, label)| TelegramButton {
                        text: label,
                        data: format!("k:{}:{i}:{n}", m.message_id.as_str()),
                    })
                    .collect::<Vec<_>>();
                let rows: Vec<Vec<TelegramButton>> = buttons.chunks(2).map(<[_]>::to_vec).collect();
                text(
                    hub,
                    r,
                    &format!("<b>{}</b>", format::escape(ask.question.as_str())),
                    rows,
                )
                .await?;
            }
            BlockBody::Table(t) => {
                let mut table = String::from("```\n");
                if let Some(title) = &t.title {
                    table.push_str(&format!("{}\n", title.as_str()));
                }
                let row = |cells: Vec<&str>| format!("| {} |\n", cells.join(" | "));
                table.push_str(&row(t.columns.iter().map(|c| c.as_str()).collect()));
                for cells in t.rows.iter() {
                    table.push_str(&row(cells.iter().map(|c| c.as_str()).collect()));
                }
                table.push_str("```\n\n");
                md.push_str(&table);
            }
            BlockBody::Pr(p) => {
                let title = p
                    .title
                    .as_ref()
                    .map(|t| format!(": {}", t.as_str()))
                    .unwrap_or_default();
                md.push_str(&format!(
                    "[{}#{}{title}](https://github.com/{}/pull/{})\n\n",
                    p.repo.as_str(),
                    p.number.get(),
                    p.repo.as_str(),
                    p.number.get()
                ));
            }
            other => {
                let what = match other {
                    BlockBody::Chart(_) => "a chart",
                    BlockBody::Diff(_) => "a diff",
                    BlockBody::Agent(_) => "an agent's card",
                    BlockBody::Checklist(_) => "a checklist",
                    _ => "a block",
                };
                md.push_str(&format!("_({what}: open the app to see it)_\n\n"));
            }
        }
    }
    flush(hub, r, &mut md).await?;
    for a in m.attachments.iter() {
        file(hub, r, &a.attachment_id, None).await?;
    }
    Ok(())
}

async fn flush(hub: &Hub, r: &ProjectRef, md: &mut String) -> Result<(), ToolError> {
    for html in format::messages(md) {
        text(hub, r, &html, Vec::new()).await?;
    }
    md.clear();
    Ok(())
}

/// A file of the chat: a photo when Telegram shows it as one, else a document; too large, a line saying so.
async fn file(
    hub: &Hub,
    r: &ProjectRef,
    id: &AttachmentId,
    caption: Option<&str>,
) -> Result<(), ToolError> {
    let Some((name, mime, bytes)) = crate::hub::intake::attachments::read(hub, id, r).await else {
        return Ok(());
    };
    if bytes.len() > TELEGRAM_SEND_MAX {
        text(
            hub,
            r,
            &format!(
                "{} is too large for Telegram: open the app to see it.",
                format::escape(&name)
            ),
            Vec::new(),
        )
        .await?;
        return Ok(());
    }
    let mime_text = serde_json::to_value(mime)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_else(|| "application/octet-stream".into());
    send(
        hub,
        r,
        TelegramSend::File {
            name,
            mime: mime_text,
            data_b64: B64.encode(&bytes),
            caption_html: caption.map(format::escape),
            photo: matches!(mime, AttachmentMime::Png | AttachmentMime::Jpeg),
        },
    )
    .await?;
    Ok(())
}

/// An approval card: the exact content (in a file before it when too long), Approve and Deny.
async fn card(
    hub: &Hub,
    r: &ProjectRef,
    navi: &str,
    item: &fleetd_contracts::chat::CommandApprovalItem,
) -> Result<(), ToolError> {
    let id = item.request_id.as_str();
    let shown = format::card(navi, item);
    if let Some(full) = &shown.file {
        send(
            hub,
            r,
            TelegramSend::File {
                name: format!("{id}.txt"),
                mime: "text/plain".into(),
                data_b64: B64.encode(full.as_bytes()),
                caption_html: None,
                photo: false,
            },
        )
        .await?;
    }
    let buttons = vec![vec![
        TelegramButton {
            text: "Approve".into(),
            data: format!("a:{id}"),
        },
        TelegramButton {
            text: "Deny".into(),
            data: format!("d:{id}"),
        },
    ]];
    let ids = text(hub, r, &shown.html, buttons).await?;
    if let Some(message_id) = ids.first() {
        hub.db.with(|c| {
            c.execute(
                "INSERT OR REPLACE INTO telegram_cards (request_id, machine_id, project_id, message_id, shown)
                 VALUES (?, ?, ?, ?, 'open')",
                params![id, r.machine_id.as_str(), r.project_id.as_str(), message_id],
            )?;
            Ok(())
        })?;
    }
    Ok(())
}

/// Each open card whose request was answered since, in the app or on Telegram: edited to say so, its buttons gone.
async fn answered(hub: &Hub, r: &ProjectRef, navi: &str) -> Result<(), ToolError> {
    let open: Vec<(String, i64)> = hub.db.with(|c| {
        let mut stmt = c.prepare_cached(
            "SELECT request_id, message_id FROM telegram_cards WHERE machine_id = ? AND project_id = ? AND shown = 'open'",
        )?;
        let rows = stmt
            .query_map(params![r.machine_id.as_str(), r.project_id.as_str()], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    })?;
    for (id, message_id) in open {
        let request = hub.approvals.get(&id);
        let item = match request.as_ref().map(crate::hub::approvals::chat_item) {
            Some(ChatItem::CommandApproval(c)) if c.state == CommandApprovalState::Open => continue,
            Some(ChatItem::CommandApproval(c)) => Some(c),
            _ => None,
        };
        let html = match &item {
            Some(c) => format::answered(navi, c),
            None => "This approval is gone.".to_owned(),
        };
        send(
            hub,
            r,
            TelegramSend::Edit {
                message_id,
                html,
                buttons: Vec::new(),
            },
        )
        .await?;
        hub.db.with(|c| {
            c.execute(
                "UPDATE telegram_cards SET shown = 'done' WHERE request_id = ?",
                [&id],
            )?;
            Ok(())
        })?;
    }
    Ok(())
}

/// "typing…" while the Navi works on what the person sent from Telegram.
async fn typing(hub: &Hub, row: &Row) {
    let r = &row.navi;
    if !sending(hub, row) || !crate::hub::chat::flow::lead_working(hub, r) {
        return;
    }
    let now = now_ms(hub.clock.as_ref());
    if hub
        .telegram
        .typing
        .lock()
        .unwrap()
        .get(r)
        .is_some_and(|at| now - at < TYPING_EVERY_MS)
    {
        return;
    }
    let last: Option<String> = hub
        .db
        .with(|c| {
            Ok(c.query_row(
                "SELECT data FROM chat_messages WHERE machine_id = ? AND project_id = ?
                 AND json_extract(data, '$.author') = 'human' ORDER BY seq DESC LIMIT 1",
                params![r.machine_id.as_str(), r.project_id.as_str()],
                |row| row.get(0),
            )
            .ok())
        })
        .ok()
        .flatten();
    let from_telegram = last
        .and_then(|d| serde_json::from_str::<ChatMessage>(&d).ok())
        .is_some_and(|m| {
            m.client == Some(ChatClient::Telegram)
                && parse_ms(m.created_at.as_str()).is_some_and(|at| now - at < TYPING_FOR_MS)
        });
    if !from_telegram {
        return;
    }
    hub.telegram.typing.lock().unwrap().insert(r.clone(), now);
    let _ = send(hub, r, TelegramSend::Typing).await;
}
