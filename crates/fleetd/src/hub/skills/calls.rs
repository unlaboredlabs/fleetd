//! The lead's `skill_install`, for its own project or every project. A task can't make it (`tasks::policy`).
use std::sync::{Arc, Weak};

use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::prim::{Line, List};
use fleetd_contracts::skills::{SkillInstallResult, SkillName, SkillScope};

use super::SkillError;
use super::tools::{changed, install_from};
use crate::hub::api::Hub;
use crate::hub::link::lead_calls::{LeadCallFuture, op_of};
use crate::hub::link::{LeadCaller, LeadCalls};

pub const OPS: [&str; 1] = ["skill_install"];

impl From<SkillError> for McpToolError {
    fn from(e: SkillError) -> Self {
        let error = McpToolError::new(e.code, e.message);
        match e.fix {
            Some(fix) => error.with_fix(fix),
            None => error,
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
                answer(&hub, &caller, call).await
            })
        },
    );
    let calls: &LeadCalls = &hub.lead_calls;
    for op in OPS {
        calls.register(op, handler.clone());
    }
}

async fn answer(
    hub: &Hub,
    caller: &LeadCaller,
    call: LeadCall,
) -> Result<LeadCallResult, McpToolError> {
    let LeadCall::SkillInstall(call) = call else {
        return Err(McpToolError::new(
            ErrorCode::Invalid,
            format!("{} is not a skills call.", op_of(&call)),
        ));
    };
    // Global skills take admin on every machine (`tools::scope_project`), which a lead never holds.
    if call.scope == SkillScope::Global {
        return Err(McpToolError::new(
            ErrorCode::Forbidden,
            "A lead installs skills for its own project only: global ones take an admin.",
        )
        .with_fix("Install it with scope project, or ask the human to install it globally from Settings > Skills."));
    }
    let r = Some(&caller.project_ref);
    let (kept, commit) = install_from(
        hub,
        call.scope,
        r,
        call.source.as_str(),
        call.skill.as_ref(),
        false,
    )
    .await?;
    let names: Vec<SkillName> = kept.iter().map(|k| k.name.clone()).collect();
    changed(hub, r, &names, &caller.by)
        .map_err(|e| McpToolError::new(ErrorCode::Failed, e.to_string()))?;
    let list = names
        .iter()
        .map(|n| format!("fleetd:{n}"))
        .collect::<Vec<_>>()
        .join(", ");
    Ok(LeadCallResult::SkillInstall(SkillInstallResult {
        installed: List::unchecked(names),
        commit: Line::unchecked(commit),
        next: Some(format!(
            "Installed {list}, pinned to this commit; the human updates it from Settings > Skills. Sessions started \
             from now get it (yours from its next start): name it in a brief and the agent uses it."
        )),
    }))
}
