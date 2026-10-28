//! A Navi reads back through its own chat: `chat_search` finds the messages holding some words, in a date range or
//! not, newest first and a page at a time, and `chat_read` reads the messages around one of them. A fresh session sees
//! only the latest part of the chat; these reach all of it, so "what I said last week" is found, not guessed.
//!
//! Plain text matching over the stored chat (`ChatStore::search`), nothing more. Only a Navi's own lead makes these
//! calls ([`super::bridge::may_use`], then [`CallerAgent::Lead`]): the chat is always the caller's own project's, so
//! another project's chat, or another person's Navi, is never read. A message id from another chat is refused.
use std::sync::{Arc, Weak};

use fleetd_contracts::chat::ChatMessage;
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::navi::{
    CHAT_SEARCH_PAGE, ChatReadCall, ChatReadResult, ChatSearchCall, ChatSearchResult,
    RecalledMessage,
};

use crate::hub::api::Hub;
use crate::hub::link::LeadCaller;
use crate::hub::link::lead_calls::{CallerAgent, LeadCallFuture, op_of};
use crate::hub::store::{StoreError, parse_ms};

#[cfg(test)]
#[path = "recall_tests.rs"]
mod tests;

pub const OPS: [&str; 2] = ["chat_search", "chat_read"];
/// The characters of a hit `chat_search` shows, around the first of its words.
const HIT_CHARS: usize = 300;
/// The characters of each message `chat_read` shows, unless it reads one message alone.
const READ_CHARS: usize = 2000;
/// Messages `chat_read` reads on each side when not told.
const SIDE: i64 = 5;

pub fn register_lead_calls(hub: &Arc<Hub>) {
    let weak: Weak<Hub> = Arc::downgrade(hub);
    let handler = Arc::new(
        move |caller: LeadCaller, call: LeadCall| -> LeadCallFuture {
            let hub = weak.upgrade();
            Box::pin(async move {
                let hub = hub.ok_or_else(|| {
                    McpToolError::new(ErrorCode::Invalid, "The hub is shutting down.")
                })?;
                answer(&hub, &caller, call)
            })
        },
    );
    for op in OPS {
        hub.lead_calls.register(op, handler.clone());
    }
}

fn failed(e: StoreError) -> McpToolError {
    tracing::error!(error = %e, "navi recall store");
    McpToolError::new(ErrorCode::Failed, "The hub failed to read the chat.")
}

fn answer(hub: &Hub, caller: &LeadCaller, call: LeadCall) -> Result<LeadCallResult, McpToolError> {
    super::bridge::may_use(&hub.db, &caller.project_ref)?;
    if caller.agent != CallerAgent::Lead {
        return Err(McpToolError::new(
            ErrorCode::Forbidden,
            "Only the Navi itself reads back through its chat.",
        )
        .with_fix("The person reads the chat in the app."));
    }
    match call {
        LeadCall::ChatSearch(call) => Ok(LeadCallResult::ChatSearch(search(hub, caller, &call)?)),
        LeadCall::ChatRead(call) => Ok(LeadCallResult::ChatRead(read(hub, caller, &call)?)),
        other => Err(McpToolError::new(
            ErrorCode::Invalid,
            format!("{} is not a chat recall call.", op_of(&other)),
        )),
    }
}

fn search(
    hub: &Hub,
    caller: &LeadCaller,
    call: &ChatSearchCall,
) -> Result<ChatSearchResult, McpToolError> {
    let r = &caller.project_ref;
    let words: Vec<&str> = call.words.as_str().split_whitespace().collect();
    if words.is_empty() {
        return Err(McpToolError::new(
            ErrorCode::Invalid,
            "Give at least one word to look for.",
        ));
    }
    let from = call
        .from
        .as_ref()
        .map(|d| when(d.as_str(), false))
        .transpose()?;
    let to = call
        .to
        .as_ref()
        .map(|d| when(d.as_str(), true))
        .transpose()?;
    let before = match &call.before {
        Some(id) => Some(own_seq(hub, caller, id.as_str())?),
        None => None,
    };
    let (found, more) = hub
        .chat
        .search(r, &words, from, to, before, CHAT_SEARCH_PAGE)
        .map_err(failed)?;
    let messages: Vec<RecalledMessage> = found
        .iter()
        .map(|m| recalled(m, &words, HIT_CHARS))
        .collect();
    let next = match (messages.last(), more) {
        (None, _) if before.is_some() => Some("No older messages hold all of those words.".to_owned()),
        (None, _) => Some(
            "Nothing in the chat holds all of those words. Try fewer or other words, or a wider date range.".to_owned(),
        ),
        (Some(last), true) => Some(format!(
            "Older hits are left: call chat_search again with before: \"{}\". chat_read with a messageId reads the \
             messages around one.",
            last.message_id
        )),
        (Some(_), false) => Some("chat_read with a messageId reads the messages around one.".to_owned()),
    };
    Ok(ChatSearchResult {
        messages,
        more: more.then_some(true),
        next,
    })
}

