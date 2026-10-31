//! machine_add_plan, machine_add, machine_add_status, machine_hosts, machine_remove, machine_join and
//! machine_claude_login: an owner's or admin's device only, as everything on the Hub pages of the app's Settings.
use std::sync::{Arc, Mutex};

use fleetd_contracts::auth::Role;
use fleetd_contracts::ids::{MachineId, Timestamp};
use fleetd_contracts::machine_setup::{MachineHost, MachineHostSource, SetupStepState, SshHost};
use fleetd_contracts::mcp::{
    ErrorCode, MachineAddInput, MachineAddOutput, MachineAddPlanInput, MachineAddPlanOutput,
    MachineAddStatusInput, MachineAddStatusOutput, MachineClaudeLoginInput,
    MachineClaudeLoginOutput, MachineHostsInput, MachineHostsOutput, MachineJoinInput,
    MachineJoinOutput, MachineRemoveInput, MachineRemoveOutput,
};

use super::{Steps, spawn_add, split_fix};
use crate::cli::setup::machine::{
    self, AddArgs, Begin, Enroll, Found, HubSide, Progress, Resolved, Stop,
};
use crate::hub::api::{
    Caller, Hub, Registry, ToolError, admin_everywhere_fix, allows_everywhere, is_human,
};
use crate::hub::store::{iso_ms, now_ms};

pub fn register(tools: &mut Registry) {
    tools.add("machine_add_plan", machine_add_plan);
    tools.add("machine_add", machine_add);
    tools.add("machine_add_status", machine_add_status);
    tools.add("machine_hosts", machine_hosts);
    tools.add("machine_remove", machine_remove);
    tools.add("machine_join", machine_join);
    tools.add("machine_claude_login", machine_claude_login);
}

/// Adding a machine runs commands on it and enrolls it, so it takes a person with Admin on every machine.
fn admin(caller: &Caller) -> Result<(), ToolError> {
    if allows_everywhere(caller, Role::Admin) && is_human(caller) {
        return Ok(());
    }
    Err(ToolError::new(
        ErrorCode::Forbidden,
        "Adding and removing machines is for the hub's owners and admins, from their own device.",
    )
    .with_fix(admin_everywhere_fix(caller)))
}

fn stopped(stop: Stop) -> ToolError {
    let (message, fix) = split_fix(&stop.message);
    let code = if stop.code == 2 {
        ErrorCode::Invalid
    } else {
        ErrorCode::Failed
    };
    let error = ToolError::new(code, message);
    match fix {
        Some(fix) => error.with_fix(fix),
        None => error,
    }
}

/// The ssh_config file a machine at `host` was set up with (`machine add --ssh-config`), so a repair or a retry
/// connects as the first run did, and its record keeps it.
fn recorded_ssh_config(hub: &Hub, host: &str, machine_id: Option<&MachineId>) -> Option<String> {
    let state = crate::cli::setup::state::read_setup(&hub.config.home)
        .ok()
        .flatten()?;
    state
        .machines
        .iter()
        .filter(|(id, r)| {
            !r.local && r.ssh_host == host && machine_id.is_none_or(|m| m.as_str() == id.as_str())
        })
        .find_map(|(_, r)| r.ssh_config.clone())
}

/// `machine add <host>` or `--local`, as the hub runs it: its own home, its own enrollment, and the ssh_config the
/// machine was set up with before.
fn resolve(
    hub: &Hub,
    host: Option<&SshHost>,
    machine_id: Option<&MachineId>,
) -> Result<Resolved, ToolError> {
    let exe = hub
        .machine_setup
        .ports()
        .exe()
        .map_err(|message| ToolError::new(ErrorCode::Failed, message))?;
    let args = AddArgs {
        host: host.map(|h| h.as_str().to_owned()),
        machine_id: machine_id.map(|m| m.as_str().to_owned()),
        tags: Vec::new(),
        dry_run: false,
        hub_url: None,
        ssh_config: host.and_then(|h| recorded_ssh_config(hub, h.as_str(), machine_id)),
        home: Some(hub.config.home.to_string_lossy().into_owned()),
        enroll: Enroll::Hub,
        git_identity: None,
        no_service: false,
        claude_config_dir: None,
    };
    machine::resolve(&args, &exe).map_err(stopped)
}

fn side(hub: &Hub) -> HubSide<'_> {
    HubSide {
        auth: &hub.auth,
        store: &hub.store,
    }
}

fn joined(hub: &Hub, machine_id: &str) -> Result<bool, ToolError> {
    let Ok(id) = MachineId::new(machine_id) else {
        return Ok(false);
    };
    Ok(hub.store.machine_get(&id)?.is_some())
}

