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

pub const HUB_KEY_USAGE: &str = r#"  hub key create --name <name> --role <read|operate|admin> --machines <'*'|id,id> [--out <file>] [--home <dir>]
             create an agent key for the MCP endpoint; prints the key once, or with --out writes it
             to a new file (0600) and prints the file's path
  hub key create --agent <name> [--machines <'*'|id,id>] [--out <file>] [--home <dir>]
             a named agent's key, to write in a project's chat (fleetd chat --key-file): its
             messages show as that agent's, never yours. Operate on every machine unless
             --machines. Written to a new file (0600), <hub home>/keys/<name>.key unless --out;
             prints only the file's path
  hub key create --human --name <device> [--role <role>] [--machines <'*'|id,id>] [--out <file>] [--home <dir>]
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

/// A name that is safe as a file name: `[A-Za-z0-9_-]{1,40}`.
fn is_file_name(name: &str) -> bool {
    (1..=40).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// A new file only its owner can read, created at once with mode 0600 (never an existing one); its directory is made
/// 0700 when missing.
fn new_private_file(path: &Path) -> Result<std::fs::File, String> {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
            .map_err(|e| format!("cannot make {}: {e}", dir.display()))?;
    }
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::AlreadyExists => {
                format!(
                    "{} exists; a key is only written to a new file",
                    path.display()
                )
            }
            _ => format!("cannot write {}: {e}", path.display()),
        })
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
        ("agent", Kind::Str),
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
            let agent = v.str("agent").filter(|n| !n.is_empty());
            if agent.is_some() && (v.flag("human") || v.has("name") || v.has("role")) {
                return key_usage(
                    "--agent names the key and sets its role; leave out --name, --role and --human",
                );
            }
            let Some(name) = agent.or(v.str("name")).filter(|n| !n.is_empty()) else {
                return key_usage("--name is required");
            };
            if agent.is_some() && !is_file_name(name) {
                return key_usage("--agent is a name of letters, digits, '-' and '_' (at most 40)");
            }
            let human = v.flag("human");
            let grant = if human || agent.is_some() {
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
            let out = match (v.str("out").filter(|o| !o.is_empty()), agent) {
                (Some(file), _) => Some(PathBuf::from(file)),
                (None, Some(name)) => match resolve_home(v.str("home")) {
                    Ok(home) => Some(home.join("keys").join(format!("{name}.key"))),
                    Err(message) => return fail(1, &message),
                },
                (None, None) => None,
            };
            // Made before the key, so the key is never minted for a file that can't take it.
            let file = match out.as_deref().map(new_private_file).transpose() {
                Ok(file) => file,
                Err(message) => return fail(1, &message),
            };
            let created = with_hub(v.str("home"), |hub| {
                match hub.auth.create_key(
                    name,
                    &[grant],
                    if human {
                        KeyKind::Human
                    } else {
                        KeyKind::Agent
                    },
                ) {
                    Ok(created) => match (file, out.as_deref()) {
                        (Some(mut file), Some(path)) => {
                            use std::io::Write;
                            match file.write_all(format!("{}\n", created.key).as_bytes()) {
                                Ok(()) => CliResult {
                                    code: 0,
                                    stdout: format!("{}\n", path.display()),
                                    stderr: String::new(),
                                },
                                Err(error) => {
                                    fail(1, &format!("cannot write {}: {error}", path.display()))
                                }
                            }
                        }
                        _ => CliResult {
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
                    },
                    Err(error) => fail(1, &error.to_string()),
                }
            });
            if created.code != 0
                && let Some(path) = &out
            {
                let _ = std::fs::remove_file(path);
            }
            created
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

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    fn create(args: &[&str]) -> CliResult {
        let argv: Vec<String> = ["create"]
            .iter()
            .chain(args)
            .map(|s| s.to_string())
            .collect();
        hub_key(&argv)
    }

    /// `--agent scout` mints an operate key named scout into a new 0600 file and prints only that file's path: the key
    /// itself never reaches the terminal. It never overwrites a file, and mints nothing when it can't write one.
    #[test]
    fn an_agent_key_goes_to_a_private_file_and_only_its_path_is_printed() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path().to_str().unwrap();
        let made = create(&["--agent", "scout", "--home", h]);
        let file = home.path().join("keys/scout.key");
        assert_eq!(
            (made.code, made.stdout.as_str(), made.stderr.as_str()),
            (0, format!("{}\n", file.display()).as_str(), "")
        );
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let key = std::fs::read_to_string(&file).unwrap();
        let info = open_hub(home.path())
            .unwrap()
            .auth
            .verify(key.trim())
            .unwrap();
        assert_eq!((info.name.as_str(), info.kind), ("scout", None));
        assert_eq!(describe_grants(&info.grants), "operate:*");

        let again = create(&["--agent", "scout", "--home", h]);
        assert!(
            again.code == 1 && again.stderr.contains("exists"),
            "{}",
            again.stderr
        );
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            key,
            "never overwritten"
        );
        let keys = || open_hub(home.path()).unwrap().auth.list().unwrap().len();
        assert_eq!(keys(), 1, "nothing minted for a file it can't write");

        let out = home.path().join("elsewhere/ci.key");
        let to = create(&[
            "--agent",
            "ci-bot",
            "--machines",
            "devbox",
            "--out",
            out.to_str().unwrap(),
            "--home",
            h,
        ]);
        assert_eq!(to.stdout, format!("{}\n", out.display()));
        assert_eq!(keys(), 2);

        for bad in [
            &["--agent", "scout", "--human", "--home", h][..],
            &["--agent", "scout", "--role", "admin", "--home", h],
            &["--agent", "../scout", "--home", h],
        ] {
            assert_eq!(create(bad).code, 2, "{bad:?}");
        }
        assert_eq!(keys(), 2);
    }

    /// The person's own key for `fleetd steer`, `chat` and `project stop`: `--human --out` writes it to a new 0600 file
    /// and prints only the path. It never overwrites a file, and mints nothing when it can't write one.
    #[test]
    fn a_human_key_goes_to_a_new_private_file_and_only_its_path_is_printed() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path().to_str().unwrap();
        let file = home.path().join("mine/human.key");
        let f = file.to_str().unwrap();
        let made = create(&["--human", "--name", "laptop", "--out", f, "--home", h]);
        assert_eq!(
            (made.code, made.stdout.as_str(), made.stderr.as_str()),
            (0, format!("{f}\n").as_str(), "")
        );
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let key = std::fs::read_to_string(&file).unwrap();
        let keys = || open_hub(home.path()).unwrap().auth.list().unwrap();
        let info = open_hub(home.path())
            .unwrap()
            .auth
            .verify(key.trim())
            .unwrap();
        assert_eq!(
            (info.name.as_str(), info.kind),
            ("laptop", Some(KeyKind::Human))
        );

        let again = create(&["--human", "--name", "laptop", "--out", f, "--home", h]);
        assert!(
            again.code == 1 && again.stderr.contains("exists"),
            "{}",
            again.stderr
        );
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            key,
            "never overwritten"
        );
        assert_eq!(keys().len(), 1, "nothing minted for a file it can't write");
    }
}
