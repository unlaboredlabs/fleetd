//! `fleetd init` in a terminal (or with --yes): the hub, how it is reached, the claude and gh logins, the machines
//! that run agents, a first project, the desktop app's pairing and the doctor, as a live checklist. Run again, it
//! finds what exists, keeps what works and repairs the rest; it never deletes data or makes a second key or unit.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use dialoguer::theme::ColorfulTheme;
use dialoguer::{Confirm, Input, MultiSelect, Select};
use fleetd_contracts::auth::KeyKind;
use fleetd_contracts::ids::MachineId;
use serde_json::{Value, json};

use super::checklist::Checklist;
use super::detect::{self, Tailnet};
use super::machine::{self, Added, local_host_name, machine_id_from_host};
use super::machine_plan::{DEFAULT_T3_PORT, machine_layout};
use super::ssh::{run_attached, run_local, run_ssh};
use super::state::{GitIdentity, MachineRecord, is_noreply, parse_git_identity, read_setup};
use super::units::q;
use super::{HubPlan, InitOptions, Probe, install_hub, probe_listen, say};
use crate::cli::hub_key::open_hub;
use crate::hub::doctor::checks::{self, CmdOutcome, DoctorStatus};

use crate::cli::pair;

const PORT: u16 = 4790;

/// The user pressed Esc or Ctrl-C at a prompt.
struct Stopped;

struct Ui {
    interactive: bool,
    theme: ColorfulTheme,
}

impl Ui {
    fn confirm(&self, prompt: &str, default: bool) -> Result<bool, Stopped> {
        if !self.interactive {
            return Ok(default);
        }
        Confirm::with_theme(&self.theme)
            .with_prompt(prompt)
            .default(default)
            .interact_opt()
            .ok()
            .flatten()
            .ok_or(Stopped)
    }

    fn input(&self, prompt: &str, default: &str) -> Result<String, Stopped> {
        if !self.interactive {
            return Ok(default.to_owned());
        }
        let mut input = Input::<String>::with_theme(&self.theme).with_prompt(prompt);
        if !default.is_empty() {
            input = input.default(default.to_owned());
        }
        input.interact_text().map_err(|_| Stopped)
    }

    fn select(&self, prompt: &str, items: &[String], default: usize) -> Result<usize, Stopped> {
        if !self.interactive {
            return Ok(default);
        }
        Select::with_theme(&self.theme)
            .with_prompt(prompt)
            .items(items)
            .default(default)
            .interact_opt()
            .ok()
            .flatten()
            .ok_or(Stopped)
    }

