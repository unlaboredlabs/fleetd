//! `fleetd doctor`: every setup check on the hub, run now over its MCP endpoint (doctor_list), each problem with the
//! command that fixes it. `fleetd init` ends with the same run.

use std::path::Path;
use std::time::Duration;

use fleetd_contracts::auth::{Grant, GrantMachines, KeyKind, Role};
use fleetd_contracts::subscriptions::Star;
use serde_json::json;

use super::super::args::{self, Kind, Spec};
use super::super::hub_key::{open_hub, resolve_home};
use super::super::mcp_client::McpClient;
use super::checklist::{Checklist, State};
use super::state::read_setup;
use super::{Failure, write_private};
use crate::hub::doctor::checks::{DoctorCheck, DoctorStatus};

const KEY_FILE: &str = "cli.key";

/// The CLI's own key, kept 0600 in the hub home beside the database it was minted from (so it grants nothing that
/// reading the home doesn't), and minted again only when it is gone or revoked.
fn cli_key(home: &Path) -> Result<String, String> {
    let file = home.join(KEY_FILE);
    let hub = open_hub(home)?;
    if let Ok(key) = std::fs::read_to_string(&file)
        && hub.auth.verify(key.trim()).is_ok()
    {
        return Ok(key.trim().to_owned());
    }
    let created = hub
        .auth
        .create_key(
            "fleetd-cli",
            &[Grant {
                role: Role::Admin,
                machines: GrantMachines::All(Star::Value),
            }],
            KeyKind::Agent,
        )
        .map_err(|error| error.to_string())?;
    write_private(&file, &format!("{}\n", created.key))?;
    Ok(created.key)
}

async fn connect(home: &Path) -> Result<McpClient, Failure> {
    let again = |message: String| Failure {
        message,
        fix: "fleetd init (it starts the hub and repairs its setup)".into(),
    };
    let state = read_setup(home)
        .map_err(again)?
        .ok_or_else(|| again(format!("{} has no hub set up", home.display())))?;
    let key = cli_key(home).map_err(again)?;
    McpClient::connect(
        &format!("http://{}", state.listen),
        &key,
        "fleetd-doctor",
        Duration::from_secs(15),
    )
    .await
    .map_err(|error| {
        again(format!(
            "the hub does not answer at {}: {}",
            state.listen,
            error.message()
        ))
    })
}

async fn list(client: &mut McpClient) -> Result<Vec<DoctorCheck>, Failure> {
    let result = client
        .call_tool(
            "doctor_list",
            json!({ "rerun": true }),
            Duration::from_secs(120),
        )
        .await
        .map_err(|error| Failure {
            message: format!("doctor_list failed: {}", error.message()),
            fix: "fleetd doctor again in a minute; if it keeps failing, fleetd init".into(),
        })?;
    serde_json::from_value(result.body.get("checks").cloned().unwrap_or_default()).map_err(
        |error| Failure {
            message: format!("doctor_list answered in an unknown shape: {error}"),
            fix: "fleetd update, so this CLI matches the hub".into(),
        },
    )
}

/// Runs every check now.
pub async fn run(home: &Path) -> Result<Vec<DoctorCheck>, Failure> {
    let mut client = connect(home).await?;
    list(&mut client).await
}

/// Registers `path` on `machine_id` as a project through the hub (project_add, the path the app and agents use).
pub async fn add_project(home: &Path, machine_id: &str, path: &Path) -> Result<(), Failure> {
    let mut client = connect(home).await?;
    let title = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let fix =
        format!("fleetd doctor shows whether {machine_id} is online; then run fleetd init again");
    let result = client
        .call_tool(
            "project_add",
            json!({ "machineId": machine_id, "path": path.to_string_lossy(), "title": title }),
            Duration::from_secs(60),
        )
        .await
        .map_err(|error| Failure {
            fix: if error.message().contains("not found") {
                "this hub's fleetd predates project_add: fleetd update, then run fleetd init again"
                    .into()
            } else {
                fix.clone()
            },
            message: format!("project_add failed: {}", error.message()),
        })?;
    if result.is_error {
        let text = |key: &str| {
            result
                .body
                .get(key)
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        };
        return Err(Failure {
            message: text("message").unwrap_or_else(|| result.body.to_string()),
            fix: text("fix").unwrap_or(fix),
        });
    }
    Ok(())
}

/// One checklist line per check that isn't ok, except those in `shown`; how many passed.
pub fn show(list: &mut Checklist, checks: &[DoctorCheck], shown: &[&str]) -> usize {
    for check in checks
        .iter()
        .filter(|c| c.status != DoctorStatus::Ok && !shown.contains(&c.id.as_str()))
    {
        let state = match check.status {
            DoctorStatus::Fail => State::Failed,
            _ => State::Warn,
        };
        let fix = check
            .fix
            .as_ref()
            .map(|f| match (&f.command, f.kind.as_str()) {
                (Some(command), _) => command.clone(),
                (None, "auto") => "fleetd doctor --fix".to_owned(),
                (None, _) => f.label.clone(),
            });
        let fix = match (state, fix) {
            (State::Failed, None) => Some("fleetd doctor again once the cause is gone".to_owned()),
            (_, fix) => fix,
        };
        let title = check.machine_id.as_deref().unwrap_or("hub");
        list.finish(
            &format!("doctor {title}"),
            state,
            check.message.trim_end_matches('.'),
            fix.as_deref(),
        );
    }
    checks
        .iter()
        .filter(|c| c.status == DoctorStatus::Ok)
        .count()
}

pub async fn doctor_command(argv: &[String]) -> u8 {
    let v = match args::parse(
        argv,
        &Spec {
            options: &[("home", Kind::Str)],
            positionals: false,
        },
    ) {
        Ok(v) => v,
        Err(message) => {
            super::say(&format!(
                "fleetd: {message}\n\nusage:\n{}",
                super::SETUP_USAGE
            ));
            return 2;
        }
    };
    let home = match resolve_home(v.str("home")) {
        Ok(home) => home,
        Err(message) => {
            super::say(&format!("fleetd: {message}"));
            return 1;
        }
    };
    let mut list = Checklist::new();
    match run(&home).await {
        Ok(checks) => {
            let ok = show(&mut list, &checks, &[]);
            list.done("doctor", &format!("{ok} of {} checks pass", checks.len()));
            u8::from(list.failures().next().is_some())
        }
        Err(failure) => {
            list.failed("doctor", &failure.message, &failure.fix);
            4
        }
    }
}