/// Collects what a run reports, for a tool that answers once it is over.
#[derive(Default)]
struct Collect(Mutex<Steps>);

impl Progress for Collect {
    fn planned(&self, steps: &[Begin]) {
        self.0.lock().unwrap().planned(steps);
    }
    fn begin(&self, step: Begin) {
        self.0.lock().unwrap().begin(&step);
    }
    fn done(&self, output: &str) {
        self.0.lock().unwrap().done(output);
    }
    fn failed(&self, code: i32, output: &str, fix: &str) {
        self.0
            .lock()
            .unwrap()
            .failed(&format!("exit {code}: {output}\nFix: {fix}"));
    }
    fn say(&self, line: &str) {
        self.0.lock().unwrap().say(line);
    }
}

async fn machine_add_plan(
    hub: Arc<Hub>,
    caller: Caller,
    input: MachineAddPlanInput,
) -> Result<MachineAddPlanOutput, ToolError> {
    admin(&caller)?;
    let r = resolve(&hub, input.host.as_ref(), input.machine_id.as_ref())?;
    let runner = hub.machine_setup.ports().runner();
    let collect = Collect::default();
    let builds = hub.machine_setup.ports().builds();
    let prepared = machine::prepare(
        &r,
        Some(side(&hub)),
        runner.as_ref(),
        builds.as_ref(),
        false,
        &collect,
    )
    .await
    .map_err(stopped)?;
    let steps = collect.0.into_inner().unwrap().steps;
    let joined = joined(&hub, &r.machine_id)?;
    Ok(MachineAddPlanOutput {
        machine_id: MachineId::unchecked(r.machine_id.clone()),
        host: input.host,
        platform: prepared.platform(),
        steps: steps
            .into_iter()
            .filter(|s| s.state == SetupStepState::Planned)
            .collect(),
        notes: prepared.plan.notes.clone(),
        joined,
        next: Some(if joined {
            format!(
                "{} is a machine already: adding it again repairs it, and skips what is in place.",
                r.machine_id
            )
        } else {
            "machine_add runs these steps.".into()
        }),
        truncated: None,
    })
}

async fn machine_add(
    hub: Arc<Hub>,
    caller: Caller,
    input: MachineAddInput,
) -> Result<MachineAddOutput, ToolError> {
    admin(&caller)?;
    let r = resolve(&hub, input.host.as_ref(), input.machine_id.as_ref())?;
    let machine = MachineId::unchecked(r.machine_id.clone());
    let at = Timestamp(iso_ms(now_ms(hub.clock.as_ref())));
    let host = input.host.map(|h| h.as_str().to_owned());
    let Some(run) = hub.machine_setup.start(&machine, host, at) else {
        return Err(ToolError::new(
            ErrorCode::Invalid,
            format!("{machine} is being added already."),
        )
        .with_fix("machine_add_status follows it."));
    };
    super::emit(&hub, &run);
    spawn_add(hub, run.clone(), r);
    Ok(MachineAddOutput {
        next: Some(format!(
            "Adding {machine}: each step sends a machine_add.step event with runId {}; machine_add_status reads the run.",
            run.run_id
        )),
        run,
        truncated: None,
    })
}

async fn machine_add_status(
    hub: Arc<Hub>,
    caller: Caller,
    input: MachineAddStatusInput,
) -> Result<MachineAddStatusOutput, ToolError> {
    admin(&caller)?;
    let runs: Vec<_> = hub
        .machine_setup
        .runs()
        .into_iter()
        .filter(|r| input.run_id.as_ref().is_none_or(|id| &r.run_id == id))
        .collect();
    let next = (input.run_id.is_some() && runs.is_empty()).then(|| {
        "No such run: the hub forgets runs when it restarts. Add the machine again; finished steps are skipped.".to_owned()
    });
    Ok(MachineAddStatusOutput {
        runs,
        next,
        truncated: None,
    })
}

async fn machine_hosts(
    hub: Arc<Hub>,
    caller: Caller,
    _: MachineHostsInput,
) -> Result<MachineHostsOutput, ToolError> {
    admin(&caller)?;
    let recorded = crate::cli::setup::state::read_setup(&hub.config.home)
        .ok()
        .flatten()
        .map(|s| s.machines)
        .unwrap_or_default();
    let (ssh, peers) = hub.machine_setup.ports().hosts().await;
    let mut hosts = Vec::new();
    for c in machine::candidates(&recorded, &ssh, &peers) {
        let host = match c.host {
            None => None,
            Some(host) => match SshHost::new(host) {
                Ok(host) => Some(host),
                Err(_) => continue,
            },
        };
        hosts.push(MachineHost {
            joined: joined(&hub, &c.machine_id)?,
            host,
            machine_id: MachineId::unchecked(c.machine_id),
            source: match c.found {
                Found::Here => MachineHostSource::Hub,
                Found::SetUp => MachineHostSource::SetUp,
                Found::SshConfig => MachineHostSource::SshConfig,
                Found::Tailnet => MachineHostSource::Tailnet,
            },
        });
    }
    Ok(MachineHostsOutput {
        hosts,
        next: Some(
            "machine_add_plan shows what adding one runs; a machine the hub can't reach joins with machine_join's line."
                .into(),
        ),
        truncated: None,
    })
}

