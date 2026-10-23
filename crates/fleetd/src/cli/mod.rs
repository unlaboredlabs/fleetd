//! The `fleetd` command line: the same subcommands, arguments, output and exit codes as older releases.
//! Exit codes: 0 ok, 1 failed (a claim that did not pass), 2 usage, 3 refused, 4 hub or node unreachable.

pub mod agent_mcp;
pub mod args;
pub mod hub_key;
pub mod lead;
pub mod mcp_client;
pub mod node;
pub mod pair;
pub mod pending;
pub mod project;
pub mod prompts;
pub mod retro;
pub mod setup;
pub mod status;
pub mod steer;
pub mod time;
pub mod update;
pub mod versions;

use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use tokio::sync::watch;

/// What a short-lived command prints and exits with.
#[derive(Debug, PartialEq)]
pub struct CliResult {
    pub code: u8,
    pub stdout: String,
    pub stderr: String,
}

impl CliResult {
    pub fn err(code: u8, stderr: String) -> Self {
        CliResult {
            code,
            stdout: String::new(),
            stderr,
        }
    }
}

/// The user's home directory, as Node's `os.homedir()` finds it ($HOME first).
pub fn home_dir() -> PathBuf {
    std::env::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

/// `[a-z0-9-]{1,32}`.
pub fn is_machine_id(id: &str) -> bool {
    fleetd_contracts::ids::MachineId::new(id).is_ok()
}

pub fn usage_text() -> String {
    format!(
        "usage: fleetd <command>

commands:
  version    print the fleetd version and protocol
  help       show this message
{}
setting up (on the hub machine):
{}{}{}
projects:
{}
running by hand:
{}{}{}{}{}{}{}{}{}
lead-side commands (a lead uses its fleetd tools; these are for you, inside a project workspace):
{}",
        UPDATE_USAGE,
        setup::SETUP_USAGE,
        setup::machine::machine_usage(),
        pair::PAIR_USAGE,
        project::PROJECT_USAGE,
        node::HUB_START_USAGE,
        hub_key::HUB_KEY_USAGE,
        status::GITHUB_WEBHOOK_USAGE,
        node::NODE_USAGE,
        retro::RETRO_USAGE,
        prompts::PROMPTS_USAGE,
        time::TIME_USAGE,
        status::STATUS_USAGE,
        steer::STEER_USAGE,
        lead::LEAD_USAGE
    )
}

const UPDATE_USAGE: &str = "  update [--check] [--channel <c>] [--restart-now]
             replace this fleetd with the latest release, then restart its hub and node when
             nothing runs on them; while something does, they keep the running version until
             their next restart. --restart-now restarts them anyway
";

/// `fleetd <command> … --help` (or `-h`): that command's usage, for stdout and exit 0. After `--` they are arguments.
pub fn help_for(argv: &[String]) -> Option<String> {
    let (command, rest) = argv.split_first()?;
    let asked = rest
        .iter()
        .take_while(|a| *a != "--")
        .any(|a| a == "--help" || a == "-h");
    if !asked {
        return None;
    }
    let text = match command.as_str() {
        "init" | "doctor" | "uninstall" => setup::SETUP_USAGE.to_owned(),
        "machine" => setup::machine::machine_usage(),
        "pair" => pair::PAIR_USAGE.to_owned(),
        "project" | "projects" => project::PROJECT_USAGE.to_owned(),
        "hub" => match rest.first().map(String::as_str) {
            Some("start" | "serve") => node::HUB_START_USAGE.to_owned(),
            Some("key") => hub_key::HUB_KEY_USAGE.to_owned(),
            Some("github-webhook") => status::GITHUB_WEBHOOK_USAGE.to_owned(),
            _ => format!(
                "{}{}{}",
                node::HUB_START_USAGE,
                hub_key::HUB_KEY_USAGE,
                status::GITHUB_WEBHOOK_USAGE
            ),
        },
        "node" => node::NODE_USAGE.to_owned(),
        "retro" => retro::RETRO_USAGE.to_owned(),
        "prompts" | "instructions" => prompts::PROMPTS_USAGE.to_owned(),
        "time" => time::TIME_USAGE.to_owned(),
        "update" => UPDATE_USAGE.to_owned(),
        "status" if !lead::is_lead_command(argv) => status::STATUS_USAGE.to_owned(),
        "steer" | "steers" => steer::STEER_USAGE.to_owned(),
        _ if lead::is_lead_command(argv) => lead::LEAD_USAGE.to_owned(),
        _ => return None,
    };
    Some(format!("usage:\n{text}"))
}

/// The short-lived commands that are not lead calls: version, help and `hub key`.
pub fn run(argv: &[String]) -> CliResult {
    let command = argv.first().map(String::as_str);
    match command {
        Some("version" | "--version" | "-v") => CliResult {
            code: 0,
            stdout: format!(
                "fleetd {} (protocol {})\n",
                update::version(),
                fleetd_contracts::hello::PROTOCOL_VERSION
            ),
            stderr: String::new(),
        },
        None | Some("help" | "--help" | "-h") => CliResult {
            code: 0,
            stdout: usage_text(),
            stderr: String::new(),
        },
        Some("pair") => pair::pair_command(&argv[1..]),
        Some("prompts") => prompts::prompts_command(&argv[1..]),
        Some("instructions") => prompts::instructions_command(&argv[1..]),
        Some("hub") => match argv.get(1).map(String::as_str) {
            Some("key") => hub_key::hub_key(&argv[2..]),
            other => CliResult::err(
                2,
                format!(
                    "fleetd: unknown hub command '{}'\n\n{}",
                    other.unwrap_or(""),
                    usage_text()
                ),
            ),
        },
        Some(other) => CliResult::err(
            2,
            format!("fleetd: unknown command '{other}'\n\n{}", usage_text()),
        ),
    }
}

/// Commands that keep running (`node …`, `status --watch`, `steer --wait`) or wait on other processes or
/// the hub (setup, `retro run`, `update`, `status`, `steer`, `hub github-webhook`). `status set` is a lead call.
fn is_long_running(argv: &[String]) -> bool {
    match argv.first().map(String::as_str) {
        Some(
            "init" | "doctor" | "uninstall" | "machine" | "project" | "projects" | "node" | "retro"
            | "time" | "update" | "steer" | "steers",
        ) => true,
        Some("status") => !lead::is_lead_command(argv),
        Some("hub") => argv.get(1).map(String::as_str) == Some("github-webhook"),
        _ => false,
    }
}

async fn run_long_running(argv: &[String]) -> u8 {
    let rest = &argv[1..];
    match argv[0].as_str() {
        "init" | "doctor" | "uninstall" => setup::setup_command(&argv[0], rest).await,
        "machine" => setup::machine::machine_command(rest).await,
        "project" | "projects" => project::project_command(rest).await,
        "node" => node::node_command(rest).await,
        "retro" => retro::retro_command(rest).await,
        "time" => time::time_command(rest).await,
        "status" => status::status_command(rest).await,
        "hub" => status::github_webhook_command(&rest[1..]).await,
        "steer" => steer::steer_command(rest, false).await,
        "steers" => steer::steer_command(rest, true).await,
        _ => update_command(rest).await,
    }
}

/// `fleetd update [--check] [--channel <c>] [--restart-now]`.
async fn update_command(argv: &[String]) -> u8 {
    let spec = args::Spec {
        options: &[
            ("check", args::Kind::Bool),
            ("channel", args::Kind::Str),
            ("restart-now", args::Kind::Bool),
        ],
        positionals: false,
    };
    let v = match args::parse(argv, &spec) {
        Ok(v) => v,
        Err(message) => {
            eprint!("fleetd: {message}\n\n{}", usage_text());
            return 2;
        }
    };
    match update::run(update::UpdateArgs {
        check: v.flag("check"),
        channel: v.string("channel"),
        restart_now: v.flag("restart-now"),
    })
    .await
    {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("fleetd: {error:#}");
            1
        }
    }
}

