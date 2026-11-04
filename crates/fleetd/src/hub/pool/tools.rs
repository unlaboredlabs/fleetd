//! The cloud machines' tools: `cloud_get` for anyone signed in (Settings › Hub › Machines, Status), and for admin keys
//! the settings, the boat key (sealed in the app to the hub's own box key), Test, Create, Reset, Resume and
//! `cloud_stop`, the kill switch (`fleetd cloud stop`, and "Stop all cloud machines"). No key or secret comes back.
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::auth::Role;
use fleetd_contracts::cloud::CloudView;
use fleetd_contracts::ids::MachineId;
use fleetd_contracts::mcp::{
    CloudCreateInput, CloudCreateOutput, CloudGetInput, CloudGetOutput, CloudKeySetInput,
    CloudKeySetOutput, CloudResetInput, CloudResetOutput, CloudResumeInput, CloudResumeOutput,
    CloudSetInput, CloudSetOutput, CloudStopInput, CloudStopOutput, CloudTestInput,
    CloudTestOutput, ErrorCode,
};

use super::boat::File;
use super::view;
use super::{CreateSpec, ledger::State};
use crate::hub::api::{Caller, Hub, Registry, ToolError, error, internal_error, require};

pub fn register(tools: &mut Registry) {
    tools.add("cloud_stop", stop);
    tools.add("cloud_get", get);
    tools.add("cloud_set", set);
    tools.add("cloud_key_set", key_set);
    tools.add("cloud_test", test);
    tools.add("cloud_create", create);
    tools.add("cloud_reset", reset);
    tools.add("cloud_resume", resume);
}

fn failed(e: impl std::fmt::Display) -> ToolError {
    ToolError::new(ErrorCode::Failed, e.to_string())
}

/// The environment the setup step has the admin make: `fleetd-<hub>`, named as the step names it.
pub fn environment_default(hub: &Hub) -> String {
    let url = crate::hub::setup::tools::hub_url(hub);
    format!(
        "fleetd-{}",
        crate::hub::setup::host_of(url.trim_end_matches('/'))
    )
}

/// The pool as the app shows it.
pub fn cloud_view(hub: &Hub) -> Result<CloudView, ToolError> {
    let pool = &hub.pool;
    let s = pool.ledger().settings()?;
    let now = pool.now();
    let budget = pool.budget(&s, now)?;
    let machines =
        pool.machines(|slot| MachineId::new(slot).ok().and_then(|id| hub.link.busy(&id)))?;
    let (hub_url, network) = match crate::hub::cloud::setup::public_hub_url(hub) {
        Ok(url) => (Some(url), None),
        Err(why) => (None, Some(why)),
    };
    let box_pub_key = crate::hub::hub_links::box_key(hub)
        .map_err(|e| {
            tracing::error!(error = %e, "cloud: the hub's box key");
            internal_error()
        })?
        .public_key();
    Ok(CloudView {
        has_key: s.has_key,
        enabled: s.enabled,
        pool_size: s.pool_size,
        machine_type: s.machine_type.clone(),
        day_budget: s.day_budget,
        month_budget: budget.month_budget,
        month_is_plan: s.month_budget.is_none(),
        environment: s.environment.clone(),
        environment_default: environment_default(hub),
        projects: s.projects.clone(),
        today: budget.day_spent,
        month: budget.month_spent,
        held: s.has_key.then(|| pool.start_held()).flatten(),
        paused: s.paused.as_ref().map(|(_, why)| why.clone()),
        key_test: pool.key_test(),
        machines,
        sizes: view::sizes(),
        plan_dollars: s.plan_dollars,
        hub_url,
        network,
        box_pub_key,
    })
}

async fn get(hub: Arc<Hub>, _: Caller, _: CloudGetInput) -> Result<CloudGetOutput, ToolError> {
    Ok(CloudGetOutput {
        cloud: cloud_view(&hub)?,
        next: None,
        truncated: None,
    })
}

async fn set(
    hub: Arc<Hub>,
    caller: Caller,
    input: CloudSetInput,
) -> Result<CloudSetOutput, ToolError> {
    require(&caller, Role::Admin, None)?;
    let s = &input.settings;
    if s.enabled && !hub.pool.ledger().settings()?.has_key {
        return Err(error(
            ErrorCode::Invalid,
            "Cloud machines need a boat.dev key first.",
            "Paste the key, Test it, then turn cloud machines on.",
        ));
    }
    hub.pool
        .apply(s)
        .map_err(|why| ToolError::new(ErrorCode::Invalid, why))?;
    Ok(CloudSetOutput {
        cloud: cloud_view(&hub)?,
        next: None,
        truncated: None,
    })
}

async fn key_set(
    hub: Arc<Hub>,
    caller: Caller,
    input: CloudKeySetInput,
) -> Result<CloudKeySetOutput, ToolError> {
    require(&caller, Role::Admin, None)?;
    let refused = || {
        error(
            ErrorCode::Invalid,
            "The boat.dev key wasn't sealed to this hub, or is empty.",
            "Paste the key again in Settings › Hub › Machines › Cloud machines.",
        )
    };
    let box_key = crate::hub::hub_links::box_key(&hub).map_err(|e| {
        tracing::error!(error = %e, "cloud: the hub's box key");
        internal_error()
    })?;
    let plain = B64
        .decode(input.sealed.as_str())
        .ok()
        .and_then(|s| box_key.open(&s))
        .and_then(|p| String::from_utf8(p.to_vec()).ok())
        .map(zeroize::Zeroizing::new)
        .ok_or_else(refused)?;
    let key = plain.trim();
    if key.is_empty() || key.chars().any(char::is_whitespace) {
        return Err(refused());
    }
    if !key.starts_with("boat_") {
        return Err(error(
            ErrorCode::Invalid,
            "That isn't a boat.dev API key.",
            "Paste the key boat.dev showed once you made it: it starts with boat_.",
        ));
    }
    hub.pool.set_key(key).map_err(failed)?;
    Ok(CloudKeySetOutput {
        cloud: cloud_view(&hub)?,
        next: None,
        truncated: None,
    })
}

