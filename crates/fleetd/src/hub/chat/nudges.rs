//! Nudges: a message worth the person's look, a showcase, something to try or a risk. The lead flags the message it
//! just wrote with `nudge`. One waits, below what the lead waits on you for, until the person has seen its message or
//! dismissed it (`chat_nudge_clear`), and fades on its own after a day, marked expired the next time the project's
//! nudges are read; a project keeps [`CHAT_NUDGES_MAX`] waiting, a newer one past that clearing the oldest. In the app
//! only: it sends no notification.
use std::sync::{Arc, Weak};

use fleetd_contracts::chat::{
    CHAT_NUDGE_MS, CHAT_NUDGES_MAX, CHAT_OPEN_NUDGES_MAX, ChatAuthor, ChatMessage,
    ChatMessageState, ChatNudge, ChatNudgeCleared, ChatOpenNudge, NudgeCall, NudgeResult,
};
use fleetd_contracts::ids::{ProjectRef, ThreadRef};
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::mcp::{ChatNudgeClearInput, ChatNudgeClearOutput, ErrorCode, McpToolError};
use fleetd_contracts::prim::{Line, True};
use rusqlite::params;

use super::{Chat, flow, history};
use crate::hub::api::{Caller, Hub, ToolError, require};
use crate::hub::executor::LiveParts;
use crate::hub::link::lead_calls::{CallerAgent, LeadCallFuture, op_of};
use crate::hub::link::{LeadCaller, LeadCalls};
use crate::hub::store::{StoreError, iso_ms, parse_ms};

/// How long a nudge for a reply not yet in the chat waits for it to land.
const PENDING_MS: i64 = 10 * 60_000;

/// The project's messages whose nudge waits, by the condition of the partial index `chat_nudges_waiting` (store
/// migrations), so a chat state read finds them without reading the rest of the chat.
pub(super) const WAITING: &str =
    "SELECT data FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2
     AND json_extract(data, '$.nudge') IS NOT NULL
     AND json_extract(data, '$.nudge.cleared') IS NULL ORDER BY seq";

/// A reason as a nudge holds it: one line, cut to fit.
pub fn reason_of(text: &str) -> Option<Line<1, 200>> {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let cut = if line.chars().count() > 200 {
        format!("{}…", line.chars().take(199).collect::<String>())
    } else {
        line
    };
    Line::new(cut).ok()
}

/// Whether a nudge still waits at `now`: not cleared, and less than a day old.
pub fn waiting(nudge: &ChatNudge, now: i64) -> bool {
    nudge.cleared.is_none()
        && parse_ms(nudge.at.as_str()).is_some_and(|at| now - at < CHAT_NUDGE_MS)
}

impl Chat {
    /// The project's nudges still waiting, oldest first. Those a day old are marked expired as they are found, quietly
    /// (the app lets them fade on its own clock), so they are not read again.
    pub fn open_nudges(&self, r: &ProjectRef) -> Result<Vec<ChatMessage>, StoreError> {
        let now = self.now();
        let open: Vec<ChatMessage> = self.db.with(|c| {
            let rows: Vec<String> = c
                .prepare_cached(WAITING)?
                .query_map(
                    params![r.machine_id.as_str(), r.project_id.as_str()],
                    |row| row.get(0),
                )?
                .collect::<rusqlite::Result<_>>()?;
            Ok(rows
                .into_iter()
                .filter_map(|d| serde_json::from_str::<ChatMessage>(&d).ok())
                .collect())
        })?;
        let (mut open, faded): (Vec<ChatMessage>, Vec<ChatMessage>) = open
            .into_iter()
            .partition(|m| m.nudge.as_ref().is_some_and(|n| waiting(n, now)));
        for m in faded {
            self.update(&m.message_id, |m| {
                let Some(n) = m.nudge.as_mut().filter(|n| n.cleared.is_none()) else {
                    return false;
                };
                n.cleared = Some(ChatNudgeCleared::Expired);
                true
            })?;
        }
        open.sort_by_key(|m| {
            let at = m.nudge.as_ref().and_then(|n| parse_ms(n.at.as_str()));
            (at, m.seq.get())
        });
        Ok(open)
    }

