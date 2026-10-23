//! prompt_get, prompt_set and session_prompt_get.
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::mcp::{
    ErrorCode, PromptGetInput, PromptGetOutput, PromptSetInput, PromptSetOutput,
    SessionPromptGetInput, SessionPromptGetOutput,
};
use fleetd_contracts::prompts::{PromptRef, PromptScope};
use serde_json::json;

use super::render::{ref_of, warnings};
use super::retired;
use super::store::{PromptError, entry};
use crate::hub::api::{
    Caller, Hub, Registry, ToolError, allows, allows_everywhere, is_human, require,
};
use crate::hub::store::{iso_ms, now_ms};

pub fn register(tools: &mut Registry) {
    tools.add("prompt_get", prompt_get);
    tools.add("prompt_set", prompt_set);
    tools.add("session_prompt_get", session_prompt_get);
}

impl From<PromptError> for ToolError {
    fn from(e: PromptError) -> Self {
        match e {
            PromptError::Invalid(m) => ToolError::new(ErrorCode::Invalid, m),
            PromptError::NotFound(m) => ToolError::new(ErrorCode::NotFound, m)
                .with_fix("prompt_get without an id lists every prompt."),
            PromptError::Store(e) => e.into(),
            PromptError::Io(e) => ToolError::new(ErrorCode::Failed, e.to_string()),
        }
    }
}

/// A retired id gets told where its words went, instead of a bare "no such prompt".
fn retired_hint(id: &str, e: PromptError) -> ToolError {
    match retired::get(id) {
        Some(r) => ToolError::new(
            ErrorCode::NotFound,
            format!("fleetd retired {id}: {}.", r.why),
        )
        .with_fix(match r.target {
            Some(t) => format!(
                "Edit {t} instead; prompt_get without an id shows any edit you made to {id} under orphans."
            ),
            None => format!("prompt_get without an id shows any edit you made to {id} under orphans."),
        }),
        None => e.into(),
    }
}

fn readable_project(hub: &Hub, caller: &Caller, r: Option<&ProjectRef>) -> Result<(), ToolError> {
    let Some(r) = r else { return Ok(()) };
    require(caller, Role::Read, Some(&r.machine_id))?;
    if hub.store.project_get(r)?.is_none() {
        return Err(ToolError::new(
            ErrorCode::NotFound,
            format!("No project {} on {}.", r.project_id, r.machine_id),
        )
        .with_fix("project_get without a projectId lists them."));
    }
    Ok(())
}

/// A hub-wide prompt reaches every machine's agents: admin on every machine, or a person's device that may operate
/// everywhere. A project's prompt: the same on its machine.
fn may_edit(caller: &Caller, scope: PromptScope, r: Option<&ProjectRef>) -> Result<(), ToolError> {
    let ok = match (scope, r) {
        (PromptScope::Project, Some(r)) => {
            allows(caller, Role::Admin, Some(&r.machine_id))
                || (is_human(caller) && allows(caller, Role::Operate, Some(&r.machine_id)))
        }
        _ => {
            allows_everywhere(caller, Role::Admin)
                || (is_human(caller) && allows_everywhere(caller, Role::Operate))
        }
    };
    if ok {
        Ok(())
    } else {
        Err(ToolError::new(
            ErrorCode::Forbidden,
            "Prompts steer every agent they reach; this key may not change them there.",
        )
        .with_fix("Use the desktop app, or a key from fleetd hub key create --role admin."))
    }
}

async fn prompt_get(
    hub: Arc<Hub>,
    caller: Caller,
    input: PromptGetInput,
) -> Result<PromptGetOutput, ToolError> {
    let r = input.project_ref.as_ref();
    readable_project(&hub, &caller, r)?;
    let Some(id) = input.id else {
        let orphans = hub.db.prompts().orphans(r);
        let next = if orphans.is_empty() {
            "prompt_get with an id shows one prompt's texts, placeholders and safety rules."
        } else {
            "orphans are your edits to prompts fleetd retired: copy what you need into suggestedTarget, then delete the old one with prompt_set (text null)."
        };
        return Ok(PromptGetOutput {
            prompts: Some(hub.db.prompts().list(r)),
            orphans: Some(orphans),
            prompt: None,
            next: Some(next.into()),
            truncated: None,
        });
    };
    let e = entry(id.as_str()).map_err(|e| retired_hint(id.as_str(), e))?;
    let prompt = hub.db.prompts().detail(e, r);
    let next = prompt.stale.as_ref().map(|s| {
        format!(
            "fleetd changed this prompt's default; yours is still in effect. Save the merged text (or yours) with base {}, or reset it with text null.",
            s.current.r#ref
        )
    });
    Ok(PromptGetOutput {
        prompts: None,
        orphans: None,
        prompt: Some(prompt),
        next,
        truncated: None,
    })
}

