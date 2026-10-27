//! preview_start, preview_end, previews_list and preview_feedback: the app's Try it. A person's admin or operate key
//! starts and ends previews and sends feedback; a read key only opens what runs (D162).
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::ledger::WorkstreamId;
use fleetd_contracts::mcp::{
    ErrorCode, PreviewEndInput, PreviewEndOutput, PreviewFeedbackInput, PreviewFeedbackOutput,
    PreviewStartInput, PreviewStartOutput, PreviewsListInput, PreviewsListOutput,
};
use fleetd_contracts::preview::{
    Preview, PreviewAsker, PreviewEndReason, PreviewId, PreviewOf, PreviewPin, PreviewState,
};
use fleetd_contracts::prim::{Line, List};
use fleetd_contracts::steer::{SteerMode, SteerTarget};
use fleetd_contracts::tasks::TaskState;

use super::{Ask, end, get, list, may_start, of_words, refuse_start, start};
use crate::hub::api::{Caller, Hub, Registry, ToolError, allows, require, unknown_project};
use crate::hub::intake::attachments;
use crate::hub::steer::{By, SteerRequest};
use crate::hub::store::now_ms;

pub fn register(tools: &mut Registry) {
    tools.add("preview_start", preview_start);
    tools.add("preview_end", preview_end);
    tools.add("previews_list", previews_list);
    tools.add("preview_feedback", preview_feedback);
}

fn not_found(id: &PreviewId) -> ToolError {
    ToolError::new(ErrorCode::NotFound, format!("No preview {id}."))
        .with_fix("Call previews_list for the project's previews.")
}

/// The preview, as a key that can read its project's machine sees it: knowing an id gives nothing elsewhere.
fn readable(hub: &Hub, caller: &Caller, id: &PreviewId) -> Result<Preview, ToolError> {
    let p = get(hub, id)?.ok_or_else(|| not_found(id))?;
    if !allows(caller, Role::Read, Some(&p.project_ref.machine_id)) {
        return Err(not_found(id));
    }
    Ok(p)
}

async fn preview_start(
    hub: Arc<Hub>,
    caller: Caller,
    input: PreviewStartInput,
) -> Result<PreviewStartOutput, ToolError> {
    let r = input.project_ref;
    require(&caller, Role::Read, Some(&r.machine_id))?;
    refuse_start(&caller, &r.machine_id)?;
    let preview = start(
        &hub,
        &r,
        Ask {
            of: input.of,
            target: input.target.unwrap_or_default(),
            asked_by: PreviewAsker {
                words: Line::unchecked("you"),
                message_id: None,
            },
        },
    )
    .await?;
    let next = match preview.state {
        PreviewState::Ready => "It runs: open it in the app or at its url.",
        _ => "It is starting: preview.state events follow each step; previews_list reads it.",
    };
    Ok(PreviewStartOutput {
        preview,
        next: Some(next.into()),
        truncated: None,
    })
}

async fn preview_end(
    hub: Arc<Hub>,
    caller: Caller,
    input: PreviewEndInput,
) -> Result<PreviewEndOutput, ToolError> {
    let p = readable(&hub, &caller, &input.preview_id)?;
    refuse_start(&caller, &p.project_ref.machine_id)?;
    let preview = end(&hub, p, PreviewEndReason::Ended, None)?;
    Ok(PreviewEndOutput {
        preview,
        next: None,
        truncated: None,
    })
}

async fn previews_list(
    hub: Arc<Hub>,
    caller: Caller,
    input: PreviewsListInput,
) -> Result<PreviewsListOutput, ToolError> {
    let r = input.project_ref;
    require(&caller, Role::Read, Some(&r.machine_id))?;
    if hub.store.project_get(&r)?.is_none() {
        return Err(unknown_project(&r));
    }
    let previews: Vec<Preview> = list(&hub, &r)?
        .into_iter()
        .filter(|p| input.of.as_ref().is_none_or(|of| &p.of == of))
        .collect();
    let all = list(&hub, &r)?;
    let suggestions = super::calls::suggestions(&hub, &r)?
        .into_iter()
        .filter(|s| input.of.as_ref().is_none_or(|of| &s.of == of))
        .filter(|s| !all.iter().any(|p| p.of == s.of))
        .collect();
    Ok(PreviewsListOutput {
        previews: List::unchecked(previews),
        suggestions: List::unchecked(suggestions),
        can_start: Some(may_start(&caller, &r.machine_id)),
        next: None,
        truncated: None,
    })
}

/// Where the person's feedback goes: the PR's writer while it works, else the order's lead, who decides how it's
/// fixed (D162).
pub struct FeedbackTo {
    pub target: SteerTarget,
    pub workstream_id: WorkstreamId,
    /// "#14's writer, at its next step".
    pub words: String,
    pub writer_ended: bool,
}