async fn machine_remove(
    hub: Arc<Hub>,
    caller: Caller,
    input: MachineRemoveInput,
) -> Result<MachineRemoveOutput, ToolError> {
    admin(&caller)?;
    let runner = hub.machine_setup.ports().runner();
    let collect = Collect::default();
    let removed = machine::remove(
        &hub.config.home,
        &input.machine_id,
        input.purge == Some(true),
        side(&hub),
        runner.as_ref(),
        &collect,
    )
    .await
    .map_err(stopped)?;
    let Steps { steps, said } = collect.0.into_inner().unwrap();
    let mut next = said;
    if !removed.remote_ok {
        next.insert(
            0,
            "A step on the machine failed: its output says which, and what to run there by hand."
                .into(),
        );
    }
    Ok(MachineRemoveOutput {
        machine_id: input.machine_id,
        steps,
        revoked: removed.revoked,
        next: Some(next.join("\n")),
        truncated: None,
    })
}

async fn machine_join(
    hub: Arc<Hub>,
    caller: Caller,
    input: MachineJoinInput,
) -> Result<MachineJoinOutput, ToolError> {
    admin(&caller)?;
    let join = crate::cli::pair::worker_join(
        &hub.config.home,
        &hub.auth,
        &input.machine_id,
        input.rejoin == Some(true),
    )
    .map_err(|message| ToolError::new(ErrorCode::Failed, message))?;
    Ok(MachineJoinOutput {
        next: Some(format!(
            "Run the line on {}: it installs fleetd and joins. The code works once, until {}; the machine needs claude and must reach the hub at {}.",
            input.machine_id, join.expires_at, join.hub
        )),
        machine_id: input.machine_id,
        hub_url: join.hub,
        code: join.code,
        expires_at: Timestamp(join.expires_at),
        git_identity: join.git_identity,
        line: join.line,
        truncated: None,
    })
}

/// The code passes through to the node and nowhere else: no log, no event. What claude gets for it stays on the machine.
async fn machine_claude_login(
    hub: Arc<Hub>,
    caller: Caller,
    input: MachineClaudeLoginInput,
) -> Result<MachineClaudeLoginOutput, ToolError> {
    admin(&caller)?;
    let machine = &input.machine_id;
    if hub.store.machine_get(machine)?.is_none() {
        return Err(ToolError::new(
            ErrorCode::NotFound,
            format!("{machine} is not one of this hub's machines."),
        ));
    }
    let code = input.code.as_deref().map(str::trim);
    if code == Some("") {
        return Err(ToolError::new(
            ErrorCode::Invalid,
            "The code is empty: paste the one the sign-in page shows.",
        ));
    }
    let answer = hub
        .machine_setup
        .ports()
        .claude_login(&hub, machine, code)
        .await
        .map_err(|message| {
            let (message, fix) = split_fix(&message);
            let error = ToolError::new(ErrorCode::Failed, message);
            match fix {
                Some(fix) => error.with_fix(fix),
                None => error,
            }
        })?;
    if !answer.ok {
        return Err(
            ToolError::new(ErrorCode::Failed, answer.message.as_str()).with_fix(
                if code.is_none() {
                    format!("Check that claude runs on {machine}, then try again.")
                } else {
                    "Start the login again: each sign-in page's code works once.".into()
                },
            ),
        );
    }
    Ok(match answer.login_url {
        Some(url) if code.is_none() => MachineClaudeLoginOutput {
            next: Some(format!(
                "Open loginUrl and sign in; then call machine_claude_login again with machineId {machine} and the code the page shows. The login waits 10 minutes."
            )),
            machine_id: input.machine_id,
            login_url: Some(url.as_str().to_owned()),
            logged_in: None,
            message: answer.message.as_str().to_owned(),
            truncated: None,
        },
        _ => MachineClaudeLoginOutput {
            next: Some(format!(
                "claude on {machine} is logged in: its sessions can start."
            )),
            machine_id: input.machine_id,
            login_url: None,
            logged_in: Some(true),
            message: answer.message.as_str().to_owned(),
            truncated: None,
        },
    })
}
