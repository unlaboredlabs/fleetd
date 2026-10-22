//! `fleetd hub key …` and `fleetd hub token create`: they open the hub home's database directly; SQLite WAL makes
//! that safe while the hub runs.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use fleetd_contracts::auth::{AgentKeyInfo, Grant, GrantMachines, KeyKind, Role};
use fleetd_contracts::ids::MachineId;
use fleetd_contracts::subscriptions::Star;

use super::CliResult;
use super::args::{self, Kind, Spec};
use super::pending::auth::{Auth, AuthError};
use super::pending::store::{HubDb, HubStore};
use crate::clock::SystemClock;

pub const HUB_KEY_USAGE: &str = r#"  hub key create --name <name> --role <read|operate|admin> --machines <'*'|id,id> [--out <file>] [--home <dir>]
             create an agent key for the MCP endpoint, or for an agent or integration that writes
             in a chat (operate); prints the key once, or writes it to a new file (0600) with --out
  hub key create --human --name <device> [--role <role>] [--machines <'*'|id,id>] [--out <file>] [--home <dir>]
             a key for a person's device (the desktop app): what it answers is recorded as the
             human's; role defaults to operate on every machine
  hub key list [--home <dir>]
  hub key revoke <keyId> [--home <dir>]
             takes effect at once, also on a running hub
"#;

pub const HUB_TOKEN_USAGE: &str = r#"  hub token create --machine <id> [--home <dir>]
             print a one-time enrollment token (15 min) for `fleetd node join`
"#;

/// The hub home's database, opened beside a running hub.
pub struct HubAccess {
    pub auth: Auth,
    pub store: HubStore,
}

/// `--home` resolved (default `~/.fleetd/hub`).
pub fn resolve_home(home: Option<&str>) -> Result<PathBuf, String> {
    Ok(super::pending::store::resolve_hub_home(
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
        ("out", Kind::Str),
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
            let out = v.str("out").filter(|o| !o.is_empty()).map(Path::new);
            if let Some(file) = out.filter(|f| f.exists()) {
                return fail(
                    1,
                    &format!("{} exists; --out writes a new file", file.display()),
                );
            }
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
                    Ok(created) => {
                        let what = format!(
                            "created {} ({}, {}{})",
                            created.info.key_id,
                            created.info.prefix,
                            describe_grants(&created.info.grants),
                            if human { ", human" } else { "" }
                        );
                        match out {
                            None => CliResult {
                                code: 0,
                                stdout: format!("{}\n", created.key),
                                stderr: format!("{what}. The key above is shown only once.\n"),
                            },
                            Some(file) => match super::setup::write_private(
                                file,
                                &format!("{}\n", created.key),
                            ) {
                                Ok(()) => CliResult {
                                    code: 0,
                                    stdout: String::new(),
                                    stderr: format!("{what}. The key is in {}.\n", file.display()),
                                },
                                Err(error) => fail(1, &error),
                            },
                        }
                    }
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

/// `fleetd hub token create`.
pub fn hub_token(argv: &[String]) -> CliResult {
    let usage = |message: &str| fail(2, &format!("{message}\n\nusage:\n{HUB_TOKEN_USAGE}"));
    let (command, rest) = argv
        .split_first()
        .map_or((None, &[][..]), |(c, r)| (Some(c.as_str()), r));
    let v = match args::parse(
        rest,
        &Spec {
            options: &[("home", Kind::Str), ("machine", Kind::Str)],
            positionals: false,
        },
    ) {
        Ok(v) => v,
        Err(message) => return usage(&message),
    };
    match command {
        Some("create") => {}
        Some(other) => return usage(&format!("unknown hub token command '{other}'")),
        None => return usage("missing hub token command"),
    }
    let Some(machine) = v.str("machine").filter(|m| !m.is_empty()) else {
        return usage("--machine is required");
    };
    let Ok(machine_id) = MachineId::new(machine) else {
        return usage(&format!(
            "'{machine}' is not a machine id ([a-z0-9-]{{1,32}})"
        ));
    };
    with_hub(v.str("home"), |hub| {
        match hub.auth.create_enroll_token(&machine_id) {
            Ok(token) => CliResult {
                code: 0,
                stdout: format!("{}\n", token.token),
                stderr: format!(
                    "one-time token for {machine}, valid until {}. On {machine}, run:\n  fleetd node join --hub <hub url> --token <token> --machine {machine}\n",
                    token.expires_at
                ),
            },
            Err(error) => fail(1, &error.to_string()),
        }
    })
}
