//! `fleetd init` in a terminal (or with --yes): one question at a time under a step header, live checks that resolve
//! to ✓/✗ with a one-line fix, and a short summary with the one next action. Run again, it finds what exists, keeps
//! what works and repairs the rest; it never deletes data or makes a second key or unit.

use std::path::{Path, PathBuf};

use fleetd_contracts::auth::KeyKind;
use fleetd_contracts::ids::MachineId;

use super::checklist::Checklist;
use super::detect::{self, Tailnet};
use super::machine::{self, Added, local_host_name, machine_id_from_host};
use super::machine_plan::{login_command, login_status_command};
use super::ssh::{run_attached, run_local, run_ssh};
use super::state::{GitIdentity, is_noreply, parse_git_identity, read_setup};
use super::steps;
use super::units::q;
use super::{HubPlan, InitOptions, Probe, install_hub, probe_listen};
use crate::cli::hub_key::open_hub;
use crate::cli::pair;
use crate::hub::doctor::checks::{self, CmdOutcome, DoctorStatus};
use crate::node::runner::claude::setup::{ClaudeSetup, describe};
use crate::node::runner::claude::version::{self, VersionVerdict};
use fleetd_contracts::setup::{HubSetupStep, SetupNeed, SetupStatus, SetupStepId};

const PORT: u16 = 4790;
const AGAIN: &str = "Run fleetd init to continue; it keeps what's done.";

/// The user pressed Esc or Ctrl-C at a prompt.
struct Stopped;

fn stopped(_: std::io::Error) -> Stopped {
    Stopped
}

/// Prompts, one at a time. Without a terminal (or with --yes) each answers its default.
struct Ui {
    interactive: bool,
}

impl Ui {
    fn confirm(&self, list: &mut Checklist, prompt: &str, default: bool) -> Result<bool, Stopped> {
        if !self.interactive {
            return Ok(default);
        }
        list.stop_spinner();
        let answer = cliclack::confirm(prompt)
            .initial_value(default)
            .interact()
            .map_err(stopped);
        list.prompted();
        answer
    }

    /// Whether to run something interactive now (claude/gh auth login, a claude update): only when a person is at
    /// the terminal and says yes. Without a terminal, with --yes or in a scripted --join it is never offered, so nothing waits for a
    /// browser; the step fails with its fix instead.
    fn offer_to_run(&self, list: &mut Checklist, prompt: &str) -> Result<bool, Stopped> {
        if !self.interactive {
            return Ok(false);
        }
        self.confirm(list, prompt, true)
    }

    /// An input; Enter on an empty line takes `default`. `check` explains a bad answer inline.
    fn input(
        &self,
        list: &mut Checklist,
        prompt: &str,
        default: &str,
        placeholder: &str,
        check: fn(&str) -> Result<(), String>,
    ) -> Result<String, Stopped> {
        if !self.interactive {
            return Ok(default.to_owned());
        }
        list.stop_spinner();
        let mut input = cliclack::input(prompt).validate(move |s: &String| check(s.trim()));
        if !default.is_empty() {
            input = input.default_input(default);
        } else if !placeholder.is_empty() {
            input = input.placeholder(placeholder);
        }
        let answer = input
            .interact::<String>()
            .map(|s| s.trim().to_owned())
            .map_err(stopped);
        list.prompted();
        answer
    }

    /// `(value, label, hint)`; the default is preselected.
    fn select<T: Clone + Eq>(
        &self,
        list: &mut Checklist,
        prompt: &str,
        items: &[(T, String, String)],
        default: T,
    ) -> Result<T, Stopped> {
        if !self.interactive {
            return Ok(default);
        }
        list.stop_spinner();
        let answer = cliclack::select(prompt)
            .items(items)
            .initial_value(default)
            .interact()
            .map_err(stopped);
        list.prompted();
        answer
    }

    fn multi<T: Clone + Eq>(
        &self,
        list: &mut Checklist,
        prompt: &str,
        items: &[(T, String, String)],
        defaults: Vec<T>,
    ) -> Result<Vec<T>, Stopped> {
        if !self.interactive {
            return Ok(defaults);
        }
        list.stop_spinner();
        let answer = cliclack::multiselect(prompt)
            .items(items)
            .initial_values(defaults)
            .required(false)
            .interact()
            .map_err(stopped);
        list.prompted();
        answer
    }
}

fn needed(s: &str) -> Result<(), String> {
    if s.is_empty() {
        Err("this one is needed".into())
    } else {
        Ok(())
    }
}

/// `bin` on PATH, without running anything.
fn which(bin: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join(bin))
            .find(|file| {
                use std::os::unix::fs::PermissionsExt;
                file.metadata()
                    .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            })
    })
}

/// Runs a command with only the environment the hub service has.
async fn hub_env_run(program: &str, args: &[&str]) -> CmdOutcome {
    let output = tokio::process::Command::new(program)
        .args(args)
        .env_clear()
        .envs(
            ["HOME", "PATH", "USER", "LANG"]
                .into_iter()
                .filter_map(|k| {
                    std::env::var(k)
                        .ok()
                        .filter(|v| !v.is_empty())
                        .map(|v| (k, v))
                }),
        )
        .stdin(std::process::Stdio::null())
        .output()
        .await;
    match output {
        Ok(out) => CmdOutcome::Ran {
            exit_code: out.status.code().unwrap_or(1),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            CmdOutcome::SpawnError("ENOENT".into())
        }
        Err(error) => CmdOutcome::SpawnError(error.to_string()),
    }
}

/// A login flow or a clone with this terminal attached.
fn attached(list: &mut Checklist, program: &str, args: &[&str]) -> bool {
    list.stop_spinner();
    std::process::Command::new(program)
        .args(args)
        .status()
        .is_ok_and(|s| s.success())
}

fn install(tool: &str) -> String {
    detect::install_command(
        tool,
        std::env::consts::OS,
        std::fs::read_to_string("/etc/os-release").ok().as_deref(),
    )
}

async fn tailnet() -> Option<Tailnet> {
    which("tailscale")?;
    let out = run_local("tailscale", &["status".into(), "--json".into()], None).await;
    (out.code == 0)
        .then(|| detect::parse_tailscale_status(&out.stdout))
        .flatten()
}

fn home_dir() -> PathBuf {
    crate::cli::home_dir()
}

/// `~/x` for paths under the home directory.
fn tilde(path: &Path) -> String {
    match path.strip_prefix(home_dir()) {
        Ok(rest) => format!("~/{}", rest.display()),
        Err(_) => path.display().to_string(),
    }
}

