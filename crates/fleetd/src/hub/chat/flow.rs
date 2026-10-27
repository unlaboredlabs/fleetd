//! The chat's moving parts over the hub: a human's message reaches the project's lead (a new turn when it is idle,
//! joined to its turn when it is working, held while it starts), the lead's replies stream back and land as
//! messages, the project's past is read in once, and the needs-you state follows.
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use fleetd_contracts::auth::Role;
use fleetd_contracts::chat::{
    ChatAuthor, ChatClient, ChatDelivery, ChatHistorySource, ProjectChatState,
};
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectRef, ThreadRef};
use fleetd_contracts::ledger::{LeadState, WorkstreamState};
use fleetd_contracts::mcp::{
    ChatSendInput, ChatSendOutput, ChatStopInput, ChatStopOutput, ErrorCode, ProjectStopInput,
    ProjectStopOutput,
};
use fleetd_contracts::model::ThreadStatus;
use fleetd_contracts::prim::Count;
use fleetd_contracts::sessions::SendMode;

use super::{NewMessage, history};
use crate::hub::api::{Caller, Hub, ToolError, require};
use crate::hub::intake::attachments;
use crate::hub::leads::lead::AutoStart;
use crate::hub::leads::records::WorkstreamFilter;
use crate::hub::prompts::PromptSet;
use crate::hub::queue::ports::SendOpts;
use crate::hub::store::{StoreError, WaitInput};
use crate::hub::tasks::records::TaskRecords;

/// How long the history read waits for the lead's session on its machine before reading without its messages.
const LEAD_READ_WAIT: Duration = Duration::from_secs(5);
/// How long a machine that came online gets for the hub's subscription to its node before its leads' missed replies
/// are read.
const LINK_WAIT: Duration = Duration::from_secs(30);
/// Streamed text is folded into the chat this often.
const STREAM_TICK: Duration = Duration::from_millis(250);
/// Held messages are tried again this often, besides on a lead starting and its machine coming online.
const HELD_RETRY: Duration = Duration::from_secs(60);
/// New messages one agent key may write in a minute, so agents answering each other through a chat can't run away.
pub const AGENT_PER_MINUTE: usize = 10;

fn store_error(e: StoreError) -> ToolError {
    tracing::error!(error = %e, "chat store");
    crate::hub::api::internal_error()
}

pub(super) fn lead_thread(hub: &Hub, r: &ProjectRef) -> Option<ThreadRef> {
    let lead = hub.leads.records.lead_get(r).ok()??;
    Some(ThreadRef {
        machine_id: r.machine_id.clone(),
        thread_id: lead.thread_id,
    })
}

pub fn lead_working(hub: &Hub, r: &ProjectRef) -> bool {
    hub.leads
        .leads
        .get(r)
        .ok()
        .flatten()
        .is_some_and(|l| l.state == LeadState::Working)
}

/// The project's chat state, announced when it changed.
pub fn state(hub: &Hub, r: &ProjectRef) -> Result<ProjectChatState, StoreError> {
    let state = hub.chat.state(r, lead_working(hub, r))?;
    hub.chat.tell_state(&state)?;
    Ok(state)
}

/// Every record of the project's past, as chat messages.
async fn past(hub: &Hub, r: &ProjectRef) -> Vec<NewMessage> {
    let mut out = Vec::new();
    let orders = hub
        .leads
        .records
        .workstreams_list(&WorkstreamFilter {
            project_ref: Some(r.clone()),
            limit: 500,
            ..Default::default()
        })
        .unwrap_or_default();
    for w in &orders {
        out.extend(history::order(w));
    }
    let ids: Vec<String> = orders.iter().map(|w| w.workstream_id.to_string()).collect();
    let rows = hub.db.with(|c| {
        let mut steers = Vec::new();
        let mut stmt = c.prepare("SELECT n, workstream_id, data FROM steers ORDER BY n")?;
        for row in stmt.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })? {
            let (n, ws, data) = row?;
            if ids.contains(&ws) {
                steers.push((n, data));
            }
        }
        // The retired questions tool's rows, kept as they were (store migration 29).
        let mut asks = Vec::new();
        let mut stmt = c.prepare("SELECT data FROM legacy_asks")?;
        for data in stmt.query_map([], |row| row.get::<_, String>(0))? {
            asks.push(data?);
        }
        Ok((steers, asks))
    });
    let (steers, asks) = rows.unwrap_or_default();
    for (n, data) in steers {
        if let Ok(v) = serde_json::from_str(&data)
            && let Some(m) = history::steer(n, &v)
        {
            out.push(m);
        }
    }
    for data in asks {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&data) else {
            continue;
        };
        let own = v["projectRef"]["machineId"].as_str() == Some(r.machine_id.as_str())
            && v["projectRef"]["projectId"].as_str() == Some(r.project_id.as_str());
        if own {
            out.extend(history::question(&v));
        }
    }
    if let Some(thread) = lead_thread(hub, r)
        && let Ok(Ok(messages)) =
            tokio::time::timeout(LEAD_READ_WAIT, hub.executors.messages(&thread)).await
    {
        out.extend(history::lead_messages(thread.thread_id.as_str(), &messages));
    }
    out
}

/// Reads the project's past into its chat, once.
pub async fn ensure(hub: &Hub, r: &ProjectRef) -> Result<(), StoreError> {
    hub.chat.read_history(r, || past(hub, r)).await
}

fn waiting_reason(e: &crate::hub::leads::LeadError) -> String {
    match &e.fix {
        Some(fix) => format!("{} {fix}", e.message),
        None => e.message.to_string(),
    }
}

/// Who writes a message, from the key, never from the text.
struct Writer {
    author: ChatAuthor,
    by: String,
    /// A human message's person.
    person: Option<fleetd_contracts::people::PersonRef>,
    client: Option<ChatClient>,
}

fn refused(message: &str, fix: &str) -> ToolError {
    ToolError::new(ErrorCode::Forbidden, message).with_fix(fix)
}

