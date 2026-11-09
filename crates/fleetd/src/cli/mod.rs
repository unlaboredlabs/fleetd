//! The `fleetd` command line: the same subcommands, arguments, output and exit codes as older releases.
//! Exit codes: 0 ok, 1 failed (a claim that did not pass), 2 usage, 3 refused, 4 hub or node unreachable.

pub mod agent_device;
pub mod agent_mcp;
pub mod args;
pub mod chat;
pub mod cloud;
pub mod github_app;
pub mod hub_key;
pub mod mac_tool;
pub mod mcp_client;
pub mod metrics;
pub mod navi;
pub mod node;
pub mod pair;
pub mod people;
pub mod project;
pub mod prompts;
pub mod push_relay;
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
{}{}{}{}{}{}{}{}{}{}{}{}{}",
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
        push_relay::PUSH_RELAY_USAGE,
        time::TIME_USAGE,
        metrics::METRICS_USAGE,
        status::STATUS_USAGE,
        usage::USAGE_USAGE,
        cloud::CLOUD_USAGE,
        steer::STEER_USAGE,
        chat::CHAT_USAGE,
        work::WORK_USAGE
    )
}

const UPDATE_USAGE: &str = "  update [--check] [--channel <c>] [--flavour <f>] [--now]
             replace this fleetd with the latest release, then restart its hub at once and its
             node once its agents finish the step they're on (10 min at most; --now doesn't wait):
             what they were running carries on by itself. The app's Update button does this for
             the hub and every node; this is for a machine without the app. --channel edge (the
             newest build of main) or stable; default: the channel this build came from.
             --flavour rust or bun switches this machine to that implementation's build
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
        "project" => project::PROJECT_USAGE.to_owned(),
        "navi" | "navis" => navi::NAVI_USAGE.to_owned(),
        "hub" => match rest.first().map(String::as_str) {
            Some("start") => node::HUB_START_USAGE.to_owned(),
            Some("key") => hub_key::HUB_KEY_USAGE.to_owned(),
            _ => format!("{}{}", node::HUB_START_USAGE, hub_key::HUB_KEY_USAGE),
        },
        "node" => node::NODE_USAGE.to_owned(),
        "prompts" | "instructions" => prompts::PROMPTS_USAGE.to_owned(),
        "push-relay" => push_relay::PUSH_RELAY_USAGE.to_owned(),
        "time" => time::TIME_USAGE.to_owned(),
        "metrics" => metrics::METRICS_USAGE.to_owned(),
        "update" => UPDATE_USAGE.to_owned(),
        "status" => status::STATUS_USAGE.to_owned(),
        "usage" => usage::USAGE_USAGE.to_owned(),
        "cloud" => cloud::CLOUD_USAGE.to_owned(),
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

/// The daemons, which serve until stopped (`node join` without `--enroll-only` goes on to run the node): their output
/// failing stays what it was.
fn is_daemon(argv: &[String]) -> bool {
    match argv.first().map(String::as_str) {
        Some("hub") => argv.get(1).map(String::as_str) == Some("start"),
        Some("node") => match argv.get(1).map(String::as_str) {
            Some("run") => true,
            Some("join") => !argv.iter().any(|a| a == "--enroll-only"),
            _ => false,
        },
        Some("push-relay") => !argv.iter().any(|a| a == "set"),
        Some("agent-mcp" | "update-finish") => true,
        _ => false,
    }
}

/// A one-shot command whose reader goes away (`fleetd project list | head -1`) ends quietly with 0, instead of std's
/// "failed printing to stdout: Broken pipe" panic and exit 101. SIGPIPE stays ignored, so a write to a child (the
/// binary streamed into ssh) or a socket still reports its error.
fn quiet_on_closed_output() {
    let report = std::panic::take_hook();
    let broken_pipe = format!("(os error {})", nix::errno::Errno::EPIPE as i32);
    std::panic::set_hook(Box::new(move |info| {
        let message = info.payload_as_str().unwrap_or_default();
        if message.starts_with("failed printing to std") && message.ends_with(&broken_pipe) {
            std::process::exit(0);
        }
        report(info);
    }));
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
                | "navi"
                | "navis"
                | "node"
                | "time"
                | "metrics"
                | "push-relay"
                | "update"
                | "steer"
                | "steers"
                | "chat"
                | "status"
                | "usage"
                | "cloud"
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
        "project" => project::project_command(rest).await,
        "navi" | "navis" => navi::navi_command(rest).await,
        "node" => node::node_command(rest).await,
        "time" => time::time_command(rest).await,
        "metrics" => metrics::metrics_command(rest).await,
        "push-relay" => push_relay::push_relay_command(rest).await,
        "status" => status::status_command(rest).await,
        "usage" => usage::usage_command(rest).await,
        "cloud" => cloud::cloud_command(rest).await,
        "steer" => steer::steer_command(rest, false).await,
        "steers" => steer::steer_command(rest, true).await,
        "chat" => chat::chat_command(rest).await,
        "work" => work::work_command(rest).await,
        _ => update_command(rest).await,
    }
}