/// "… Fix: <command>" split into the why and the command.
fn split_fix(problem: &str) -> (String, String) {
    match problem.split_once(" Fix: ") {
        Some((why, fix)) => (
            why.trim().trim_end_matches('.').to_owned(),
            fix.trim().trim_end_matches('.').to_owned(),
        ),
        None => (
            problem.trim().trim_end_matches('.').to_owned(),
            problem.trim().to_owned(),
        ),
    }
}

pub async fn run(opts: InitOptions, interactive: bool) -> u8 {
    // Ctrl-C outside a prompt (a spinner, a check): give the cursor back and say how to go on.
    tokio::spawn(async {
        if tokio::signal::ctrl_c().await.is_ok() {
            let _ = console::Term::stderr().show_cursor();
            eprintln!("\n{AGAIN}");
            std::process::exit(130);
        }
    });
    let ui = Ui { interactive };
    let mut list = Checklist::new();
    if list.rich {
        let _ = cliclack::intro(
            console::style(" fleetd init ")
                .on_cyan()
                .black()
                .for_stderr(),
        );
    }
    match steps(&opts, &ui, &mut list).await {
        Ok(code) => code,
        Err(Stopped) => {
            list.stop_spinner();
            // cliclack has already closed the prompt with "Operation cancelled."
            eprintln!("{}{AGAIN}", if list.rich { "   " } else { "" });
            130
        }
    }
}

/// What the summary at the end shows.
#[derive(Default)]
struct Summary {
    hub: Option<String>,
    workers: Vec<String>,
    project: Option<String>,
    pairing: Option<String>,
}

async fn steps(opts: &InitOptions, ui: &Ui, list: &mut Checklist) -> Result<u8, Stopped> {
    let previous = opts.previous.as_ref();
    let joined = machine::joined_here();
    let role = super::init_role(
        previous.is_some(),
        joined
            .as_ref()
            .map(|j| (j.hub.as_str(), j.machine_id.as_str())),
        opts.join
            .as_ref()
            .map(|(hub, _)| (hub.as_str(), opts.machine_id.as_deref())),
        opts.rejoin,
    );
    match (role, joined) {
        (super::InitRole::RepairWorker, Some(joined)) => {
            list.set_sections(1);
            return repair_worker(opts, ui, list, joined).await;
        }
        (super::InitRole::Join, _) => {
            list.set_sections(2);
            return join_hub(opts, ui, list).await;
        }
        _ => {}
    }

    list.set_sections(6);
    list.section("This machine");
    if role == super::InitRole::Ask {
        if let Some(code) = offer_app(ui, list)? {
            return Ok(code);
        }
        let hub = ui.select(
            list,
            "What is this machine?",
            &[
                (
                    true,
                    "The hub".to_owned(),
                    "always on; your fleet and the app connect to it".to_owned(),
                ),
                (
                    false,
                    "A worker for a hub I already have".to_owned(),
                    "joins it with a one-time code".to_owned(),
                ),
            ],
            true,
        )?;
        if !hub {
            list.set_sections(2);
            return join_hub(opts, ui, list).await;
        }
    }
    let net = tailnet().await;
    let lan = detect::lan_ipv4();
    let (listen, url) = reachability(opts, ui, list, net.as_ref(), lan.as_deref()).await?;
    let mut summary = Summary {
        hub: Some(url.clone()),
        ..Summary::default()
    };

    list.section("Logins");
    let claude = hub_claude(ui, list).await?;
    let gh_ok = gh_check(ui, list).await?;
    let identity = commit_identity(opts, ui, list, gh_ok).await?;

    list.section("Hub");
    list.start("Starting the hub");
    let plan = HubPlan {
        home: &opts.home,
        listen: listen.clone(),
        url: url.clone(),
        suffix: opts.suffix.clone(),
        identity,
        with_service: opts.with_service,
        restart: false,
    };
    let hub_up = match install_hub(&plan, &|_| {}).await {
        Ok(how) if how.starts_with("not started") => {
            list.todo(
                "hub",
                "not started (--no-service)",
                "start the hub, then run fleetd init again",
                &format!(
                    "fleetd hub start --home {} --listen {listen}",
                    q(&opts.home.to_string_lossy())
                ),
            );
            false
        }
        Ok(how) => {
            list.done("hub", &how.replace(" and answers at ", " · "));
            true
        }
        Err(failure) => {
            list.failed("hub", &failure.message, &failure.fix);
            false
        }
    };

    let (mut added, mut idle) = (Vec::new(), Vec::new());
    list.section("Workers");
    if hub_up {
        let (local, ids, by_hand) = workers(opts, ui, list, net.as_ref(), claude.as_ref()).await?;
        summary.workers = ids.iter().chain(&by_hand).cloned().collect();
        (added, idle) = (ids, by_hand);
        list.section("Project");
        summary.project = first_project(opts, ui, list, local.as_deref(), gh_ok).await?;
    } else {
        list.skipped("workers", "need the hub running");
        list.section("Project");
        list.skipped("project", "needs the hub running");
    }

    list.section("App & setup");
    let paired = app(opts, ui, list, &mut summary)?;
    if hub_up {
        await_runner_checks(opts, list, &added).await;
        setup(opts, ui, list, &idle).await?;
    }
    finish(list, &summary, paired);
    Ok(u8::from(list.failures().next().is_some()))
}

/// On a desktop with the fleetd app: "Continue in the desktop app" opens its onboarding (`fleetd://setup`).
fn offer_app(ui: &Ui, list: &mut Checklist) -> Result<Option<u8>, Stopped> {
    let (installed, _) = app_hint();
    if !ui.interactive || !installed || !has_display() {
        return Ok(None);
    }
    let in_app = ui.select(
        list,
        "Where would you like to set up?",
        &[
            (false, "Here in the terminal".to_owned(), String::new()),
            (
                true,
                "Continue in the desktop app".to_owned(),
                "the fleetd app walks you through it".to_owned(),
            ),
        ],
        false,
    )?;
    if !in_app {
        return Ok(None);
    }
    let link = setup_link();
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    let opened = std::process::Command::new(opener)
        .arg(&link)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success());
    if opened {
        list.outro(&[], "Opened the fleetd app; it takes it from here.");
        Ok(Some(0))
    } else {
        list.failed("desktop app", "did not open", &format!("{opener} '{link}'"));
        Ok(None)
    }
}

/// `fleetd://setup?v=1&cli=<this fleetd>&home=<hub home>`: what the app needs to finish setup with this CLI.
fn setup_link() -> String {
    let enc = |s: &str| url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>();
    let cli = super::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "fleetd".into());
    let home = super::super::hub_key::resolve_home(None)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    format!("fleetd://setup?v=1&cli={}&home={}", enc(&cli), enc(&home))
}