/// The author is the key's: a human key writes as the human, from the app unless it says otherwise; any other key as
/// an agent, by the key's name. A message sent from inside a fleetd session (`session`, which `fleetd chat` reads
/// from its process tree) is an agent's whatever key it holds, and the project's own lead and tasks are refused, so
/// they talk through their fleetd tools and never wake their lead through its chat. `session` is the caller's own
/// report, so this catches mistakes and is no boundary: the key decides.
fn writer(hub: &Hub, caller: &Caller, input: &ChatSendInput) -> Result<Writer, ToolError> {
    let r = &input.project_ref;
    if let Some(session) = &input.session {
        if lead_thread(hub, r).is_some_and(|t| t.thread_id == *session) {
            return Err(refused(
                "This project's lead can't write to its own chat.",
                "What you write in your turn is your chat message; talk to your agents with message_agent.",
            ));
        }
        let task = hub
            .db
            .with(|c| Ok(TaskRecords::by_thread_id(c, session.as_str())?))
            .map_err(store_error)?;
        if task.is_some_and(|stored| stored.task.project_ref == *r) {
            return Err(refused(
                "A task can't write to its own lead's chat.",
                "Tell your lead through your fleetd tools: report, or ask_lead.",
            ));
        }
        if crate::hub::api::is_human(caller) {
            return Err(refused(
                "An agent's session can't write as the human.",
                "Write with an agent key of your own: fleetd hub key create --agent <name>.",
            ));
        }
    }
    Ok(if crate::hub::api::is_human(caller) {
        Writer {
            author: ChatAuthor::Human,
            by: caller.name.to_string(),
            person: caller.person.clone(),
            client: Some(input.client.unwrap_or(ChatClient::App)),
        }
    } else {
        Writer {
            author: ChatAuthor::Agent,
            by: caller.name.to_string(),
            person: None,
            client: None,
        }
    })
}

/// `chat_send`: a message is stored at once, held until it is in the lead's session, then sent. The same
/// clientRequestId returns the stored message, and tries again to send it if it has not gone yet.
pub async fn send(
    hub: &Arc<Hub>,
    caller: &Caller,
    input: ChatSendInput,
) -> Result<ChatSendOutput, ToolError> {
    let r = input.project_ref.clone();
    require(caller, Role::Operate, Some(&r.machine_id))?;
    if hub.store.project_get(&r).map_err(store_error)?.is_none() {
        return Err(ToolError::new(
            ErrorCode::NotFound,
            format!("No project {} on {}.", r.project_id, r.machine_id),
        )
        .with_fix("Pick a project from fleetd_status."));
    }
    if let Some((holder, repo)) = crate::hub::repos::holder(&hub.db, &r).map_err(store_error)? {
        let (message, fix) = crate::hub::repos::archived_note(&holder, &repo);
        return Err(ToolError::new(ErrorCode::Invalid, message).with_fix(fix));
    }
    let writer = writer(hub, caller, &input)?;
    let now = input.now == Some(true);
    if now && writer.author != ChatAuthor::Human {
        return Err(refused(
            "Only a person can stop the lead's step.",
            "Send it without now: the lead reads it at its next step.",
        ));
    }
    let ids: Vec<_> = input
        .attachments
        .as_ref()
        .map(|a| a.iter().cloned().collect())
        .unwrap_or_default();
    let request = format!("{}:{}", caller.key_id, input.client_request_id);
    let stored = hub.chat.by_request(&r, &request).map_err(store_error)?;
    let message = match stored {
        Some(message) => message,
        None => {
            if writer.author == ChatAuthor::Agent && !hub.chat.allow_agent(caller.key_id.as_str()) {
                return Err(ToolError::new(
                    ErrorCode::Invalid,
                    format!("This key wrote {AGENT_PER_MINUTE} chat messages in the last minute."),
                )
                .with_fix("Wait a minute, and put what you have in one message."));
            }
            attachments::check(hub, caller, &ids)?;
            ensure(hub, &r).await.map_err(store_error)?;
            // Only a lead message of this chat is answered; any other names nothing, and the text goes as it is.
            let reply_to = input
                .reply_to
                .filter(|to| replied_in(hub, &r, to).is_some());
            let (message, created) = hub
                .chat
                .add(
                    &r,
                    NewMessage {
                        author: Some(writer.author),
                        text: input.text.to_string(),
                        attachments: attachments::refs(hub, &ids)?,
                        skills: input
                            .skills
                            .as_ref()
                            .map(|s| s.iter().cloned().collect())
                            .unwrap_or_default(),
                        request: Some(request),
                        by: Some(writer.by),
                        person: writer.person,
                        client: writer.client,
                        reply_to,
                        delivery: Some(ChatDelivery::Queued),
                        held: true,
                        ..Default::default()
                    },
                )
                .map_err(store_error)?;
            if created {
                // The project's from now on, so the unused-upload cleanup keeps them and the chat can show them.
                attachments::claim(hub, &ids, &r)?;
            }
            message
        }
    };
    let (message, lead_waiting) = if hub.chat.is_held(&message).map_err(store_error)? {
        go(hub, &r, message, now).await
    } else {
        (message, None)
    };
    state(hub, &r).map_err(store_error)?;
    Ok(ChatSendOutput {
        message,
        lead_waiting,
        next: Some(
            "The lead's reply arrives as chat.message events; read the chat with chat_history."
                .into(),
        ),
        truncated: None,
    })
}

