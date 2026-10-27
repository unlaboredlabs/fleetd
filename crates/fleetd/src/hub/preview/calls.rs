//! `preview_suggest`, `preview_config_propose` and the lead's `preview_start`: agents and Try it (D161). A writer or
//! lead suggests trying a PR (once per PR, one chat line with Try it, flagged for the person's look; nothing runs) or proposes how the project's
//! preview runs (an approval card; nothing is saved until a person approves it). Only a lead starts one, and only in
//! a turn answering the person's message.
use std::sync::{Arc, Weak};

use fleetd_contracts::chat::{ChatAuthor, ChatMessage, ChatMessageState};
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult, RequestResult};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::preview::{
    PreviewAsker, PreviewConfigProposeCall, PreviewOf, PreviewStartCall, PreviewStartResult,
    PreviewSuggestCall, PreviewSuggestResult, PreviewSuggestion,
};
use fleetd_contracts::prim::{Line, Positive};
use fleetd_contracts::train::{GitHubRepo, parse_pr_url};
use rusqlite::params;

use super::{Ask, of_words, start};
use crate::hub::api::{Hub, ToolError};
use crate::hub::chat::NewMessage;
use crate::hub::link::lead_calls::{CallerAgent, LeadCallFuture, op_of};
use crate::hub::link::{LeadCaller, LeadCalls};
use crate::hub::store::{StoreError, iso_ms, now_ms, parse_ms};
use crate::hub::usage::wire::convert;

pub const OPS: [&str; 3] = ["preview_suggest", "preview_config_propose", "preview_start"];

/// How far back the person's message a lead's start answers may be.
const ANSWER_WINDOW_MS: i64 = 60 * 60_000;
/// Chat messages looked through for it.
const ANSWER_LOOKBACK: usize = 40;

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
                    LeadCall::PreviewSuggest(call) => {
                        suggest(&hub, &caller, call).map(LeadCallResult::PreviewSuggest)
                    }
                    LeadCall::PreviewConfigPropose(call) => propose(&hub, &caller, call)
                        .await
                        .map(LeadCallResult::PreviewConfigPropose),
                    LeadCall::PreviewStart(call) => lead_start(&hub, &caller, call)
                        .await
                        .map(LeadCallResult::PreviewStart),
                    other => Err(McpToolError::new(
                        ErrorCode::Invalid,
                        format!("{} is not a preview call.", op_of(&other)),
                    )),
                }
            })
        },
    );
    let calls: &LeadCalls = &hub.lead_calls;
    for op in OPS {
        calls.register(op, handler.clone());
    }
}

/// The project's suggestions, newest first.
pub fn suggestions(hub: &Hub, r: &ProjectRef) -> Result<Vec<PreviewSuggestion>, StoreError> {
    hub.db.with(|c| {
        let mut stmt = c.prepare(
            "SELECT data FROM preview_suggestions WHERE machine_id = ?1 AND project_id = ?2
             ORDER BY at_ms DESC LIMIT ?3",
        )?;
        let rows = stmt.query_map(
            params![
                r.machine_id.as_str(),
                r.project_id.as_str(),
                super::LIST_MAX as i64
            ],
            |row| row.get::<_, String>(0),
        )?;
        let mut out = Vec::new();
        for data in rows {
            out.push(serde_json::from_str(&data?)?);
        }
        Ok(out)
    })
}

/// The PR a URL names, when it is the caller's project's: a Change of it, or a repo whose PRs land through it.
fn own_pr(
    hub: &Hub,
    r: &ProjectRef,
    url: &str,
) -> Result<
    (
        GitHubRepo,
        Positive,
        Option<fleetd_contracts::train::Change>,
    ),
    ToolError,
> {
    let not_ours = || {
        ToolError::new(
            ErrorCode::NotFound,
            format!("{url} is not a PR of your project."),
        )
        .with_fix("Name one of your project's PRs, by its URL.")
    };
    let parsed = parse_pr_url(url).ok_or_else(not_ours)?;
    let (Ok(repo), Ok(number)) = (
        GitHubRepo::new(parsed.repo.clone()),
        Positive::new(parsed.pr_number),
    ) else {
        return Err(not_ours());
    };
    let change = hub
        .train
        .records()
        .latest_for(&parsed.repo, parsed.pr_number);
    let ours = match &change {
        Some(c) => &c.project_ref == r,
        None => crate::hub::prs::owner_of(hub, &parsed.repo).as_ref() == Some(r),
    };
    if !ours {
        return Err(not_ours());
    }
    Ok((repo, number, change))
}