/// Not the hub: join one as a worker with the one-time code `fleetd pair --worker` printed there.
async fn join_hub(opts: &InitOptions, ui: &Ui, list: &mut Checklist) -> Result<u8, Stopped> {
    list.section("Join a hub");
    let (hub, code) = match &opts.join {
        Some(join) => join.clone(),
        None => {
            list.note("On the hub, run: fleetd pair --worker <name for this machine>");
            let hub = ui.input(
                list,
                "Hub address",
                "",
                "http://devbox.tailnet.ts.net:4790",
                |s| {
                    reqwest::Url::parse(s)
                        .map(|_| ())
                        .map_err(|_| "a URL, as fleetd pair --worker prints it".to_owned())
                },
            )?;
            let code = ui.input(list, "One-time code", "", "", needed)?;
            (hub, code)
        }
    };
    let machine_id = match &opts.machine_id {
        Some(id) => id.clone(),
        None if opts.join.is_some() || !ui.interactive => machine_id_from_host(&local_host_name()),
        None => ui.input(
            list,
            "This machine's name on the hub",
            &machine_id_from_host(&local_host_name()),
            "",
            |s| {
                MachineId::new(s.to_owned())
                    .map(|_| ())
                    .map_err(|_| "lowercase letters, digits and dashes".to_owned())
            },
        )?,
    };
    if hub.trim().is_empty() || code.trim().is_empty() {
        list.failed(
            "join",
            "needs the hub's address and a one-time code",
            "on the hub, run fleetd pair --worker <name>, then the command it prints here",
        );
        let needs = list.needs_you();
        list.outro(&needs, AGAIN);
        return Ok(1);
    }
    list.section("Worker");
    let title = machine_id.clone();
    list.start(&format!("Joining {}", hub.trim()));
    super::capture();
    let joined = machine::join(
        hub.trim(),
        machine::Enroll::Token(code.trim().to_owned()),
        machine::AddArgs {
            git_identity: opts.identity.clone(),
            claude_config_dir: opts.claude_config_dir.clone(),
            ..machine::AddArgs::local(machine_id.clone(), &opts.suffix, opts.with_service)
        },
    )
    .await;
    let said = super::release();
    match joined {
        Ok(added) => {
            node_line(list, &title, &added, &format!("joined {}", hub.trim()));
            notes(list, &said);
            worker_claude(ui, list, &added, None).await?;
        }
        Err(_) => failed_with_log(
            list,
            &title,
            "could not join",
            &said,
            &format!(
                "a used or expired code: on the hub, fleetd pair --worker {machine_id} prints a new command"
            ),
        ),
    }
    Ok(worker_end(list, "This machine is a worker now."))
}

/// A worker that joined by itself, run again: keeps its enrolment and only checks and repairs what it runs.
async fn repair_worker(
    opts: &InitOptions,
    ui: &Ui,
    list: &mut Checklist,
    joined: machine::Joined,
) -> Result<u8, Stopped> {
    list.section("Worker");
    if opts.join.is_some() {
        list.note(
            "Already enrolled with that hub, so the code is not used (--rejoin enrols again).",
        );
    }
    let title = joined.machine_id.clone();
    list.start(&format!("Checking {title}"));
    super::capture();
    let repaired = machine::join(
        &joined.hub,
        machine::Enroll::Keep,
        machine::AddArgs {
            tags: joined.tags.clone(),
            git_identity: opts.identity.clone().or(joined.identity.clone()),
            claude_config_dir: opts.claude_config_dir.clone(),
            ..machine::AddArgs::local(joined.machine_id.clone(), &joined.suffix, opts.with_service)
        },
    )
    .await;
    let said = super::release();
    match repaired {
        Ok(added) => {
            node_line(
                list,
                &title,
                &added,
                &format!("enrolled with {}", joined.hub),
            );
            notes(list, &said);
            worker_claude(ui, list, &added, None).await?;
        }
        Err(_) => failed_with_log(
            list,
            &title,
            "check stopped",
            &said,
            "fix the cause above, then run fleetd init again",
        ),
    }
    Ok(worker_end(list, "This machine is a worker."))
}

/// The tail of what a captured step printed, as a dim note, then its ✗ line.
fn failed_with_log(list: &mut Checklist, title: &str, what: &str, said: &[String], fix: &str) {
    let why = said
        .iter()
        .rev()
        .find(|l| l.starts_with("fleetd: "))
        .map(|l| l.trim_start_matches("fleetd: ").to_owned());
    match why {
        Some(why) => {
            let (why, own_fix) = split_fix(&why);
            let fix = if why == own_fix {
                fix.to_owned()
            } else {
                own_fix
            };
            list.failed(title, &format!("{what}: {}", first_line(&why)), &fix);
        }
        None => list.failed(title, what, fix),
    }
}

fn first_line(text: &str) -> &str {
    text.lines().next().unwrap_or("")
}

/// `machine add`'s notes (linger, an untested claude, …) as ! lines; the login note is the claude line's.
fn notes(list: &mut Checklist, said: &[String]) {
    for note in said.iter().filter_map(|l| l.strip_prefix("note: ")) {
        if note.contains("not logged in") {
            continue;
        }
        let (why, fix) = split_fix(note);
        list.warn("note", &why, (why != fix).then_some(fix.as_str()));
    }
}

/// A worker's line: done when its node runs as a service; with --no-service, left to the user with its command.
fn node_line(list: &mut Checklist, title: &str, added: &Added, done: &str) {
    match &added.run_by_hand {
        None => list.done(title, done),
        Some(cmd) => list.todo(
            title,
            "enrolled; its node isn't started (--no-service)",
            &format!("start {}'s node", added.machine_id),
            &if added.target.local {
                cmd.clone()
            } else {
                format!("ssh {} {}", added.target.host, q(cmd))
            },
        ),
    }
}

fn worker_end(list: &mut Checklist, ok: &str) -> u8 {
    let failed = list.failures().next().is_some();
    let needs = list.needs_you();
    let next = if failed {
        AGAIN.to_owned()
    } else if !list.todos.is_empty() {
        "Then run fleetd init again.".to_owned()
    } else {
        format!("{ok} Its agents start from orders you send in the fleetd app.")
    };
    list.outro(&needs, &next);
    u8::from(failed)
}