/// A message one of fleetd's own agents writes to another project's lead, as the agent `by` (Navi's bridge,
/// hub/navi): stored and sent as `send` does an agent key's, idempotent per `request`. Returns it, and why it waits
/// when it does.
pub async fn send_as_agent(
    hub: &Arc<Hub>,
    r: &ProjectRef,
    by: &str,
    text: String,
    request: String,
) -> Result<(fleetd_contracts::chat::ChatMessage, Option<String>), ToolError> {
    let message = match hub.chat.by_request(r, &request).map_err(store_error)? {
        Some(message) => message,
        None => {
            if !hub.chat.allow_agent(by) {
                return Err(ToolError::new(
                    ErrorCode::Invalid,
                    format!("{by} wrote {AGENT_PER_MINUTE} chat messages in the last minute."),
                )
                .with_fix("Wait a minute, and put what you have in one message."));
            }
            ensure(hub, r).await.map_err(store_error)?;
            let new = NewMessage {
                author: Some(ChatAuthor::Agent),
                text,
                request: Some(request),
                by: Some(by.to_owned()),
                delivery: Some(ChatDelivery::Queued),
                held: true,
                ..Default::default()
            };
            hub.chat.add(r, new).map_err(store_error)?.0
        }
    };
    let (message, lead_waiting) = if hub.chat.is_held(&message).map_err(store_error)? {
        go(hub, r, message, false).await
    } else {
        (message, None)
    };
    state(hub, r).map_err(store_error)?;
    Ok((message, lead_waiting))
}

/// Sends a held message to the project's lead, starting it if it has none: released once its session or the
/// offline queue took it, with how it went in; still held, with why, when it couldn't go. `now` stops a working
/// lead's running step for it; an idle or starting lead takes it as any message. A message that starts the lead ends
/// its first message, so the lead's first turn answers it instead of an empty chat.
async fn go(
    hub: &Arc<Hub>,
    r: &ProjectRef,
    mut message: fleetd_contracts::chat::ChatMessage,
    now: bool,
) -> (fleetd_contracts::chat::ChatMessage, Option<String>) {
    // Files that can't be placed yet leave the message to `deliver`, which says why it waits. A cold lead takes it as
    // the first message of a fresh session, as a lead that doesn't exist yet does.
    let starts = match hub.leads.leads.get(r) {
        Ok(None) => true,
        Ok(Some(_)) => hub.leads.leads.cold(r),
        Err(_) => false,
    };
    let first = match starts {
        true => files_of(hub, r, &message).await.ok().map(|files| {
            let replied = replied(hub, &message);
            for_lead(
                &hub.db.prompts().current(Some(r)),
                &message,
                replied.as_ref(),
                &files,
                &crate::hub::people::writer(&hub.db, message.person.as_ref()),
            )
        }),
        false => None,
    };
    if let Some(first) = &first
        && let Ok(Some(_)) = hub.leads.leads.fresh_if_cold(r, first).await
    {
        sent(hub, &mut message, ChatDelivery::Turn);
        return (message, None);
    }
    let lead = match hub.leads.leads.auto_start(r, first.as_deref()).await {
        AutoStart::Started(_) if first.is_some() => {
            sent(hub, &mut message, ChatDelivery::Turn);
            return (message, None);
        }
        AutoStart::Running(lead) | AutoStart::Started(lead) => lead,
        AutoStart::Held(e) => return (message, Some(waiting_reason(&e))),
    };
    let thread = ThreadRef {
        machine_id: r.machine_id.clone(),
        thread_id: lead.thread_id.clone(),
    };
    let now = now && lead.state == LeadState::Working;
    match deliver(hub, r, &thread, &message, now).await {
        Ok(queued) => {
            let delivery = match lead.state {
                _ if queued => ChatDelivery::Queued,
                LeadState::Working if now => ChatDelivery::Now,
                LeadState::Working => ChatDelivery::Steer,
                LeadState::Starting => ChatDelivery::Queued,
                _ => ChatDelivery::Turn,
            };
            sent(hub, &mut message, delivery);
            (message, None)
        }
        Err(e) => (
            message,
            Some(format!(
                "Not sent yet: {}. It goes in as soon as it can.",
                e.message
            )),
        ),
    }
}

/// Records how a message went in and releases it.
fn sent(hub: &Hub, message: &mut fleetd_contracts::chat::ChatMessage, delivery: ChatDelivery) {
    message.delivery = Some(delivery);
    if let Err(error) = hub
        .chat
        .put(message)
        .and_then(|()| hub.chat.release(message))
    {
        tracing::warn!(%error, "chat: sent message not released");
    }
}

/// A chat message as the lead reads it: the writer's own words in the `chat.human` or `chat.agent` prompt. The
/// human's are the human's wherever they wrote them; an agent's say plainly that they are not. A reply to one of the
/// lead's bubbles (`replied`, the message `reply_to` names) opens with that bubble whole, in place of its one-line
/// quote, and when the lead wrote it. `writer` names a human message's writer ([`crate::hub::people::writer`]).
pub fn for_lead(
    set: &PromptSet,
    message: &fleetd_contracts::chat::ChatMessage,
    replied: Option<&fleetd_contracts::chat::ChatMessage>,
    files: &str,
    writer: &str,
) -> String {
    let replying = message
        .reply_to
        .as_ref()
        .zip(replied)
        .and_then(|(to, replied)| replying(message, replied, to.part.get()));
    let text = replying.as_deref().unwrap_or(message.text.as_str());
    match message.author {
        ChatAuthor::Agent => set.render(
            "chat.agent",
            &[
                (
                    "agent",
                    &message.by.as_ref().map_or("unnamed", |b| b.as_str()),
                ),
                ("text", &text),
                ("files", &files),
            ],
        ),
        _ => set.render(
            "chat.human",
            &[("writer", &writer), ("text", &text), ("files", &files)],
        ),
    }
}

/// The longest quote of a replied bubble, in characters; a longer one keeps its start and end.
const REPLY_QUOTE_MAX: usize = 1000;
const REPLY_QUOTE_HEAD: usize = 600;
const REPLY_QUOTE_TAIL: usize = 300;