pub fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    crate::home::init_from_argv(&argv);
    if let Some(text) = help_for(&argv) {
        print!("{text}");
        return ExitCode::SUCCESS;
    }
    if argv.first().map(String::as_str) == Some("hub")
        && matches!(argv.get(1).map(String::as_str), Some("start" | "serve"))
    {
        return node::hub_start(&argv[2..]);
    }
    if argv.first().map(String::as_str) == Some("agent-mcp") {
        return ExitCode::from(agent_mcp::run(&argv[1..]));
    }
    if is_long_running(&argv) {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("a tokio runtime starts");
        return ExitCode::from(runtime.block_on(run_long_running(&argv)));
    }
    let result = if lead::is_lead_command(&argv) {
        lead::run(&argv)
    } else {
        run(&argv)
    };
    use std::io::Write;
    let _ = std::io::stdout().write_all(result.stdout.as_bytes());
    let _ = std::io::stderr().write_all(result.stderr.as_bytes());
    ExitCode::from(result.code)
}

/// SIGINT/SIGTERM as a flag that long-running loops check at the points where stopping is safe.
pub struct Stop {
    rx: watch::Receiver<bool>,
}

impl Stop {
    pub fn on_signals() -> Self {
        use tokio::signal::unix::{SignalKind, signal};
        let (tx, rx) = watch::channel(false);
        tokio::spawn(async move {
            let (Ok(mut int), Ok(mut term)) = (
                signal(SignalKind::interrupt()),
                signal(SignalKind::terminate()),
            ) else {
                return;
            };
            tokio::select! {
                _ = int.recv() => {}
                _ = term.recv() => {}
            }
            let _ = tx.send(true);
        });
        Stop { rx }
    }

