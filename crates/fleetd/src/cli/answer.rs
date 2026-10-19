//! `fleetd answer`: the open questions with their labels and what each choice does, and the reply grammar to answer
//! them (asks_list, inbox_reply, inbox_undo). Answers speak for the human, so it needs a human key.

use std::time::Duration;

use fleetd_contracts::ledger::{Ask, AskKind};
use fleetd_contracts::mcp::{AsksListOutput, InboxReplyOutput};
use serde_json::{Value, json};

use super::args::{self, Kind, Spec};
use super::mcp_client::McpClient;
use super::steer::{Failure, call, hub_url};

pub const ANSWER_USAGE: &str = r##"  answer --key-file <human key> [--hub <url>]
             the open questions: each choice's label, what happens if you pick it, and the
             lead's recommendation
  answer "<reply>" --key-file <human key> [--hub <url>]
             answer them: "1 a", "1-3 go" (take the recommendation), "2: your own answer",
             "3 skip" (skip for now: the lead keeps its recommendation), "4 later", "#B4 1 b".
             A question's answer can be taken back for 10 s
  answer undo A<n> --key-file <human key> [--hub <url>]
             take an answer back within 10 s; the question is open again
"##;

const CALL_TIMEOUT: Duration = Duration::from_secs(30);
const LETTERS: &str = "abcdef";

#[derive(Debug, PartialEq)]
pub enum AnswerCommand {
    List,
    Reply(String),
    Undo(String),
}

#[derive(Debug, PartialEq)]
pub struct AnswerArgs {
    pub command: AnswerCommand,
    pub hub: Option<String>,
    pub key_file: String,
}

pub fn parse_answer_args(argv: &[String]) -> Result<AnswerArgs, String> {
    let v = args::parse(
        argv,
        &Spec {
            options: &[("hub", Kind::Str), ("key-file", Kind::Str)],
            positionals: true,
        },
    )?;
    let Some(key_file) = v.string("key-file").filter(|s| !s.is_empty()) else {
        return Err(
            "--key-file is required: an answer speaks for you, so it needs a human key (fleetd hub key create --human)"
                .into(),
        );
    };
    let command = match v.positionals.as_slice() {
        [] => AnswerCommand::List,
        [undo, id] if undo == "undo" => {
            if !id.strip_prefix('A').is_some_and(|n| {
                !n.is_empty() && !n.starts_with('0') && n.bytes().all(|b| b.is_ascii_digit())
            }) {
                return Err(format!("'{id}' is not a question id (A7)"));
            }
            AnswerCommand::Undo(id.clone())
        }
        words => AnswerCommand::Reply(words.join(" ")),
    };
    Ok(AnswerArgs {
        command,
        hub: v.string("hub").filter(|s| !s.is_empty()),
        key_file,
    })
}

