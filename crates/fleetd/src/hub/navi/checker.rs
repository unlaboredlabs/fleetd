//! A Navi's approval checker (W239, D263): before one of its risky actions becomes an approval card (a send, reply,
//! share or invite through an integration, a site it opens on its own for the first time), a fresh model judges it.
//! `go` runs it, with one quiet line in the chat and an entry in the Navi's auto-approved log; `ask` brings the card,
//! with the checker's reason; `block` refuses it, tells the person why, and lets them approve it anyway.
//!
//! The checker is a tool-less turn (`executor::turn`) on the Navi owner's own Claude, in the Navi's own project, on the
//! model and effort the person picked (default [`CHECKER_MODEL`] at [`CHECKER_EFFORT`]). Its input is built here, not
//! by the Navi: the action exactly as it runs, where each of its parts came from ([`provenance`]: the person's own
//! messages, content the Navi read, or neither), and the person's recent messages. The content the Navi read is only
//! searched for those parts; it never reaches the checker. Its answer is one JSON verdict; anything else, a failure
//! or a timeout asks the person.
//!
//! A Navi's mode (`navi_approvals_set`) can instead ask the person about every risky action (no checker), or run them
//! all (YOLO, no checker). Every mode keeps the hard floors (`hub/integrations/policy.rs`: money, trading, accounts, a
//! credential in what goes out), and a spend always asks ([`always_asks`]).
use std::sync::Arc;

use fleetd_contracts::chat::ChatAuthor;
use fleetd_contracts::effort::{Effort, ModelName, ProfileName};
use fleetd_contracts::ids::{ProjectRef, ThreadRef};
use fleetd_contracts::integrations::{ToolAction, ToolPreview};
use fleetd_contracts::ledger::{CheckerNote, CheckerVerdict};
use fleetd_contracts::mcp_servers::McpSessionConfig;
use fleetd_contracts::model::RuntimeMode;
use fleetd_contracts::navi::{
    AUTO_APPROVED_MAX, AutoApproved, AutoApprovedBy, CHECKER_EFFORT, CHECKER_MODEL,
    NaviApprovalMode, NaviApprovals,
};
use fleetd_contracts::people::PersonId;
use fleetd_contracts::prim::Line;
use fleetd_contracts::sessions::SessionRole;
use regex::Regex;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;
use std::sync::LazyLock;

use super::review::{self, Answer, Read, Review};
use crate::hub::api::Hub;
use crate::hub::claude_accounts::{Whose, launch_account};
use crate::hub::executor::turn::Turn;
use crate::hub::executor::{LaunchInput, LaunchOptions};
use crate::hub::store::{StoreError, iso_ms, now_ms};
use crate::hub::usage::time::clip;

/// The person's messages the checker reads, newest last.
const MESSAGES: usize = 12;
/// The chat messages looked through for them.
const MESSAGES_LOOKED: usize = 200;
/// Each of the person's messages, cut to this many characters.
const MESSAGE_MAX: usize = 2_000;
/// The Navi's recent tool calls whose output counts as content it read.
const READS: usize = 60;

/// One risky action, as the relay holds it before it asks anyone.
#[derive(Clone, Debug, PartialEq)]
pub struct Action {
    /// The tool the session asked for: `mcp__mail__send_message`, `WebFetch`, `Bash`.
    pub tool: String,
    /// The prompt's own summary of it.
    pub summary: String,
    /// Exactly the input it runs with.
    pub input: Value,
    /// An integration's tool: its server, its name and what kind of act it is.
    pub preview: Option<ToolPreview>,
    /// A first visit: the site.
    pub site: Option<String>,
}

impl Action {
    /// What it does, in one line of markdown, for the chat and the log: "`send_message` on `mail`, to sam@example.com".
    pub fn what(&self) -> String {
        let to = addresses(&self.input);
        let to = if to.is_empty() {
            String::new()
        } else {
            let shown: Vec<_> = to.iter().take(3).cloned().collect();
            let more = to.len().saturating_sub(3);
            let more = if more > 0 {
                format!(" and {more} more")
            } else {
                String::new()
            };
            format!(", to {}{more}", shown.join(", "))
        };
        // Markdown: names and hosts in backticks, as the chat and the app show code.
        let field = |k: &str| {
            self.input
                .get(k)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .replace('`', "'")
        };
        let what = match (&self.preview, &self.site) {
            (Some(p), _) if p.action == ToolAction::Confirm => {
                format!("Click \"{}\" on `{}`", field("button"), field("site"))
            }
            (Some(p), _) => format!("`{}` on `{}`{to}", p.tool, p.server),
            (None, Some(site)) if self.tool == "WebFetch" => format!("Fetch `{site}`"),
            (None, Some(site)) => format!("Open `{site}`"),
            (None, None) => format!("`{}`: {}", self.tool, self.summary.replace('`', "'")),
        };
        clip(&one_line(&what), 300)
    }
}

