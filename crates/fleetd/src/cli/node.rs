//! `fleetd node join|run|serve` and `fleetd hub start|serve`: the CLI parses the flags, the node and the hub run.

use std::path::PathBuf;

use super::args::{self, Kind, Spec};

pub use crate::node::NODE_USAGE;

pub const HUB_START_USAGE: &str = r#"  hub start [--home <dir>] [--listen <host:port>] [--queue-ttl <seconds>]
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
    ("tags", Kind::Str),
    ("name", Kind::Str),
    ("claude-config-dir", Kind::Str),
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
            positionals: command == Some("trust"),
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
                tags: v.str("tags").map(crate::node::parse_tags),
                name: v.string("name"),
                home,
                enroll_only: v.flag("enroll-only"),
                claude_config_dir: v.string("claude-config-dir").filter(|d| !d.is_empty()),
            };
            exit(
                crate::node::join(join)
                    .await
                    .map_err(|error| error.to_string()),
            )
        }
        Some("run" | "serve") => exit(
            crate::node::run(crate::node::RunArgs { home })
                .await
                .map_err(|error| error.to_string()),
        ),
        Some("trust") => {
            let [dir] = v.positionals.as_slice() else {
                return usage("node trust takes the checkout's folder");
            };
            let home = home.unwrap_or_else(crate::node::config::default_node_home);
            let dir = std::path::absolute(dir).unwrap_or_else(|_| PathBuf::from(dir));
            match crate::node::checkouts::trust(&home, &dir) {
                Ok(true) => {
                    println!("{} is trusted as it is now: send again.", dir.display());
                    0
                }
                Ok(false) => {
                    println!(
                        "fleetd has nothing recorded for {}: nothing to trust.",
                        dir.display()
                    );
                    0
                }
                Err(e) => exit(Err(format!("{} was not trusted: {e}", dir.display()))),
            }
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
