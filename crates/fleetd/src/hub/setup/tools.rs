//! setup_list, setup_test and setup_skip: the hub's setup steps for an admin, read from the doctor's checks.
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::mcp::{
    ErrorCode, SetupListInput, SetupListOutput, SetupSkipInput, SetupSkipOutput, SetupTestInput,
    SetupTestOutput,
};
use fleetd_contracts::prim::Count;
use fleetd_contracts::setup::{SetupNeed, SetupStep, SetupStepId};

use crate::hub::api::{Caller, Hub, Registry, ToolError, allows_everywhere, error};
use crate::hub::doctor::checks::{self, DoctorCheck};
use crate::hub::store::now_ms;

pub fn register(tools: &mut Registry) {
    tools.add("setup_list", setup_list);
    tools.add("setup_test", setup_test);
    tools.add("setup_skip", setup_skip);
}

/// The hub's own setup is an admin's: Admin on every machine.
fn require_admin(caller: &Caller) -> Result<(), ToolError> {
    if allows_everywhere(caller, Role::Admin) {
        return Ok(());
    }
    Err(error(
        ErrorCode::Forbidden,
        "The hub's setup is for its owners and admins: a key with admin on every machine.",
        "Open Administration › Setup in the app, or run fleetd init on the hub.",
    ))
}

/// Where devices reach the hub: its --url, else the one setup saved, else its listen address.
fn hub_url(hub: &Hub) -> String {
    hub.config
        .url
        .clone()
        .or_else(|| {
            crate::hub::doctor::config::read_hub_config(&hub.config.home)
                .0
                .url
        })
        .unwrap_or_else(|| hub.config.url())
}

/// The doctor's checks with the ones read from the hub's own state taken now, so a client saved a moment ago counts.
fn with_fresh(hub: &Hub, mut checks: Vec<DoctorCheck>) -> Vec<DoctorCheck> {
    let fresh = hub.doctor.setup_checks();
    checks.retain(|c| !SETUP_CHECKS.contains(&c.id.as_str()));
    checks.extend(fresh);
    checks
}

/// The checks [`checks::setup_checks`] makes.
const SETUP_CHECKS: [&str; 3] = ["hub/people", "hub/google", "hub/notion"];

fn read(hub: &Hub, checks: &[DoctorCheck]) -> Result<Vec<SetupStep>, ToolError> {
    let skipped = super::skipped(&hub.db)?;
    Ok(super::read(super::guides(&hub_url(hub)), checks, &skipped))
}

fn one(steps: Vec<SetupStep>, id: SetupStepId) -> SetupStep {
    steps
        .into_iter()
        .find(|s| s.id == id)
        .expect("every step id has a guide")
}

async fn setup_list(
    hub: Arc<Hub>,
    caller: Caller,
    _input: SetupListInput,
) -> Result<SetupListOutput, ToolError> {
    require_admin(&caller)?;
    let checks = with_fresh(&hub, hub.doctor.list(false).await.checks);
    let steps = read(&hub, &checks)?;
    let left = steps.iter().filter(|s| s.required_left()).count();
    let next = match steps.iter().find(|s| s.required_left()) {
        Some(s) => format!(
            "Required next: {} (setup_test step: {}).",
            s.title,
            s.id.as_str()
        ),
        None => "Every required step is done; the rest wait until something needs them.".to_owned(),
    };
    Ok(SetupListOutput {
        steps,
        required_left: Count::unchecked(left as i64),
        next: Some(next),
        truncated: None,
    })
}

async fn setup_test(
    hub: Arc<Hub>,
    caller: Caller,
    input: SetupTestInput,
) -> Result<SetupTestOutput, ToolError> {
    require_admin(&caller)?;
    // Machines and Claude read every machine's checks; the rest, the hub's own.
    let results = match input.step {
        SetupStepId::Machines | SetupStepId::Claude => hub.doctor.list(true).await,
        _ => hub.doctor.rerun_hub().await,
    };
    let mut checks = with_fresh(&hub, results.checks);
    if input.step == SetupStepId::Google && hub.db.google().client()?.is_some() {
        let tested = match crate::hub::google::tools::test_machine(&hub, None) {
            Err(e) => checks::google_tested(None, Some(&e.message)),
            Ok(m) => match crate::hub::google::tools::test_client(&hub, &m).await {
                Ok(c) => {
                    checks::google_tested(Some(m.as_str()), c.problem.as_deref().filter(|_| !c.ok))
                }
                Err(e) => checks::google_tested(Some(m.as_str()), Some(&e.message)),
            },
        };
        checks.retain(|c| c.id != "hub/google");
        checks.push(tested.check);
    }
    Ok(SetupTestOutput {
        step: one(read(&hub, &checks)?, input.step),
        next: None,
        truncated: None,
    })
}

async fn setup_skip(
    hub: Arc<Hub>,
    caller: Caller,
    input: SetupSkipInput,
) -> Result<SetupSkipOutput, ToolError> {
    require_admin(&caller)?;
    let checks = with_fresh(&hub, hub.doctor.list(false).await.checks);
    let step = one(read(&hub, &checks)?, input.step);
    if input.skipped && step.need == SetupNeed::Required {
        return Err(error(
            ErrorCode::Invalid,
            format!(
                "{} is required: agents can't run without it, so it can't wait.",
                step.title
            ),
            format!("setup_test step: {} once it is set up.", step.id.as_str()),
        ));
    }
    super::set_skipped(
        &hub.db,
        input.step,
        input.skipped,
        now_ms(hub.clock.as_ref()),
    )?;
    Ok(SetupSkipOutput {
        step: one(read(&hub, &checks)?, input.step),
        next: None,
        truncated: None,
    })
}