/// The class of action no mode lets through without the person, nor gives the checker: a spend. Moving money and
/// trading never get this far (the policy refuses them).
pub fn always_asks(action: &Action) -> bool {
    action
        .preview
        .as_ref()
        .is_some_and(|p| p.action == ToolAction::Spend)
}

/// A Navi's approval settings: the defaults when the person set none.
pub fn approvals(c: &Connection, r: &ProjectRef) -> rusqlite::Result<NaviApprovals> {
    let row: Option<(String, Option<String>, Option<String>)> = c
        .prepare_cached(
            "SELECT mode, model, effort FROM navi_approvals WHERE machine_id = ? AND project_id = ?",
        )?
        .query_row(
            params![r.machine_id.as_str(), r.project_id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let (mode, model, effort) = row.unwrap_or_default();
    let model = model.and_then(|m| ModelName::new(m).ok());
    let effort = effort.as_deref().and_then(Effort::parse);
    Ok(NaviApprovals {
        mode: NaviApprovalMode::parse(&mode).unwrap_or_default(),
        defaults: model.is_none() && effort.is_none(),
        model: model.unwrap_or_else(|| ModelName::unchecked(CHECKER_MODEL)),
        effort: effort.unwrap_or(CHECKER_EFFORT),
    })
}

pub fn set_approvals(
    c: &Connection,
    r: &ProjectRef,
    mode: NaviApprovalMode,
    model: Option<&ModelName>,
    effort: Option<Effort>,
) -> rusqlite::Result<()> {
    c.prepare_cached(
        "INSERT INTO navi_approvals (machine_id, project_id, mode, model, effort) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (machine_id, project_id) DO UPDATE SET mode = excluded.mode, model = excluded.model,
           effort = excluded.effort",
    )?
    .execute(params![
        r.machine_id.as_str(),
        r.project_id.as_str(),
        mode.as_str(),
        model.map(ModelName::as_str),
        effort.map(Effort::as_str)
    ])?;
    Ok(())
}

/// The actions the Navi ran without asking, newest first.
pub fn log(c: &Connection, r: &ProjectRef) -> Result<Vec<AutoApproved>, StoreError> {
    let rows: Vec<String> = c
        .prepare_cached(
            "SELECT data FROM navi_auto_approved WHERE machine_id = ? AND project_id = ? ORDER BY n DESC LIMIT ?",
        )?
        .query_map(
            params![
                r.machine_id.as_str(),
                r.project_id.as_str(),
                AUTO_APPROVED_MAX as i64
            ],
            |row| row.get(0),
        )?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows
        .iter()
        .filter_map(|d| serde_json::from_str(d).ok())
        .collect())
}

/// An action that ran without asking: one quiet line in the Navi's chat, and an entry in its log that links to it.
pub fn auto_approved(
    hub: &Hub,
    r: &ProjectRef,
    action: &Action,
    by: AutoApprovedBy,
    reason: Option<&str>,
) -> Result<AutoApproved, StoreError> {
    let what = action.what();
    let reason = reason
        .map(one_line)
        .filter(|r| !r.is_empty())
        .map(|r| clip(&r, 300));
    let text = match (by, &reason) {
        (AutoApprovedBy::Checker, Some(why)) => {
            format!("Let through without asking you: {what}. The checker's reason: {why}")
        }
        (AutoApprovedBy::Checker, None) => format!("Let through without asking you: {what}."),
        (AutoApprovedBy::Yolo, _) => format!("Ran without asking you (YOLO): {what}."),
    };
    let line = hub.chat.system_line(r, &text)?;
    let at = now_ms(hub.clock.as_ref());
    let entry = AutoApproved {
        at: iso_ms(at).into(),
        by,
        tool: Line::new(clip(&action.tool, 200)).unwrap_or_else(|_| Line::unchecked("a tool")),
        what: Line::new(what).unwrap_or_else(|_| Line::unchecked("an action")),
        reason: reason.and_then(|r| Line::new(r).ok()),
        message_id: Some(line.message_id),
    };
    hub.db.with(|c| {
        c.prepare_cached(
            "INSERT INTO navi_auto_approved (machine_id, project_id, at_ms, data) VALUES (?, ?, ?, ?)",
        )?
        .execute(params![
            r.machine_id.as_str(),
            r.project_id.as_str(),
            at,
            serde_json::to_string(&entry)?
        ])?;
        Ok(())
    })?;
    Ok(entry)
}

static EMAIL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}").unwrap()
});