    /// The waiting nudges as a chat state lists them.
    pub(super) fn nudges_listed(&self, r: &ProjectRef) -> Result<Vec<ChatOpenNudge>, StoreError> {
        Ok(self
            .open_nudges(r)?
            .into_iter()
            .filter_map(|m| {
                let n = m.nudge?;
                Some(ChatOpenNudge {
                    message_id: m.message_id,
                    reason: n.reason,
                    at: n.at,
                })
            })
            .take(CHAT_OPEN_NUDGES_MAX)
            .collect())
    }

    /// Flags `message` for the person's look, announced; on one already flagged, its reason and time are new, and one
    /// seen or dismissed waits again. Past the cap, the oldest waiting nudge of its kind is replaced.
    /// Set on the stored message, so streamed text written since the caller read it stays.
    pub fn nudge(
        &self,
        message: ChatMessage,
        reason: Line<1, 200>,
    ) -> Result<ChatMessage, StoreError> {
        let nudge = self.make_room(&message, reason)?;
        let now = self.now_ts();
        let flagged = self.update(&message.message_id, |m| {
            m.nudge = Some(nudge);
            m.updated_at = Some(now);
            true
        })?;
        let Some(message) = flagged else {
            return Ok(message);
        };
        self.announce(&message)?;
        Ok(message)
    }

    /// The nudge for `message`, with room made for it: past its kind's cap, the oldest waiting one is replaced.
    fn make_room(
        &self,
        message: &ChatMessage,
        reason: Line<1, 200>,
    ) -> Result<ChatNudge, StoreError> {
        let now = self.now();
        let others: Vec<ChatMessage> = self
            .open_nudges(&message.project_ref)?
            .into_iter()
            .filter(|m| m.message_id != message.message_id)
            .collect();
        let over = (others.len() + 1).saturating_sub(CHAT_NUDGES_MAX);
        for old in others.into_iter().take(over) {
            self.clear_nudge(old, ChatNudgeCleared::Replaced)?;
        }
        Ok(ChatNudge {
            reason,
            at: iso_ms(now).into(),
            cleared: None,
        })
    }

    /// The nudge no longer waits: seen, dismissed or replaced. False when it wasn't waiting.
    pub fn clear_nudge(
        &self,
        message: ChatMessage,
        how: ChatNudgeCleared,
    ) -> Result<bool, StoreError> {
        let now = self.now_ts();
        let cleared = self.update(&message.message_id, |m| {
            let Some(nudge) = m.nudge.as_mut().filter(|n| n.cleared.is_none()) else {
                return false;
            };
            nudge.cleared = Some(how);
            m.updated_at = Some(now);
            true
        })?;
        match cleared {
            Some(m) => self.announce(&m).map(|()| true),
            None => Ok(false),
        }
    }

    /// Flags the message `source` names once it lands, for a reply the lead nudged before the chat had it.
    pub fn nudge_on_landing(&self, source: &str, reason: Line<1, 200>) {
        let now = self.now();
        let mut pending = self.pending_nudges.lock().unwrap();
        pending.retain(|_, (_, at)| now - *at < PENDING_MS);
        pending.insert(source.to_owned(), (reason, now));
    }

    /// A new message's nudge, its own or one that waited for its source: set on it before it is announced.
    pub(super) fn landed(
        &self,
        source: Option<&str>,
        nudge: Option<Line<1, 200>>,
        message: &mut ChatMessage,
    ) -> Result<(), StoreError> {
        let now = self.now();
        let waited = source.and_then(|source| {
            let mut pending = self.pending_nudges.lock().unwrap();
            pending
                .remove(source)
                .filter(|(_, at)| now - *at < PENDING_MS)
                .map(|(reason, _)| reason)
        });
        match nudge.or(waited) {
            Some(reason) => {
                message.nudge = Some(self.make_room(message, reason)?);
                message.updated_at = Some(self.now_ts());
                self.put(message)
            }
            None => Ok(()),
        }
    }
}

pub fn register_lead_calls(hub: &Arc<Hub>) {
    let weak: Weak<Hub> = Arc::downgrade(hub);
    let handler = Arc::new(
        move |caller: LeadCaller, call: LeadCall| -> LeadCallFuture {
            let hub = weak.upgrade();
            Box::pin(async move {
                let hub = hub.ok_or_else(|| {
                    McpToolError::new(ErrorCode::Invalid, "The hub is shutting down.")
                })?;
                match call {
                    LeadCall::Nudge(call) => nudge(&hub, &caller, call, |t| hub.executors.live(t))
                        .map(LeadCallResult::Nudge),
                    other => Err(McpToolError::new(
                        ErrorCode::Invalid,
                        format!("{} is not a nudge.", op_of(&other)),
                    )),
                }
            })
        },
    );
    let calls: &LeadCalls = &hub.lead_calls;
    calls.register("nudge", handler);
}