/// `fleetd update [--check] [--channel <c>] [--now]`.
async fn update_command(argv: &[String]) -> u8 {
    let spec = args::Spec {
        options: &[
            ("check", args::Kind::Bool),
            ("channel", args::Kind::Str),
            ("flavour", args::Kind::Str),
            ("now", args::Kind::Bool),
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
        flavour: v.string("flavour"),
        now: v.flag("now"),
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
    // `mac` on an agent session's PATH (node/mac_tool): every argument is mac's, `--help` too.
    if argv.first().map(String::as_str) == Some("mac") {
        return ExitCode::from(mac_tool::run(&argv[1..]));
    }
    // The forwarding agent-device's (node/device/remote.rs): every argument is agent-device's, `--help` too.
    if argv.first().map(String::as_str) == Some("agent-device") {
        return ExitCode::from(agent_device::run(&argv[1..]));
    }
    // An agent's cargo, which waits its turn for a build slot (node/build_slots.rs); not for people, so not in help.
    if argv.first().map(String::as_str) == Some(crate::node::build_slots::COMMAND) {
        return crate::node::build_slots::main(&argv[1..]);
    }
    // A session's host, which the node starts for each session (node/runner/host.rs); not for people, so not in help.
    if argv.first().map(String::as_str) == Some(crate::node::runner::host::COMMAND) {
        return crate::node::runner::host::main(&argv[1..]);
    }
    crate::home::init_from_argv(&argv);
    let help = help_for(&argv);
    if help.is_some() || !is_daemon(&argv) {
        quiet_on_closed_output();
    }
    if let Some(text) = help {
        print!("{text}");
        return ExitCode::SUCCESS;
    }
    if argv.first().map(String::as_str) == Some("hub")
        && argv.get(1).map(String::as_str) == Some("start")
    {
        return node::hub_start(&argv[2..]);
    }
    if argv.first().map(String::as_str) == Some("agent-mcp") {
        return ExitCode::from(agent_mcp::run(&argv[1..]));
    }
    // The watcher an update starts from the previous binary (crate::update::finish); not for people, so not in help.
    if argv.first().map(String::as_str) == Some("update-finish")
        && let Some(plan) = argv.get(1)
    {
        return crate::update::finish::run(std::path::Path::new(plan));
    }
    // A session's PreToolUse hook while its node holds its agents for an update (node/hold.rs); not for people.
    if argv.first().map(String::as_str) == Some("update-hold")
        && let Some(hold) = argv.get(1)
    {
        return crate::node::hold::run_hook(std::path::Path::new(hold));
    }
    // `fleetd update` runs it from the binary it just installed, which knows the Claude Code it was tested with.
    if argv.first().map(String::as_str) == Some("update-claude") {
        return update::run_claude();
    }
    if is_long_running(&argv) {
        let grace = match argv.get(..2) {
            Some([node, run]) if node == "node" && run == "run" => NODE_SHUTDOWN_GRACE,
            _ => SHUTDOWN_GRACE,
        };
        return ExitCode::from(block_on_bounded(run_long_running(&argv), grace));
    }
    let result = run(&argv);
    use std::io::Write;
    let _ = std::io::stdout().write_all(result.stdout.as_bytes());
    let _ = std::io::stderr().write_all(result.stderr.as_bytes());
    ExitCode::from(result.code)
}

/// How long a finished command waits for tasks still running before it exits anyway.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);
/// `node run`'s, as the hub's: the node has stopped gracefully by then, and every moment more is blackout when it
/// restarts for an update (the 3 s grace was most of it).
const NODE_SHUTDOWN_GRACE: Duration = Duration::from_millis(100);

/// Runs `command` on a fresh runtime, then exits within `grace`: dropping the runtime instead waits on every worker
/// with no limit, so one task stuck in a poll (or a blocking call) kept a finished command alive forever.
/// Long-running commands (`node run`) stop gracefully inside `command`, before this grace starts.
fn block_on_bounded(command: impl std::future::Future<Output = u8>, grace: Duration) -> u8 {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("a tokio runtime starts");
    let code = runtime.block_on(command);
    runtime.shutdown_timeout(grace);
    code
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
    fn only_one_shot_commands_end_quietly_on_a_closed_pipe() {
        for daemon in [
            &["hub", "start", "--listen", "127.0.0.1:4790"][..],
            &["node", "run"],
            &[
                "node",
                "join",
                "--hub",
                "http://devbox:4790",
                "--token-file",
                "t",
            ],
            &["push-relay"],
            &["push-relay", "--listen", "127.0.0.1:4791"],
            &["agent-mcp"],
            &["update-finish", "plan.json"],
        ] {
            assert!(is_daemon(&argv(daemon)), "{daemon:?}");
        }
        for one_shot in [
            &["status"][..],
            &["hub", "key", "list"],
            &["node", "restart"],
            &["node", "join", "--enroll-only", "--token-file", "t"],
            &["push-relay", "set", "off"],
            &["project", "set", "P1"],
            &["chat", "--follow"],
        ] {
            assert!(!is_daemon(&argv(one_shot)), "{one_shot:?}");
        }
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
    fn a_finished_command_exits_with_a_task_stuck_in_a_poll() {
        let (done, finished) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let code = block_on_bounded(
                async {
                    // A task that never yields: its worker never comes back to the runtime.
                    let (started, running) = tokio::sync::oneshot::channel();
                    tokio::spawn(async move {
                        let _ = started.send(());
                        loop {
                            std::thread::sleep(Duration::from_secs(1));
                        }
                    });
                    let _ = running.await;
                    7
                },
                SHUTDOWN_GRACE,
            );
            let _ = done.send(code);
        });
        let code = finished.recv_timeout(SHUTDOWN_GRACE + Duration::from_secs(10));
        assert_eq!(code, Ok(7), "the command's runtime never let it exit");
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
        assert!(!usage_text().contains("--retention"), "retention is fixed");
        // After `--` it is an argument, and unknown commands keep their error.
        assert_eq!(help(&["task", "--", "-h"]), None);
        assert_eq!(help(&["frobnicate", "--help"]), None);
        assert_eq!(help(&["init"]), None);
    }
}
