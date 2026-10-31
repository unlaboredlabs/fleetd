//! A Navi's `skill_save` (W238, D261): it writes one of its own skills, new or changed, with no approval. The skill is
//! its project's, kept as a new version of the Navi's with its one line on why, so the person sees, diffs and reverts
//! it in the app; the chat gets one quiet line linking to it; and the Navi's sessions get it from their next start, as
//! every project skill reaches its sessions. Only a Navi's own lead makes it, so a Navi's skill never reaches another
//! Navi or a project. An installed skill is the person's, pinned to its source: a Navi saves its version under a name
//! of its own.
use std::sync::{Arc, Weak};

use fleetd_contracts::chat::ChatAuthor;
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::prim::Int;
use fleetd_contracts::skills::{SkillSaveCall, SkillSaveResult, SkillSaved, SkillScope};

use super::calls::title_of;
use super::tools::changed;
use super::{Who, versions};
use crate::hub::api::Hub;
use crate::hub::chat::NewMessage;
use crate::hub::link::LeadCaller;
use crate::hub::link::lead_calls::{CallerAgent, LeadCallFuture, op_of};
use crate::hub::store::{StoreError, now_ms};

pub const OPS: [&str; 1] = ["skill_save"];

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
    tracing::error!(error = %e, "skill_save store");
    McpToolError::new(ErrorCode::Failed, "The hub failed to save the skill.")
}

fn answer(hub: &Hub, caller: &LeadCaller, call: LeadCall) -> Result<LeadCallResult, McpToolError> {
    let LeadCall::SkillSave(call) = call else {
        return Err(McpToolError::new(
            ErrorCode::Invalid,
            format!("{} is not a skill save.", op_of(&call)),
        ));
    };
    let r = &caller.project_ref;
    if !crate::hub::navi::bridge::is_navi(&hub.db, r, false).map_err(failed)? {
        return Err(McpToolError::new(
            ErrorCode::Forbidden,
            "Only a Navi saves skills of its own: a project's skills are the person's, in Settings > Skills.",
        )
        .with_fix("Install one from a source with skill_install, or ask the human to write it."));
    }
    if caller.agent != CallerAgent::Lead {
        return Err(McpToolError::new(
            ErrorCode::Forbidden,
            "Only the Navi itself saves its skills.",
        ));
    }
    Ok(LeadCallResult::SkillSave(save(hub, caller, &call)?))
}

fn save(
    hub: &Hub,
    caller: &LeadCaller,
    call: &SkillSaveCall,
) -> Result<SkillSaveResult, McpToolError> {
    let r = &caller.project_ref;
    let skills = hub.db.skills();
    let before = skills.get(SkillScope::Project, Some(r), &call.name);
    if before.as_ref().is_some_and(|k| k.install.is_some()) {
        return Err(McpToolError::new(
            ErrorCode::Invalid,
            format!(
                "{} was installed from a source, and its updates would replace your change.",
                call.name
            ),
        )
        .with_fix("Save your version under a name of its own."));
    }
    let created = before.is_none();
    let who = Who::agent(
        &title_of(hub, r),
        call.why.as_str(),
        now_ms(hub.clock.as_ref()),
    );
    let kept = skills.set(
        SkillScope::Project,
        Some(r),
        &call.name,
        call.text.as_str(),
        false,
        &who,
    )?;
    let version = kept.changed.as_ref().map_or(1, |v| v.version.get());
    changed(hub, Some(r), std::slice::from_ref(&call.name), &caller.by).map_err(failed)?;
    let text = if created {
        format!("Saved a new skill, {}: {}", call.name, call.why.as_str())
    } else {
        format!("Updated the skill {}: {}", call.name, call.why.as_str())
    };
    let saved = SkillSaved {
        name: call.name.clone(),
        version: Int::unchecked(version),
        created,
        why: call.why.clone(),
    };
    hub.chat
        .add(
            r,
            NewMessage {
                author: Some(ChatAuthor::System),
                text,
                skill_saved: Some(saved),
                ..Default::default()
            },
        )
        .map_err(failed)?;
    let off = versions::uses(&hub.db, r)
        .map_err(failed)?
        .get(call.name.as_str())
        .is_some_and(|u| u.off);
    let next = if off {
        format!(
            "Saved as version {version}. The person turned {} off, so your sessions don't get it until they turn it \
             back on.",
            call.name
        )
    } else {
        format!(
            "Saved as version {version}; the person sees it in your Skills. Your next session lists it as fleetd:{}.",
            call.name
        )
    };
    Ok(SkillSaveResult {
        name: call.name.clone(),
        version: Int::unchecked(version),
        created,
        next: Some(next),
    })
}