/// The source of the lead's newest reply of its run, from what its node streamed: the text streaming now when the
/// node hasn't stored it complete yet, else the last one it stored. Streamed text the chat already holds final is an
/// earlier run's.
fn newest_reply(hub: &Hub, r: &ProjectRef, parts: LiveParts, thread: &ThreadRef) -> Option<String> {
    let source = |id: &str| history::lead_source(thread.thread_id.as_str(), id);
    if let Some(text) = parts
        .text
        .as_ref()
        .filter(|t| parts.run_active && !parts.done.iter().any(|d| d.message_id == t.message_id))
    {
        let s = source(&text.message_id);
        let earlier = hub
            .chat
            .by_source(r, &s)
            .ok()
            .flatten()
            .is_some_and(|m| m.state == ChatMessageState::Final);
        if !earlier {
            return Some(s);
        }
    }
    parts.done.last().map(|d| source(&d.message_id))
}

/// The lead's `nudge`: flags its reply of this turn, the one it just wrote. A reply the chat doesn't have yet is
/// flagged as it lands.
pub(super) fn nudge(
    hub: &Hub,
    caller: &LeadCaller,
    call: NudgeCall,
    live: impl Fn(&ThreadRef) -> Option<LiveParts>,
) -> Result<NudgeResult, McpToolError> {
    if caller.agent != CallerAgent::Lead {
        return Err(McpToolError::new(
            ErrorCode::Forbidden,
            "Only a project's lead nudges, and only its own messages.",
        ));
    }
    let r = &caller.project_ref;
    let store = |e: StoreError| {
        tracing::error!(error = %e, "nudge");
        McpToolError::new(ErrorCode::Failed, "The chat couldn't be read.")
    };
    let source = flow::lead_thread(hub, r).and_then(|t| newest_reply(hub, r, live(&t)?, &t));
    let Some(source) = source else {
        return Err(McpToolError::new(
            ErrorCode::Invalid,
            "You haven't written anything this turn to flag.",
        )
        .with_fix("Write the message in the chat first, then call nudge."));
    };
    let Some(message) = hub
        .chat
        .by_source(r, &source)
        .map_err(store)?
        .filter(|m| m.author == ChatAuthor::Lead)
    else {
        hub.chat.nudge_on_landing(&source, call.reason);
        return Ok(NudgeResult {
            message_id: None,
            next: Some(
                "Flagged: the person sees it as something to look at once it is in the chat."
                    .into(),
            ),
        });
    };
    let message = hub.chat.nudge(message, call.reason).map_err(store)?;
    flow::state(hub, r).map_err(store)?;
    Ok(NudgeResult {
        message_id: Some(message.message_id),
        next: Some(
            "Flagged: the person sees it as something to look at until they have seen it.".into(),
        ),
    })
}

/// `chat_nudge_clear`: the person has seen a nudge's message, or dismissed it.
pub(super) async fn chat_nudge_clear(
    hub: Arc<Hub>,
    caller: Caller,
    input: ChatNudgeClearInput,
) -> Result<ChatNudgeClearOutput, ToolError> {
    crate::hub::orders::notes::require_human(&caller, "chat_nudge_clear")?;
    let r = &input.project_ref;
    require(
        &caller,
        fleetd_contracts::auth::Role::Operate,
        Some(&r.machine_id),
    )?;
    let message = hub
        .chat
        .by_id(input.message_id.as_str())?
        .filter(|m| &m.project_ref == r)
        .ok_or_else(|| {
            ToolError::new(
                ErrorCode::NotFound,
                format!("No message {} in this chat.", input.message_id),
            )
        })?;
    let how = if input.dismissed == Some(true) {
        ChatNudgeCleared::Dismissed
    } else {
        ChatNudgeCleared::Seen
    };
    if hub.chat.clear_nudge(message, how)? {
        flow::state(&hub, r)?;
    }
    Ok(ChatNudgeClearOutput {
        ok: True,
        next: None,
        truncated: None,
    })
}

#[cfg(test)]
#[path = "nudges_tests.rs"]
mod tests;