async fn reachability(
    opts: &InitOptions,
    ui: &Ui,
    list: &mut Checklist,
    net: Option<&Tailnet>,
    lan: Option<&str>,
) -> Result<(String, String), Stopped> {
    if let Some(listen) = &opts.listen {
        let url = opts
            .url
            .clone()
            .unwrap_or_else(|| format!("http://{listen}"));
        list.done("reachable at", &url);
        return Ok((listen.clone(), url));
    }
    if let Some(previous) = &opts.previous {
        let url = opts.url.clone().unwrap_or_else(|| previous.url.clone());
        list.done("reachable at", &url);
        return Ok((previous.listen.clone(), url));
    }
    // (address to listen on, host in the URL, label, why), each on the first free port from 4790.
    let mut hosts: Vec<(String, String, &str, &str)> = Vec::new();
    if let Some(ip) = net.and_then(|n| n.ipv4.as_deref()) {
        let name = net.and_then(|n| n.dns_name.as_deref()).unwrap_or(ip);
        hosts.push((
            ip.into(),
            name.into(),
            "Your tailnet",
            "your devices reach it, nothing public",
        ));
    }
    hosts.push((
        "127.0.0.1".into(),
        "127.0.0.1".into(),
        "This machine only",
        "other machines can't reach it",
    ));
    if let Some(ip) = lan {
        hosts.push((
            ip.into(),
            ip.into(),
            "Your LAN",
            "anyone on this network, plain HTTP",
        ));
    }
    list.start("Looking for a free port");
    let mut choices: Vec<(usize, String, String)> = Vec::new();
    let mut addrs = Vec::new();
    for (i, (ip, name, label, why)) in hosts.into_iter().enumerate() {
        let mut port = PORT;
        while port < PORT + 10 && probe_listen(&(ip.clone(), port)).await != Probe::Free {
            port += 1;
        }
        let url = format!("http://{name}:{port}");
        choices.push((i, label.to_owned(), format!("{url} · {why}")));
        addrs.push((format!("{ip}:{port}"), url));
    }
    list.stop_spinner();
    let picked = ui.select(list, "Where should the hub listen?", &choices, 0)?;
    let (listen, url) = addrs.swap_remove(picked);
    let url = opts.url.clone().unwrap_or(url);
    list.done("reachable at", &url);
    Ok((listen, url))
}

/// The environment a node session gets: what the node's own claude checks run with.
fn session_env() -> Vec<(String, String)> {
    crate::node::sessions::SessionConfig::for_node(&crate::node::config::default_node_home())
        .runner_env()
}

/// The user's own claude, as fleetd's sessions run it. Offers the login when it is logged out.
async fn hub_claude(ui: &Ui, list: &mut Checklist) -> Result<Option<ClaudeSetup>, Stopped> {
    let Some(binary) = which("claude") else {
        list.failed(
            "claude",
            "is not installed; fleetd's agents run through it",
            &install("claude"),
        );
        return Ok(None);
    };
    let (mut logged, mut updated) = (false, false);
    loop {
        list.start("Checking claude");
        let setup = describe(&binary, &session_env()).await;
        let printed = setup.version.clone().unwrap_or_default();
        let verdict = version::check(&printed);
        // The version first, then always the login: an old claude's login still matters.
        if setup.version.is_some() && verdict != VersionVerdict::Ok {
            let fix = match verdict {
                VersionVerdict::UntestedOlder => update_command(&binary),
                _ => verdict.fix().unwrap_or_else(|| update_command(&binary)),
            };
            let why = verdict.problem(&printed).unwrap_or_default();
            let why = why.trim_end_matches('.');
            let why = why.strip_prefix("claude ").unwrap_or(why);
            list.warn("claude version", why, Some(&fix));
            if !updated
                && verdict != VersionVerdict::UntestedNewer
                && ui.offer_to_run(list, &format!("Update claude now? ({fix})"))?
            {
                updated = true;
                attached(list, "/bin/sh", &["-c", &fix]);
                continue;
            }
        }
        let shown = setup.to_string();
        let detail = shown.strip_prefix("claude ").unwrap_or(&shown).to_owned();
        if setup.login_kind.is_none() {
            if setup.version.is_some()
                && !logged
                && ui.offer_to_run(list, "claude isn't logged in. Log in now?")?
            {
                logged = true;
                attached(list, "claude", &["auth", "login"]);
                continue;
            }
            match (&setup.version, &setup.problem) {
                (None, Some(problem)) => {
                    let (why, fix) = split_fix(problem);
                    list.failed("claude", why.strip_prefix("claude ").unwrap_or(&why), &fix);
                }
                _ => list.failed("claude", &detail, "claude auth login"),
            }
            return Ok(None);
        }
        if setup.proxy_source.as_deref() == Some("environment") {
            list.warn(
                "claude",
                &format!(
                    "{detail}; that proxy is only in this shell, so fleetd's services won't use it"
                ),
                Some("put ANTHROPIC_BASE_URL in the env block of ~/.claude/settings.json"),
            );
        } else {
            list.done("claude", &detail);
        }
        // A protocol break the probe found (the version and login are shown above).
        if let Some(problem) = setup
            .problem
            .as_deref()
            .filter(|p| !p.contains("not logged in"))
        {
            let (why, fix) = split_fix(problem);
            list.failed(
                "claude protocol",
                why.strip_prefix("claude ").unwrap_or(&why),
                &fix,
            );
            return Ok(None);
        }
        return Ok(Some(setup));
    }
}

/// How this claude updates itself: Homebrew and npm installs through their package manager, the native installer's
/// by running it again, anything else with `claude update`.
fn update_command(binary: &Path) -> String {
    let real = std::fs::canonicalize(binary).unwrap_or_else(|_| binary.to_path_buf());
    update_command_for(&real.to_string_lossy())
}

fn update_command_for(path: &str) -> String {
    if path.contains("/Caskroom/")
        || path.contains("/Cellar/")
        || path.starts_with("/opt/homebrew/")
    {
        "brew upgrade claude-code".into()
    } else if path.contains("/node_modules/") {
        "npm install -g @anthropic-ai/claude-code@latest".into()
    } else if path.contains("/.local/share/claude/") || path.contains("/.claude/local/") {
        "curl -fsSL https://claude.ai/install.sh | bash".into()
    } else {
        "claude update".into()
    }
}

