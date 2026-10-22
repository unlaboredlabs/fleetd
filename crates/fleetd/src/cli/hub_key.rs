//! `fleetd hub key …`: it opens the hub home's database directly; SQLite WAL makes
//! that safe while the hub runs.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use fleetd_contracts::auth::{AgentKeyInfo, Grant, GrantMachines, KeyKind, Role, Star};
use fleetd_contracts::ids::MachineId;

use super::CliResult;
use super::args::{self, Kind, Spec};
use crate::clock::SystemClock;
use crate::hub::auth::{Auth, AuthError};
use crate::hub::store::{HubDb, HubStore};

pub const HUB_KEY_USAGE: &str = r#"  hub key create --name <name> --role <read|operate|admin> --machines <'*'|id,id> [--home <dir>]
             create an agent key for the MCP endpoint; prints the key once
  hub key create --human --name <device> [--role <role>] [--machines <'*'|id,id>] [--home <dir>]
             a key for a person's device (the desktop app): what it answers is recorded as the
             human's; role defaults to operate on every machine
  hub key list [--home <dir>]
  hub key revoke <keyId> [--home <dir>]
             takes effect at once, also on a running hub
"#;

/// The hub home's database, opened beside a running hub.
pub struct HubAccess {
    pub auth: Auth,
    pub store: HubStore,
}

/// `--home` resolved (default `~/.fleetd/hub`).
pub fn resolve_home(home: Option<&str>) -> Result<PathBuf, String> {
    Ok(crate::hub::store::resolve_hub_home(
        home,
        &super::home_dir(),
    ))
}

pub fn open_hub(home: &Path) -> Result<HubAccess, String> {
    let db = HubDb::open(home).map_err(|error| error.to_string())?;
    Ok(HubAccess {
        auth: Auth::new(db.clone(), Arc::new(SystemClock)),
        store: HubStore::new(db),
    })
}

fn fail(code: u8, message: &str) -> CliResult {
    CliResult::err(code, format!("fleetd: {message}\n"))
}

fn key_usage(message: &str) -> CliResult {
    fail(2, &format!("{message}\n\nusage:\n{HUB_KEY_USAGE}"))
}

fn describe_grants(grants: &[Grant]) -> String {
    grants
        .iter()
        .map(|g| {
            let role = serde_json::to_value(g.role)
                .ok()
                .and_then(|v| v.as_str().map(str::to_owned))
                .unwrap_or_default();
            let machines = match &g.machines {
                GrantMachines::All(_) => "*".to_owned(),
                GrantMachines::Only(ids) => ids
                    .iter()
                    .map(|id| id.as_str())
                    .collect::<Vec<_>>()
                    .join(","),
            };
            format!("{role}:{machines}")
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn row(info: &AgentKeyInfo) -> String {
    [
        info.key_id.to_string(),
        info.prefix.to_string(),
        if info.kind == Some(KeyKind::Human) {
            format!("{} (human)", info.name)
        } else {
            info.name.clone()
        },
        describe_grants(&info.grants),
        info.created_at.to_string(),
        info.last_used_at
            .as_ref()
            .map_or("-".into(), ToString::to_string),
        info.revoked_at
            .as_ref()
            .map_or("active".into(), |at| format!("revoked {at}")),
    ]
    .join("\t")
}

fn parse_grant(role: Option<&str>, machines: Option<&str>) -> Result<Grant, String> {
    let role: Role = role
        .and_then(|r| serde_json::from_value(serde_json::Value::String(r.to_owned())).ok())
        .ok_or("--role must be read, operate or admin")?;
    let Some(machines) = machines.filter(|m| !m.is_empty()) else {
        return Err("--machines is required: '*' or a comma-separated list of machine ids".into());
    };
    if machines == "*" {
        return Ok(Grant {
            role,
            machines: GrantMachines::All(Star::Value),
        });
    }
    let mut ids = Vec::new();
    for id in machines.split(',').map(str::trim) {
        ids.push(
            MachineId::new(id)
                .map_err(|_| format!("'{id}' is not a machine id ([a-z0-9-]{{1,32}})"))?,
        );
    }
    Ok(Grant {
        role,
        machines: GrantMachines::Only(ids),
    })
}

fn with_hub(home: Option<&str>, use_: impl FnOnce(&HubAccess) -> CliResult) -> CliResult {
    let opened = resolve_home(home).and_then(|home| open_hub(&home));
    match opened {
        Ok(hub) => use_(&hub),
        Err(message) => fail(1, &message),
    }
}

/// `fleetd hub key …`.
pub fn hub_key(argv: &[String]) -> CliResult {
    let (command, rest) = argv
        .split_first()
        .map_or((None, &[][..]), |(c, r)| (Some(c.as_str()), r));
    const OPTIONS: &[(&str, Kind)] = &[
        ("home", Kind::Str),
        ("name", Kind::Str),
        ("role", Kind::Str),
        ("machines", Kind::Str),
        ("human", Kind::Bool),
    ];
    let v = match args::parse(
        rest,
        &Spec {
            options: OPTIONS,
            positionals: true,
        },
    ) {
        Ok(v) => v,
        Err(message) => return key_usage(&message),
    };
    match command {
        Some("create") => {
            let Some(name) = v.str("name").filter(|n| !n.is_empty()) else {
                return key_usage("--name is required");
            };
            let human = v.flag("human");
            let grant = if human {
                parse_grant(
                    Some(v.str("role").unwrap_or("operate")),
                    Some(v.str("machines").unwrap_or("*")),
                )
            } else {
                parse_grant(v.str("role"), v.str("machines"))
            };
            let grant = match grant {
                Ok(grant) => grant,
                Err(message) => return key_usage(&message),
            };
            with_hub(v.str("home"), |hub| {
                match hub.auth.create_key(
                    name,
                    &[grant],
                    if human {
                        KeyKind::Human
                    } else {
                        KeyKind::Agent
                    },
                ) {
                    Ok(created) => CliResult {
                        code: 0,
                        stdout: format!("{}\n", created.key),
                        stderr: format!(
                            "created {} ({}, {}{}). The key above is shown only once.\n",
                            created.info.key_id,
                            created.info.prefix,
                            describe_grants(&created.info.grants),
                            if human { ", human" } else { "" }
                        ),
                    },
                    Err(error) => fail(1, &error.to_string()),
                }
            })
        }
        Some("list") => with_hub(v.str("home"), |hub| match hub.auth.list() {
            Ok(keys) => {
                let mut lines =
                    vec!["key\tprefix\tname\tgrants\tcreated\tlast used\tstatus".to_owned()];
                lines.extend(keys.iter().map(row));
                CliResult {
                    code: 0,
                    stdout: format!("{}\n", lines.join("\n")),
                    stderr: String::new(),
                }
            }
            Err(error) => fail(1, &error.to_string()),
        }),
        Some("revoke") => {
            let Some(key_id) = v.positionals.first().filter(|k| !k.is_empty()) else {
                return key_usage("revoke needs a key id (see `fleetd hub key list`)");
            };
            with_hub(v.str("home"), |hub| match hub.auth.revoke(key_id) {
                Ok(()) => CliResult {
                    code: 0,
                    stdout: format!("revoked {key_id}\n"),
                    stderr: String::new(),
                },
                Err(error @ AuthError::KeyNotFound { .. }) => fail(1, &error.to_string()),
                Err(error) => fail(1, &error.to_string()),
            })
        }
        Some(other) => key_usage(&format!("unknown hub key command '{other}'")),
        None => key_usage("missing hub key command"),
    }
}
