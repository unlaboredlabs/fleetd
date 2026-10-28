//! The `fleetd` command line: the same subcommands, arguments, output and exit codes as older releases.
//! Exit codes: 0 ok, 1 failed (a claim that did not pass), 2 usage, 3 refused, 4 hub or node unreachable.

pub mod agent_mcp;
pub mod args;
pub mod chat;
pub mod github_app;
pub mod google_mcp;
pub mod hub_key;
pub mod mcp_client;
pub mod metrics;
pub mod navi;
pub mod node;
pub mod pair;
pub mod people;
pub mod project;
pub mod prompts;
pub mod setup;
pub mod status;
pub mod steer;
pub mod time;
pub mod update;
pub mod usage;
pub mod versions;
pub mod work;

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
{}{}{}{}{}
projects:
{}{}
running by hand:
{}{}{}{}{}{}{}{}{}{}{}",
        UPDATE_USAGE,
        setup::SETUP_USAGE,
        setup::machine::machine_usage(),
        pair::PAIR_USAGE,
        people::PEOPLE_USAGE,
        github_app::GITHUB_APP_USAGE,
        project::PROJECT_USAGE,
        navi::NAVI_USAGE,
        node::HUB_START_USAGE,
        hub_key::HUB_KEY_USAGE,
        node::NODE_USAGE,
        prompts::PROMPTS_USAGE,
        time::TIME_USAGE,
        metrics::METRICS_USAGE,
        status::STATUS_USAGE,
        usage::USAGE_USAGE,
        steer::STEER_USAGE,
        chat::CHAT_USAGE,
        work::WORK_USAGE
    )
}

const UPDATE_USAGE: &str = "  update [--check] [--channel <c>]
             replace this fleetd with the latest release, then restart its hub and node at once:
             what they were running carries on by itself. The app's Update button does this for
             the hub and every node; this is for a machine without the app. --channel edge (the
             newest build of main) or stable; default: the channel this build came from
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
        "invite" | "people" => people::PEOPLE_USAGE.to_owned(),
        "github-app" => github_app::GITHUB_APP_USAGE.to_owned(),
        "project" | "projects" => project::PROJECT_USAGE.to_owned(),
        "navi" | "navis" => navi::NAVI_USAGE.to_owned(),
        "hub" => match rest.first().map(String::as_str) {
            Some("start" | "serve") => node::HUB_START_USAGE.to_owned(),
            Some("key") => hub_key::HUB_KEY_USAGE.to_owned(),
            _ => format!("{}{}", node::HUB_START_USAGE, hub_key::HUB_KEY_USAGE),
        },
        "node" => node::NODE_USAGE.to_owned(),
        "prompts" | "instructions" => prompts::PROMPTS_USAGE.to_owned(),
        "time" => time::TIME_USAGE.to_owned(),
        "metrics" => metrics::METRICS_USAGE.to_owned(),
        "update" => UPDATE_USAGE.to_owned(),
        "status" => status::STATUS_USAGE.to_owned(),
        "usage" => usage::USAGE_USAGE.to_owned(),
        "steer" | "steers" => steer::STEER_USAGE.to_owned(),
        "chat" => chat::CHAT_USAGE.to_owned(),
        "work" => work::WORK_USAGE.to_owned(),
        _ => return None,
    };
    Some(format!("usage:\n{text}"))
}

/// `fleetd version`: the build's label, with the raw version beside it when they differ.
fn version_line() -> String {
    version_line_of(update::version())
}

fn version_line_of(version: &str) -> String {
    let protocol = fleetd_contracts::hello::PROTOCOL_VERSION;
    match crate::version_label(version) {
        label if label == version => format!("fleetd {version} (protocol {protocol})\n"),
        label => format!("fleetd {label} ({version}, protocol {protocol})\n"),
    }
}

