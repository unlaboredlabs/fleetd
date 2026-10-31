//! `fleetd doctor`: every setup check on the hub, run now over its MCP endpoint (doctor_list): the hub's setup steps
//! first (setup_list), then each other problem with the command that fixes it. `fleetd init` ends with the same run.

use std::path::Path;
use std::time::Duration;

use fleetd_contracts::auth::{Grant, GrantMachines, KeyKind, Role, Star};
use serde_json::json;

use super::super::args::{self, Spec};
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

/// The hub on this machine, with the CLI's own admin key. `fleetd time` without `--hub` uses it too.
pub async fn connect(home: &Path) -> Result<McpClient, Failure> {
    connect_as(home, "fleetd-doctor").await
}

/// [`connect`], named `client` in the hub's logs.
pub async fn connect_as(home: &Path, client: &str) -> Result<McpClient, Failure> {
    connect_to(home, None, client).await
}

/// The hub's MCP endpoint with the CLI's own key from `home`; `hub` overrides the address `fleetd init` saved
/// (for a hub started by hand with `fleetd hub start`).
pub async fn connect_to(
    home: &Path,
    hub: Option<&str>,
    client: &str,
) -> Result<McpClient, Failure> {
    let key = cli_key(home).map_err(again)?;
    connect_with(home, hub, client, &key).await
}

fn again(message: String) -> Failure {
    Failure {
        message,
        fix: "fleetd init (it starts the hub and repairs its setup)".into(),
    }
}

/// [`connect_to`] with `key` instead of the CLI's own, for what speaks for the person: their human key.
pub async fn connect_with(
    home: &Path,
    hub: Option<&str>,
    client: &str,
    key: &str,
) -> Result<McpClient, Failure> {
    let listen = match hub {
        Some(url) => url.trim_end_matches('/').to_owned(),
        None => {
            let state = read_setup(home).map_err(again)?.ok_or_else(|| Failure {
                message: format!("{} has no hub set up", home.display()),
                fix: super::no_setup_fix(home),
            })?;
            format!("http://{}", state.listen)
        }
    };
    McpClient::connect(&listen, key, client, Duration::from_secs(15))
        .await
        .map_err(|error| {
            again(format!(
                "the hub does not answer at {}: {}",
                listen,
                error.message()
            ))
        })
}

async fn list_checks(client: &mut McpClient) -> Result<Vec<DoctorCheck>, Failure> {
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
    list_checks(&mut client).await
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

/// What the hub says while a node's first runner check is still running (hub/link/server.rs), and what an older hub
/// said.
const CHECKING: [&str; 2] = [
    "checking the node's runner",
    "checking the node's claude runner",
];

/// A machine's degraded reason that only means its first runner check hasn't answered yet.
pub fn still_checking(reason: &str) -> bool {
    CHECKING.iter().any(|c| reason.contains(c))
}

/// The hub answers `name` (an unknown tool comes back as "not found"; any other answer means it exists).
pub async fn hub_has_tool(home: &Path, name: &str) -> bool {
    let Ok(mut client) = connect(home).await else {
        return false;
    };
    match client
        .call_tool(name, json!({}), Duration::from_secs(15))
        .await
    {
        Ok(_) => true,
        Err(error) => !error.message().contains("not found"),
    }
}

/// One checklist line per check that isn't ok, except for machines in `idle` (their node is left to the user, and
/// the list already says how to start it), a finding already listed, and a repeat of the same message; how many
/// passed.
pub fn show(list: &mut Checklist, checks: &[DoctorCheck], idle: &[String]) -> usize {
    let mut said: Vec<(Option<&str>, &str)> = Vec::new();
    for check in checks.iter().filter(|c| {
        c.status != DoctorStatus::Ok && !c.machine_id.as_ref().is_some_and(|m| idle.contains(m))
    }) {
        let key = (check.machine_id.as_deref(), check.message.as_str());
        if said.contains(&key) {
            continue;
        }
        said.push(key);
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
        // A step before (init's own check) already reported this, with the same fix.
        if fix.as_deref().is_some_and(|f| list.has_fix(f)) {
            continue;
        }
        let title = check.machine_id.as_deref().unwrap_or("hub");
        if still_checking(&check.message) {
            list.skipped(
                &format!("doctor {title}"),
                "still checking its claude; run fleetd doctor in a minute for the result",
            );
            continue;
        }
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
    if let Err(message) = args::parse(
        argv,
        &Spec {
            options: &[],
            positionals: false,
        },
    ) {
        super::say(&format!(
            "fleetd: {message}\n\nusage:\n{}",
            super::SETUP_USAGE
        ));
        return 2;
    }
    let home = match resolve_home(None) {
        Ok(home) => home,
        Err(message) => {
            super::say(&format!("fleetd: {message}"));
            return 1;
        }
    };
    let mut list = Checklist::new();
    let mut client = match connect(&home).await {
        Ok(client) => client,
        Err(failure) => {
            list.failed("doctor", &failure.message, &failure.fix);
            return 4;
        }
    };
    match list_checks(&mut client).await {
        Ok(checks) => {
            // The setup steps first, then what no step speaks for; a hub from before steps, the checks alone.
            let (checks, other) = match super::steps::list(&mut client).await {
                Ok(Some(steps)) => {
                    super::steps::show(&mut list, &steps);
                    (super::steps::unowned(&checks, &steps), "other ")
                }
                _ => (checks, ""),
            };
            let ok = show(&mut list, &checks, &[]);
            if let Some(line) = super::super::versions::line(&mut client).await {
                list.warn("versions", &line, None);
            }
            list.done(
                "doctor",
                &format!("{ok} of {} {other}checks pass", checks.len()),
            );
            u8::from(list.failures().next().is_some())
        }
        Err(failure) => {
            list.failed("doctor", &failure.message, &failure.fix);
            4
        }
    }
}