/// One open question as text: where it comes from and what it blocks, the question and its context, then each
/// choice by its reply letter with what it does, the recommended one marked with the lead's reason.
pub fn render_ask(number: i64, ask: &Ask) -> String {
    let mut head = vec![format!("{number}"), ask.class.as_str().to_string()];
    match &ask.project_ref {
        Some(r) => head.push(r.project_id.to_string()),
        None => head.push("no project yet".into()),
    }
    if let Some(w) = &ask.workstream_id {
        head.push(w.to_string());
    }
    let mut lines = vec![head.join(" · ")];
    if ask.blocks.as_str() != "nothing" {
        lines.push(format!("  blocks: {}", ask.blocks));
    }
    lines.push(format!("  {}", ask.text));
    if let Some(context) = &ask.context {
        lines.extend(context.lines().map(|l| format!("  {l}")));
    }
    let rec = ask.recommendation.as_deref();
    let why = ask
        .recommendation_why
        .as_ref()
        .map(|w| format!(": {w}"))
        .unwrap_or_default();
    let options: Vec<_> = ask.options.iter().flatten().collect();
    match ask.kind {
        AskKind::Decide => {
            if let Some(rec) = rec
                && !options.iter().any(|o| o.key.as_str() == rec)
            {
                lines.push(format!("  go) {rec}  [recommended{why}]"));
            }
            for (i, option) in options.iter().enumerate().take(LETTERS.len()) {
                let mark = if Some(option.key.as_str()) == rec {
                    format!("  [recommended{why}]")
                } else {
                    String::new()
                };
                lines.push(format!(
                    "  {}) {}{mark}",
                    &LETTERS[i..=i],
                    option.display_label()
                ));
                if let Some(consequence) = &option.consequence {
                    lines.push(format!("     {consequence}"));
                }
            }
            let kept = rec.map(|r| {
                options
                    .iter()
                    .find(|o| o.key.as_str() == r)
                    .map_or_else(|| r.to_string(), |o| o.display_label())
            });
            lines.push(format!(
                "  reply \"{number} <letter>\", \"{number}: your own answer\"{} or \"{number} later\"",
                kept.map(|k| format!(", \"{number} skip\" (the lead keeps {k})"))
                    .unwrap_or_default()
            ));
        }
        AskKind::Do => {
            for (i, step) in ask.steps.iter().flatten().enumerate() {
                lines.push(format!("  {}. {}", i + 1, step.text));
            }
            lines.push(format!("  reply \"{number} done\" once finished"));
        }
        AskKind::Approve => lines.push(format!(
            "  reply \"{number} go\" to run it or \"{number} no\""
        )),
        AskKind::Secret => {
            lines.push("  enter it in the fleetd app, which seals it to its machine".into())
        }
    }
    lines.join("\n")
}

pub fn render_list(listed: &AsksListOutput) -> String {
    if listed.asks.is_empty() {
        return "Nothing needs you.".into();
    }
    let mut out = Vec::new();
    for batch in listed.batches.iter() {
        out.push(format!("{}:", batch.batch_id));
        for item in &batch.items {
            if let Some(ask) = listed.asks.iter().find(|a| a.ask_id == item.ask_id) {
                out.push(render_ask(item.number.get(), ask));
            }
        }
    }
    out.join("\n\n")
}

pub fn render_reply(output: &InboxReplyOutput) -> String {
    let mut lines = Vec::new();
    if let Some(echo) = &output.echo {
        lines.push(echo.clone());
    }
    if let Some(hint) = &output.hint {
        lines.push(hint.clone());
    }
    let held: Vec<&str> = output
        .applied
        .iter()
        .filter(|a| a.undo_until.is_some())
        .filter_map(|a| a.ask_id.as_deref())
        .collect();
    if !held.is_empty() {
        lines.push(format!(
            "Changed your mind? `fleetd answer undo {}` within 10 s; after that the lead has it.",
            held.join("` or `fleetd answer undo ")
        ));
    }
    lines.join("\n")
}

async fn run(args: AnswerArgs) -> Result<u8, Failure> {
    let key = std::fs::read_to_string(&args.key_file)
        .map(|k| k.trim().to_owned())
        .map_err(|error| Failure::Refused(format!("cannot read --key-file: {error}")))?;
    let url = hub_url(args.hub).map_err(Failure::Unreachable)?;
    let mut client =
        McpClient::connect(&url, &key, "fleetd-answer", Duration::from_secs(15)).await?;
    let shape = |error: serde_json::Error| {
        Failure::Refused(format!(
            "the hub answered in a shape this fleetd does not know ({error}); update fleetd"
        ))
    };
    match args.command {
        AnswerCommand::List => {
            let body = call(&mut client, "asks_list", json!({}), CALL_TIMEOUT).await?;
            let listed: AsksListOutput = serde_json::from_value(body).map_err(shape)?;
            println!("{}", render_list(&listed));
            Ok(0)
        }
        AnswerCommand::Reply(raw) => {
            let body = call(
                &mut client,
                "inbox_reply",
                json!({ "raw": raw }),
                CALL_TIMEOUT,
            )
            .await?;
            let output: InboxReplyOutput = serde_json::from_value(body).map_err(shape)?;
            println!("{}", render_reply(&output));
            Ok(if output.parsed { 0 } else { 1 })
        }
        AnswerCommand::Undo(ask_id) => {
            let body = call(
                &mut client,
                "inbox_undo",
                json!({ "askId": ask_id }),
                CALL_TIMEOUT,
            )
            .await?;
            let id = body
                .pointer("/ask/askId")
                .and_then(Value::as_str)
                .unwrap_or(&ask_id);
            println!("{id} is open again.");
            Ok(0)
        }
    }
}

