//! Every command `fleetd machine add` runs on a worker, derived from what a read-only probe found there, and the
//! commands `machine remove` undoes it with. A worker needs the fleetd binary, the `claude` CLI (installed by the
//! user; fleetd never installs it) and one service: the node, which runs claude itself.

use std::collections::HashMap;

use base64::Engine;
use serde_json::{Value, json};

use super::state::{GitIdentity, git_identity_env};
use super::units::{Dirs, Platform, Role, ServiceManager, ServiceSpec, q, render_unit, unit_path};
use crate::node::runner::claude::version::{self, VersionVerdict};

pub use crate::node::runner::claude::version::INSTALL as CLAUDE_INSTALL;

/// The node.json fields `machine add` sets; the rest (cmdRoots, …) are the user's or the node's and are kept.
const NODE_CONFIG_OWNED: [&str; 4] = ["hub", "machineId", "name", "claudeConfigDir"];

/// Where fleetd puts things on a machine, under the SSH user's home.
#[derive(Clone, Debug)]
pub struct MachineLayout {
    pub fleetd: String,
    pub node_home: String,
    pub node_config: String,
    /// Optional extra KEY=value lines the node adds to claude's environment; setup never creates it.
    pub env_file: String,
    pub logs: String,
    pub bin_dir: String,
    /// The fleetd binary: the node service runs it, and the installer puts the CLI at the same path.
    pub bin: String,
    /// Where older releases put the fleetd binary.
    pub legacy_share: Vec<String>,
}

pub fn machine_layout(home: &str) -> MachineLayout {
    let home = home.trim_end_matches('/');
    machine_layout_at(home, &format!("{home}/.fleetd"))
}

/// The layout with fleetd's own directory at `fleetd` (`FLEETD_HOME` on this machine) instead of `~/.fleetd`.
pub fn machine_layout_at(home: &str, fleetd: &str) -> MachineLayout {
    let home = home.trim_end_matches('/');
    let fleetd = fleetd.trim_end_matches('/').to_owned();
    let share = format!("{home}/.local/share/fleetd");
    MachineLayout {
        node_home: format!("{fleetd}/node"),
        node_config: format!("{fleetd}/node/node.json"),
        env_file: format!("{fleetd}/claude.env"),
        logs: format!("{fleetd}/logs"),
        bin_dir: format!("{fleetd}/bin"),
        bin: format!("{fleetd}/bin/fleetd"),
        legacy_share: ["bin", "cli"].map(|d| format!("{share}/{d}")).to_vec(),
        fleetd,
    }
}

/// What the read-only probe reports about the machine. Files are keyed by absolute path; `None` when absent.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Facts {
    pub home: String,
    /// fleetd's own directory there; empty means `<home>/.fleetd`.
    pub fleetd: String,
    pub config_home: String,
    pub user: String,
    pub uid: u32,
    /// `linux` or `darwin`.
    pub platform: String,
    /// `x64` or `arm64`.
    pub arch: String,
    pub path: String,
    /// `claude` on PATH or in its installer's usual places.
    pub claude: Option<String>,
    /// What `claude --version` printed.
    pub claude_version: Option<String>,
    pub linger: String,
    pub files: HashMap<String, Option<String>>,
    /// Size in bytes: for files whose content the probe must not read (the login).
    pub sizes: HashMap<String, Option<u64>>,
    /// sha256 of a file's content.
    pub digests: HashMap<String, Option<String>>,
}

impl Facts {
    pub fn layout(&self) -> MachineLayout {
        if self.fleetd.is_empty() {
            machine_layout(&self.home)
        } else {
            machine_layout_at(&self.home, &self.fleetd)
        }
    }

    fn file(&self, path: &str) -> Option<&str> {
        self.files.get(path).and_then(|f| f.as_deref())
    }
}