fn read(
    hub: &Hub,
    caller: &LeadCaller,
    call: &ChatReadCall,
) -> Result<ChatReadResult, McpToolError> {
    let seq = own_seq(hub, caller, call.message_id.as_str())?;
    let before = call.before.map_or(SIDE, |n| n.get()) as usize;
    let after = call.after.map_or(SIDE, |n| n.get()) as usize;
    let (found, more_before, more_after) = hub
        .chat
        .around(&caller.project_ref, seq, before, after)
        .map_err(failed)?;
    // One message alone reads whole.
    let max = if before == 0 && after == 0 {
        usize::MAX
    } else {
        READ_CHARS
    };
    let messages: Vec<RecalledMessage> = found.iter().map(|m| recalled(m, &[], max)).collect();
    let next = (more_before || more_after).then(|| {
        "chat_read again with the first message's id and before, or the last one's and after, reads further."
            .to_owned()
    });
    Ok(ChatReadResult {
        messages,
        more_before,
        more_after,
        next,
    })
}

/// The seq of message `id` in the caller's own chat; any other chat's message is refused as unknown.
fn own_seq(hub: &Hub, caller: &LeadCaller, id: &str) -> Result<i64, McpToolError> {
    hub.chat
        .seq_in(&caller.project_ref, id)
        .map_err(failed)?
        .ok_or_else(|| {
            McpToolError::new(
                ErrorCode::NotFound,
                format!("{id} is not a message of this chat."),
            )
            .with_fix("Use a messageId chat_search returned.")
        })
}

/// A date (2026-10-20, in UTC: its start, or with `end` its last moment) or a time, as ms.
fn when(text: &str, end: bool) -> Result<i64, McpToolError> {
    let text = text.trim();
    if let Ok(day) = chrono::NaiveDate::parse_from_str(text, "%Y-%m-%d") {
        let start = day
            .and_hms_opt(0, 0, 0)
            .unwrap_or_default()
            .and_utc()
            .timestamp_millis();
        return Ok(if end { start + 86_400_000 - 1 } else { start });
    }
    parse_ms(text).ok_or_else(|| {
        McpToolError::new(
            ErrorCode::Invalid,
            format!("{text} is not a date or a time."),
        )
        .with_fix("Give a day, 2026-10-20, or a time, 2026-10-20T09:00:00Z.")
    })
}

fn recalled(m: &ChatMessage, words: &[&str], max: usize) -> RecalledMessage {
    let (text, cut) = excerpt(m.text.as_str(), words, max);
    RecalledMessage {
        message_id: m.message_id.clone(),
        at: m.created_at.clone(),
        author: m.author,
        by: m.by.as_ref().map(|b| b.to_string()),
        text,
        cut: cut.then_some(true),
    }
}

/// At most `max` characters of `text`, starting a little before the first of `words` it holds, and whether it was
/// cut.
fn excerpt(text: &str, words: &[&str], max: usize) -> (String, bool) {
    let total = text.chars().count();
    if total <= max {
        return (text.to_owned(), false);
    }
    let lower = text.to_lowercase();
    // Lowercasing that changes a text's length would move the hit: read it from the start then.
    let hit = (lower.len() == text.len())
        .then(|| {
            words
                .iter()
                .filter_map(|w| lower.find(&w.to_lowercase()))
                .min()
                .filter(|at| text.is_char_boundary(*at))
        })
        .flatten()
        .map_or(0, |at| text[..at].chars().count());
    let start = hit.saturating_sub(max / 3).min(total.saturating_sub(max));
    let mut out: String = text.chars().skip(start).take(max).collect();
    if start > 0 {
        out = format!("…{out}");
    }
    if start + max < total {
        out.push('…');
    }
    (out, true)
}