/// The short-lived commands: version, help and `hub key`.
pub fn run(argv: &[String]) -> CliResult {
    let command = argv.first().map(String::as_str);
    match command {
        Some("version" | "--version" | "-v") => CliResult {
            code: 0,
            stdout: version_line(),
            stderr: String::new(),
        },
        None | Some("help" | "--help" | "-h") => CliResult {
            code: 0,
            stdout: usage_text(),
            stderr: String::new(),
        },
        Some("pair") => pair::pair_command(&argv[1..]),
        Some("invite") => people::invite_command(&argv[1..]),
        Some("people") => people::people_command(&argv[1..]),
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

/// Commands that keep running (`node …`, `status --watch`, `steer --wait`, `chat --follow`) or wait on other processes
/// or the hub (setup, `update`, `status`, `steer`, `chat`, `work`).
fn is_long_running(argv: &[String]) -> bool {
    matches!(
        argv.first().map(String::as_str),
        Some(
            "init"
                | "doctor"
                | "uninstall"
                | "machine"
                | "github-app"
                | "project"
                | "projects"
                | "navi"
                | "navis"
                | "node"
                | "time"
                | "metrics"
                | "update"
                | "steer"
                | "steers"
                | "chat"
                | "status"
                | "usage"
                | "work"
        )
    )
}

async fn run_long_running(argv: &[String]) -> u8 {
    let rest = &argv[1..];
    match argv[0].as_str() {
        "init" | "doctor" | "uninstall" => setup::setup_command(&argv[0], rest).await,
        "machine" => setup::machine::machine_command(rest).await,
        "github-app" => github_app::github_app_command(rest).await,
        "project" | "projects" => project::project_command(rest).await,
        "navi" | "navis" => navi::navi_command(rest).await,
        "node" => node::node_command(rest).await,
        "time" => time::time_command(rest).await,
        "metrics" => metrics::metrics_command(rest).await,
        "status" => status::status_command(rest).await,
        "usage" => usage::usage_command(rest).await,
        "steer" => steer::steer_command(rest, false).await,
        "steers" => steer::steer_command(rest, true).await,
        "chat" => chat::chat_command(rest).await,
        "work" => work::work_command(rest).await,
        _ => update_command(rest).await,
    }
}

/// `fleetd update [--check] [--channel <c>]`; `--restart-now`, from before restarts stopped waiting, is still taken.
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
    crate::update::keep_running_binary();
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
    if argv.first().map(String::as_str) == Some(fleetd_contracts::google::GOOGLE_MCP_ARG) {
        return ExitCode::from(google_mcp::run(&argv[1..]));
    }
    // The watcher an update starts from the previous binary (crate::update::finish); not for people, so not in help.
    if argv.first().map(String::as_str) == Some("update-finish")
        && let Some(plan) = argv.get(1)
    {
        return crate::update::finish::run(std::path::Path::new(plan));
    }
    // `fleetd update` runs it from the binary it just installed, which knows the Claude Code it was tested with.
    if argv.first().map(String::as_str) == Some("update-claude") {
        return update::run_claude();
    }
    if is_long_running(&argv) {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("a tokio runtime starts");
        return ExitCode::from(runtime.block_on(run_long_running(&argv)));
    }
    let result = run(&argv);
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
        assert_eq!(run(&argv(&["--version"])).stdout, version_line());
        assert_eq!(version_line_of("0.4.0"), "fleetd 0.4.0 (protocol 1)\n");
        assert_eq!(
            version_line_of("0.0.0-edge.202610261056+1b563d7"),
            "fleetd Edge · Oct 26, 10:56 UTC · 1b563d7 (0.0.0-edge.202610261056+1b563d7, protocol 1)\n"
        );
        assert_eq!(
            version_line_of("0.0.0-nightly.202610261056+1b563d7"),
            "fleetd Edge · Oct 26, 10:56 UTC · 1b563d7 (0.0.0-nightly.202610261056+1b563d7, protocol 1)\n"
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
        assert!(
            help(&["metrics", "-h"])
                .unwrap()
                .contains("metrics [--project <p>] [--days 30]")
        );
        assert!(usage_text().contains("  metrics --retention <days>"));
        // After `--` it is an argument, and unknown commands keep their error.
        assert_eq!(help(&["task", "--", "-h"]), None);
        assert_eq!(help(&["frobnicate", "--help"]), None);
        assert_eq!(help(&["init"]), None);
    }
}