/// gh installed and logged in, as the hub service runs it; offers `gh auth login` right here.
async fn gh_check(ui: &Ui, list: &mut Checklist) -> Result<bool, Stopped> {
    if which("gh").is_none() {
        list.failed(
            "gh",
            "is not installed; the merge train and PR checks need it",
            &format!("{}, then gh auth login", install("gh")),
        );
        return Ok(false);
    }
    let mut offered = false;
    loop {
        list.start("Checking gh");
        let entry = checks::gh_auth(&hub_env_run("gh", &["auth", "status"]).await);
        if entry.check.status == DoctorStatus::Ok {
            let message = entry.check.message.replace(" on the hub", "");
            let message = message
                .split(';')
                .next()
                .unwrap_or("")
                .trim_end_matches('.')
                .trim_start_matches("gh is ");
            list.done("gh", message);
            return Ok(true);
        }
        if !offered && ui.offer_to_run(list, "gh isn't logged in. Log in now?")? {
            offered = true;
            attached(list, "gh", &["auth", "login"]);
            continue;
        }
        list.failed(
            "gh",
            "not logged in; the merge train and PR checks need it",
            "gh auth login",
        );
        return Ok(false);
    }
}

fn identity_ok(s: &str) -> Result<(), String> {
    parse_git_identity(s)
        .map(|_| ())
        .ok_or_else(|| "like: Name <id+user@users.noreply.github.com>".to_owned())
}

async fn commit_identity(
    opts: &InitOptions,
    ui: &Ui,
    list: &mut Checklist,
    gh_ok: bool,
) -> Result<Option<GitIdentity>, Stopped> {
    let known = opts
        .identity
        .clone()
        .or_else(|| opts.previous.as_ref().and_then(|p| p.git_identity.clone()));
    let mut asked = false;
    let identity = match known {
        Some(identity) => Some(identity),
        None => {
            asked = ui.interactive;
            let from_gh = if gh_ok {
                let out = run_local("gh", &["api".into(), "user".into()], None).await;
                detect::noreply_identity(&out.stdout)
            } else {
                None
            };
            let from_git = || {
                let get = |key: &str| {
                    std::process::Command::new("git")
                        .args(["config", "--global", key])
                        .output()
                        .ok()
                        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
                        .filter(|v| !v.is_empty())
                };
                Some(format!("{} <{}>", get("user.name")?, get("user.email")?))
            };
            let default = from_gh.or_else(from_git).unwrap_or_default();
            let text = ui.input(
                list,
                "Commit author for your agents",
                &default,
                "Name <id+user@users.noreply.github.com>",
                identity_ok,
            )?;
            parse_git_identity(&text)
        }
    };
    match &identity {
        // Just answered above: no second line saying the same.
        Some(id) if is_noreply(id) && asked => {}
        Some(id) if is_noreply(id) => {
            list.done("commit author", &format!("{} <{}>", id.name, id.email))
        }
        Some(id) => list.warn(
            "commit author",
            &format!(
                "{} <{}> isn't a GitHub noreply address; public repos will show it",
                id.name, id.email
            ),
            Some("fleetd init --git-identity \"Name <id+user@users.noreply.github.com>\""),
        ),
        None => list.failed(
            "commit author",
            "none set; agents need one to commit",
            "fleetd init --git-identity \"Name <id+user@users.noreply.github.com>\"",
        ),
    }
    Ok(identity)
}

/// Picks the machines that run agents and runs `machine add` on each. Returns this machine's id when it is one,
/// the machines whose node runs, and those whose node is left to the user (--no-service).
async fn workers(
    opts: &InitOptions,
    ui: &Ui,
    list: &mut Checklist,
    net: Option<&Tailnet>,
    claude: Option<&ClaudeSetup>,
) -> Result<(Option<String>, Vec<String>, Vec<String>), Stopped> {
    let state = read_setup(&opts.home).ok().flatten();
    let recorded = state.map(|s| s.machines).unwrap_or_default();
    let hosts = std::fs::read_to_string(home_dir().join(".ssh/config"))
        .map(|text| detect::parse_ssh_hosts(&text))
        .unwrap_or_default();
    let found = machine::candidates(
        &recorded,
        &hosts,
        net.map(|n| n.peers.as_slice()).unwrap_or_default(),
    );
    let local_id = found[0].machine_id.clone();
    let mut defaults = Vec::new();
    if recorded.is_empty() || recorded.contains_key(&local_id) {
        defaults.push(local_id.clone());
    }
    // (id, host (None: this machine), ssh config, hint)
    let candidates: Vec<(String, Option<String>, Option<String>, String)> = found
        .into_iter()
        .map(|c| {
            let hint = match (c.found, &c.host) {
                (machine::Found::Here, _) => "this machine".to_owned(),
                (machine::Found::SetUp, Some(host)) => format!("set up · {host}"),
                (machine::Found::SshConfig, Some(host)) => format!("~/.ssh/config · {host}"),
                _ => "tailnet".to_owned(),
            };
            if c.found == machine::Found::SetUp {
                defaults.push(c.machine_id.clone());
            }
            (c.machine_id, c.host, c.ssh_config, hint)
        })
        .collect();
    let items: Vec<(String, String, String)> = candidates
        .iter()
        .map(|(id, _, _, hint)| (id.clone(), id.clone(), hint.clone()))
        .collect();
    let chosen = ui.multi(list, "Which machines should run agents?", &items, defaults)?;
    if chosen.is_empty() {
        list.skipped("workers", "none yet");
        list.note("Add one later: fleetd machine add <ssh-host>, or fleetd pair --worker <name>");
        return Ok((None, Vec::new(), Vec::new()));
    }
    let home = opts.home.to_string_lossy().into_owned();
    let mut local = None;
    let (mut ids, mut by_hand) = (Vec::new(), Vec::new());
    for (id, host, ssh_config, _) in candidates.iter().filter(|c| chosen.contains(&c.0)) {
        let again = match host {
            None => "fleetd machine add --local".to_owned(),
            Some(host) => format!("fleetd machine add {host}"),
        };
        list.start(&format!("Setting up {id}"));
        super::capture();
        let added = machine::add(machine::AddArgs {
            host: host.clone(),
            machine_id: Some(id.clone()),
            tags: Vec::new(),
            dry_run: false,
            hub_url: None,
            ssh_config: ssh_config.clone(),
            home: Some(home.clone()),
            unit_suffix: None,
            enroll: machine::Enroll::Hub,
            git_identity: None,
            no_service: !opts.with_service,
            claude_config_dir: opts.claude_config_dir.clone(),
        })
        .await;
        let said = super::release();
        match added {
            Ok(Some(added)) => {
                node_line(list, id, &added, "online");
                notes(list, &said);
                let this_one = host.is_none().then_some(claude).flatten();
                worker_claude(ui, list, &added, this_one).await?;
                if added.run_by_hand.is_none() {
                    ids.push(added.machine_id.clone());
                } else {
                    by_hand.push(added.machine_id.clone());
                }
                if host.is_none() {
                    local = Some(added.machine_id);
                }
            }
            Ok(None) => {}
            Err(_) => failed_with_log(
                list,
                id,
                "setup stopped",
                &said,
                &format!("fix the cause, then run {again}"),
            ),
        }
    }
    Ok((local, ids, by_hand))
}