async fn test(
    hub: Arc<Hub>,
    caller: Caller,
    _: CloudTestInput,
) -> Result<CloudTestOutput, ToolError> {
    require(&caller, Role::Admin, None)?;
    let test = hub.pool.test().await;
    Ok(CloudTestOutput {
        test,
        cloud: cloud_view(&hub)?,
        next: None,
        truncated: None,
    })
}

/// Creates `slot`'s machine: the setup script for this hub, and a one-time pool enroll token in a file under /tmp,
/// which boat never snapshots. The create spends one boat start.
async fn create_slot(hub: &Hub, slot: &str) -> Result<(), String> {
    let id = MachineId::new(slot).map_err(|e| e.to_string())?;
    let script = crate::hub::cloud::setup::for_slot(hub, &id)?;
    let token = hub
        .auth
        .create_pool_enroll_token(&id)
        .map_err(|e| e.to_string())?;
    let body_until = crate::hub::store::parse_ms(&token.expires_at)
        .ok_or("the enroll token's end can't be read")?;
    hub.pool
        .create(
            slot,
            CreateSpec {
                setup_script: Some(script),
                files: vec![File {
                    path: crate::hub::cloud::setup::TOKEN_FILE.to_owned(),
                    content: token.token,
                }],
                body_until,
            },
        )
        .await
}

async fn create(
    hub: Arc<Hub>,
    caller: Caller,
    _: CloudCreateInput,
) -> Result<CloudCreateOutput, ToolError> {
    require(&caller, Role::Admin, None)?;
    // The key is scoped to the environment: a create outside it is refused, and would count against the starts.
    if hub.pool.ledger().settings()?.environment.is_none() {
        return Err(error(
            ErrorCode::Invalid,
            "No boat.dev environment is saved, and the hub's key is scoped to one.",
            format!(
                "Save the environment you made in Settings › Hub › Machines › Cloud machines ({}), then create them.",
                environment_default(&hub)
            ),
        ));
    }
    if let Err(why) = crate::hub::cloud::setup::public_hub_url(&hub) {
        return Err(ToolError::new(ErrorCode::Invalid, why));
    }
    let missing = hub.pool.missing()?;
    let mut lines = Vec::new();
    for slot in &missing {
        match create_slot(&hub, slot).await {
            Ok(()) => lines.push(format!("{slot}: creating")),
            Err(why) => {
                lines.push(format!("{slot}: not created: {why}"));
                // One refusal holds every start the same way (budget, backoff, plan): stop asking.
                break;
            }
        }
    }
    if missing.is_empty() {
        lines.push("Every cloud machine is made.".into());
    }
    Ok(CloudCreateOutput {
        lines,
        cloud: cloud_view(&hub)?,
        next: None,
        truncated: None,
    })
}

async fn reset(
    hub: Arc<Hub>,
    caller: Caller,
    input: CloudResetInput,
) -> Result<CloudResetOutput, ToolError> {
    require(&caller, Role::Admin, None)?;
    let slot = input.machine_id.as_str();
    let row = hub.pool.ledger().slot(slot)?.ok_or_else(|| {
        error(
            ErrorCode::NotFound,
            format!("{slot} isn't one of the hub's cloud machines."),
            "Pick one from Settings › Hub › Machines › Cloud machines.",
        )
    })?;
    if matches!(row.state, State::Awake | State::Waking) {
        return Err(error(
            ErrorCode::Invalid,
            format!("{slot} is awake: Reset deletes its disk, and its work with it."),
            "Wait until it is asleep, or Stop all cloud machines first.",
        ));
    }
    hub.pool
        .retire(slot)
        .await
        .map_err(|why| ToolError::new(ErrorCode::Failed, why))?;
    let said = match create_slot(&hub, slot).await {
        Ok(()) => format!("{slot} was deleted at boat.dev and is being made again."),
        Err(why) => format!("{slot} was deleted at boat.dev; making it again waits: {why}"),
    };
    Ok(CloudResetOutput {
        said,
        cloud: cloud_view(&hub)?,
        next: None,
        truncated: None,
    })
}

async fn resume(
    hub: Arc<Hub>,
    caller: Caller,
    _: CloudResumeInput,
) -> Result<CloudResumeOutput, ToolError> {
    require(&caller, Role::Admin, None)?;
    hub.pool.resume_bursting()?;
    Ok(CloudResumeOutput {
        cloud: cloud_view(&hub)?,
        next: None,
        truncated: None,
    })
}

async fn stop(
    hub: Arc<Hub>,
    caller: Caller,
    _: CloudStopInput,
) -> Result<CloudStopOutput, ToolError> {
    require(&caller, Role::Admin, None)?;
    let kill = hub
        .pool
        .kill()
        .await
        .map_err(|e| ToolError::new(ErrorCode::Failed, e))?;
    Ok(CloudStopOutput {
        stopped: kill.stopped,
        failed: kill
            .failed
            .into_iter()
            .map(|(machine, why)| format!("{machine}: {why}"))
            .collect(),
        unlisted: kill.unlisted,
        next: None,
        truncated: None,
    })
}
