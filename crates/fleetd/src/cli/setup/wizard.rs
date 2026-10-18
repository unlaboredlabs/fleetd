//! `fleetd init` in a terminal (or with --yes): the hub, how it is reached, the claude and gh logins, the machines
//! that run agents, a first project, the desktop app's pairing and the doctor, as a live checklist. Run again, it
//! finds what exists, keeps what works and repairs the rest; it never deletes data or makes a second key or unit.

use std::path::{Path, PathBuf};

use dialoguer::theme::ColorfulTheme;
use dialoguer::{Confirm, Input, MultiSelect, Select};
use fleetd_contracts::auth::KeyKind;
use fleetd_contracts::ids::MachineId;

use super::checklist::Checklist;
use super::detect::{self, Tailnet};
use super::machine::{self, Added, local_host_name, machine_id_from_host};
use super::machine_plan::{login_command, login_status_command};
use super::ssh::{run_attached, run_local, run_ssh};
use super::state::{GitIdentity, is_noreply, parse_git_identity, read_setup};
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

    if opts.join.is_some()
        || previous.is_none()
            && !ui.confirm(
                "Is this machine the hub (the always-on machine that runs your fleet)?",
                true,
            )?
    {
        return join_hub(opts, ui, &mut list).await;
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
        first_project(opts, ui, &mut list, local.as_deref(), gh_ok).await?;
    } else {
        list.skipped(
            "workers, first project and doctor",
            "they need the hub running",
        );
    }
    let paired = app(opts, ui, &mut list)?;
    if hub_up {
        doctor(opts, &mut list).await;
    }
    finish(&list, paired);
    Ok(u8::from(list.failures().next().is_some()))
}

/// Not the hub: join one as a worker with the one-time code `fleetd pair --worker` printed there.
async fn join_hub(opts: &InitOptions, ui: &Ui, list: &mut Checklist) -> Result<u8, Stopped> {
    let (hub, code) = match &opts.join {
        Some(join) => join.clone(),
        None => {
            say(
                "On the hub, run `fleetd pair --worker <name for this machine>`; it prints the address and a code.",
            );
            (ui.input("Hub address", "")?, ui.input("One-time code", "")?)
        }
    };
    let machine_id = match &opts.machine_id {
        Some(id) => id.clone(),
        None if opts.join.is_some() => machine_id_from_host(&local_host_name()),
        None => ui.input(
            "This machine's name on the hub (as given to fleetd pair --worker)",
            &machine_id_from_host(&local_host_name()),
        )?,
    };
    if hub.trim().is_empty() || code.trim().is_empty() {
        list.failed(
            "join",
            "needs the hub's address and a one-time code",
            "on the hub, run fleetd pair --worker <name>, then run the command it prints here",
        );
        return Ok(1);
    }
    let title = format!("worker {machine_id}");
    list.start(&title);
    match machine::join(
        hub.trim(),
        code.trim(),
        Some(machine_id),
        opts.identity.clone(),
        &opts.suffix,
    )
    .await
    {
        Ok(added) => {
            list.done(&title, &format!("joined {} and runs its node", hub.trim()));
            worker_claude(ui, list, &added).await?;
        }
        Err(_) => list.failed(
            &title,
            "joining stopped (see above)",
            "fix the cause it names, then run the same fleetd init again",
        ),
    }
    let failed = list.failures().next().is_some();
    if failed {
        let items: Vec<String> = list.failures().map(|i| list.line(i)).collect();
        say(&format!(
            "\n{} step(s) need you:\n  {}",
            items.len(),
            items.join("\n  ")
        ));
    } else {
        say(
            "\nThis machine is a worker now. Its agents start from orders you send in the desktop app.",
        );
    }
    Ok(u8::from(failed))
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
                .trim_end_matches('.')
                .trim_start_matches(&format!("{name} is "));
            if let Tool::Claude = tool {
                let out = hub_env_run("claude", &["--version"]).await;
                let printed = match &out {
                    CmdOutcome::Ran { stdout, .. } => stdout.trim().to_owned(),
                    CmdOutcome::SpawnError(_) => String::new(),
                };
                let v = crate::node::runner::version::check(&printed);
                if !v.runs() {
                    list.failed(
                        name,
                        v.problem(&printed)
                            .unwrap_or_default()
                            .trim_end_matches('.'),
                        &v.fix().unwrap_or_default(),
                    );
                    return Ok(false);
                }
                let version = printed.split_whitespace().next().unwrap_or("");
                list.done(name, &format!("{version}, {message}"));
                return Ok(true);
            }
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
    /// The ssh host, or `None` for this machine.
    host: Option<String>,
    ssh_config: Option<String>,
    picked: bool,
}