pub async fn answer_command(argv: &[String]) -> u8 {
    match parse_answer_args(argv) {
        Err(error) => {
            eprint!("fleetd: {error}\n\nusage:\n{ANSWER_USAGE}");
            2
        }
        Ok(args) => run(args).await.unwrap_or_else(|f| f.report_as("answer")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    fn ask(extra: Value) -> Ask {
        let mut value = json!({
            "askId": "A7", "projectRef": { "machineId": "forge", "projectId": "console" },
            "workstreamId": "W1", "kind": "decide", "key": "share.link", "class": "product",
            "text": "What should a shared link show?", "recommendation": "public-snapshot",
            "blocks": "Copy link button", "proceededOnRec": false, "state": "open",
            "createdAt": "2026-10-19T00:00:00.000Z"
        });
        for (k, v) in extra.as_object().unwrap() {
            value[k] = v.clone();
        }
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn parses_list_reply_and_undo() {
        let parsed = |a: &[&str]| parse_answer_args(&argv(a)).map(|a| a.command);
        assert_eq!(parsed(&["--key-file", "k"]), Ok(AnswerCommand::List));
        assert_eq!(
            parsed(&["1", "a", "--key-file", "k"]),
            Ok(AnswerCommand::Reply("1 a".into()))
        );
        assert_eq!(
            parsed(&["undo", "A7", "--key-file", "k"]),
            Ok(AnswerCommand::Undo("A7".into()))
        );
        assert!(parsed(&["undo", "7", "--key-file", "k"]).is_err());
        assert!(parsed(&["1 a"]).unwrap_err().contains("human key"));
    }

    #[test]
    fn shows_labels_consequences_and_the_recommendation_not_keys() {
        let labelled = ask(json!({
            "context": "Your console shows usage per key; the card is shared from it.",
            "recommendationWhy": "Nobody needs a login to see it, and it never changes after sharing.",
            "options": [
                { "key": "public-snapshot", "label": "Public frozen snapshot", "consequence": "Anyone with the link sees a copy that never updates." },
                { "key": "image-only", "label": "Image only", "consequence": "The link shows a PNG of the card, nothing else." }
            ]
        }));
        let text = render_ask(1, &labelled);
        assert!(text.contains("blocks: Copy link button"), "{text}");
        assert!(
            text.contains("a) Public frozen snapshot  [recommended: Nobody needs"),
            "{text}"
        );
        assert!(
            text.contains("     The link shows a PNG of the card, nothing else."),
            "{text}"
        );
        assert!(
            text.contains("\"1 skip\" (the lead keeps Public frozen snapshot)"),
            "{text}"
        );
        assert!(!text.contains("image-only"), "{text}");
    }

    #[test]
    fn an_old_ask_shows_humanized_keys_and_a_free_text_recommendation() {
        let old = ask(
            json!({ "options": ["image-only", "b-prorated"], "recommendation": "keep monthly" }),
        );
        let text = render_ask(2, &old);
        assert!(text.contains("go) keep monthly  [recommended]"), "{text}");
        assert!(text.contains("a) Image only\n  b) B prorated\n"), "{text}");
    }
}