/// A reply's text with the bubble it answers whole: "Replying to your message at 22:05 UTC:", the bubble quoted, then
/// the words under the app's one-line quote. None when the bubble isn't there.
fn replying(
    message: &fleetd_contracts::chat::ChatMessage,
    replied: &fleetd_contracts::chat::ChatMessage,
    part: i64,
) -> Option<String> {
    let bubble = super::parts::bubble(replied, usize::try_from(part).ok()?)?;
    let chars = bubble.chars().count();
    let bubble = if chars > REPLY_QUOTE_MAX {
        // Cut between words.
        let head: String = bubble.chars().take(REPLY_QUOTE_HEAD).collect();
        let head = head
            .rsplit_once(char::is_whitespace)
            .map_or(&*head, |(h, _)| h);
        let tail: String = bubble.chars().skip(chars - REPLY_QUOTE_TAIL).collect();
        let tail = tail
            .split_once(char::is_whitespace)
            .map_or(&*tail, |(_, t)| t);
        let (head, tail) = (head.trim_end(), tail.trim_start());
        format!(
            "{head}\n[… {} characters cut …]\n{tail}",
            chars - head.chars().count() - tail.chars().count()
        )
    } else {
        bubble
    };
    let quote: Vec<String> = bubble
        .lines()
        .map(|l| format!("> {l}").trim_end().to_owned())
        .collect();
    let (at, on) = (replied.created_at.as_str(), message.created_at.as_str());
    let when = match (at.get(..10), at.get(11..16)) {
        (Some(day), Some(time)) if on.get(..10) == Some(day) => format!("{time} UTC"),
        (Some(day), Some(time)) => format!("{day} {time} UTC"),
        _ => at.to_owned(),
    };
    let of = match replied.parts.as_ref().map_or(1, |p| p.len()) {
        1 => String::new(),
        n => format!(", its bubble {} of {n}", part + 1),
    };
    let text = message.text.as_str();
    // The app's one-line quote ("> …" and a blank line) gives way to the whole bubble.
    let words = text
        .strip_prefix("> ")
        .and_then(|rest| rest.split_once("\n\n"))
        .filter(|(line, _)| !line.contains('\n'))
        .map_or(text, |(_, words)| words);
    Some(format!(
        "Replying to your message at {when}{of}:\n{}\n\n{words}",
        quote.join("\n")
    ))
}

/// The lead message of the project `to` names.
fn replied_in(
    hub: &Hub,
    r: &ProjectRef,
    to: &fleetd_contracts::chat::ChatReplyTo,
) -> Option<fleetd_contracts::chat::ChatMessage> {
    hub.chat
        .by_id(to.message_id.as_str())
        .ok()
        .flatten()
        .filter(|m| m.project_ref == *r && m.author == ChatAuthor::Lead)
}

/// The lead message a reply answers.
fn replied(
    hub: &Hub,
    message: &fleetd_contracts::chat::ChatMessage,
) -> Option<fleetd_contracts::chat::ChatMessage> {
    replied_in(hub, &message.project_ref, message.reply_to.as_ref()?)
}

/// Into the lead's session, with its files: a plain send, which starts a turn or joins the running one, or with `now`
/// steer_send's own interrupt (SendMode::Now), which stops the running step first. True when it waits for the
/// machine in the offline queue.
async fn deliver(
    hub: &Arc<Hub>,
    r: &ProjectRef,
    thread: &ThreadRef,
    message: &fleetd_contracts::chat::ChatMessage,
    now: bool,
) -> Result<bool, ToolError> {
    let files = files_of(hub, r, message).await? + &skills_of(hub, r, message);
    let set = hub
        .db
        .prompts()
        .for_thread(&thread.machine_id, thread.thread_id.as_str());
    let replied = replied(hub, message);
    let writer = crate::hub::people::writer(&hub.db, message.person.as_ref());
    let text = for_lead(&set, message, replied.as_ref(), &files, &writer);
    let crid = format!("chat:{}", message.message_id);
    let opts = SendOpts {
        mode: if now { SendMode::Now } else { SendMode::Plain },
        ..SendOpts::default()
    };
    let sent = hub
        .queue
        .send_with(thread, &text, &crid, None, opts)
        .await
        .map_err(|e| ToolError::new(ErrorCode::Failed, e.to_string()))?;
    Ok(sent.queued)
}

/// The message's files placed on the project's machine, as the lines the lead reads after its text.
async fn files_of(
    hub: &Arc<Hub>,
    r: &ProjectRef,
    message: &fleetd_contracts::chat::ChatMessage,
) -> Result<String, ToolError> {
    let ids: Vec<_> = message
        .attachments
        .iter()
        .map(|a| a.attachment_id.clone())
        .collect();
    if ids.is_empty() {
        return Ok(String::new());
    }
    let files = attachments::place(hub, &ids, r, "chat", None).await?;
    Ok(if files.is_empty() {
        String::new()
    } else {
        format!("\n\nAttached:\n{}", files.join("\n"))
    })
}

/// The skills a person named with `$name`, as the lines the lead reads after the text: each as the session lists it
/// (`fleetd:<name>`) with where it comes from and what it does, so the lead uses it or names it in a brief.
pub(crate) fn skills_of(
    hub: &Hub,
    r: &ProjectRef,
    message: &fleetd_contracts::chat::ChatMessage,
) -> String {
    use fleetd_contracts::skills::{SkillScope, description_of};
    let Some(names) = &message.skills else {
        return String::new();
    };
    let skills = hub.db.skills();
    let lines: Vec<String> = names
        .iter()
        .map(|name| {
            let kept = skills
                .get(SkillScope::Project, Some(r), name)
                .or_else(|| skills.get(SkillScope::Global, None, name));
            match kept {
                Some(k) => format!(
                    "- fleetd:{name} ({} skill): {}",
                    match k.scope {
                        SkillScope::Project => "this project's",
                        SkillScope::Global => "a global",
                    },
                    description_of(&k.text)
                ),
                None => {
                    format!("- fleetd:{name} (from the repo's .agents/skills or .claude/skills)")
                }
            }
        })
        .collect();
    format!(
        "\n\nSkills the human named: use each with the Skill tool, or name it in an agent's brief. One added since \
         your session started isn't in your skill list yet: read $FLEETD_SKILLS_DIR/<name>/SKILL.md instead.\n{}",
        lines.join("\n")
    )
}