/// The email addresses in an input's text, each once, lower case.
pub fn addresses(input: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (_, text) in review::leaves(input) {
        for m in EMAIL.find_iter(&text) {
            let found = m.as_str().trim_end_matches('.').to_lowercase();
            if !out.contains(&found) {
                out.push(found);
            }
        }
    }
    out
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn nonce() -> String {
    rand::random::<[u8; 12]>()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// What the checker's review is built from besides the action: what the person said, the Navi's last question, what
/// the Navi read, and the sites it may visit.
#[derive(Clone, Debug, Default)]
pub struct Context {
    /// The person: their name.
    pub person: Value,
    /// Oldest first.
    pub person_messages: Vec<String>,
    pub navi_last_question: Option<String>,
    pub reads: Vec<Read>,
    pub allowed_sites: Vec<String>,
    pub today: String,
}

/// The person's recent messages in the Navi's chat, oldest first, and the Navi's last message to them when it asked
/// something after their last word but one (so "yes" can be judged against it).
pub fn person_messages(
    hub: &Hub,
    r: &ProjectRef,
) -> Result<(Vec<String>, Option<String>), StoreError> {
    let (messages, _, _) = hub.chat.page(r, None, None, MESSAGES_LOOKED)?;
    let mut said: Vec<String> = Vec::new();
    let mut question = None;
    for m in &messages {
        let text = m.text.as_str().trim();
        match m.author {
            ChatAuthor::Human if !text.is_empty() => said.push(clip(text, MESSAGE_MAX)),
            ChatAuthor::Lead if text.contains('?') => {
                question = Some((said.len(), clip(text, 1_000)))
            }
            _ => {}
        }
    }
    // The question the person's last message answers: asked after the one before it.
    let question = question
        .filter(|(before, _)| !said.is_empty() && *before == said.len() - 1)
        .map(|(_, q)| q);
    let skip = said.len().saturating_sub(MESSAGES);
    said.drain(..skip);
    Ok((said, question))
}

/// What the Navi's lead read lately: its recent tool calls' whole output, each with its call (the tool's name first,
/// which says what kind of content it is).
pub async fn reads(hub: &Arc<Hub>, thread: &ThreadRef) -> Vec<Read> {
    match hub.executors.reads(thread, READS).await {
        Ok(reads) => reads
            .into_iter()
            .map(|(call, text)| Read {
                source: one_line(&call),
                text,
            })
            .collect(),
        Err(e) => {
            tracing::warn!(thread = %thread.thread_id, "approval checker: the Navi's reads not read: {e}");
            Vec::new()
        }
    }
}

/// The checker's review of `action`: the action as it runs, with its tool and kind, and where each part came from.
pub fn review(action: &Action, context: &Context) -> Review {
    let url = action
        .site
        .as_ref()
        .and_then(|_| review::visit_url(&action.input));
    let kind = match (action.preview.as_ref().map(|p| p.action), &action.site) {
        (Some(ToolAction::Send), _) => "send",
        (Some(ToolAction::Share), _) => "share",
        (Some(ToolAction::Delete), _) => "delete",
        (Some(ToolAction::Spend), _) => "spend",
        (Some(ToolAction::Write), _) => "write",
        (Some(ToolAction::Confirm), _) => "confirm_step",
        (None, Some(_)) => "visit",
        (None, None) => "tool",
    };
    let mut shown = serde_json::Map::new();
    shown.insert("tool".to_owned(), Value::String(action.tool.clone()));
    shown.insert("kind".to_owned(), Value::String(kind.to_owned()));
    match &action.input {
        Value::Object(o) => {
            for (k, v) in o {
                if k != "tool" && k != "kind" {
                    shown.insert(k.clone(), v.clone());
                }
            }
        }
        other => {
            shown.insert("input".to_owned(), other.clone());
        }
    }
    if let Some(url) = &url {
        shown.insert("url".to_owned(), Value::String(url.clone()));
    }
    let (mine, contacts) = review::known(&context.person_messages, &context.reads);
    let mut person = context.person.clone();
    if let Value::Object(o) = &mut person
        && !mine.is_empty()
    {
        o.insert("emails".to_owned(), serde_json::json!(mine));
    }
    Review {
        person,
        contacts: contacts
            .into_iter()
            .map(|e| serde_json::json!({ "email": e }))
            .collect(),
        allowed_sites: context.allowed_sites.clone(),
        today: context.today.clone(),
        person_messages: context.person_messages.clone(),
        navi_last_question: context
            .navi_last_question
            .as_ref()
            .map(|q| format!("(written by the Navi, not the person) {q}")),
        provenance: review::provenance(
            &action.input,
            url.as_deref(),
            &context.person_messages,
            &context.reads,
            &context.allowed_sites,
        ),
        action: Value::Object(shown),
    }
}

/// The checker's verdict on `action`, in the Navi `r` of `owner`: its turn on `turn` with the review, then fleetd's
/// code rules (`review::decide`). Anything but a readable verdict asks the person, saying why.
pub async fn check(
    hub: &Hub,
    turn: &dyn Turn,
    r: &ProjectRef,
    owner: Option<&PersonId>,
    settings: &NaviApprovals,
    action: &Action,
    context: &Context,
) -> CheckerNote {
    let review = review(action, context);
    // The floors need no model: refused without one.
    if let Some(rule) = review::rules(&review)
        && rule.verdict == CheckerVerdict::Block
    {
        return rule;
    }
    let answer = match launch(hub, r, owner, settings, &review) {
        Err(why) => Answer::Failed(why),
        Ok((input, options)) => match turn.run(r, owner, input, options).await {
            Ok(reply) => Answer::Reply(reply),
            Err(why) if review::refused(&why) => Answer::Refused,
            Err(why) => Answer::Failed(why),
        },
    };
    review::decide(&review, &answer)
}

/// The checker's session: no tools at all, on the owner's own Claude, on the checker's model and effort, with the
/// `navi.checker` prompt as its rules and the review as its one message.
fn launch(
    hub: &Hub,
    r: &ProjectRef,
    owner: Option<&PersonId>,
    settings: &NaviApprovals,
    review: &Review,
) -> Result<(LaunchInput, LaunchOptions), String> {
    // Run apart from the Navi's folder, whose CLAUDE.md and settings the Navi writes: only on a node that can.
    if !hub
        .link
        .node_can(&r.machine_id, fleetd_contracts::node_link::CAP_ISOLATED)
    {
        return Err(format!(
            "{} runs a fleetd too old to hold the checker apart from the Navi; update it",
            r.machine_id
        ));
    }
    let setup = hub
        .db
        .claude_accounts()
        .setup()
        .map_err(|e| format!("it couldn't start: {e}"))?;
    let whose = owner.cloned().map_or(Whose::Hub, Whose::Person);
    let claude_account = launch_account(&setup, &whose, &r.machine_id, || {
        hub.link.node_can(
            &r.machine_id,
            fleetd_contracts::node_link::CAP_CLAUDE_ACCOUNTS,
        )
    })
    .map_err(|refused| format!("it couldn't start: {}", refused.message))?;
    let input = LaunchInput {
        project_id: r.project_id.clone(),
        prompt: review.render(),
        system_prompt: Some(hub.db.prompts().current(None).render("navi.checker", &[])),
        profile: hub
            .db
            .profiles()
            .default_profile()
            .map_or_else(|_| ProfileName::legacy(), |p| p.name),
        // Its node asks for any tool, and refuses it: it has none.
        runtime_mode: RuntimeMode::ApprovalRequired,
        title: Some("fleetd approval check".to_owned()),
        client_request_id: format!("fleetd-approval-check:{}:{}", r.project_id, nonce()),
    };
    let options = LaunchOptions {
        role: SessionRole::Plain,
        mcp_role: None,
        mcp: Some(McpSessionConfig {
            user_servers: false,
            servers: Vec::new(),
        }),
        only_tools: Some(Vec::new()),
        claude_account,
        isolated: true,
        model: Some((settings.model.clone(), settings.effort)),
        ..Default::default()
    };
    Ok((input, options))
}
