//! The read model of a project's past (spec item 6): its orders, the steers people sent, the questions the retired
//! questions tool asked and their answers, and the lead's own messages, read once into the chat in time order.
//! Nothing is moved or deleted: the source rows stay as they are, and each message names its record (`source`), so
//! reading again adds nothing. Texts never carry internal ids.
use fleetd_contracts::chat::{ChatAuthor, ChatHistorySource};
use fleetd_contracts::ledger::{IntakeChannel, Workstream, WorkstreamState};
use fleetd_contracts::sessions::{MessageRole, ThreadMessage};
use serde_json::Value;

use super::NewMessage;
use crate::hub::store::parse_ms;

fn entry(
    author: ChatAuthor,
    history: ChatHistorySource,
    source: String,
    text: String,
    at_ms: i64,
) -> NewMessage {
    NewMessage {
        author: Some(author),
        text,
        source: Some(source),
        history: Some(history),
        created_ms: Some(at_ms),
        ..Default::default()
    }
}

/// An order: what a person asked, and how it ended. Orders a lead opened itself carry no human words.
pub fn order(w: &Workstream) -> Vec<NewMessage> {
    let mut out = Vec::new();
    let id = w.workstream_id.as_str();
    let created = parse_ms(w.created_at.as_str()).unwrap_or(0);
    if w.source.channel != IntakeChannel::Lead {
        out.push(entry(
            ChatAuthor::Human,
            ChatHistorySource::Order,
            format!("order:{id}"),
            w.source.text.to_string(),
            created,
        ));
    }
    let ended = match w.state {
        WorkstreamState::Done => Some("done"),
        WorkstreamState::Stopped => Some("stopped"),
        WorkstreamState::Open => None,
    };
    if let Some(how) = ended {
        out.push(entry(
            ChatAuthor::System,
            ChatHistorySource::OrderOutcome,
            format!("outcome:{id}"),
            format!("{} is {how}.", w.title),
            parse_ms(w.updated_at.as_str()).unwrap_or(created),
        ));
    }
    out
}

/// A person's steer (an order note is one too), from its stored JSON; a lead's steer to its task is not the human's.
pub fn steer(n: i64, data: &Value) -> Option<NewMessage> {
    if data["by"]["kind"].as_str() != Some("human") {
        return None;
    }
    let text = data["text"].as_str()?.trim();
    if text.is_empty() {
        return None;
    }
    let at = data["queuedAt"].as_str().and_then(parse_ms).unwrap_or(0);
    Some(entry(
        ChatAuthor::Human,
        ChatHistorySource::Steer,
        format!("steer:{n}"),
        text.to_owned(),
        at,
    ))
}

/// A question of the retired questions tool, and the human's answer when there was one.
pub fn question(data: &Value) -> Vec<NewMessage> {
    let Some(id) = data["askId"].as_str() else {
        return Vec::new();
    };
    let Some(text) = data["text"].as_str().filter(|t| !t.trim().is_empty()) else {
        return Vec::new();
    };
    let asked = data["createdAt"].as_str().and_then(parse_ms).unwrap_or(0);
    let mut out = vec![entry(
        ChatAuthor::Lead,
        ChatHistorySource::Question,
        format!("ask:{id}"),
        plain_question(text),
        asked,
    )];
    let answer = &data["answer"];
    let said = answer["raw"]
        .as_str()
        .or_else(|| answer["value"].as_str())
        .filter(|s| !s.trim().is_empty());
    if let Some(said) = said {
        out.push(entry(
            ChatAuthor::Human,
            ChatHistorySource::Question,
            format!("answer:{id}"),
            said.trim().to_owned(),
            answer["at"].as_str().and_then(parse_ms).unwrap_or(asked),
        ));
    }
    out
}

/// A done-check question reads "Check done:0 of W5 (<the order>): Did …?": the ids go, the question stays.
fn plain_question(text: &str) -> String {
    let text = text.trim();
    if text.starts_with("Check done:")
        && let Some((_, question)) = text.split_once("): ")
    {
        return question.trim().to_owned();
    }
    text.to_owned()
}

/// The key of a lead message read off its thread, shared by the live mirror and the history read.
pub fn lead_source(thread_id: &str, message_id: &str) -> String {
    format!("lead:{thread_id}:{message_id}")
}

/// A lead reply that says nothing to the person: a wake with no news ends with exactly this, since claude re-prompts
/// a turn that ends with no text, which only forces filler.
pub const QUIET: &str = "(quiet)";