    fn multi(
        &self,
        prompt: &str,
        items: &[String],
        picked: &[bool],
    ) -> Result<Vec<usize>, Stopped> {
        if !self.interactive {
            return Ok((0..items.len()).filter(|i| picked[*i]).collect());
        }
        MultiSelect::with_theme(&self.theme)
            .with_prompt(prompt)
            .items(items)
            .defaults(picked)
            .interact_opt()
            .ok()
            .flatten()
            .ok_or(Stopped)
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

/// Runs a command with only the environment the hub service has, as the doctor does, so a check sees what the hub
/// will see.
async fn hub_env_run(program: &str, args: &[&str]) -> CmdOutcome {
    let output = tokio::process::Command::new(program)
        .args(args)
        .env_clear()
        .envs(crate::hub::doctor::service::router_env())
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

/// A login flow with this terminal attached.
fn attached(program: &str, args: &[&str]) -> bool {
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

pub async fn run(opts: InitOptions, interactive: bool) -> u8 {
    let ui = Ui {
        interactive,
        theme: ColorfulTheme::default(),
    };
    match steps(&opts, &ui).await {
        Ok(code) => code,
        Err(Stopped) => {
            say(
                "stopped. Run fleetd init again to pick up where you left off; it keeps what is done.",
            );
            130
        }
    }
}

async fn steps(opts: &InitOptions, ui: &Ui) -> Result<u8, Stopped> {
    let mut list = Checklist::new();
    let previous = opts.previous.as_ref();
    say(if previous.is_some() {
        "fleetd init: checking your setup. It keeps what works and repairs the rest."
    } else {
        "fleetd init: sets up fleetd on this machine, step by step. Enter takes the default."
    });

    if previous.is_none()
        && !ui.confirm(
            "Is this machine the hub (the always-on machine that runs your fleet)?",
            true,
        )?
    {
        return Ok(worker_only(&mut list).await);
    }

    // Reachability.
    let net = tailnet().await;
    let lan = detect::lan_ipv4();
    let (listen, url) = reachability(opts, ui, &mut list, net.as_ref(), lan.as_deref()).await?;

    // Logins on the hub.
    login_check(ui, &mut list, Tool::Claude).await?;
    let gh_ok = login_check(ui, &mut list, Tool::Gh).await?;
    let identity = commit_identity(opts, ui, &mut list, gh_ok).await?;

    // The hub.
    list.start("hub");
    let plan = HubPlan {
        home: &opts.home,
        listen: listen.clone(),
        url: url.clone(),
        suffix: opts.suffix.clone(),
        identity,
        with_service: opts.with_service,
    };
    let indent = |line: &str| say(&format!("    {}", line.trim_start()));
    let hub_up = match install_hub(&plan, &indent).await {
        Ok(how) => {
            let running = !how.starts_with("not started");
            let how = format!("{how} (home {})", tilde(&opts.home));
            if running {
                list.done("hub", &how);
            } else {
                list.skipped("hub", &how);
            }
            running
        }
        Err(failure) => {
            list.failed("hub", &failure.message, &failure.fix);
            false
        }
    };

    if hub_up {
        let local = workers(opts, ui, &mut list, net.as_ref()).await?;
        first_project(opts, ui, &mut list, local.as_ref(), gh_ok).await?;
    } else {
        list.skipped(
            "workers, first project and doctor",
            "they need the hub running",
        );
    }
    let paired = app(opts, ui, &mut list)?;
    if hub_up {
        doctor(opts, ui, &mut list).await?;
    }
    finish(&list, paired);
    Ok(u8::from(list.failures().next().is_some()))
}

/// Not the hub: workers are set up from the hub over SSH, so check what that needs here and say what to run there.
async fn worker_only(list: &mut Checklist) -> u8 {
    let net = tailnet().await;
    let host = net
        .as_ref()
        .and_then(|n| n.dns_name.clone())
        .unwrap_or_else(local_host_name);
    let user = std::env::var("USER").unwrap_or_else(|_| "you".into());
    let ssh = tokio::time::timeout(
        Duration::from_secs(2),
        tokio::net::TcpStream::connect("127.0.0.1:22"),
    )
    .await
    .is_ok_and(|c| c.is_ok());
    if ssh {
        list.done("ssh", "this machine accepts SSH");
    } else {
        list.failed(
            "ssh",
            "no SSH server answers on this machine; the hub sets workers up over SSH",
            if cfg!(target_os = "macos") {
                "sudo systemsetup -setremotelogin on"
            } else {
                "sudo apt install openssh-server"
            },
        );
    }
    let node = run_local("node", &["--version".into()], None).await;
    let major: u32 = node
        .stdout
        .trim()
        .strip_prefix('v')
        .and_then(|v| v.split('.').next())
        .and_then(|m| m.parse().ok())
        .unwrap_or(0);
    if major >= 24 {
        list.done("node", node.stdout.trim());
    } else {
        list.failed("node", "T3 needs Node 24 or newer here", &install("node"));
    }
    if which("claude").is_some() {
        list.done("claude", "installed");
    } else {
        list.failed(
            "claude",
            "agents here run through Claude Code",
            &install("claude"),
        );
    }
    say(&format!(
        "\nNext, on your hub machine, run:\n  fleetd machine add {user}@{host}\nIt sets this machine up over SSH and shows every command first."
    ));
    u8::from(list.failures().next().is_some())
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
        list.done(
            "reachability",
            &format!("the hub listens on {listen}, reached at {url}"),
        );
        return Ok((listen.clone(), url));
    }
    if let Some(previous) = &opts.previous {
        let url = opts.url.clone().unwrap_or_else(|| previous.url.clone());
        list.done(
            "reachability",
            &format!(
                "kept: the hub listens on {}, reached at {url}",
                previous.listen
            ),
        );
        return Ok((previous.listen.clone(), url));
    }
    // (address to listen on, host in the URL, why), each on the first free port from 4790.
    let mut hosts: Vec<(String, String, &str)> = Vec::new();
    if let Some(ip) = net.and_then(|n| n.ipv4.as_deref()) {
        let name = net.and_then(|n| n.dns_name.as_deref()).unwrap_or(ip);
        hosts.push((
            ip.into(),
            name.into(),
            "your tailnet: the app and your other machines reach it, nothing public",
        ));
    }
    hosts.push((
        "127.0.0.1".into(),
        "127.0.0.1".into(),
        "this machine only: workers on other machines can't reach it",
    ));
    if let Some(ip) = lan {
        hosts.push((
            ip.into(),
            ip.into(),
            "your LAN: anyone on this network can reach it (plain HTTP)",
        ));
    }
    let mut choices: Vec<(String, String, String)> = Vec::new();
    for (ip, name, why) in hosts {
        let mut port = PORT;
        while port < PORT + 10 && probe_listen(&(ip.clone(), port)).await != Probe::Free {
            port += 1;
        }
        choices.push((
            format!("{ip}:{port}"),
            format!("http://{name}:{port}"),
            why.into(),
        ));
    }
    let labels: Vec<String> = choices
        .iter()
        .map(|(_, url, why)| format!("{url}  {why}"))
        .collect();
    let picked = ui.select("Where should the hub listen?", &labels, 0)?;
    let (listen, url, _) = choices.swap_remove(picked);
    let url = opts.url.clone().unwrap_or(url);
    let later = match (listen.starts_with("127."), lan) {
        (true, Some(ip)) => format!(
            ". To open it to your LAN later: fleetd init --listen {ip}:{PORT} --url http://{ip}:{PORT}"
        ),
        (true, None) => ". To reach it from other machines later, install Tailscale and run fleetd init --listen <tailnet ip>:4790".into(),
        _ => String::new(),
    };
    list.done(
        "reachability",
        &format!("the hub will answer at {url}{later}"),
    );
    Ok((listen, url))
}

#[derive(Clone, Copy)]
enum Tool {
    Claude,
    Gh,
}

/// Installed and logged in, as the hub service will run it; offers the login right here when it isn't.
async fn login_check(ui: &Ui, list: &mut Checklist, tool: Tool) -> Result<bool, Stopped> {
    let (name, login): (&str, &[&str]) = match tool {
        Tool::Claude => ("claude", &["auth", "login"]),
        Tool::Gh => ("gh", &["auth", "login"]),
    };
    let fix = format!("{name} {}", login.join(" "));
    if which(name).is_none() {
        let why = match tool {
            Tool::Claude => {
                "Claude Code is not installed; fleetd's agents and its router run through it"
            }
            Tool::Gh => "the GitHub CLI is not installed; the merge train and PR checks need it",
        };
        list.failed(name, why, &format!("{}, then {fix}", install(name)));
        return Ok(false);
    }
    let mut offered = false;
    loop {
        let entry = match tool {
            Tool::Claude => {
                checks::claude_login(&hub_env_run("claude", &["auth", "status", "--json"]).await)
            }
            Tool::Gh => checks::gh_auth(&hub_env_run("gh", &["auth", "status"]).await),
        };
        if entry.check.status == DoctorStatus::Ok {
            let message = entry.check.message.replace(" on the hub", "");
            let message = message
                .split(';')
                .next()
                .unwrap_or("")
                .trim_end_matches('.');
            list.done(name, message);
            return Ok(true);
        }
        let message = match tool {
            Tool::Claude => "not logged in; the hub's router and every agent need it",
            Tool::Gh => "not logged in; the merge train and PR checks need it",
        };
        if offered
            || !ui.interactive
            || !ui.confirm(&format!("{name} is {message}. Log it in now?"), true)?
        {
            list.failed(name, message, &fix);
            return Ok(false);
        }
        offered = true;
        attached(name, login);
    }
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
    let identity = match known {
        Some(identity) => Some(identity),
        None => {
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
            loop {
                let text = ui.input(
                    "Commit author for your agents' commits (Name <email>)",
                    &default,
                )?;
                match parse_git_identity(&text) {
                    Some(identity) => break Some(identity),
                    None if ui.interactive => {
                        say("  that should look like: Name <id+user@users.noreply.github.com>")
                    }
                    None => break None,
                }
            }
        }
    };
    match &identity {
        Some(id) if is_noreply(id) => {
            list.done("commit author", &format!("{} <{}>", id.name, id.email))
        }
        Some(id) => list.warn(
            "commit author",
            &format!(
                "{} <{}> is not a GitHub noreply address, so public repos will show it",
                id.name, id.email
            ),
            Some("fleetd init --git-identity \"Name <id+user@users.noreply.github.com>\""),
        ),
        None => list.failed(
            "commit author",
            "none set; machines need one for their agents' commits",
            "fleetd init --git-identity \"Name <id+user@users.noreply.github.com>\"",
        ),
    }
    Ok(identity)
}

struct Candidate {
    id: String,
    label: String,
    argv: Vec<String>,
    picked: bool,
}

/// Picks the machines that run agents and runs `machine add` on each. Returns this machine's record when it is one.
async fn workers(
    opts: &InitOptions,
    ui: &Ui,
    list: &mut Checklist,
    net: Option<&Tailnet>,
) -> Result<Option<MachineRecord>, Stopped> {
    let state = read_setup(&opts.home).ok().flatten();
    let recorded = state.map(|s| s.machines).unwrap_or_default();
    let me = machine_id_from_host(&local_host_name());
    let mut candidates = Vec::new();
    let local_id = recorded
        .iter()
        .find(|(_, r)| r.local)
        .map_or(me.clone(), |(id, _)| id.clone());
    candidates.push(Candidate {
        label: format!("{local_id} (this machine)"),
        argv: vec!["--local".into(), "--machine-id".into(), local_id.clone()],
        id: local_id.clone(),
        picked: recorded.is_empty() || recorded.contains_key(&local_id),
    });
    for (id, record) in recorded.iter().filter(|(_, r)| !r.local) {
        let mut argv = vec![record.ssh_host.clone(), "--machine-id".into(), id.clone()];
        if let Some(config) = &record.ssh_config {
            argv.extend(["--ssh-config".into(), config.clone()]);
        }
        candidates.push(Candidate {
            id: id.clone(),
            label: format!("{id} (set up from here; {})", record.ssh_host),
            argv,
            picked: true,
        });
    }
    let ssh_config = home_dir().join(".ssh/config");
    let hosts = std::fs::read_to_string(&ssh_config)
        .map(|text| detect::parse_ssh_hosts(&text))
        .unwrap_or_default();
    for host in hosts {
        let id = machine_id_from_host(&host);
        if MachineId::new(id.clone()).is_ok() && !candidates.iter().any(|c| c.id == id) {
            candidates.push(Candidate {
                label: format!("{id} (~/.ssh/config: {host})"),
                argv: vec![host, "--machine-id".into(), id.clone()],
                id,
                picked: false,
            });
        }
    }
    for peer in net.map(|n| n.peers.as_slice()).unwrap_or_default() {
        let id = machine_id_from_host(&peer.name);
        if MachineId::new(id.clone()).is_ok() && !candidates.iter().any(|c| c.id == id) {
            candidates.push(Candidate {
                label: format!("{id} (on your tailnet: {})", peer.dns_name),
                argv: vec![peer.dns_name.clone(), "--machine-id".into(), id.clone()],
                id,
                picked: false,
            });
        }
    }
    let labels: Vec<String> = candidates.iter().map(|c| c.label.clone()).collect();
    let picked = candidates.iter().map(|c| c.picked).collect::<Vec<_>>();
    let chosen = ui.multi(
        "Which machines should run agents? (space toggles, enter accepts)",
        &labels,
        &picked,
    )?;
    if chosen.is_empty() {
        list.skipped(
            "workers",
            "none picked; add one later with fleetd machine add <ssh-host>",
        );
        return Ok(None);
    }
    let home = opts.home.to_string_lossy().into_owned();
    for index in chosen {
        let candidate = &candidates[index];
        let title = format!("worker {}", candidate.id);
        list.start(&title);
        let mut argv = candidate.argv.clone();
        argv.extend(["--home".into(), home.clone()]);
        let again = if candidate.argv[0] == "--local" {
            "fleetd machine add --local".to_owned()
        } else {
            format!("fleetd machine add {}", candidate.argv[0])
        };
        match machine::add(&argv).await {
            Ok(Some(added)) => {
                list.done(&title, "online");
                worker_claude(ui, list, &added).await?;
            }
            Ok(None) => {}
            Err(_) => list.failed(
                &title,
                "machine add stopped (see above)",
                &format!("fix the cause it names, then run {again}"),
            ),
        }
    }
    Ok(read_setup(&opts.home)
        .ok()
        .flatten()
        .and_then(|s| s.machines.into_values().find(|r| r.local)))
}

/// The fleetd Claude instance on a worker has a login of its own (its own config dir, or a token in t3.env).
async fn worker_claude(ui: &Ui, list: &mut Checklist, added: &Added) -> Result<(), Stopped> {
    let title = format!("claude on {}", added.machine_id);
    let Some(claude) = &added.claude else {
        list.failed(
            &title,
            "Claude Code is not installed there",
            &install("claude"),
        );
        return Ok(());
    };
    let login = format!(
        "CLAUDE_CONFIG_DIR={} {} auth login",
        q(&added.claude_dir),
        q(claude)
    );
    let fix = if added.target.local {
        login.clone()
    } else {
        format!("ssh -t {} {}", added.target.host, q(&login))
    };
    let status = format!(
        "[ -s {env} ] && echo '{{\"loggedIn\":true,\"authMethod\":\"token in t3.env\"}}' || CLAUDE_CONFIG_DIR={dir} {claude} auth status --json",
        env = q(&added.env_file),
        dir = q(&added.claude_dir),
        claude = q(claude)
    );
    let mut offered = false;
    loop {
        let out = run_ssh(&added.target, &status, None).await;
        let entry = checks::claude_login(&CmdOutcome::Ran {
            exit_code: out.code,
            stdout: out.stdout,
            stderr: out.stderr,
        });
        if entry.check.status == DoctorStatus::Ok {
            list.done(&title, "fleetd's Claude is logged in");
            return Ok(());
        }
        let why = "fleetd's Claude there is not logged in (it keeps a login of its own)";
        if offered || !ui.interactive || !ui.confirm(&format!("{why}. Log it in now?"), true)? {
            list.failed(&title, why, &fix);
            return Ok(());
        }
        offered = true;
        run_attached(&added.target, &login);
    }
}

async fn first_project(
    opts: &InitOptions,
    ui: &Ui,
    list: &mut Checklist,
    local: Option<&MachineRecord>,
    gh_ok: bool,
) -> Result<(), Stopped> {
    let title = "first project";
    let existing = open_hub(&opts.home)
        .ok()
        .and_then(|hub| hub.store.projects_list(None, None).ok())
        .unwrap_or_default();
    if let Some(project) = existing.first() {
        list.done(
            "projects",
            &format!(
                "{} on the hub, e.g. {} on {}",
                existing.len(),
                project.title,
                project.machine_id.as_str()
            ),
        );
        return Ok(());
    }
    let Some(local) = local else {
        list.skipped(title, "this machine runs no agents, so no project here yet");
        return Ok(());
    };
    let Some(machine_id) = read_setup(&opts.home).ok().flatten().and_then(|s| {
        s.machines
            .into_iter()
            .find(|(_, r)| r.local)
            .map(|(id, _)| id)
    }) else {
        return Ok(());
    };
    let roots: Vec<PathBuf> = detect::REPO_ROOTS
        .iter()
        .map(|r| home_dir().join(r))
        .collect();
    let repos = detect::find_repos(&roots);
    let mut labels: Vec<String> = repos
        .iter()
        .take(30)
        .map(|r| match &r.remote {
            Some(remote) => format!("{}  {}", tilde(&r.path), detect::short_remote(remote)),
            None => tilde(&r.path),
        })
        .collect();
    let shown = labels.len();
    labels.push("clone one from GitHub (paste its URL)".into());
    labels.push("not now".into());
    if !ui.interactive {
        list.skipped(
            title,
            "--yes does not pick one; run fleetd init in a terminal to pick a repo",
        );
        return Ok(());
    }
    let picked = ui.select("Which repo should be your first project?", &labels, 0)?;
    let path = if picked < shown {
        repos[picked].path.clone()
    } else if picked == shown {
        let text = ui.input("GitHub repo (URL or owner/repo)", "")?;
        let Some((owner, repo)) = detect::parse_github_repo(&text) else {
            list.failed(
                title,
                &format!("'{text}' is not a GitHub repo"),
                "run fleetd init again and paste https://github.com/<owner>/<repo>",
            );
            return Ok(());
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
                attached("gh", &["repo", "clone", &full, &dest_text])
            } else {
                attached(
                    "git",
                    &["clone", &format!("https://github.com/{full}"), &dest_text],
                )
            };
            if !cloned {
                list.failed(
                    title,
                    &format!("cloning {full} failed (see above)"),
                    &format!(
                        "gh repo clone {full} {}, then run fleetd init again",
                        tilde(&dest)
                    ),
                );
                return Ok(());
            }
        }
        dest
    } else {
        list.skipped(title, "none picked; run fleetd init again to add one");
        return Ok(());
    };
    list.start(title);
    match register_project(&opts.home, local, &machine_id, &path).await {
        Ok(()) => list.done(title, &format!("{} on {machine_id}", tilde(&path))),
        Err(failure) => list.failed(title, &failure.message, &failure.fix),
    }
    Ok(())
}

/// A project is a T3 project on a worker; the hub learns it from that machine's node. So: create it in this
/// machine's fleetd T3, then wait until the hub lists it.
async fn register_project(
    hub_home: &Path,
    record: &MachineRecord,
    machine_id: &str,
    path: &Path,
) -> Result<(), super::Failure> {
    let failure = |message: String| super::Failure {
        message,
        fix: "fleetd machine add --local, then run fleetd init again".into(),
    };
    let layout = machine_layout(&record.home);
    let issue = format!(
        "T3CODE_HOME={home} node {bin} auth session issue --base-dir {home} --ttl 5m --label fleetd-init --token-only",
        home = q(&layout.t3_home),
        bin = q(&layout.t3_bin)
    );
    let out = run_local("/bin/sh", &["-c".into(), issue], None).await;
    let bearer = out
        .stdout
        .trim()
        .lines()
        .last()
        .unwrap_or("")
        .trim()
        .to_owned();
    if out.code != 0 || bearer.is_empty() {
        return Err(failure(format!(
            "could not get a session from this machine's T3: {}",
            out.stderr.trim()
        )));
    }
    let port = if record.t3_port == 0 {
        DEFAULT_T3_PORT
    } else {
        record.t3_port
    };
    let base = format!("http://127.0.0.1:{port}");
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| failure(e.to_string()))?;
    let root = path.to_string_lossy().into_owned();
    let have: Value = http
        .get(format!("{base}/api/projects"))
        .bearer_auth(&bearer)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|e| failure(format!("this machine's T3 at {base} did not answer: {e}")))?
        .json()
        .await
        .unwrap_or_default();
    let exists = have
        .get("projects")
        .and_then(Value::as_array)
        .is_some_and(|ps| {
            ps.iter()
                .any(|p| p.get("workspaceRoot").and_then(Value::as_str) == Some(root.as_str()))
        });
    if !exists {
        let title = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| root.clone());
        http.post(format!("{base}/api/projects/mutate"))
            .bearer_auth(&bearer)
            .json(&json!({
                "type": "project.create",
                "commandId": crate::hub::executor::new_uuid(),
                "projectId": crate::hub::executor::new_uuid(),
                "title": title,
                "workspaceRoot": root,
            }))
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|e| failure(format!("T3 refused the project: {e}")))?;
    }
    let machine = MachineId::new(machine_id.to_owned())
        .map_err(|_| failure(format!("bad machine id {machine_id}")))?;
    let hub = open_hub(hub_home).map_err(failure)?;
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let listed = hub
            .store
            .projects_list(Some(&machine), None)
            .unwrap_or_default()
            .iter()
            .any(|p| p.workspace_root == root);
        if listed {
            return Ok(());
        }
        if Instant::now() > deadline {
            return Err(super::Failure {
                message: "T3 has the project but the hub has not listed it within 60 s".into(),
                fix: format!("fleetd doctor shows whether {machine_id}'s node is connected"),
            });
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

/// How to open the desktop app here, or how to install it.
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
    let bin = data.join("fleetd/app/fleetd-app");
    if bin.is_file() {
        (
            true,
            format!("open “fleetd” from your app menu, or run {}", tilde(&bin)),
        )
    } else {
        (
            false,
            "curl -fsSL https://fleetd.sh | sh -s -- --app".into(),
        )
    }
}