    pub fn stopped(&self) -> bool {
        *self.rx.borrow()
    }

    pub async fn wait(&mut self) {
        let _ = self.rx.wait_for(|stopped| *stopped).await;
    }

    /// Sleeps `duration`; true when a signal came first.
    pub async fn sleep(&mut self, duration: Duration) -> bool {
        tokio::select! {
            _ = tokio::time::sleep(duration) => self.stopped(),
            _ = self.wait() => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn version_and_unknown_commands() {
        assert_eq!(
            run(&argv(&["--version"])).stdout,
            format!("fleetd {} (protocol 1)\n", update::version())
        );
        let unknown = run(&argv(&["frobnicate"]));
        assert_eq!(unknown.code, 2);
        assert!(
            unknown
                .stderr
                .starts_with("fleetd: unknown command 'frobnicate'\n\nusage: fleetd")
        );
        assert_eq!(run(&argv(&["hub", "device", "add"])).code, 2);
        assert!(!usage_text().contains("hub device"));
    }

    #[test]
    fn every_command_answers_help() {
        let help = |args: &[&str]| help_for(&argv(args));
        assert!(help(&["init", "--help"]).unwrap().contains("init [--yes]"));
        assert!(
            help(&["machine", "add", "-h"])
                .unwrap()
                .contains("machine add <ssh-host>")
        );
        assert!(
            help(&["hub", "key", "create", "--help"])
                .unwrap()
                .contains("hub key create")
        );
        assert!(!help(&["hub", "key", "-h"]).unwrap().contains("hub start"));
        assert!(help(&["hub", "--help"]).unwrap().contains("hub key create"));
        assert!(
            help(&["update", "-h"])
                .unwrap()
                .contains("update [--check]")
        );
        assert!(help(&["status", "--help"]).is_some());
        // After `--` it is an argument, and unknown commands keep their error.
        assert_eq!(help(&["task", "--", "-h"]), None);
        assert_eq!(help(&["frobnicate", "--help"]), None);
        assert_eq!(help(&["init"]), None);
    }
}