/// A node that just linked is "degraded: checking …" until its first claude check answers, about a second later.
/// The doctor runs after that answer, so it never reports the wait as a problem.
async fn await_runner_checks(opts: &InitOptions, list: &mut Checklist, ids: &[String]) {
    let Ok(hub) = open_hub(&opts.home) else {
        return;
    };
    for id in ids {
        let Ok(machine) = MachineId::new(id.clone()) else {
            continue;
        };
        list.start(&format!("Waiting for {id}'s claude check"));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        let answered = loop {
            let checking = hub
                .store
                .machine_get(&machine)
                .ok()
                .flatten()
                .is_some_and(|m| {
                    m.degraded_reason
                        .as_deref()
                        .is_some_and(super::doctor::still_checking)
                });
            if !checking {
                break true;
            }
            if std::time::Instant::now() > deadline {
                break false;
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        };
        list.stop_spinner();
        if !answered {
            list.skipped(
                id,
                "still checking its claude; run fleetd doctor in a minute",
            );
        }
    }
}

/// claude on a worker, as its node runs it. This machine's was checked above, so it isn't asked twice.
async fn worker_claude(
    ui: &Ui,
    list: &mut Checklist,
    added: &Added,
    here: Option<&ClaudeSetup>,
) -> Result<(), Stopped> {
    let title = format!("claude on {}", added.machine_id);
    if added.target.local && here.is_some() {
        return Ok(());
    }
    let config_dir = added.claude_config_dir.as_deref();
    let login = login_command(&added.claude, config_dir);
    let fix = if added.target.local {
        login.clone()
    } else {
        format!("ssh -t {} {}", added.target.host, q(&login))
    };
    let mut logged_in = added.logged_in;
    let mut offered = false;
    loop {
        if logged_in {
            list.done(&title, "logged in");
            return Ok(());
        }
        if offered
            || !ui.offer_to_run(
                list,
                &format!(
                    "claude on {} isn't logged in. Log in now?",
                    added.machine_id
                ),
            )?
        {
            list.failed(&title, "not logged in", &fix);
            return Ok(());
        }
        offered = true;
        list.stop_spinner();
        run_attached(&added.target, &login);
        let out = run_ssh(
            &added.target,
            &login_status_command(&added.layout, &added.claude, config_dir),
            None,
        )
        .await;
        logged_in = super::machine::logged_in(&out.stdout);
    }
}

async fn first_project(
    opts: &InitOptions,
    ui: &Ui,
    list: &mut Checklist,
    local: Option<&str>,
    gh_ok: bool,
) -> Result<Option<String>, Stopped> {
    let title = "project";
    let existing = open_hub(&opts.home)
        .ok()
        .and_then(|hub| hub.store.projects_list(None, None).ok())
        .unwrap_or_default();
    if let Some(project) = existing.first() {
        let what = format!("{} on {}", project.title, project.machine_id.as_str());
        list.done(
            "projects",
            &if existing.len() > 1 {
                format!("{what} and {} more", existing.len() - 1)
            } else {
                what.clone()
            },
        );
        return Ok(Some(what));
    }
    let Some(machine_id) = local else {
        list.skipped(title, "none here: this machine runs no agents");
        return Ok(None);
    };
    if !super::doctor::hub_has_tool(&opts.home, "project_add").await {
        list.skipped(
            title,
            "this hub can't add projects yet; after fleetd update, run fleetd init again",
        );
        return Ok(None);
    }
    if !ui.interactive {
        list.skipped(
            title,
            "none picked (--yes); run fleetd init in a terminal to pick one",
        );
        return Ok(None);
    }
    let roots: Vec<PathBuf> = detect::REPO_ROOTS
        .iter()
        .map(|r| home_dir().join(r))
        .collect();
    let repos = detect::find_repos(&roots);
    #[derive(Clone, PartialEq, Eq)]
    enum Pick {
        Repo(usize),
        Clone,
        Later,
    }
    let mut items: Vec<(Pick, String, String)> = repos
        .iter()
        .take(30)
        .enumerate()
        .map(|(i, r)| {
            (
                Pick::Repo(i),
                tilde(&r.path),
                r.remote
                    .as_deref()
                    .map(detect::short_remote)
                    .unwrap_or_default(),
            )
        })
        .collect();
    let default = if items.is_empty() {
        Pick::Clone
    } else {
        Pick::Repo(0)
    };
    items.push((
        Pick::Clone,
        "Clone one from GitHub".into(),
        "paste its URL".into(),
    ));
    items.push((Pick::Later, "Not now".into(), String::new()));
    let path = match ui.select(
        list,
        "Which repo should be your first project?",
        &items,
        default,
    )? {
        Pick::Repo(i) => repos[i].path.clone(),
        Pick::Later => {
            list.skipped(title, "none yet; run fleetd init again to add one");
            return Ok(None);
        }
        Pick::Clone => {
            let text = ui.input(
                list,
                "GitHub repo",
                "",
                "https://github.com/owner/repo",
                |s| {
                    detect::parse_github_repo(s)
                        .map(|_| ())
                        .ok_or_else(|| "a GitHub URL or owner/repo".to_owned())
                },
            )?;
            let Some((owner, repo)) = detect::parse_github_repo(&text) else {
                return Ok(None);
            };
            let parent = ["src", "code", "projects"]
                .iter()
                .map(|d| home_dir().join(d))
                .find(|d| d.is_dir())
                .unwrap_or_else(|| home_dir().join("src"));
            let dest = parent.join(&repo);
            if !dest.join(".git").is_dir() {
                let _ = std::fs::create_dir_all(&parent);
                let dest_text = dest.to_string_lossy().into_owned();
                let full = format!("{owner}/{repo}");
                let cloned = if gh_ok {
                    attached(list, "gh", &["repo", "clone", &full, &dest_text])
                } else {
                    attached(
                        list,
                        "git",
                        &["clone", &format!("https://github.com/{full}"), &dest_text],
                    )
                };
                if !cloned {
                    list.failed(
                        title,
                        &format!("cloning {full} failed"),
                        &format!(
                            "gh repo clone {full} {}, then run fleetd init again",
                            tilde(&dest)
                        ),
                    );
                    return Ok(None);
                }
            }
            dest
        }
    };
    list.start("Adding the project");
    match super::doctor::add_project(&opts.home, machine_id, &path).await {
        Ok(()) => {
            let what = format!("{} on {machine_id}", tilde(&path));
            list.done(title, &what);
            Ok(Some(what))
        }
        Err(failure) => {
            list.failed(title, &failure.message, &failure.fix);
            Ok(None)
        }
    }
}

/// A desktop session the app could open in: always on macOS, an X or Wayland display on Linux.
fn has_display() -> bool {
    cfg!(target_os = "macos")
        || ["DISPLAY", "WAYLAND_DISPLAY"]
            .iter()
            .any(|k| std::env::var_os(k).is_some_and(|v| !v.is_empty()))
}

/// Whether the desktop app is installed here, and how to open (or install) it.
fn app_hint() -> (bool, String) {
    let home = home_dir();
    if cfg!(target_os = "macos") {
        for app in [
            home.join("Applications/fleetd.app"),
            PathBuf::from("/Applications/fleetd.app"),
        ] {
            if app.is_dir() {
                return (true, format!("open {}", tilde(&app)));
            }
        }
        return (false, "curl -fsSL https://fleetd.sh | sh".into());
    }
    let data = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".local/share"));
    let bin = data.join("fleetd/app/fleetd-desktop.AppImage");
    if bin.is_file() {
        (true, "open fleetd from your app menu".into())
    } else {
        (
            false,
            "curl -fsSL https://fleetd.sh | sh -s -- --app".into(),
        )
    }
}