/// Every held message of the project, oldest first; one that can't go stops the rest, so they stay in order.
pub(super) async fn send_held(hub: &Arc<Hub>, r: &ProjectRef) {
    let held = match hub.chat.held(r) {
        Ok(held) => held,
        Err(error) => return tracing::warn!(%error, "chat: held messages not read"),
    };
    for message in held {
        // Held means the lead couldn't take it then: it goes in as any message, never as an interrupt later.
        let (_, waiting) = go(hub, r, message, false).await;
        if let Some(why) = waiting {
            tracing::info!(project = %r.project_id, %why, "chat: held message waits");
            break;
        }
    }
    if let Err(error) = state(hub, r) {
        tracing::warn!(%error, "chat: state not told");
    }
}

/// A person's request (a secret to enter, a command to approve) as its inline item in the project's chat: added
/// when it opens, updated in place as it is answered, withdrawn or expires. The item carries no secret value; only
/// the request's own fields, through `approvals::chat_item`.
pub(super) async fn show_request(hub: &Hub, id: &str) {
    let Some(request) = hub.approvals.get(id) else {
        return;
    };
    let r = request.project_ref.clone();
    if let Err(error) = ensure(hub, &r).await {
        return tracing::warn!(%error, "chat: history not read");
    }
    let item = crate::hub::approvals::chat_item(&request);
    let shown = match hub.chat.update_item(&request.request_id, item.clone()) {
        Ok(Some(_)) => Ok(()),
        Ok(None) => hub.chat.item(&r, item).map(|_| ()),
        Err(e) => Err(e),
    };
    if let Err(error) = shown.and_then(|()| state(hub, &r).map(|_| ())) {
        tracing::warn!(%error, request = id, "chat: request not shown");
    }
}

/// A project's max-agents change is one quiet line in its chat, its event's summary; a fleet-wide change says nothing
/// in any one chat.
pub(super) async fn cap_line(hub: &Hub, seq: i64, data: Option<&serde_json::Value>, summary: &str) {
    let Some(r) = data
        .and_then(|d| d.get("projectRef"))
        .and_then(|p| serde_json::from_value::<ProjectRef>(p.clone()).ok())
    else {
        return;
    };
    if let Err(error) = ensure(hub, &r).await {
        return tracing::warn!(%error, "chat: history not read");
    }
    let line = NewMessage {
        author: Some(ChatAuthor::System),
        text: summary.to_owned(),
        source: Some(format!("cap:{seq}")),
        ..Default::default()
    };
    if let Err(error) = hub.chat.add(&r, line) {
        tracing::warn!(%error, "chat: max agents line not added");
    }
}

/// Requests still open when the hub starts (opened while it was down, or asks the migration kept as requests).
/// The start of the follower: takes the event cursor, then shows every open request and brings every chat item that
/// still reads open or approved in line with its request. Returns the cursor to follow from.
pub(super) async fn startup(hub: &Hub) -> i64 {
    let cursor = hub.events.head();
    show_open_requests(hub).await;
    for id in hub.chat.unsettled_requests().unwrap_or_default() {
        show_request(hub, &id).await;
    }
    cursor
}

async fn show_open_requests(hub: &Hub) {
    let open = hub
        .approvals
        .list(&crate::hub::approvals::store::RequestFilter {
            project_ref: None,
            states: Some(vec![fleetd_contracts::ledger::RequestState::Open]),
            kind: None,
            limit: 500,
        });
    for request in open.unwrap_or_default() {
        show_request(hub, request.request_id.as_str()).await;
    }
}

/// A message the offline queue gave up on is held again, to go when it can.
pub(super) fn expired(hub: &Hub, data: &serde_json::Value) {
    let Some(id) = data["clientRequestId"]
        .as_str()
        .and_then(|c| c.strip_prefix("chat:"))
    else {
        return;
    };
    match hub.chat.by_id(id) {
        Ok(Some(message)) => {
            if let Err(error) = hub.chat.hold(&message) {
                tracing::warn!(%error, "chat: expired message not held");
            }
        }
        Ok(None) => {}
        Err(error) => tracing::warn!(%error, "chat: expired message not read"),
    }
}

/// A stop speaks for the person, so only a person's device (a human key) may make one.
fn stop_caller(caller: &Caller, tool: &str, r: &ProjectRef) -> Result<(), ToolError> {
    crate::hub::orders::notes::require_human(caller, tool)?;
    require(caller, Role::Operate, Some(&r.machine_id))
}

/// Interrupts the lead's turn now, also one held on a permission prompt. True when it had one.
async fn stop_lead(hub: &Hub, r: &ProjectRef) -> Result<bool, ToolError> {
    let Some(thread) = lead_thread(hub, r) else {
        return Ok(false);
    };
    let mid_turn = hub
        .store
        .thread_get(&thread)
        .map_err(store_error)?
        .is_some_and(|t| {
            matches!(
                t.thread.status,
                ThreadStatus::Running | ThreadStatus::Waiting
            )
        });
    if !mid_turn {
        return Ok(false);
    }
    hub.executors
        .interrupt_now(&thread)
        .await
        .map_err(crate::hub::executor::tools::from_executor)?;
    Ok(true)
}

fn agents(n: i64) -> String {
    if n == 1 {
        "1 agent".into()
    } else {
        format!("{n} agents")
    }
}

/// What one stop did: orders stopped, agents cancelled, and its chat line.
struct Stopped {
    orders: i64,
    agents: i64,
    /// The lead's turn or an agent stopped.
    any: bool,
    text: String,
}