async fn prompt_set(
    hub: Arc<Hub>,
    caller: Caller,
    input: PromptSetInput,
) -> Result<PromptSetOutput, ToolError> {
    let Some(text) = input.text.as_deref() else {
        return reset(&hub, &caller, &input).await;
    };
    let e = entry(input.id.as_str()).map_err(|e| retired_hint(input.id.as_str(), e))?;
    let r = input.project_ref.as_ref();
    may_edit(&caller, input.scope, r)?;
    readable_project(&hub, &caller, r)?;
    if input.dry_run == Some(true) {
        return Ok(PromptSetOutput {
            r#ref: PromptRef::unchecked(ref_of(e.id, text)),
            warnings: warnings(e, text),
            next: Some("Not saved: dryRun.".into()),
            truncated: None,
        });
    }
    let (saved, found) = hub.db.prompts().set(
        e,
        input.scope,
        r,
        text,
        input.base.as_ref().map(|b| b.as_str()),
    )?;
    let codes: Vec<_> = found.iter().map(|w| w.code).collect();
    super::changed(
        &hub.events,
        &iso_ms(now_ms(hub.clock.as_ref())),
        e.id,
        input.scope,
        r,
        json!({ "ref": saved, "warnings": codes }),
    )?;
    Ok(PromptSetOutput {
        r#ref: PromptRef::unchecked(saved),
        warnings: found,
        next: Some(
            "New sessions get it now; a running lead gets it at its next fresh lead_start, a task at its next attempt.".into(),
        ),
        truncated: None,
    })
}

/// `prompt_set` with `text: null`: back to the next level, or a retired prompt's edit deleted.
async fn reset(
    hub: &Hub,
    caller: &Caller,
    input: &PromptSetInput,
) -> Result<PromptSetOutput, ToolError> {
    let r = input.project_ref.as_ref();
    if let Some(old) = retired::get(input.id.as_str()) {
        may_edit(caller, input.scope, r)?;
        readable_project(hub, caller, r)?;
        hub.db.prompts().reset_retired(old, input.scope, r)?;
        super::changed(
            &hub.events,
            &iso_ms(now_ms(hub.clock.as_ref())),
            old.id,
            input.scope,
            r,
            json!({ "retired": true }),
        )?;
        // A retired prompt sends nothing: what is in effect is no text at all.
        return Ok(PromptSetOutput {
            r#ref: PromptRef::unchecked(ref_of(old.id, "")),
            warnings: Vec::new(),
            next: Some(format!(
                "Your edit to {} is deleted; fleetd retired that prompt.",
                old.id
            )),
            truncated: None,
        });
    }
    let e = entry(input.id.as_str())?;
    may_edit(caller, input.scope, r)?;
    readable_project(hub, caller, r)?;
    hub.db.prompts().reset(e, input.scope, r)?;
    super::changed(
        &hub.events,
        &iso_ms(now_ms(hub.clock.as_ref())),
        e.id,
        input.scope,
        r,
        json!({}),
    )?;
    Ok(PromptSetOutput {
        r#ref: hub.db.prompts().detail(e, r).effective.r#ref,
        warnings: Vec::new(),
        next: Some("Reset: the next level's text is in effect.".into()),
        truncated: None,
    })
}

async fn session_prompt_get(
    hub: Arc<Hub>,
    caller: Caller,
    input: SessionPromptGetInput,
) -> Result<SessionPromptGetOutput, ToolError> {
    require(&caller, Role::Read, Some(&input.machine_id))?;
    let session = hub
        .db
        .prompts()
        .session(&input.machine_id, &input.thread_id)?
        .ok_or_else(|| {
            ToolError::new(
                ErrorCode::NotFound,
                format!(
                    "fleetd kept no first message for thread {} on {}: it did not start it, or started it before prompts were kept.",
                    input.thread_id, input.machine_id
                ),
            )
            .with_fix("thread_tail shows the thread's messages.")
        })?;
    Ok(SessionPromptGetOutput {
        session,
        next: Some("thread_tail shows its later messages.".into()),
        truncated: None,
    })
}
