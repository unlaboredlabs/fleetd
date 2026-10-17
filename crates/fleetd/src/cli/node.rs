//! `fleetd node join|run|serve` and `fleetd hub start|serve`: the CLI parses the flags, the node and the hub run.

use std::path::PathBuf;

use super::args::{self, Kind, Spec};

pub const NODE_USAGE: &str = r#"  node join --hub <url> (--token <token> | --token-file <file|->) --machine <id> --t3-home <dir>
            --t3-url <url> [--t3-cmd <cmd>] [--t3-restart-cmd <cmd>] [--tags a,b] [--name <name>]
            [--home <dir>] [--enroll-only]
             enroll this machine with the hub, then keep its link up (node home default ~/.fleetd/node);
             --t3-restart-cmd (e.g. "t3 service restart") runs when T3 fails 3 health checks, else T3 is
             only reported down; --token-file - reads the token from stdin; --enroll-only exits once
             the hub has accepted this node
  node run [--home <dir>]
             keep the link up for a machine that has joined
"#;

pub const HUB_START_USAGE: &str = r#"  hub start [--home <dir>] [--listen <host:port>] [--queue-ttl <seconds>] [--router-model <model>]
             run the hub (default home ~/.fleetd/hub, listen 127.0.0.1:4790,
             writes to an offline machine wait 24 h, intents without a project
             are routed by the claude CLI with claude-haiku-5-5)
"#;

const OPTIONS: &[(&str, Kind)] = &[
    ("home", Kind::Str),
    ("hub", Kind::Str),
    ("token", Kind::Str),
    ("token-file", Kind::Str),
    ("enroll-only", Kind::Bool),
    ("machine", Kind::Str),
    ("t3-home", Kind::Str),
    ("t3-url", Kind::Str),
    ("t3-cmd", Kind::Str),
    ("t3-restart-cmd", Kind::Str),
    ("tags", Kind::Str),
    ("name", Kind::Str),
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
                match super::pending::node::read_token_file(file) {
                    Ok(text) => token = Some(text),
                    Err(error) => return usage(&format!("cannot read --token-file: {error}")),
                }
            }
            let fields = [
                ("hub", v.string("hub")),
                ("token", token.clone()),
                ("machine", v.string("machine")),
                ("t3-home", v.string("t3-home")),
                ("t3-url", v.string("t3-url")),
            ];
            if let Some((missing, _)) = fields
                .iter()
                .find(|(_, value)| value.as_deref().is_none_or(str::is_empty))
            {
                return usage(&format!("--{missing} is required"));
            }
            let [hub, token, machine, t3_home, t3_url] =
                fields.map(|(_, value)| value.unwrap_or_default());
            let join = super::pending::node::JoinArgs {
                hub,
                token,
                machine,
                t3_home,
                t3_url,
                t3_cmd: v.string("t3-cmd"),
                t3_restart_cmd: v.string("t3-restart-cmd"),
                tags: v.str("tags").map(super::pending::node::parse_tags),
                name: v.string("name"),
                home,
                enroll_only: v.flag("enroll-only"),
            };
            exit(
                super::pending::node::join(join)
                    .await
                    .map_err(|error| error.to_string()),
            )
        }
        Some("run" | "serve") => exit(
            super::pending::node::run(super::pending::node::RunArgs { home })
                .await
                .map_err(|error| error.to_string()),
        ),
        Some(other) => usage(&format!("unknown node command '{other}'")),
        None => usage("missing node command"),
    }
}

/// `fleetd hub start|serve [--home <dir>] [--listen <host:port>] …`: runs the hub in the foreground until a signal.
/// The hub parses its own flags and prints its own usage, so the CLI hands it the rest of the argv as given.
pub async fn hub_start(argv: &[String]) -> u8 {
    super::pending::serve::run(argv).await
}