/// The lead's reply has words for the person: not blank, not [`QUIET`].
pub fn said(text: &str) -> bool {
    let text = text.trim();
    !text.is_empty() && text != QUIET
}

/// The lead's own words from its session, before the chat: its assistant messages.
pub fn lead_messages(thread_id: &str, messages: &[ThreadMessage]) -> Vec<NewMessage> {
    messages
        .iter()
        .filter(|m| m.role == MessageRole::Assistant && said(&m.text))
        .map(|m| {
            entry(
                ChatAuthor::Lead,
                ChatHistorySource::LeadMessage,
                lead_source(thread_id, m.id.as_str()),
                m.text.trim().to_owned(),
                parse_ms(m.created_at.as_str()).unwrap_or(0),
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn workstream(channel: &str, state: &str) -> Workstream {
        serde_json::from_value(json!({
            "workstreamId": "W4", "projectRef": { "machineId": "devbox", "projectId": "app" }, "title": "Schedules",
            "source": { "text": "add schedules", "channel": channel, "by": "human", "at": "2026-10-19T08:00:00.000Z" },
            "state": state, "createdAt": "2026-10-19T08:00:00.000Z", "updatedAt": "2026-10-19T09:00:00.000Z",
        }))
        .unwrap()
    }

    #[test]
    fn an_order_reads_as_the_humans_words_and_its_outcome_without_ids() {
        let done = order(&workstream("app", "done"));
        assert_eq!(done.len(), 2);
        assert_eq!(
            (done[0].author, done[0].text.as_str(), done[0].history),
            (
                Some(ChatAuthor::Human),
                "add schedules",
                Some(ChatHistorySource::Order)
            )
        );
        assert_eq!(done[1].text, "Schedules is done.");
        assert!(!done[1].text.contains("W4"));
        assert!(done[0].created_ms < done[1].created_ms);
        // Running: no outcome yet. A lead's own order: no human words.
        assert_eq!(order(&workstream("app", "running")).len(), 1);
        assert_eq!(order(&workstream("lead", "running")).len(), 0);
    }

    #[test]
    fn only_a_persons_steers_and_answered_questions_read_in() {
        let human = json!({ "by": { "kind": "human" }, "text": "use the blue one", "queuedAt": "2026-10-19T08:30:00.000Z" });
        assert_eq!(steer(3, &human).unwrap().text, "use the blue one");
        let lead = json!({ "by": { "kind": "lead" }, "text": "do it", "queuedAt": "2026-10-19T08:30:00.000Z" });
        assert!(steer(4, &lead).is_none());
        let ask = json!({ "askId": "A1", "text": "Public link or image only?", "createdAt": "2026-10-19T08:13:41.719Z",
            "answer": { "value": "public frozen PNG", "raw": "1 go", "at": "2026-10-19T08:15:03.719Z" } });
        let q = question(&ask);
        assert_eq!(
            q.iter()
                .map(|m| (m.author, m.text.as_str()))
                .collect::<Vec<_>>(),
            [
                (Some(ChatAuthor::Lead), "Public link or image only?"),
                (Some(ChatAuthor::Human), "1 go")
            ]
        );
        let open = json!({ "askId": "A2", "text": "Which plan?", "createdAt": "2026-10-19T08:13:41.719Z" });
        assert_eq!(question(&open).len(), 1);
        // A done-check question loses its ids, even when the order's text has a question mark of its own.
        let check = json!({ "askId": "A3", "createdAt": "2026-10-19T08:13:41.719Z",
            "text": "Check done:0 of W5 (what model does the lead use ?): Did the answer explain which and why?" });
        assert_eq!(
            question(&check)[0].text,
            "Did the answer explain which and why?"
        );
    }

    /// A lead's quiet reply and its blank ones never read back into the chat; its words do.
    #[test]
    fn the_quiet_reply_never_reads_back() {
        let messages: Vec<ThreadMessage> = ["(quiet)", " (quiet)\n", "\n", "login fix is live"]
            .iter()
            .enumerate()
            .map(|(n, text)| {
                serde_json::from_value(json!({
                    "id": format!("m{n}"), "role": "assistant", "text": text,
                    "createdAt": "2026-10-19T08:00:00.000Z",
                }))
                .unwrap()
            })
            .collect();
        let read: Vec<String> = lead_messages("t1", &messages)
            .into_iter()
            .map(|m| m.text)
            .collect();
        assert_eq!(read, ["login fix is live"]);
    }
}