/// Picks the machines that run agents and runs `machine add` on each. Returns this machine's id when it is one.
async fn workers(
    opts: &InitOptions,
    ui: &Ui,
    list: &mut Checklist,
    net: Option<&Tailnet>,
) -> Result<Option<String>, Stopped> {
    let state = read_setup(&opts.home).ok().flatten();
    let recorded = state.map(|s| s.machines).unwrap_or_default();
    let local_id = recorded.iter().find(|(_, r)| r.local).map_or_else(
        || machine_id_from_host(&local_host_name()),
        |(id, _)| id.clone(),
    );
    let mut candidates = vec![Candidate {
        label: format!("{local_id} (this machine)"),
        host: None,
        ssh_config: None,
        id: local_id.clone(),
        picked: recorded.is_empty() || recorded.contains_key(&local_id),
    }];
    for (id, record) in recorded.iter().filter(|(_, r)| !r.local) {
        candidates.push(Candidate {
            id: id.clone(),
            label: format!("{id} (set up from here; {})", record.ssh_host),
            host: Some(record.ssh_host.clone()),
            ssh_config: record.ssh_config.clone(),
            picked: true,
        });
    }
    let hosts = std::fs::read_to_string(home_dir().join(".ssh/config"))
        .map(|text| detect::parse_ssh_hosts(&text))
        .unwrap_or_default();
    let mut offer = |id: String, label: String, host: String| {
        if MachineId::new(id.clone()).is_ok() && !candidates.iter().any(|c| c.id == id) {
            candidates.push(Candidate {
                id,
                label,
                host: Some(host),
                ssh_config: None,
                picked: false,
            });
        }
    };
    for host in hosts {
        let id = machine_id_from_host(&host);
        offer(id.clone(), format!("{id} (~/.ssh/config: {host})"), host);
    }
    for peer in net.map(|n| n.peers.as_slice()).unwrap_or_default() {
        let id = machine_id_from_host(&peer.name);
        offer(
            id.clone(),
            format!("{id} (on your tailnet: {})", peer.dns_name),
            peer.dns_name.clone(),
        );
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
            "none picked; add one later with fleetd machine add <ssh-host>, or fleetd pair --worker <name> for a machine this one can't SSH to",
        );
        return Ok(None);
    }
    let home = opts.home.to_string_lossy().into_owned();
    let mut local = None;
    for index in chosen {
        let candidate = &candidates[index];
        let title = format!("worker {}", candidate.id);
        list.start(&title);
        let again = match &candidate.host {
            None => "fleetd machine add --local".to_owned(),
            Some(host) => format!("fleetd machine add {host}"),
        };
        let added = machine::add(machine::AddArgs {
            host: candidate.host.clone(),
            machine_id: Some(candidate.id.clone()),
            tags: Vec::new(),
            dry_run: false,
            hub_url: None,
            ssh_config: candidate.ssh_config.clone(),
            home: Some(home.clone()),
            unit_suffix: None,
            enroll: machine::Enroll::Hub,
            git_identity: None,
        })
        .await;
        match added {
            Ok(Some(added)) => {
                list.done(&title, "online");
                worker_claude(ui, list, &added).await?;
                if candidate.host.is_none() {
                    local = Some(added.machine_id);
                }
            }
            Ok(None) => {}
            Err(_) => list.failed(
                &title,
                "machine add stopped (see above)",
                &format!("fix the cause it names, then run {again}"),
            ),
        }
    }
    Ok(local)
}

/// fleetd's Claude on a worker keeps a login of its own (its own config dir, or a token in claude.env).
async fn worker_claude(ui: &Ui, list: &mut Checklist, added: &Added) -> Result<(), Stopped> {
    let title = format!("claude on {}", added.machine_id);
    let login = login_command(&added.layout, &added.claude);
    let fix = if added.target.local {
        login.clone()
    } else {
        format!("ssh -t {} {}", added.target.host, q(&login))
    };
    let mut logged_in = added.logged_in;
    let mut offered = false;
    loop {
        if logged_in {
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
        let out = run_ssh(
            &added.target,
            &login_status_command(&added.layout, &added.claude),
            None,
        )
        .await;
        logged_in = checks::claude_login(&CmdOutcome::Ran {
            exit_code: out.code,
            stdout: out.stdout,
            stderr: out.stderr,
        })
        .check
        .status
            == DoctorStatus::Ok;
    }
}

async fn first_project(
    opts: &InitOptions,
    ui: &Ui,
    list: &mut Checklist,
    local: Option<&str>,
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
    let Some(machine_id) = local else {
        list.skipped(title, "this machine runs no agents, so no project here yet");
        return Ok(());
    };
    if !ui.interactive {
        list.skipped(
            title,
            "--yes does not pick one; run fleetd init in a terminal to pick a repo",
        );
        return Ok(());
    }
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
    match super::doctor::add_project(&opts.home, machine_id, &path).await {
        Ok(()) => list.done(title, &format!("{} on {machine_id}", tilde(&path))),
        Err(failure) => list.failed(title, &failure.message, &failure.fix),
    }
    Ok(())
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

async fn doctor(opts: &InitOptions, list: &mut Checklist) {
    list.start("doctor");
    match super::doctor::run(&opts.home).await {
        Ok(checks) => {
            // The wizard checked these logins itself, with the same commands.
            let shown = ["hub/claude_login", "hub/gh_auth", "hub/claude_version"];
            let ok = super::doctor::show(list, &checks, &shown);
            list.done("doctor", &format!("{ok} of {} checks pass", checks.len()));
        }
        Err(failure) => list.failed("doctor", &failure.message, &failure.fix),
    }
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
