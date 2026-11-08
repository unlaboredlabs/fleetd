//! The cloud machines' tools: `cloud_get` for anyone signed in (Settings › Hub › Machines, Status), and for keys with
//! admin on every machine the settings, the boat key (sealed in the app to the hub's own box key), Test (the key, then
//! the whole way from a cloud machine to the hub), Create, Reset, Resume and `cloud_stop`, the kill switch (`fleetd
//! cloud stop`, and "Stop all cloud machines"). No key or secret comes back; the hub's SSH key shows only its public
//! half.
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
use super::{CreateSpec, Why, ledger::State};
use crate::hub::api::{
    Caller, Hub, Registry, ToolError, admin_everywhere_fix, allows_everywhere, error,
    internal_error,
};

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

/// Cloud machines are the hub's, as its other Hub settings are: their account, money and kill switch take admin on every
/// machine, never on some.
fn hub_admin(caller: &Caller) -> Result<(), ToolError> {
    if allows_everywhere(caller, Role::Admin) {
        return Ok(());
    }
    Err(error(
        ErrorCode::Forbidden,
        "Cloud machines are the hub's: changing them takes admin on every machine.",
        admin_everywhere_fix(caller),
    ))
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
    // Made with the boat key, so a hub that never uses cloud machines never makes one.
    let ssh_key = if s.has_key {
        pool.ssh_public_key()
            .inspect_err(|e| tracing::error!(error = %e, "cloud: the hub's SSH key"))
            .ok()
    } else {
        None
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
        path_test: pool.path_test(),
        ssh_key,
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
    hub_admin(&caller)?;
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
    hub_admin(&caller)?;
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
    hub_admin(&caller)?;
    let test = hub.pool.test().await;
    if test.ok {
        test_path(&hub).await;
    }
    Ok(CloudTestOutput {
        test,
        cloud: cloud_view(&hub)?,
        next: None,
        truncated: None,
    })
}

/// The Test of the whole way, once the key works and cloud machines are on: a machine awake already is checked as it
/// is, else one waking or being made is followed, else one asleep is woken (one boat start), else the first slot not
/// made yet is created. The life loop follows it from there ([`super::Pool::path_test`]); a start refused ends it here.
pub async fn test_path(hub: &Hub) {
    let pool = &hub.pool;
    let (Ok(s), Ok(rows)) = (pool.ledger().settings(), pool.ledger().slots()) else {
        return;
    };
    if !s.enabled {
        return;
    }
    let first = |states: &[State]| {
        rows.iter()
            .find(|r| states.contains(&r.state) && r.sandbox_id.is_some())
            .map(|r| r.slot.clone())
    };
    if let Some(slot) = first(&[State::Awake, State::Waking, State::Creating]) {
        pool.path_begin(&slot);
        if let Ok(Some(row)) = pool.ledger().slot(&slot) {
            pool.path_step(&row);
        }
        return;
    }
    if let Some(slot) = first(&[State::Asleep, State::Stopping]) {
        pool.path_begin(&slot);
        // A wake that didn't start says why on the machine's line, or as the pool's hold.
        if pool.wake(&slot, Why::Test).await.is_err() {
            pool.path_clear();
        }
        return;
    }
    match pool.missing().ok().and_then(|m| m.into_iter().next()) {
        Some(slot) if s.environment.is_some() => {
            pool.path_begin(&slot);
            if create_slot(hub, &slot).await.is_err() {
                pool.path_clear();
            }
        }
        _ => {
            if let Some(row) = rows.first() {
                pool.path_begin(&row.slot);
                pool.path_end(Err(format!(
                    "{}: {}: Reset it in Settings › Hub › Machines › Cloud machines, then Test again",
                    row.slot,
                    row.note.as_deref().unwrap_or("it can't be woken")
                )));
            }
        }
    }
}

/// Creates `slot`'s machine: the setup script for this hub, and a one-time pool enroll token in a file under /tmp,
/// which boat never snapshots. The create spends one boat start. No token is minted while starts are held, and one
/// whose create boat didn't take is revoked: only a machine being made holds an open code.
async fn create_slot(hub: &Hub, slot: &str) -> Result<(), String> {
    let id = MachineId::new(slot).map_err(|e| e.to_string())?;
    if let Some(why) = hub.pool.start_held() {
        return Err(why);
    }
    let script = crate::hub::cloud::setup::for_slot(hub, &id)?;
    let token = hub
        .auth
        .create_pool_enroll_token(&id)
        .map_err(|e| e.to_string())?;
    let body_until = crate::hub::store::parse_ms(&token.expires_at)
        .ok_or("the enroll token's end can't be read")?;
    let made = hub
        .pool
        .create(
            slot,
            CreateSpec {
                setup_script: Some(script),
                files: vec![File {
                    path: crate::hub::cloud::setup::TOKEN_FILE.to_owned(),
                    content: token.token.clone(),
                }],
                body_until,
            },
        )
        .await;
    // A create with no answer stays `creating`, and the sweep may send its body, token and all, again.
    let creating =
        matches!(hub.pool.ledger().slot(slot), Ok(Some(r)) if r.state == State::Creating);
    if made.is_err()
        && !creating
        && let Err(e) = hub.auth.revoke_enroll_secret(&token.token)
    {
        tracing::warn!(slot, error = %e, "pool: a refused create's enroll code wasn't revoked");
    }
    made
}

async fn create(
    hub: Arc<Hub>,
    caller: Caller,
    _: CloudCreateInput,
) -> Result<CloudCreateOutput, ToolError> {
    hub_admin(&caller)?;
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
    hub_admin(&caller)?;
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
    hub_admin(&caller)?;
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
    hub_admin(&caller)?;
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