/// The one stop behind the chat's Stop and `project_stop`: the lead's turn is interrupted, every open order of the
/// project stops (its PRs off the train, its agents cancelled, what waits on a person withdrawn), any other agent of the project is
/// cancelled, and the line says what stopped and what still runs.
async fn stop_all(
    hub: &Arc<Hub>,
    caller: &Caller,
    r: &ProjectRef,
    reason: Option<fleetd_contracts::prim::Text<1, 200>>,
) -> Result<Stopped, ToolError> {
    // The lead first, so it starts no new agents while they stop. None: its machine didn't answer.
    let lead = match stop_lead(hub, r).await {
        Ok(stopped) => Some(stopped),
        Err(e) => {
            tracing::warn!(error = %e.message, "stop: lead not interrupted");
            None
        }
    };
    let open = hub
        .leads
        .records
        .workstreams_list(&WorkstreamFilter {
            project_ref: Some(r.clone()),
            state: Some(WorkstreamState::Open),
            limit: 200,
        })
        .map_err(store_error)?;
    let (mut orders, mut cancelled, mut off_train) = (0, 0, Vec::new());
    for w in &open {
        let why = reason.as_ref().map(|r| r.as_str());
        match crate::hub::orders::notes::stop(hub, caller, w.workstream_id.as_str(), why).await {
            Ok((n, prs)) => {
                orders += 1;
                cancelled += n;
                off_train.extend(prs);
            }
            Err(e) => {
                tracing::warn!(workstream = %w.workstream_id, error = %e.message, "stop: order not stopped")
            }
        }
    }
    // Agents of orders that already ended.
    let by = crate::hub::tasks::TaskCaller {
        project_ref: r.clone(),
        by: caller.key_id.to_string(),
    };
    for (task_id, _) in hub.tasks.live(Some(r)) {
        match hub
            .tasks
            .cancel(
                &by,
                &task_id,
                Some("Cancelled: the human stopped all work."),
            )
            .await
        {
            Ok(_) => cancelled += 1,
            Err(e) => {
                tracing::warn!(task = %task_id, error = %e.message, "stop: agent not stopped")
            }
        }
    }
    let left = hub.tasks.live(Some(r)).len();
    let what = match (lead == Some(true), cancelled) {
        (true, 0) => Some("the lead".to_owned()),
        (true, n) => Some(format!("the lead and {}", agents(n))),
        (false, 0) => None,
        (false, n) => Some(agents(n)),
    };
    let any = what.is_some();
    let mut text = match what {
        Some(what) => format!("Stopped {what}."),
        // Only when it is true: the lead answered idle and no agent runs.
        None if left == 0 && lead.is_some() => "Nothing was running.".to_owned(),
        None => "Nothing stopped.".to_owned(),
    };
    if lead.is_none() {
        text.push_str(" The lead's turn could not be stopped: its machine didn't answer.");
    }
    match left {
        0 => {}
        1 => text.push_str(" 1 agent could not be stopped and is still working."),
        n => text.push_str(&format!(
            " {n} agents could not be stopped and are still working."
        )),
    }
    if !off_train.is_empty() {
        let prs: Vec<_> = off_train.iter().map(|n| format!("#{n}")).collect();
        text.push_str(&format!(" Left open, off the train: {}.", prs.join(", ")));
    }
    Ok(Stopped {
        orders,
        agents: cancelled,
        any,
        text,
    })
}

/// `chat_stop`: the chat's Stop, the same stop as `project_stop`. The same clientRequestId returns the line it wrote
/// and stops nothing again.
pub async fn chat_stop(
    hub: &Arc<Hub>,
    caller: &Caller,
    input: ChatStopInput,
) -> Result<ChatStopOutput, ToolError> {
    let r = input.project_ref.clone();
    stop_caller(caller, "chat_stop", &r)?;
    let source = format!("stop:{}:{}", caller.key_id, input.client_request_id);
    if let Some(message) = hub.chat.by_source(&r, &source).map_err(store_error)? {
        return Ok(ChatStopOutput {
            stopped: message.text.as_str().starts_with("Stopped"),
            message,
            next: None,
            truncated: None,
        });
    }
    let done = stop_all(hub, caller, &r, None).await?;
    ensure(hub, &r).await.map_err(store_error)?;
    let (message, _) = hub
        .chat
        .add(
            &r,
            NewMessage {
                author: Some(ChatAuthor::System),
                text: done.text,
                source: Some(source),
                ..Default::default()
            },
        )
        .map_err(store_error)?;
    state(hub, &r).map_err(store_error)?;
    Ok(ChatStopOutput {
        stopped: done.any,
        message,
        next: None,
        truncated: None,
    })
}

/// `project_stop`: [`stop_all`], with counts. The lead hears it; the lead and the chat stay.
pub async fn project_stop(
    hub: &Arc<Hub>,
    caller: &Caller,
    input: ProjectStopInput,
) -> Result<ProjectStopOutput, ToolError> {
    let r = input.project_ref.clone();
    stop_caller(caller, "project_stop", &r)?;
    let done = stop_all(hub, caller, &r, input.reason).await?;
    ensure(hub, &r).await.map_err(store_error)?;
    let message = hub.chat.system_line(&r, &done.text).map_err(store_error)?;
    state(hub, &r).map_err(store_error)?;
    Ok(ProjectStopOutput {
        stopped: Count::unchecked(done.orders),
        cancelled: Count::unchecked(done.agents),
        message,
        next: Some("Tell the lead in the chat what to do next.".into()),
        truncated: None,
    })
}