/// Pairs the desktop app: a one-time code the app on this machine picks up by itself. True when a device is or
/// can now be paired.
fn app(opts: &InitOptions, ui: &Ui, list: &mut Checklist) -> Result<bool, Stopped> {
    let title = "desktop app";
    let devices: Vec<String> = open_hub(&opts.home)
        .ok()
        .and_then(|hub| hub.auth.list().ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|k| k.kind == Some(KeyKind::Human) && k.revoked_at.is_none())
        .map(|k| k.name)
        .collect();
    let want = if devices.is_empty() {
        ui.confirm("Pair the desktop app with this hub now?", true)?
    } else {
        list.done(title, &format!("paired: {}", devices.join(", ")));
        ui.interactive && ui.confirm("Pair another device?", false)?
    };
    if !want {
        if devices.is_empty() {
            list.skipped(
                title,
                "not paired; fleetd pair prints a code whenever you want one",
            );
        }
        return Ok(!devices.is_empty());
    }
    let home = opts.home.to_string_lossy().into_owned();
    match pair::mint(Some(&home), None) {
        Ok(minted) => {
            let hub = minted.urls.first().cloned().unwrap_or_default();
            list.done(
                "pairing code",
                &format!(
                    "{} for {hub} (one use, until {})",
                    minted.code, minted.expires_at
                ),
            );
            say(&format!(
                "    The app on this machine pairs by itself ({}).\n    On another computer: open the app, enter {hub} and the code, or open {}",
                tilde(&minted.app_pair_file),
                minted.deep_link
            ));
            Ok(true)
        }
        Err(message) => {
            list.failed("pairing code", &message, "fleetd pair");
            Ok(!devices.is_empty())
        }
    }
}