pub fn feedback_to(hub: &Hub, p: &Preview) -> Result<FeedbackTo, ToolError> {
    let lead = |workstream_id: WorkstreamId, writer_ended: bool| FeedbackTo {
        target: SteerTarget::Lead {
            workstream_id: workstream_id.clone(),
        },
        words: format!("the lead of {workstream_id}, who decides how it's fixed"),
        workstream_id,
        writer_ended,
    };
    match &p.of {
        PreviewOf::Order { workstream_id } => Ok(lead(workstream_id.clone(), false)),
        PreviewOf::Pr { repo, number } => {
            let Some(change) = hub.train.records().latest_for(repo.as_str(), number.get()) else {
                return Err(ToolError::new(
                    ErrorCode::Invalid,
                    format!(
                        "#{} is no order's PR, so no agent works on it.",
                        number.get()
                    ),
                )
                .with_fix("Tell the lead in the project's chat instead."));
            };
            let writer = match &change.task_id {
                Some(task_id) => hub.tasks.get(task_id)?,
                None => None,
            };
            match writer {
                Some(task)
                    if matches!(
                        task.state,
                        TaskState::Queued | TaskState::Running | TaskState::Idle
                    ) =>
                {
                    Ok(FeedbackTo {
                        target: SteerTarget::Task {
                            task_id: task.task_id.clone(),
                        },
                        words: format!("#{}'s writer, at its next step", number.get()),
                        workstream_id: change.workstream_id,
                        writer_ended: false,
                    })
                }
                writer => Ok(lead(change.workstream_id, writer.is_some())),
            }
        }
    }
}

/// The fix request in the person's words: the head line for the agent, and one line per pin.
pub fn fix_request(p: &Preview, pins: &[PreviewPin], to: &FeedbackTo) -> (String, Vec<String>) {
    let at = p
        .head
        .as_ref()
        .map_or(String::new(), |h| format!(" at {}", short(h.as_str())));
    let mut head = format!(
        "Fix request from the person, who tried {} on the {}{at}: {}, below.",
        of_words(&p.of),
        p.target.as_str(),
        match pins.len() {
            1 => "one point".to_owned(),
            n => format!("{n} points"),
        }
    );
    match (&to.target, to.writer_ended) {
        (SteerTarget::Task { .. }, _) => {
            head.push_str(" When it's fixed, push to the PR: the person tries it again from there.")
        }
        (_, true) => head.push_str(&format!(
            " {}'s writer has ended: decide how it's fixed, a fix task on the same branch or a new order.",
            of_words(&p.of)
        )),
        (_, false) => head.push_str(" Decide how it's fixed, and push the fix to the PR it belongs to."),
    }
    let lines = pins
        .iter()
        .enumerate()
        .map(|(i, pin)| {
            let n = i + 1;
            let note = pin
                .note
                .as_ref()
                .map_or("(no words: see the screenshot)".to_owned(), |t| {
                    t.split_whitespace().collect::<Vec<_>>().join(" ")
                });
            let what = pin.what.as_ref().map_or("the point", |w| w.as_str());
            let place = pin
                .at
                .as_ref()
                .map_or(String::new(), |a| format!(", on {}", a.as_str()));
            format!(
                "{n}. {note} Pin {n}: {what}{place}, {}% across, {}% down.",
                pin.x.get() / 100,
                pin.y.get() / 100
            )
        })
        .collect();
    (head, lines)
}

fn short(sha: &str) -> &str {
    sha.get(..7).unwrap_or(sha)
}

async fn preview_feedback(
    hub: Arc<Hub>,
    caller: Caller,
    input: PreviewFeedbackInput,
) -> Result<PreviewFeedbackOutput, ToolError> {
    let p = readable(&hub, &caller, &input.preview_id)?;
    if !may_start(&caller, &p.project_ref.machine_id) {
        return Err(ToolError::new(
            ErrorCode::Forbidden,
            "Only a person with an admin or operate key sends feedback to the agents.",
        )
        .with_fix("Use the desktop app with such a key."));
    }
    let to = feedback_to(&hub, &p)?;
    let (head, mut refs) = fix_request(&p, input.pins.as_slice(), &to);
    let clip = input.clip_seconds.map_or(0, |s| s.get());
    if clip > 0
        && let Some(session) = &p.session_id
    {
        refs.push(format!(
            "The preview's browser session {session} is recorded: its last {clip} s before this request show what \
             the person saw (Sessions in the app replays it)."
        ));
    }
    let ids: Vec<_> = input.files.iter().cloned().collect();
    let attached = if ids.is_empty() {
        Vec::new()
    } else {
        attachments::deliver(
            &hub,
            &caller,
            &ids,
            &p.project_ref,
            to.workstream_id.as_str(),
            Some(&to.workstream_id),
        )
        .await?
    };
    let request = format!("preview:{}:{}", p.preview_id, now_ms(hub.clock.as_ref()));
    crate::hub::steer::send(
        &hub,
        By::Human(&caller),
        SteerRequest {
            target: to.target.clone(),
            text: &head,
            mode: SteerMode::Queue,
            refs,
            attached,
            client_request_id: &request,
        },
    )
    .await?;
    Ok(PreviewFeedbackOutput {
        delivered_to: Line::new(crate::hub::api::clip(&to.words, 300))
            .unwrap_or_else(|_| Line::unchecked("the agents")),
        next: None,
        truncated: None,
    })
}