/// Pairs the desktop app with a one-time code; the app on this machine picks it up by itself. True when a device
/// is or can now be paired.
fn app(
    opts: &InitOptions,
    ui: &Ui,
    list: &mut Checklist,
    summary: &mut Summary,
) -> Result<bool, Stopped> {
    let devices: Vec<String> = open_hub(&opts.home)
        .ok()
        .and_then(|hub| hub.auth.list().ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|k| k.kind == Some(KeyKind::Human) && k.revoked_at.is_none())
        .map(|k| k.name)
        .collect();
    let want = if devices.is_empty() {
        ui.confirm(list, "Pair the fleetd app with this hub?", true)?
    } else {
        list.done("app", &format!("paired: {}", devices.join(", ")));
        summary.pairing = Some(format!("paired: {}", devices.join(", ")));
        ui.interactive && ui.confirm(list, "Pair another device?", false)?
    };
    if !want {
        if devices.is_empty() {
            list.skipped("app", "not paired; fleetd pair prints a code any time");
        }
        return Ok(!devices.is_empty());
    }
    let home = opts.home.to_string_lossy().into_owned();
    match pair::mint(Some(&home), None, crate::hub::pair::DEFAULT_ROLE) {
        Ok(minted) => {
            let hub = minted.urls.first().cloned().unwrap_or_default();
            let (installed, _) = app_hint();
            list.done(
                "pairing code",
                &format!("{} · one use, 15 min", minted.code),
            );
            if installed && has_display() {
                list.note("The app on this machine pairs by itself when you open it.");
            } else {
                list.note(&format!(
                    "In the fleetd app, enter {hub} and the code, or open:"
                ));
                list.note(&minted.deep_link);
            }
            summary.pairing = Some(format!("code {}", minted.code));
            Ok(true)
        }
        Err(message) => {
            list.failed("pairing code", &message, "fleetd pair");
            Ok(!devices.is_empty())
        }
    }
}

/// The hub's setup steps (setup_list), each a line, then the doctor's checks no
/// step speaks for. A person at the terminal may open the steps left, one by one.
async fn setup(
    opts: &InitOptions,
    ui: &Ui,
    list: &mut Checklist,
    idle: &[String],
) -> Result<(), Stopped> {
    list.start("Running the doctor");
    let checks = match super::doctor::run(&opts.home).await {
        Ok(checks) => checks,
        Err(failure) => {
            list.failed("doctor", &failure.message, &failure.fix);
            return Ok(());
        }
    };
    let mut client = match super::doctor::connect(&opts.home).await {
        Ok(client) => client,
        Err(failure) => {
            list.failed("setup", &failure.message, &failure.fix);
            return Ok(());
        }
    };
    let steps = match steps::list(&mut client).await {
        Ok(Some(steps)) => steps,
        // A hub from before setup steps: the doctor alone, as then.
        Ok(None) => {
            let ok = super::doctor::show(list, &checks, idle);
            list.done("doctor", &format!("{ok} of {} checks pass", checks.len()));
            return Ok(());
        }
        Err(failure) => {
            list.failed("setup", &failure.message, &failure.fix);
            return Ok(());
        }
    };
    steps::show(list, &steps);
    let rest = steps::unowned(&checks, &steps);
    let ok = super::doctor::show(list, &rest, idle);
    list.done(
        "doctor",
        &format!("{ok} of {} other checks pass", rest.len()),
    );
    let left: Vec<_> = steps
        .iter()
        .filter(|s| s.status != SetupStatus::Done)
        .map(|s| (s.id, s.title.clone(), steps::need_words(&s.need)))
        .collect();
    if left.is_empty() || !ui.interactive {
        return Ok(());
    }
    let picked = ui.multi(
        list,
        "Set up any of these now? (the app's Settings › Hub › Setup has them too)",
        &left,
        Vec::new(),
    )?;
    for step in steps.iter().filter(|s| picked.contains(&s.id)) {
        walk(opts, ui, list, &mut client, step).await?;
    }
    Ok(())
}

/// One step, open: its guide, then Test (its checks, now) until it passes or the person goes on, or Later.
async fn walk(
    opts: &InitOptions,
    ui: &Ui,
    list: &mut Checklist,
    client: &mut crate::cli::mcp_client::McpClient,
    step: &HubSetupStep,
) -> Result<SetupStatus, Stopped> {
    list.section(&format!(
        "{} · {}",
        step.title,
        steps::need_words(&step.need)
    ));
    list.note(&steps::guide(step));
    if !ui.interactive {
        return Ok(tested(list, client, step.id).await);
    }
    loop {
        let mut actions = Vec::new();
        if step.id == SetupStepId::People {
            actions.push((
                "invite",
                "Invite someone now".to_owned(),
                "a link and a code, for 7 days".to_owned(),
            ));
        }
        if step.test.is_some() || !step.ways.is_empty() {
            actions.push((
                "test",
                "Test it".to_owned(),
                "run its checks now".to_owned(),
            ));
        }
        actions.push(("next", "Go on".to_owned(), String::new()));
        match ui.select(list, &format!("{}:", step.title), &actions, actions[0].0)? {
            // An invite counts once they join; test it now anyway, as the hub may already know them.
            "invite" => {
                invite(opts, ui, list)?;
                if tested(list, client, step.id).await == SetupStatus::Done {
                    return Ok(SetupStatus::Done);
                }
            }
            "test" => {
                if tested(list, client, step.id).await == SetupStatus::Done {
                    return Ok(SetupStatus::Done);
                }
            }
            _ => return Ok(step.status),
        }
    }
}