/// The probe: POSIX sh only, so a machine needs nothing but a shell to be read. One fact per line. `fleetd`: this
/// machine's relocated fleetd dir (`FLEETD_HOME`), for `--local` only; a machine over SSH keeps `~/.fleetd`.
pub fn probe_command(fleetd: Option<&str>) -> String {
    let l = machine_layout_at("$H", "$F");
    let dirs = Dirs {
        home: "$H",
        config_home: "$C",
    };
    let mut reads = vec![l.node_config.clone()];
    reads.push(unit_path(Platform::Linux, &dirs, Role::Node));
    reads.push(unit_path(Platform::Darwin, &dirs, Role::Node));
    let quoted = |paths: &[String]| {
        paths
            .iter()
            .map(|p| format!("\"{p}\""))
            .collect::<Vec<_>>()
            .join(" ")
    };
    [
        format!(
            r#"H=$HOME; C=${{XDG_CONFIG_HOME:-$HOME/.config}}; F={}"#,
            fleetd.map_or_else(|| "$H/.fleetd".to_owned(), q)
        ),
        r#"echo "home $H"; echo "fleetd $F"; echo "config $C"; echo "user $(id -un)"; echo "uid $(id -u)"; echo "os $(uname -s)"; echo "arch $(uname -m)"; echo "path $PATH""#.into(),
        r#"CL=$(command -v claude || true); for c in "$H/.local/bin/claude" "$H/.claude/local/claude" /opt/homebrew/bin/claude /usr/local/bin/claude; do [ -n "$CL" ] && break; [ -x "$c" ] && CL=$c; done"#.into(),
        r#"if [ -n "$CL" ]; then echo "claude $CL"; echo "claude_version $("$CL" --version 2>/dev/null | head -n 1)"; fi"#.into(),
        r#"L=unknown; if command -v loginctl >/dev/null 2>&1; then L=$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || true); fi; echo "linger ${L:-unknown}""#.into(),
        format!(r#"for f in {}; do if [ -f "$f" ]; then printf 'file %s ' "$f"; base64 < "$f" | tr -d '\n'; echo; fi; done"#, quoted(&reads)),
        format!(r#"for f in {}; do if [ -e "$f" ]; then echo "size $f $(wc -c < "$f" | tr -d ' ')"; fi; done"#, quoted(std::slice::from_ref(&l.env_file))),
        format!(r#"for f in {}; do if [ -f "$f" ]; then echo "digest $f $( (sha256sum "$f" 2>/dev/null || shasum -a 256 "$f") | cut -d ' ' -f 1)"; fi; done"#, quoted(std::slice::from_ref(&l.bin))),
    ]
    .join("\n")
}

/// The probe's output. Files it found are listed; every path it was asked about and didn't list is absent.
pub fn parse_facts(output: &str) -> Result<Facts, String> {
    let mut facts = Facts::default();
    for line in output.lines() {
        let (key, rest) = line.split_once(' ').unwrap_or((line, ""));
        match key {
            "home" => facts.home = rest.into(),
            "fleetd" => facts.fleetd = rest.into(),
            "config" => facts.config_home = rest.into(),
            "user" => facts.user = rest.into(),
            "uid" => facts.uid = rest.trim().parse().map_err(|_| format!("uid '{rest}'"))?,
            "os" => {
                facts.platform = match rest.trim() {
                    "Linux" => "linux".into(),
                    "Darwin" => "darwin".into(),
                    other => other.to_lowercase(),
                }
            }
            "arch" => {
                facts.arch = match rest.trim() {
                    "x86_64" | "amd64" => "x64".into(),
                    "aarch64" | "arm64" => "arm64".into(),
                    other => other.into(),
                }
            }
            "path" => facts.path = rest.into(),
            "claude" => facts.claude = Some(rest.into()).filter(|c: &String| !c.is_empty()),
            "claude_version" => {
                facts.claude_version = Some(rest.trim().into()).filter(|v: &String| !v.is_empty())
            }
            "linger" => facts.linger = rest.trim().into(),
            "file" => {
                let (path, data) = rest.split_once(' ').unwrap_or((rest, ""));
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(data.trim())
                    .map_err(|e| format!("{path}: {e}"))?;
                facts.files.insert(
                    path.into(),
                    Some(String::from_utf8_lossy(&bytes).into_owned()),
                );
            }
            "size" => {
                let (path, size) = rest.rsplit_once(' ').unwrap_or((rest, ""));
                facts.sizes.insert(path.into(), size.parse().ok());
            }
            "digest" => {
                let (path, digest) = rest.rsplit_once(' ').unwrap_or((rest, ""));
                facts.digests.insert(path.into(), Some(digest.into()));
            }
            _ => {}
        }
    }
    if facts.home.is_empty() || facts.platform.is_empty() {
        return Err("the probe printed no home or OS".into());
    }
    Ok(facts)
}

/// The OS and architecture of the running fleetd, as the probe names them.
pub fn local_target() -> (String, String) {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    (os.to_owned(), arch.to_owned())
}

#[derive(Clone)]
pub struct MachineAddInput {
    pub machine_id: String,
    pub hub_url: String,
    pub git_identity: Option<GitIdentity>,
    /// sha256 of the fleetd binary this hub copies to the machine: the one running now.
    pub binary_digest: String,
    /// The OS and CPU that binary is for: this fleetd's (`local_target()`), or the machine's when `machine add` fetched
    /// this version's release build for it.
    pub binary_target: (String, String),
    pub version: String,
    /// The hub already holds a node key for this machine id.
    pub hub_has_node_key: bool,
    /// Run the node as a user service; false (`--no-service`): nothing goes to systemd or launchd, and
    /// [`MachinePlan::run_by_hand`] says how to start it.
    pub service: bool,
    /// `--claude-config-dir`: the CLAUDE_CONFIG_DIR the node runs claude with (node.json `claudeConfigDir`); `None`
    /// keeps what the node has, which by default is the user's own (~/.claude).
    pub claude_config_dir: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Stdin {
    Text {
        label: String,
        text: String,
    },
    /// The running fleetd executable.
    Binary,
    EnrollToken,
}

impl Stdin {
    pub fn kind(&self) -> &'static str {
        match self {
            Stdin::Text { .. } => "text",
            Stdin::Binary => "binary",
            Stdin::EnrollToken => "enrollToken",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Step {
    pub title: String,
    /// POSIX shell, run on the machine as the SSH user.
    pub command: String,
    pub stdin: Option<Stdin>,
    /// The file this step writes with stdin as its content.
    pub writes: Option<String>,
}

fn step(title: impl Into<String>, command: impl Into<String>) -> Step {
    Step {
        title: title.into(),
        command: command.into(),
        stdin: None,
        writes: None,
    }
}

pub struct MachinePlan {
    pub platform: Platform,
    pub layout: MachineLayout,
    pub steps: Vec<Step>,
    /// Things the user should know or do by hand (linger, an untested claude).
    pub notes: Vec<String>,
    /// The node will (re)connect during this run, so `machine add` waits for it to come back.
    pub node_restarts: bool,
    /// Without a service: the command that runs the node, with the environment its unit would have set.
    pub run_by_hand: Option<String>,
}

fn dirname(path: &str) -> &str {
    path.rsplit_once('/')
        .map(|(dir, _)| if dir.is_empty() { "/" } else { dir })
        .unwrap_or(".")
}

fn basename(path: &str) -> &str {
    path.rsplit_once('/').map(|(_, base)| base).unwrap_or(path)
}

fn write_command(file: &str, mode: &str) -> String {
    let tmp = q(&format!("{file}.fleetd-tmp"));
    format!(
        "mkdir -p {} && cat > {tmp} && chmod {mode} {tmp} && mv {tmp} {}",
        q(dirname(file)),
        q(file)
    )
}

fn write_file(title: &str, file: &str, text: String, mode: &str) -> Step {
    Step {
        title: title.into(),
        command: write_command(file, mode),
        stdin: Some(Stdin::Text {
            label: basename(file).into(),
            text,
        }),
        writes: Some(file.into()),
    }
}

/// Every command `fleetd machine add` runs, in order, for a machine in the state `facts` describes. Steps whose
/// result is already in place are left out, so a re-run on a set-up machine only checks that the node runs.
pub fn plan_machine_add(facts: &Facts, input: &MachineAddInput) -> Result<MachinePlan, String> {
    let platform = match facts.platform.as_str() {
        "linux" => Platform::Linux,
        "darwin" => Platform::Darwin,
        other => {
            return Err(format!(
                "fleetd sets up Linux (systemd) and macOS (launchd) machines, not {other}"
            ));
        }
    };
    let (os, arch) = &input.binary_target;
    if facts.platform != *os || facts.arch != *arch {
        return Err(if facts.platform == "linux" && facts.arch == "arm64" {
            "the machine is linux-arm64, and fleetd has no Linux ARM build yet".to_owned()
        } else {
            format!(
                "the machine is {}-{} and this fleetd is a {os}-{arch} build: fleetd has builds for Linux on x64 and macOS on x64 and arm64 only",
                facts.platform, facts.arch
            )
        });
    }
    if facts.home.chars().any(char::is_whitespace) {
        return Err(format!(
            "the machine's home ({}) must not contain spaces",
            facts.home
        ));
    }
    let Some(claude) = &facts.claude else {
        return Err(format!(
            "claude is not installed on the machine; fleetd runs its agents through it. Fix: on the machine, run {CLAUDE_INSTALL}"
        ));
    };
    let printed = facts.claude_version.as_deref().unwrap_or("");
    let claude_verdict = version::check(printed);

    let l = facts.layout();
    let dirs = Dirs {
        home: &facts.home,
        config_home: &facts.config_home,
    };
    let unit_file = |role: Role| unit_path(platform, &dirs, role);
    let services = ServiceManager::new(platform, facts.uid, unit_file);
    let claude_bin_dir = dirname(claude).to_owned();
    let mut path_dirs = vec![l.bin_dir.clone(), claude_bin_dir.clone()];
    for dir in facts.path.split(':') {
        if !dir.is_empty() && !path_dirs.iter().any(|d| d == dir) {
            path_dirs.push(dir.to_owned());
        }
    }
    let mut env = vec![
        ("HOME".to_owned(), facts.home.clone()),
        ("PATH".into(), path_dirs.join(":")),
        ("LANG".into(), "C.UTF-8".into()),
    ];
    env.extend(git_identity_env(input.git_identity.as_ref()));
    let node_spec = ServiceSpec {
        role: Role::Node,
        description: "fleetd node".into(),
        program: vec![
            l.bin.clone(),
            "node".into(),
            "run".into(),
            "--home".into(),
            l.node_home.clone(),
        ],
        env,
        env_file: None,
        working_directory: facts.home.clone(),
        log_path: format!("{}/node.log", l.logs),
    };

    let mut steps = Vec::new();
    let mut notes = Vec::new();
    steps.push(step(
        "create fleetd's directories",
        format!(
            "mkdir -p {} && chmod 700 {}",
            [&l.node_home, &l.logs, &l.bin_dir].map(|d| q(d)).join(" "),
            q(&l.fleetd)
        ),
    ));

    let binary_changes =
        facts.digests.get(&l.bin).and_then(|d| d.as_deref()) != Some(input.binary_digest.as_str());
    if binary_changes {
        steps.push(Step {
            title: format!("install fleetd {}", input.version),
            command: format!(
                "{} && rm -rf {}",
                write_command(&l.bin, "755"),
                l.legacy_share
                    .iter()
                    .map(|d| q(d))
                    .collect::<Vec<_>>()
                    .join(" ")
            ),
            stdin: Some(Stdin::Binary),
            writes: None,
        });
    }

    let text = render_unit(platform, &node_spec);
    let existing_unit = facts.file(&unit_file(Role::Node));
    // A second fleet on this machine (its own fleetd dir) never takes over the first one's node service.
    if input.service
        && l.fleetd != machine_layout(&facts.home).fleetd
        && existing_unit.is_some_and(|unit| !unit.contains(&l.node_home))
    {
        return Err(format!(
            "the {} service on this machine runs another fleet's node. Fix: pass --no-service",
            unit_file(Role::Node).rsplit('/').next().unwrap_or_default()
        ));
    }
    let node_changed = input.service && existing_unit != Some(text.as_str());
    let node_existed = input.service && existing_unit.is_some();
    if node_changed {
        steps.push(write_file(
            "write the node service",
            &unit_file(Role::Node),
            text,
            "644",
        ));
    }

    let existing_node = facts
        .file(&l.node_config)
        .and_then(|text| serde_json::from_str::<serde_json::Map<String, Value>>(text).ok());
    let get = |key: &str| existing_node.as_ref().and_then(|o| o.get(key)).cloned();
    // The flag wins; without it the node keeps the config dir it has (by default none: the user's ~/.claude).
    let config_dir = input
        .claude_config_dir
        .clone()
        .map(Value::String)
        .or_else(|| get("claudeConfigDir"))
        .unwrap_or(Value::Null);
    let desired = json!({
        "hub": input.hub_url,
        "machineId": input.machine_id,
        "name": input.machine_id,
        "claudeConfigDir": config_dir,
    });
    let enrolled = get("enrolled") == Some(Value::Bool(true))
        && get("machineId") == Some(desired["machineId"].clone())
        && get("hub") == Some(desired["hub"].clone());
    let enrolls = !input.hub_has_node_key || !enrolled;
    let config_change = !enrolls
        && NODE_CONFIG_OWNED
            .iter()
            .any(|k| get(k).unwrap_or(Value::Null) != desired[*k]);
    if enrolls {
        let mut argv = vec![
            l.bin.clone(),
            "node".into(),
            "join".into(),
            "--hub".into(),
            input.hub_url.clone(),
            "--token-file".into(),
            "-".into(),
            "--machine".into(),
            input.machine_id.clone(),
        ];
        if let Some(dir) = desired["claudeConfigDir"].as_str() {
            argv.extend(["--claude-config-dir".to_owned(), dir.to_owned()]);
        }
        argv.extend([
            "--home".to_owned(),
            l.node_home.clone(),
            "--enroll-only".into(),
        ]);
        let stop_first = if node_existed {
            format!("{}; ", services.remove(Role::Node))
        } else {
            String::new()
        };
        steps.push(Step {
            title: "enroll the node with a one-time token (sent on stdin)".into(),
            command: format!(
                "{stop_first}{}",
                argv.iter().map(|a| q(a)).collect::<Vec<_>>().join(" ")
            ),
            stdin: Some(Stdin::EnrollToken),
            writes: None,
        });
    } else if config_change {
        // The owned keys replaced, every other key (cmdRoots, the node's own) kept.
        let mut config = existing_node.clone().unwrap_or_default();
        for key in NODE_CONFIG_OWNED {
            if !desired[key].is_null() {
                config.insert(key.to_owned(), desired[key].clone());
            }
        }
        steps.push(write_file(
            "update the node's settings",
            &l.node_config,
            format!("{:#}\n", Value::Object(config)),
            "600",
        ));
    }
    // A new binary is new node code: the running node keeps the old one until it restarts.
    let node_restarts =
        input.service && (enrolls || config_change || node_changed || binary_changes);
    let run_by_hand = (!input.service).then(|| {
        let env = node_spec
            .env
            .iter()
            .filter(|(k, _)| k.starts_with("GIT_"))
            .map(|(k, v)| format!("{k}={}", q(v)))
            .collect::<Vec<_>>()
            .join(" ");
        format!("{env} {} node run --home {}", q(&l.bin), q(&l.node_home))
            .trim_start()
            .to_owned()
    });
    if input.service {
        steps.push(if node_restarts {
            step(
                "(re)start the node",
                services.restart(Role::Node, node_changed && node_existed),
            )
        } else {
            step(
                "make sure the node runs",
                services.ensure_running(Role::Node),
            )
        });
    }

    if claude_verdict != VersionVerdict::Ok {
        notes.push(format!(
            "{} If sessions misbehave, run on the machine: {}",
            claude_verdict.problem(printed).unwrap_or_default(),
            claude_verdict.fix().unwrap_or_default()
        ));
    }
    if input.service && platform == Platform::Linux && facts.linger != "yes" {
        notes.push(format!(
            "linger is {} for {u}, so the node stops when {u} logs out. Fix: sudo loginctl enable-linger {u}",
            facts.linger,
            u = facts.user
        ));
    }
    if platform == Platform::Darwin {
        notes.push(format!(
            "launchd runs the node while {} is logged in; keep that user logged in on this Mac.",
            facts.user
        ));
    }
    if input.git_identity.is_none() {
        notes.push(r#"no commit identity on the hub. Fix: fleetd init --git-identity "Name <id+user@users.noreply.github.com>", then add this machine again."#.into());
    }
    Ok(MachinePlan {
        platform,
        layout: l,
        steps,
        notes,
        node_restarts,
        run_by_hand,
    })
}

/// Whether claude is logged in on the machine, asked as the node runs it: an environment built from scratch (HOME,
/// PATH, USER, LANG), then the optional claude.env, and the config dir the node was given (default: the user's own).
/// Nothing from the shell that runs setup leaks in. Prints `claude auth status --json`.
pub fn login_status_command(l: &MachineLayout, claude: &str, config_dir: Option<&str>) -> String {
    let dir = config_dir.map_or(String::new(), |d| format!("CLAUDE_CONFIG_DIR={} ", q(d)));
    let inner = format!(
        "set -a; [ -f {env} ] && . {env}; set +a; {dir}exec {claude} auth status --json",
        env = q(&l.env_file),
        claude = q(claude)
    );
    format!(
        "env -i HOME=\"$HOME\" PATH=\"$PATH\" USER=\"$USER\" LANG=C.UTF-8 /bin/sh -c {}",
        q(&inner)
    )
}

/// The login a person runs on the machine, in the config dir the node uses.
pub fn login_command(claude: &str, config_dir: Option<&str>) -> String {
    match config_dir {
        Some(dir) => format!("CLAUDE_CONFIG_DIR={} {} auth login", q(dir), q(claude)),
        None => format!("{} auth login", q(claude)),
    }
}

/// A machine fleetd has never touched: what `--dry-run` plans against, since it does not connect.
pub fn fresh_facts(user: &str, arch: &str) -> Facts {
    Facts {
        home: format!("/home/{user}"),
        config_home: format!("/home/{user}/.config"),
        user: user.into(),
        uid: 1000,
        platform: "linux".into(),
        arch: arch.into(),
        path: "/usr/local/bin:/usr/bin:/bin".into(),
        claude: Some(format!("/home/{user}/.local/bin/claude")),
        claude_version: Some(format!("{} (Claude Code)", version::TESTED)),
        linger: "yes".into(),
        ..Facts::default()
    }
}

/// What an older fleetd installed for T3 Code on a machine: its service and its files. Only `--purge` removes them,
/// and prints the line only where there is something to remove.
pub fn old_t3_removal(platform: Platform, home: &str, config_home: &str, uid: u32) -> Step {
    let home = home.trim_end_matches('/');
    let dirs = Dirs { home, config_home };
    let unit = unit_path(platform, &dirs, Role::T3);
    let services = ServiceManager::new(platform, uid, |role| unit_path(platform, &dirs, role));
    let files = [
        format!("{home}/.fleetd/t3"),
        format!("{home}/.fleetd/t3.env"),
        format!("{home}/.local/share/fleetd/npm"),
    ];
    let quoted = files.iter().map(|f| q(f)).collect::<Vec<_>>().join(" ");
    step(
        "remove T3 Code, if an older fleetd installed it",
        format!(
            "if [ -e {unit} ] || [ -e {first} ]; then echo 'older fleetd installed T3 Code; removing it'; {remove}; rm -rf {unit} {quoted}; fi",
            unit = q(&unit),
            first = q(&files[0]),
            remove = services.remove(Role::T3),
        ),
    )
}

/// Commands that undo `machine add`: the node's service (unless `own_service` is false: the unit there runs another
/// fleet's node); with `purge` also the node's key and settings, fleetd's Claude login and config, its logs, and,
/// for the default fleet only, what an older fleetd left. The fleetd binary stays: it may be the CLI the installer
/// put there.
#[allow(clippy::too_many_arguments)]
pub fn plan_machine_remove(
    platform: Platform,
    home: &str,
    fleetd: Option<&str>,
    config_home: &str,
    uid: u32,
    own_service: bool,
    purge: bool,
) -> Vec<Step> {
    let l = fleetd.map_or_else(|| machine_layout(home), |f| machine_layout_at(home, f));
    let dirs = Dirs { home, config_home };
    let unit_file = |role: Role| unit_path(platform, &dirs, role);
    let services = ServiceManager::new(platform, uid, unit_file);
    let mut steps = Vec::new();
    if own_service {
        steps.push(step(
            "stop and remove the node service",
            format!(
                "{}; rm -f {}",
                services.remove(Role::Node),
                q(&unit_file(Role::Node))
            ),
        ));
        // Its agents run on through a node's restart (node/runner/host.rs): a node that goes for good ends them.
        let hosts = format!("{}/hosts", l.node_home);
        steps.push(step(
            "stop the agents the node left running",
            format!(
                "if [ -d {hosts} ]; then {bin} session-host stop-all {hosts} || true; fi",
                hosts = q(&hosts),
                bin = q(&l.bin),
            ),
        ));
    }
    if purge {
        let mut paths = vec![&l.node_home, &l.env_file, &l.logs];
        paths.extend(l.legacy_share.iter());
        steps.push(step(
            "delete the node's key and settings, its claude.env and its logs",
            format!(
                "rm -rf {}",
                paths.iter().map(|p| q(p)).collect::<Vec<_>>().join(" ")
            ),
        ));
        if fleetd.is_none() {
            steps.push(old_t3_removal(platform, home, config_home, uid));
        }
    }
    if platform == Platform::Linux {
        steps.push(step(
            "forget the removed units",
            format!("XDG_RUNTIME_DIR=/run/user/{uid} systemctl --user daemon-reload"),
        ));
    }
    steps
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> MachineAddInput {
        MachineAddInput {
            machine_id: "mac-mini".into(),
            hub_url: "https://devbox.example.ts.net".into(),
            git_identity: Some(GitIdentity {
                name: "ada-lovelace".into(),
                email: "1+ada-lovelace@users.noreply.github.com".into(),
            }),
            binary_digest: "b".repeat(64),
            binary_target: ("linux".into(), "x64".into()),
            version: "0.0.0".into(),
            hub_has_node_key: false,
            service: true,
            claude_config_dir: None,
        }
    }

    fn summary(plan: &MachinePlan) -> Value {
        Value::Array(
            plan.steps
                .iter()
                .map(|s| {
                    let mut entry = json!({ "title": s.title, "command": s.command });
                    if let Some(stdin) = &s.stdin {
                        entry["stdin"] = json!(stdin.kind());
                    }
                    entry
                })
                .collect(),
        )
    }

    /// A second run on a set-up machine only makes sure the node runs.
    #[test]
    fn rerun_is_idempotent_and_keeps_the_users_node_settings() {
        let first = plan_machine_add(&fresh_facts("ada", "x64"), &input()).unwrap();
        let mut facts = fresh_facts("ada", "x64");
        let l = machine_layout(&facts.home);
        for s in &first.steps {
            if let (Some(file), Some(Stdin::Text { text, .. })) = (&s.writes, &s.stdin) {
                facts.files.insert(file.clone(), Some(text.clone()));
            }
        }
        let node = json!({ "hub": "https://devbox.example.ts.net", "machineId": "mac-mini", "name": "mac-mini",
            "tags": ["macos", "xcode"], "cmdRoots": ["/srv"], "enrolled": true });
        facts
            .files
            .insert(l.node_config.clone(), Some(node.to_string()));
        facts.sizes.insert(l.env_file.clone(), Some(0));
        facts.digests.insert(l.bin.clone(), Some("b".repeat(64)));
        let set_up = MachineAddInput {
            hub_has_node_key: true,
            ..input()
        };
        let titles = |plan: MachinePlan| -> Vec<String> {
            plan.steps.into_iter().map(|s| s.title).collect()
        };
        assert_eq!(
            titles(plan_machine_add(&facts, &set_up).unwrap()),
            ["create fleetd's directories", "make sure the node runs"]
        );

        // Its claude config dir changed: only the owned keys are rewritten, cmdRoots and the rest stay.
        let moved = plan_machine_add(
            &facts,
            &MachineAddInput {
                claude_config_dir: Some("/srv/claude".into()),
                ..set_up
            },
        )
        .unwrap();
        let update = moved
            .steps
            .iter()
            .find(|s| s.title == "update the node's settings")
            .unwrap();
        let Some(Stdin::Text { text, .. }) = &update.stdin else {
            panic!()
        };
        let written: Value = serde_json::from_str(text).unwrap();
        assert_eq!(written["claudeConfigDir"], "/srv/claude");
        assert_eq!(written["cmdRoots"], json!(["/srv"]));
    }

    /// --no-service: nothing for systemd or launchd, and the node's command to run by hand.
    #[test]
    fn no_service_writes_no_unit_and_says_how_to_run_the_node() {
        let plan = plan_machine_add(
            &fresh_facts("ada", "x64"),
            &MachineAddInput {
                service: false,
                ..input()
            },
        )
        .unwrap();
        assert!(
            plan.steps
                .iter()
                .all(|s| !s.command.contains("systemctl") && !s.command.contains("systemd/user"))
        );
        assert!(
            plan.steps
                .iter()
                .any(|s| s.stdin == Some(Stdin::EnrollToken))
        );
        assert!(!plan.node_restarts);
        assert_eq!(
            plan.run_by_hand.as_deref(),
            Some(
                "GIT_AUTHOR_NAME=ada-lovelace GIT_AUTHOR_EMAIL=1+ada-lovelace@users.noreply.github.com GIT_COMMITTER_NAME=ada-lovelace GIT_COMMITTER_EMAIL=1+ada-lovelace@users.noreply.github.com /home/ada/.fleetd/bin/fleetd node run --home /home/ada/.fleetd/node"
            )
        );
    }

    #[test]
    fn refuses_another_arch_unknown_os_and_a_missing_claude() {
        let facts = fresh_facts("ada", "arm64");
        assert!(
            plan_machine_add(&facts, &input()).err().unwrap()
                == "the machine is linux-arm64, and fleetd has no Linux ARM build yet"
        );
        let win = Facts {
            platform: "win32".into(),
            ..fresh_facts("ada", "x64")
        };
        assert!(plan_machine_add(&win, &input()).is_err());
        let none = Facts {
            claude: None,
            ..fresh_facts("ada", "x64")
        };
        assert!(
            plan_machine_add(&none, &input()).err().unwrap().ends_with(
                "Fix: on the machine, run curl -fsSL https://claude.ai/install.sh | bash"
            )
        );
        // Outside the tested range: set up anyway, with a note that says so and how to change it.
        for (version, fix) in [
            ("2.2.1", "claude install 2.1.314"),
            ("2.1.296", "claude update"),
        ] {
            let untested = Facts {
                claude_version: Some(format!("{version} (Claude Code)")),
                ..fresh_facts("ada", "x64")
            };
            let plan = plan_machine_add(&untested, &input()).unwrap();
            assert!(
                plan.notes
                    .iter()
                    .any(|n| n.contains("sessions run") && n.ends_with(fix)),
                "{:?}",
                plan.notes
            );
        }
    }

    /// The login check sees claude.env and the node's config dir, and nothing of the shell that runs it.
    #[test]
    fn the_login_check_runs_with_only_the_nodes_environment() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path().to_str().unwrap();
        let l = machine_layout(h);
        std::fs::create_dir_all(&l.fleetd).unwrap();
        std::fs::write(&l.env_file, "ANTHROPIC_BASE_URL=https://gw\n").unwrap();
        let fake = format!("{h}/claude");
        std::fs::write(
            &fake,
            "#!/bin/sh\necho \"${CLAUDE_CONFIG_DIR:-own}|$ANTHROPIC_BASE_URL|${ANTHROPIC_AUTH_TOKEN:-none}\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
        let out = std::process::Command::new("/bin/sh")
            .args(["-c", &login_status_command(&l, &fake, None)])
            .env("HOME", h)
            .env("ANTHROPIC_AUTH_TOKEN", "from-the-shell")
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&out.stdout).trim(),
            "own|https://gw|none"
        );
    }

    #[test]
    fn reads_the_probe() {
        let out = "home /home/ada\nconfig /home/ada/.config\nuser ada\nuid 1001\nos Darwin\narch arm64\n\
                   path /usr/bin:/bin\nclaude /home/ada/.local/bin/claude\nclaude_version 2.1.314 (Claude Code)\n\
                   linger unknown\nfile /home/ada/.fleetd/node/node.json eyJlbnJvbGxlZCI6dHJ1ZX0=\n\
                   file /home/ada/empty \nsize /home/ada/.fleetd/claude.env 0\n\
                   digest /home/ada/.fleetd/bin/fleetd abc123\n";
        let facts = parse_facts(out).unwrap();
        assert_eq!(
            (facts.platform.as_str(), facts.arch.as_str(), facts.uid),
            ("darwin", "arm64", 1001)
        );
        assert_eq!(
            facts.claude_version.as_deref(),
            Some("2.1.314 (Claude Code)")
        );
        assert_eq!(
            facts.file("/home/ada/.fleetd/node/node.json"),
            Some(r#"{"enrolled":true}"#)
        );
        assert_eq!(facts.file("/home/ada/empty"), Some(""));
        assert_eq!(facts.file("/home/ada/missing"), None);
        assert_eq!(facts.sizes["/home/ada/.fleetd/claude.env"], Some(0));
        assert_eq!(
            facts.digests["/home/ada/.fleetd/bin/fleetd"].as_deref(),
            Some("abc123")
        );
        let machine = parse_facts("home /h\nos Linux\narch x86_64\n").unwrap();
        assert_eq!(
            (machine.platform.as_str(), machine.arch.as_str()),
            ("linux", "x64")
        );
        assert_eq!(machine.claude, None);
        assert!(parse_facts("nothing\n").is_err());
    }

    /// A second fleet on this machine (`FLEETD_HOME`) sets up its node in its own directory and never takes over
    /// the first one's node service.
    #[test]
    fn a_relocated_fleet_keeps_to_its_own_dir_and_service() {
        let mut facts = fresh_facts("ada", "x64");
        facts.fleetd = "/tmp/second".into();
        let plan = plan_machine_add(&facts, &input()).unwrap();
        let text = summary(&plan).to_string();
        assert!(text.contains("/tmp/second/node"), "{text}");
        assert!(!text.contains("/home/ada/.fleetd"), "{text}");

        let unit = "/home/ada/.config/systemd/user/fleetd-node.service";
        facts.files.insert(
            unit.into(),
            Some(
                "ExecStart=/home/ada/.fleetd/bin/fleetd node run --home /home/ada/.fleetd/node\n"
                    .into(),
            ),
        );
        let Err(refused) = plan_machine_add(&facts, &input()) else {
            panic!("took over the first fleet's node service");
        };
        assert!(refused.contains("another fleet's node"), "{refused}");
        assert!(refused.contains("--no-service"), "{refused}");
        let no_service = MachineAddInput {
            service: false,
            ..input()
        };
        assert!(plan_machine_add(&facts, &no_service).is_ok());
        facts.fleetd = String::new();
        assert!(
            plan_machine_add(&facts, &input()).is_ok(),
            "the default fleet keeps rewriting its own unit"
        );
    }

    #[test]
    fn the_probe_reads_a_relocated_fleetd_dir() {
        let home = tempfile::tempdir().unwrap();
        let fleet = tempfile::tempdir().unwrap();
        let (h, f) = (
            home.path().to_str().unwrap(),
            fleet.path().to_str().unwrap(),
        );
        std::fs::create_dir_all(format!("{f}/node")).unwrap();
        std::fs::write(format!("{f}/node/node.json"), "{}\n").unwrap();
        std::fs::create_dir_all(format!("{h}/.fleetd/node")).unwrap();
        std::fs::write(format!("{h}/.fleetd/node/node.json"), "{\"real\":1}\n").unwrap();
        let out = std::process::Command::new("/bin/sh")
            .args(["-c", &probe_command(Some(f))])
            .env("HOME", h)
            .output()
            .unwrap();
        let facts = parse_facts(&String::from_utf8_lossy(&out.stdout)).unwrap();
        assert_eq!(facts.fleetd, f);
        assert_eq!(facts.file(&format!("{f}/node/node.json")), Some("{}\n"));
        assert!(
            !facts
                .files
                .contains_key(&format!("{h}/.fleetd/node/node.json"))
        );
    }

    /// The probe is POSIX sh, so it runs here as it would on a machine.
    #[test]
    fn the_probe_runs_in_sh_and_reads_back() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path().to_str().unwrap();
        std::fs::create_dir_all(format!("{h}/.fleetd/node")).unwrap();
        std::fs::write(format!("{h}/.fleetd/node/node.json"), "{\"hub\":\"x\"}\n").unwrap();
        std::fs::write(format!("{h}/.fleetd/claude.env"), "").unwrap();
        let out = std::process::Command::new("/bin/sh")
            .args(["-c", &probe_command(None)])
            .env("HOME", h)
            .env_remove("XDG_CONFIG_HOME")
            .output()
            .unwrap();
        let facts = parse_facts(&String::from_utf8_lossy(&out.stdout)).unwrap();
        assert_eq!(facts.home, h);
        assert_eq!(facts.config_home, format!("{h}/.config"));
        assert_eq!(
            facts.file(&format!("{h}/.fleetd/node/node.json")),
            Some("{\"hub\":\"x\"}\n")
        );
        assert_eq!(facts.sizes[&format!("{h}/.fleetd/claude.env")], Some(0));
        assert!(
            !facts
                .files
                .contains_key(&format!("{h}/.config/systemd/user/fleetd-node.service"))
        );
    }

    /// A removed machine's agents, which outlive a node's restart, end with its node: before its home goes.
    #[test]
    fn a_removed_machine_stops_the_agents_its_node_left_running() {
        let steps = plan_machine_remove(
            Platform::Linux,
            "/home/ada",
            None,
            "/home/ada/.config",
            1000,
            true,
            true,
        );
        let at = |title: &str| {
            steps
                .iter()
                .position(|s| s.title.starts_with(title))
                .unwrap()
        };
        let stop = &steps[at("stop the agents")];
        assert_eq!(
            stop.command,
            "if [ -d /home/ada/.fleetd/node/hosts ]; then /home/ada/.fleetd/bin/fleetd session-host stop-all /home/ada/.fleetd/node/hosts || true; fi"
        );
        assert!(at("stop and remove the node service") < at("stop the agents"));
        assert!(at("stop the agents") < at("delete the node's key"));
        // Another fleet's node runs there: its agents aren't ours to stop.
        let foreign = plan_machine_remove(
            Platform::Linux,
            "/home/ada",
            None,
            "/home/ada/.config",
            1000,
            false,
            false,
        );
        assert!(
            !foreign
                .iter()
                .any(|s| s.title.starts_with("stop the agents"))
        );
    }
}