/// Lands the lead's replies of its session as chat messages: new ones added, streamed ones finished with their
/// complete text. Messages from before the chat read in as history. Once the lead's run is over, a reply it never
/// stored complete (the run was stopped, interrupted or crashed mid-text) is finished with the text it streamed.
pub(super) async fn mirror(hub: &Hub, r: &ProjectRef, thread: &ThreadRef) {
    if let Err(error) = ensure(hub, r).await {
        return tracing::warn!(%error, "chat: history not read");
    }
    let messages = hub
        .executors
        .messages(thread)
        .await
        .unwrap_or_else(|error| {
            tracing::debug!(%error, "chat: lead messages not read");
            Vec::new()
        });
    let since = hub.chat.history_ms(r).ok().flatten().unwrap_or(0);
    for m in history::lead_messages(thread.thread_id.as_str(), &messages) {
        let source = m.source.clone().unwrap_or_default();
        match hub.chat.by_source(r, &source) {
            Ok(Some(mut existing)) => {
                if existing.state == fleetd_contracts::chat::ChatMessageState::Streaming
                    && let Err(error) = hub.chat.finish(&mut existing, &m.text)
                {
                    tracing::warn!(%error, "chat: streamed message not finished");
                }
            }
            Ok(None) => {
                let old = m.created_ms.unwrap_or(0) < since;
                let new = NewMessage {
                    history: old.then_some(ChatHistorySource::LeadMessage),
                    ..m
                };
                if let Err(error) = hub.chat.add(r, new) {
                    tracing::warn!(%error, "chat: lead message not added");
                }
            }
            Err(error) => tracing::warn!(%error, "chat: lead message not read"),
        }
    }
    if run_over(hub, thread) {
        let prefix = history::lead_source(thread.thread_id.as_str(), "");
        for mut cut in hub.chat.streaming_from(r, &prefix).unwrap_or_default() {
            let text = cut.text.as_str().trim().to_owned();
            if let Err(error) = hub.chat.finish(&mut cut, &text) {
                tracing::warn!(%error, "chat: cut-off reply not finished");
            }
        }
    }
    if let Err(error) = state(hub, r) {
        tracing::warn!(%error, "chat: state not told");
    }
}

/// The thread's run ended: not running, and not paused on a request it resumes from.
fn run_over(hub: &Hub, thread: &ThreadRef) -> bool {
    hub.store
        .thread_get(thread)
        .ok()
        .flatten()
        .is_some_and(|t| {
            !matches!(
                t.thread.status,
                ThreadStatus::Running | ThreadStatus::Waiting
            )
        })
}

/// Folds each working lead's streamed text into its chat: the first text of a reply starts a streaming message,
/// later text appends to it, and once the reply is complete it lands whole and final, even when a delta never came
/// or the reply reached the hub after its run ended.
fn stream_pass(hub: &Hub, sent: &mut HashMap<String, u64>) {
    stream_pass_with(hub, sent, |thread| hub.executors.live(thread));
}

/// `sent` for a reply that landed whole: nothing more streams into it.
const LANDED: u64 = u64::MAX;

pub(super) fn stream_pass_with(
    hub: &Hub,
    sent: &mut HashMap<String, u64>,
    live_parts: impl Fn(&ThreadRef) -> Option<crate::hub::executor::LiveParts>,
) {
    let Ok(leads) = hub.leads.records.leads_list() else {
        return;
    };
    let mut live = std::collections::HashSet::new();
    for lead in leads {
        let r = lead.project_ref;
        let thread = ThreadRef {
            machine_id: r.machine_id.clone(),
            thread_id: lead.thread_id,
        };
        let Some(parts) = live_parts(&thread).filter(|p| p.run_active || !p.done.is_empty()) else {
            continue;
        };
        if !hub.chat.history_read(&r).unwrap_or(false) {
            continue;
        }
        // The complete replies first: they were said before the one streaming now.
        for done in &parts.done {
            let source = history::lead_source(thread.thread_id.as_str(), &done.message_id);
            live.insert(source.clone());
            if sent.get(&source) != Some(&LANDED) && land(hub, &r, &source, done.text.trim()) {
                sent.insert(source, LANDED);
            }
        }
        let Some(text) = parts.text.filter(|_| parts.run_active) else {
            continue;
        };
        let source = history::lead_source(thread.thread_id.as_str(), &text.message_id);
        live.insert(source.clone());
        let done = sent.get(&source).copied().unwrap_or(0);
        if text.total <= done {
            continue;
        }
        let append = text.since(done).to_owned();
        // A turn that ends with no text, or with the quiet reply, posts nothing: no bubble opens before the reply
        // has words in it that can't still turn out to be `QUIET`.
        if done == 0 && history::QUIET.starts_with(append.trim()) {
            continue;
        }
        let message = match hub.chat.by_source(&r, &source) {
            Ok(Some(m)) => Some(m),
            Ok(None) => hub
                .chat
                .add(
                    &r,
                    NewMessage {
                        author: Some(ChatAuthor::Lead),
                        streaming: true,
                        source: Some(source.clone()),
                        ..Default::default()
                    },
                )
                .ok()
                .map(|(m, _)| m),
            Err(_) => None,
        };
        let Some(mut message) =
            message.filter(|m| m.state == fleetd_contracts::chat::ChatMessageState::Streaming)
        else {
            sent.insert(source, text.total);
            continue;
        };
        if let Err(error) = hub.chat.append(&mut message, &append) {
            tracing::warn!(%error, "chat: streamed text not kept");
            continue;
        }
        sent.insert(source, text.total);
    }
    sent.retain(|source, _| live.contains(source));
}

/// A complete reply in the chat: its streaming message finished, or a final one added when none streamed. False
/// when the store failed, to try again on the next tick.
fn land(hub: &Hub, r: &ProjectRef, source: &str, text: &str) -> bool {
    if !history::said(text) {
        return true;
    }
    let result = match hub.chat.by_source(r, source) {
        Ok(Some(mut m)) if m.state == fleetd_contracts::chat::ChatMessageState::Streaming => {
            hub.chat.finish(&mut m, text)
        }
        Ok(Some(_)) => Ok(()),
        Ok(None) => hub
            .chat
            .add(
                r,
                NewMessage {
                    author: Some(ChatAuthor::Lead),
                    text: text.to_owned(),
                    source: Some(source.to_owned()),
                    ..Default::default()
                },
            )
            .map(|_| ()),
        Err(error) => Err(error),
    };
    if let Err(error) = &result {
        tracing::warn!(%error, "chat: complete reply not landed");
    }
    result.is_ok()
}