fn suggest(
    hub: &Hub,
    caller: &LeadCaller,
    call: PreviewSuggestCall,
) -> Result<PreviewSuggestResult, ToolError> {
    let r = &caller.project_ref;
    let (repo, number, change) = own_pr(hub, r, call.pr_url.as_str())?;
    let n = number.get();
    let by = match &caller.agent {
        CallerAgent::Task(task)
            if change.as_ref().and_then(|c| c.task_id.as_ref()) == Some(task) =>
        {
            format!("#{n}'s writer")
        }
        CallerAgent::Task(task) => format!("{task}"),
        CallerAgent::Lead => "the lead".to_owned(),
        CallerAgent::Person => "you".to_owned(),
        CallerAgent::Preview(_) | CallerAgent::EndedPreview(_) | CallerAgent::MemoryRefresh => {
            return Err(ToolError::new(
                ErrorCode::Forbidden,
                "A preview's session suggests nothing, nor does a memory refresh.",
            ));
        }
    };
    let now = now_ms(hub.clock.as_ref());
    let suggestion = PreviewSuggestion {
        project_ref: r.clone(),
        of: PreviewOf::Pr {
            repo: repo.clone(),
            number,
        },
        by: Line::unchecked(by.clone()),
        why: call.why.clone(),
        at: iso_ms(now).into(),
    };
    let shown = hub.db.transaction(|c| {
        Ok(c.execute(
            "INSERT OR IGNORE INTO preview_suggestions (repo, number, machine_id, project_id, at_ms, data)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                repo.to_lowercase(),
                n,
                r.machine_id.as_str(),
                r.project_id.as_str(),
                now,
                serde_json::to_string(&suggestion)?
            ],
        )? == 1)
    })?;
    if shown {
        let text = format!("{by} suggests trying #{n}: {}", call.why);
        hub.chat.add(
            r,
            NewMessage {
                author: Some(ChatAuthor::Agent),
                text,
                by: Some(by),
                source: Some(format!("preview_suggest:{}#{n}", repo.to_lowercase())),
                preview_suggestion: Some(suggestion),
                nudge: crate::hub::chat::nudges::reason_of(&format!("Try #{n}: {}", call.why)),
                ..Default::default()
            },
        )?;
        crate::hub::chat::flow::state(hub, r)?;
    }
    Ok(PreviewSuggestResult { shown })
}

async fn propose(
    hub: &Hub,
    caller: &LeadCaller,
    call: PreviewConfigProposeCall,
) -> Result<RequestResult, ToolError> {
    if call.config.targets().is_empty() {
        return Err(ToolError::new(
            ErrorCode::Invalid,
            "The proposed setting runs nothing: it needs web.",
        )
        .with_fix("Propose web's setup, build, start and ready path."));
    }
    let workstream = match &caller.agent {
        CallerAgent::Task(task) => hub.tasks.get(task)?.map(|t| t.workstream_id),
        _ => None,
    };
    let project = convert(&caller.project_ref).expect("a project ref reads back");
    let r = hub
        .approvals
        .propose_preview(&project, call, workstream)
        .await
        .map_err(crate::hub::approvals::tools::refusal)?;
    Ok(RequestResult {
        request_id: r.request_id.clone(),
        state: r.state,
        next: Some(
            "carry on: the person approves or denies it in chat, and the outcome arrives in your lead's wake; \
             nothing is saved until they approve it."
                .into(),
        ),
    })
}

/// The person's message a lead's turn answers now: the newest the person wrote, with no finished lead reply after it,
/// within the last hour.
fn answering(hub: &Hub, r: &ProjectRef) -> Result<Option<ChatMessage>, StoreError> {
    let (recent, _, _) = hub.chat.page(r, None, None, ANSWER_LOOKBACK)?;
    let now = now_ms(hub.clock.as_ref());
    for m in recent.into_iter().rev() {
        if m.history.is_some() || m.item.is_some() {
            continue;
        }
        match (m.author, m.state) {
            (ChatAuthor::Human, _) => {
                let at = parse_ms(m.created_at.as_str()).unwrap_or_default();
                return Ok((now - at <= ANSWER_WINDOW_MS).then_some(m));
            }
            (ChatAuthor::Lead, ChatMessageState::Final) => return Ok(None),
            _ => {}
        }
    }
    Ok(None)
}

async fn lead_start(
    hub: &Hub,
    caller: &LeadCaller,
    call: PreviewStartCall,
) -> Result<PreviewStartResult, ToolError> {
    let r = &caller.project_ref;
    let asked_by = match &caller.agent {
        CallerAgent::Lead => {
            let Some(message) = answering(hub, r)? else {
                return Err(ToolError::new(
                    ErrorCode::Forbidden,
                    "A lead starts a preview only in a turn that answers the person asking for one (D161).",
                )
                .with_fix(
                    "Suggest it with preview_suggest, or ask the person in chat whether they want to try it.",
                ));
            };
            let hhmm = message
                .created_at
                .as_str()
                .get(11..16)
                .unwrap_or("")
                .to_owned();
            PreviewAsker {
                words: Line::unchecked(format!("the lead, because you asked at {hhmm}")),
                message_id: Some(message.message_id),
            }
        }
        CallerAgent::Person => PreviewAsker {
            words: Line::unchecked(format!("you, with fleetd on {}", r.machine_id)),
            message_id: None,
        },
        CallerAgent::Task(task) => {
            return Err(ToolError::new(
                ErrorCode::Forbidden,
                format!("{task} is a task: only the person, or the lead answering them, starts a preview."),
            )
            .with_fix("Suggest it with preview_suggest."));
        }
        CallerAgent::Preview(_) | CallerAgent::EndedPreview(_) | CallerAgent::MemoryRefresh => {
            return Err(ToolError::new(
                ErrorCode::Forbidden,
                "A preview's session starts no preview, nor does a memory refresh.",
            ));
        }
    };
    if let PreviewOf::Pr { repo, number } = &call.of {
        own_pr(
            hub,
            r,
            &format!("https://github.com/{repo}/pull/{}", number.get()),
        )?;
    }
    let preview = start(
        hub,
        r,
        Ask {
            of: call.of,
            target: call.target,
            asked_by,
        },
    )
    .await?;
    tracing::info!(preview = %preview.preview_id, of = %of_words(&preview.of), "the lead started a preview");
    Ok(PreviewStartResult { preview })
}