/// setup_test, said as the step's line.
async fn tested(
    list: &mut Checklist,
    client: &mut crate::cli::mcp_client::McpClient,
    id: SetupStepId,
) -> SetupStatus {
    list.start("Testing");
    match steps::test(client, id).await {
        Ok(step) => {
            let (state, detail, fix) = steps::line(&step);
            list.finish(&step.title, state, &detail, fix.as_deref());
            step.status
        }
        Err(failure) => {
            list.failed("test", &failure.message, &failure.fix);
            SetupStatus::Look
        }
    }
}

/// `fleetd invite --name <name>` from the People step: the link and code are shown this once.
fn invite(opts: &InitOptions, ui: &Ui, list: &mut Checklist) -> Result<(), Stopped> {
    let name = ui.input(list, "Their name", "", "alice", needed)?;
    let home = opts.home.to_string_lossy().into_owned();
    let out =
        crate::cli::people::invite_command(&["--name".into(), name.clone(), "--home".into(), home]);
    if out.code == 0 {
        list.done(&format!("invite {name}"), "send them this:");
        list.note(out.stdout.trim_end());
    } else {
        list.failed(
            &format!("invite {name}"),
            out.stderr.trim().trim_start_matches("fleetd: "),
            "fleetd invite --name <name>",
        );
    }
    Ok(())
}

/// `fleetd init --step <id>`: that one step against the hub this machine runs, then the next action.
pub async fn open_step(opts: InitOptions, id: SetupStepId, interactive: bool) -> u8 {
    let ui = Ui { interactive };
    let mut list = Checklist::new();
    let mut client = match super::doctor::connect(&opts.home).await {
        Ok(client) => client,
        Err(failure) => {
            list.failed("setup", &failure.message, &failure.fix);
            return 4;
        }
    };
    let step = match steps::list(&mut client).await {
        Ok(Some(steps)) => steps.into_iter().find(|s| s.id == id),
        Ok(None) => {
            list.failed(
                "setup",
                "this hub has no setup steps yet",
                "fleetd update, then fleetd init --step again",
            );
            return 1;
        }
        Err(failure) => {
            list.failed("setup", &failure.message, &failure.fix);
            return 4;
        }
    };
    let Some(step) = step else {
        list.failed(
            "setup",
            &format!("this hub has no step {}", id.as_str()),
            "fleetd init",
        );
        return 1;
    };
    match walk(&opts, &ui, &mut list, &mut client, &step).await {
        Ok(SetupStatus::Done) => {
            list.outro(&[], "Next: fleetd init lists what's left; the app's Settings › Hub › Setup has the same steps.");
            0
        }
        Ok(_) => {
            list.outro(
                &[],
                &format!(
                    "Run fleetd init --step {} again when you've done it; it keeps what's done.",
                    id.as_str()
                ),
            );
            u8::from(step.need == SetupNeed::Required)
        }
        Err(Stopped) => {
            list.stop_spinner();
            eprintln!("{}{AGAIN}", if list.rich { "   " } else { "" });
            130
        }
    }
}

fn finish(list: &mut Checklist, summary: &Summary, paired: bool) {
    let needs = list.needs_you();
    if list.failures().next().is_some() {
        list.outro(
            &needs,
            "Fix those, then run fleetd init again; it keeps what's done.",
        );
        return;
    }
    if !list.todos.is_empty() {
        list.outro(&needs, "Then run fleetd init again; it keeps what's done.");
        return;
    }
    let mut lines = Vec::new();
    if let Some(hub) = &summary.hub {
        lines.push(format!("hub       {hub}"));
    }
    if !summary.workers.is_empty() {
        lines.push(format!("workers   {}", summary.workers.join(", ")));
    }
    if let Some(project) = &summary.project {
        lines.push(format!("project   {project}"));
    }
    if let Some(pairing) = &summary.pairing {
        lines.push(format!("app       {pairing}"));
    }
    if which("fleetd").is_none() {
        lines.push("PATH      add: export PATH=\"$HOME/.local/bin:$PATH\"".into());
    }
    if list.rich {
        list.boxed("fleetd is ready", &lines.join("\n"));
    } else {
        eprintln!("\nfleetd is ready");
        for line in &lines {
            eprintln!("  {line}");
        }
    }
    let (installed, _) = app_hint();
    let next = match (installed, paired) {
        (true, true) => {
            "Next: open the fleetd app; it connects by itself, then send your first order."
                .to_owned()
        }
        (true, false) => "Next: run fleetd pair, then open the fleetd app.".to_owned(),
        (false, _) => {
            "Next: get the fleetd app (curl -fsSL https://fleetd.sh | sh) and enter the code."
                .to_owned()
        }
    };
    list.outro(&[], &next);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_updates_the_way_it_was_installed() {
        let native = "/Users/ada/.local/share/claude/versions/2.1.296";
        assert_eq!(
            update_command_for(native),
            "curl -fsSL https://claude.ai/install.sh | bash"
        );
        assert_eq!(
            update_command_for("/opt/homebrew/Caskroom/claude-code/2.1.296/claude"),
            "brew upgrade claude-code"
        );
        assert_eq!(
            update_command_for("/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"),
            "npm install -g @anthropic-ai/claude-code@latest"
        );
        assert_eq!(update_command_for("/usr/local/bin/claude"), "claude update");
    }

    /// --yes, no terminal, a scripted --join: a logged-out claude or gh is reported, never logged in interactively.
    #[test]
    fn logins_are_offered_only_to_a_person_at_the_terminal() {
        let mut list = Checklist::plain();
        let unattended = Ui { interactive: false };
        assert!(matches!(
            unattended.offer_to_run(&mut list, "claude isn't logged in. Log in now?"),
            Ok(false)
        ));
        // Nor is a claude update.
        assert!(matches!(
            unattended.offer_to_run(&mut list, "Update claude now? (claude update)"),
            Ok(false)
        ));
        // Other prompts still take their defaults unattended.
        assert!(matches!(
            unattended.confirm(&mut list, "Pair the fleetd app?", true),
            Ok(true)
        ));
    }
}