/// The project whose lead runs in `thread`.
fn lead_project(hub: &Hub, thread: &ThreadRef) -> Option<ProjectRef> {
    hub.leads
        .records
        .leads_list()
        .ok()?
        .into_iter()
        .find(|l| l.thread_id == thread.thread_id && l.project_ref.machine_id == thread.machine_id)
        .map(|l| l.project_ref)
}

/// Lands every reply of the leads (on `machine`, else everywhere) that isn't in their chat yet: one said while the hub
/// was down, or while it couldn't read the lead's machine. On the hub's start a node is rarely linked yet, so its
/// coming online is the read that counts. Idempotent by each reply's `source`.
pub(super) async fn land_missed(hub: &Hub, machine: Option<&MachineId>) {
    let Ok(leads) = hub.leads.records.leads_list() else {
        return;
    };
    for lead in leads {
        let r = lead.project_ref;
        if machine.is_some_and(|m| *m != r.machine_id)
            || !hub.chat.history_read(&r).unwrap_or(false)
        {
            continue;
        }
        let thread = ThreadRef {
            machine_id: r.machine_id.clone(),
            thread_id: lead.thread_id,
        };
        mirror(hub, &r, &thread).await;
    }
}

/// Follows the leads until the hub stops: their turns starting and ending (the chat's working state, their replies
/// landing), a lead starting (messages held for it go in), and their streamed text.
pub async fn run(hub: Arc<Hub>) {
    let streamer = {
        let hub = hub.clone();
        tokio::spawn(async move {
            let mut sent = HashMap::new();
            loop {
                hub.clock.sleep(STREAM_TICK).await;
                stream_pass(&hub, &mut sent);
            }
        })
    };
    // The cursor first: a request that moves while the start shows the open ones (the approvals service reopens
    // unfinished commands at the same time) is an event after it, followed below. Showing is safe to repeat.
    let mut cursor = startup(&hub).await;
    land_missed(&hub, None).await;
    // Held messages from before a restart, and every minute after, go when they can.
    let sweeper = {
        let hub = hub.clone();
        tokio::spawn(async move {
            loop {
                for r in hub.chat.held_projects().unwrap_or_default() {
                    send_held(&hub, &r).await;
                }
                hub.clock.sleep(HELD_RETRY).await;
            }
        })
    };
    let types = vec![
        HubEventType::ThreadStarted,
        HubEventType::ThreadCompleted,
        HubEventType::ThreadFailed,
        HubEventType::ThreadInterrupted,
        HubEventType::ThreadWaiting,
        HubEventType::LeadStarted,
        HubEventType::MachineOnline,
        HubEventType::WriteExpired,
        HubEventType::RequestOpened,
        HubEventType::RequestUpdated,
        HubEventType::AgentsCap,
    ];
    loop {
        let page = match hub
            .events
            .wait(WaitInput {
                cursor: Some(cursor),
                types: Some(types.clone()),
                machine_id: None,
                timeout_sec: 3600,
            })
            .await
        {
            Ok(page) => page,
            Err(error) => {
                tracing::warn!(%error, "chat: event log read failed");
                hub.clock.sleep(Duration::from_secs(1)).await;
                continue;
            }
        };
        cursor = page.cursor;
        for event in page.events {
            match event.r#type {
                HubEventType::AgentsCap => {
                    cap_line(
                        &hub,
                        event.seq.get(),
                        event.data.as_ref(),
                        event.summary.as_str(),
                    )
                    .await;
                    continue;
                }
                HubEventType::RequestOpened | HubEventType::RequestUpdated => {
                    if let Some(id) = event.data.as_ref().and_then(|d| d["requestId"].as_str()) {
                        show_request(&hub, id).await;
                    }
                    continue;
                }
                HubEventType::WriteExpired => {
                    if let Some(data) = &event.data {
                        expired(&hub, data);
                    }
                    continue;
                }
                HubEventType::MachineOnline => {
                    if let Some(machine) = event.machine_id.clone() {
                        let hub = hub.clone();
                        tokio::spawn(async move {
                            // machine.online can be logged before the hub's subscription to the node is live.
                            let live = hub.executors.await_live(&machine);
                            let _ = tokio::time::timeout(LINK_WAIT, live).await;
                            land_missed(&hub, Some(&machine)).await;
                        });
                    }
                    for r in hub.chat.held_projects().unwrap_or_default() {
                        if Some(&r.machine_id) == event.machine_id.as_ref() {
                            send_held(&hub, &r).await;
                        }
                    }
                    continue;
                }
                _ => {}
            }
            let (Some(machine_id), Some(thread_id)) = (event.machine_id, event.thread_id) else {
                continue;
            };
            let thread = ThreadRef {
                machine_id,
                thread_id,
            };
            let Some(r) = lead_project(&hub, &thread) else {
                continue;
            };
            match event.r#type {
                HubEventType::LeadStarted => send_held(&hub, &r).await,
                HubEventType::ThreadStarted => {
                    if let Err(error) = state(&hub, &r) {
                        tracing::warn!(%error, "chat: state not told");
                    }
                }
                _ => mirror(&hub, &r, &thread).await,
            }
        }
        if streamer.is_finished() || sweeper.is_finished() {
            return;
        }
    }
}

/// For the snapshot and fleetd_status: every project's chat state.
pub fn states(hub: &Hub) -> Vec<ProjectChatState> {
    let Ok(projects) = hub.store.projects_shown(None, None) else {
        return Vec::new();
    };
    projects
        .into_iter()
        .take(50)
        .filter_map(|p| {
            let r = ProjectRef {
                machine_id: p.machine_id,
                project_id: p.project_id,
            };
            hub.chat.state(&r, lead_working(hub, &r)).ok()
        })
        .collect()
}
