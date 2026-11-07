//! `fleetd node join|run|serve|flush` and `fleetd hub start|serve`: the CLI parses the flags, the node and the hub run.

use std::path::PathBuf;

use super::args::{self, Kind, Spec};

pub use crate::node::NODE_USAGE;

pub const HUB_START_USAGE: &str = r#"  hub start [--home <dir>] [--listen <host:port>]
             run the hub (default home ~/.fleetd/hub, listen 127.0.0.1:4790,
             writes to an offline machine wait 24 h)
"#;

const OPTIONS: &[(&str, Kind)] = &[
    ("home", Kind::Str),
    ("hub", Kind::Str),
    ("token", Kind::Str),
    ("token-file", Kind::Str),
    ("enroll-only", Kind::Bool),
    ("machine", Kind::Str),
    ("claude-config-dir", Kind::Str),
    ("mac", Kind::Bool),
    ("wait", Kind::Str),
    ("ask", Kind::Str),
];

fn usage(message: &str) -> u8 {
    eprint!("fleetd: {message}\n\nusage:\n{NODE_USAGE}");
    2
}

/// The node's own result: `Ok` on SIGINT/SIGTERM (exit 0), `Err` for a failure it cannot retry past (exit 1).
fn exit(outcome: Result<(), String>) -> u8 {
    match outcome {
        Ok(()) => 0,
        Err(message) => {
            eprintln!("fleetd: {message}");
            1
        }
    }
}

/// `fleetd node …`. Long-running, so it returns an exit code once the node stops.
pub async fn node_command(argv: &[String]) -> u8 {
    let (command, rest) = argv
        .split_first()
        .map_or((None, &[][..]), |(c, r)| (Some(c.as_str()), r));
    let v = match args::parse(
        rest,
        &Spec {
            options: OPTIONS,
            positionals: false,
        },
    ) {
        Ok(v) => v,
        Err(message) => return usage(&message),
    };
    let home = v.str("home").map(PathBuf::from);
    match command {
        Some("join") => {
            let mut token = v.string("token");
            if token.is_none()
                && let Some(file) = v.str("token-file")
            {
                match crate::node::read_token_file(file) {
                    Ok(text) => token = Some(text),
                    Err(error) => return usage(&format!("cannot read --token-file: {error}")),
                }
            }
            let fields = [
                ("hub", v.string("hub")),
                ("token", token.clone()),
                ("machine", v.string("machine")),
            ];
            if let Some((missing, _)) = fields
                .iter()
                .find(|(_, value)| value.as_deref().is_none_or(str::is_empty))
            {
                return usage(&format!("--{missing} is required"));
            }
            let [hub, token, machine] = fields.map(|(_, value)| value.unwrap_or_default());
            let join = crate::node::JoinArgs {
                hub,
                token,
                machine,
                home,
                enroll_only: v.flag("enroll-only"),
                claude_config_dir: v.string("claude-config-dir").filter(|d| !d.is_empty()),
                mac: v.flag("mac"),
            };
            exit(
                crate::node::join(join)
                    .await
                    .map_err(|error| error.to_string()),
            )
        }
        Some("run") => exit(
            crate::node::run(crate::node::RunArgs { home })
                .await
                .map_err(|error| error.to_string()),
        ),
        // What a node started now would be granted; the agents' Mac's node asks it to take up a new grant (agents_mac/grants.rs).
        // With --ask, setup's grant step: the running node asks macOS for one, then its pane opens.
        Some("grants") => match v.str("ask") {
            None => {
                println!("{}", crate::node::agents_mac::grants::Grants::own().line());
                0
            }
            Some(name) => {
                use crate::cli::setup::mac_finish;
                let Some(grant) =
                    crate::node::agents_mac::grants::asked(name).map(mac_finish::grant)
                else {
                    return usage("--ask takes accessibility or screen_recording");
                };
                // The app asks for less: its grants view shows only while the node rewrites its checks every 2 s.
                let wait = match v.str("wait").map(str::parse::<u64>) {
                    None => mac_finish::ASK_WAIT,
                    Some(Ok(secs)) => std::time::Duration::from_secs(secs),
                    Some(Err(_)) => return usage("--wait takes a number of seconds"),
                };
                let home = home.unwrap_or_else(crate::node::config::default_node_home);
                let asked = mac_finish::ask_node(&home, grant.id, wait).await;
                mac_finish::open_pane(&grant);
                if asked {
                    println!(
                        "macOS asks for {} now: turn on fleetd in System Settings › Privacy & Security › {}",
                        grant.name, grant.name
                    );
                    0
                } else {
                    exit(Err(format!(
                        "the node didn't ask macOS for {}: it isn't running. Fix: {}",
                        grant.name,
                        mac_finish::not_asked(&grant)
                    )))
                }
            }
        },
        // The node service fleetd init made for this binary, restarted: `launchctl kickstart -k` or `systemctl --user
        // restart`. The agents' Mac's node runs it to take up a new grant; setup runs it to retry.
        Some("restart") => {
            let node = crate::cli::setup::current_exe().ok().and_then(|exe| {
                crate::update::service::services(&exe)
                    .into_iter()
                    .find(|s| !s.hub())
            });
            match node {
                None => exit(Err(
                    "no node service of this fleetd here. Fix: fleetd init --join sets one up"
                        .into(),
                )),
                Some(service) => match crate::update::service::restart(&service) {
                    Ok(()) => {
                        println!("restarted {}", service.name);
                        0
                    }
                    Err(why) => exit(Err(format!(
                        "{why}. Fix: log in as this user at the machine's screen, then run fleetd node restart again"
                    ))),
                },
            }
        }
        Some("flush") => {
            let wait = match v.str("wait").map(str::parse::<u64>) {
                None => 50,
                Some(Ok(secs)) => secs,
                Some(Err(_)) => return usage("--wait takes a number of seconds"),
            };
            let home = home.unwrap_or_else(crate::node::config::default_node_home);
            println!(
                "{}",
                crate::node::flush::flush(&home, std::time::Duration::from_secs(wait)).await
            );
            0
        }
        Some(other) => usage(&format!("unknown node command '{other}'")),
        None => usage("missing node command"),
    }
}

/// `fleetd hub start|serve [--home <dir>] [--listen <host:port>] …`: runs the hub in the foreground until a signal.
/// The hub parses its own flags, prints its own usage and runs its own runtime, so it gets the argv as given.
pub fn hub_start(argv: &[String]) -> std::process::ExitCode {
    crate::hub::serve::hub_start(argv)
}