async fn doctor(opts: &InitOptions, ui: &Ui, list: &mut Checklist) -> Result<(), Stopped> {
    list.start("doctor");
    let mut checks = match super::doctor::run(&opts.home, false).await {
        Ok(checks) => checks,
        Err(failure) => {
            list.failed("doctor", &failure.message, &failure.fix);
            return Ok(());
        }
    };
    let autos = checks
        .iter()
        .filter(|c| {
            c.status != DoctorStatus::Ok && c.fix.as_ref().is_some_and(|f| f.kind == "auto")
        })
        .count();
    if autos > 0
        && ui.confirm(
            &format!("The doctor can fix {autos} problem(s) by itself. Fix now?"),
            true,
        )?
    {
        match super::doctor::run(&opts.home, true).await {
            Ok(fixed) => checks = fixed,
            Err(failure) => {
                list.failed("doctor", &failure.message, &failure.fix);
                return Ok(());
            }
        }
    }
    // The wizard checked these two logins itself, with the same commands.
    let ok = super::doctor::show(list, &checks, &["hub/claude_login", "hub/gh_auth"]);
    list.done("doctor", &format!("{ok} of {} checks pass", checks.len()));
    Ok(())
}

fn finish(list: &Checklist, paired: bool) {
    let failures: Vec<_> = list.failures().collect();
    if !failures.is_empty() {
        say(&format!("\n{} step(s) need you:", failures.len()));
        for item in &failures {
            say(&format!("  {}", list.line(item)));
        }
        say("Then run fleetd init again; it keeps what is done.");
    } else {
        say("\nfleetd is set up.");
    }
    if !failures.is_empty() {
        return;
    }
    let (installed, open) = app_hint();
    let next = match (installed, paired) {
        (true, true) => format!(
            "Next: open the desktop app ({open}); it connects by itself. Then type your first order in it, e.g. \"fix the typo in the README\"."
        ),
        (true, false) => format!("Next: run fleetd pair, then open the desktop app ({open})."),
        (false, _) => format!(
            "Next: install the desktop app on the computer you work from ({open}), open it and enter the pairing code; then type your first order in it."
        ),
    };
    say(&next);
    if which("fleetd").is_none() {
        say(
            "fleetd is not on your PATH: add export PATH=\"$HOME/.local/bin:$PATH\" to your shell profile.",
        );
    }
}
