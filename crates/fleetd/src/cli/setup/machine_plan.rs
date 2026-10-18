//! Every remote command `fleetd machine add` runs, derived from what a read-only probe found on the machine, and
//! the commands `machine remove` undoes it with.

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::{Value, json};

use super::ordered_json::{Json, Object};
use super::state::{GitIdentity, git_identity_env};
use super::t3_settings::apply_fleetd_settings;
use super::units::{Dirs, Platform, Role, ServiceManager, ServiceSpec, q, render_unit, unit_path};

pub const DEFAULT_T3_PORT: u16 = 3774;
/// The node.json fields `machine add` sets, in the node's own key order; the rest (cmdRoots) are the user's.
const NODE_CONFIG_OWNED: [&str; 8] = [
    "hub",
    "machineId",
    "name",
    "tags",
    "t3Home",
    "t3Url",
    "t3Cmd",
    "t3RestartCmd",
];
const MIN_NODE_MAJOR: u32 = 24;

/// Where fleetd puts things on a machine, under the SSH user's home.
#[derive(Clone, Debug)]
pub struct MachineLayout {
    pub fleetd: String,
    pub node_home: String,
    pub node_config: String,
    /// Its own T3 home, so a T3 the user already runs on the machine (~/.t3) is never touched.
    pub t3_home: String,
    pub t3_settings: String,
    pub claude_dir: String,
    /// The fleetd instance's Claude login (e.g. CLAUDE_CODE_OAUTH_TOKEN=…), 0600, filled in by the user.
    pub env_file: String,
    pub logs: String,
    /// Where older releases installed the CLI bundle; deleted when the binary replaces it.
    pub legacy_cli_dir: String,
    pub bin_dir: String,
    /// The fleetd binary itself: the node service runs it and leads find it on T3's PATH.
    pub bin: String,
    pub npm_prefix: String,
    pub t3_bin: String,
    pub t3_package: String,
}

pub fn machine_layout(home: &str) -> MachineLayout {
    let home = home.trim_end_matches('/');
    let fleetd = format!("{home}/.fleetd");
    let share = format!("{home}/.local/share/fleetd");
    MachineLayout {
        node_home: format!("{fleetd}/node"),
        node_config: format!("{fleetd}/node/node.json"),
        t3_home: format!("{fleetd}/t3"),
        t3_settings: format!("{fleetd}/t3/userdata/settings.json"),
        claude_dir: format!("{fleetd}/claude"),
        env_file: format!("{fleetd}/t3.env"),
        logs: format!("{fleetd}/logs"),
        legacy_cli_dir: format!("{share}/cli"),
        bin_dir: format!("{share}/bin"),
        bin: format!("{share}/bin/fleetd"),
        npm_prefix: format!("{share}/npm"),
        t3_bin: format!("{share}/npm/bin/t3"),
        t3_package: format!("{share}/npm/lib/node_modules/t3/package.json"),
        fleetd,
    }
}

/// What the read-only probe reports about the machine. Files are keyed by absolute path; null when absent.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Facts {
    pub home: String,
    pub config_home: String,
    pub user: String,
    pub uid: u32,
    pub platform: String,
    /// `process.arch` of the machine's Node: x64, arm64, …
    pub arch: String,
    pub node_path: String,
    pub node_version: String,
    pub path: String,
    pub claude: Option<String>,
    pub linger: String,
    pub files: HashMap<String, Option<String>>,
    /// Size in bytes, null when absent: for files whose content the probe must not read.
    pub sizes: HashMap<String, Option<u64>>,
    /// sha256 of a file's content, null when absent.
    pub digests: HashMap<String, Option<String>>,
}

impl Facts {
    fn file(&self, path: &str) -> Option<&str> {
        self.files.get(path).and_then(|f| f.as_deref())
    }
}

/// Paths the probe reads, with `{home}` and `{config}` filled in on the machine.
pub fn probe_spec(suffix: &str) -> Value {
    let l = machine_layout("{home}");
    let dirs = Dirs {
        home: "{home}",
        config_home: "{config}",
    };
    let mut read = vec![
        l.t3_settings.clone(),
        l.node_config.clone(),
        l.t3_package.clone(),
    ];
    for role in [Role::T3, Role::Node] {
        read.push(unit_path(Platform::Linux, &dirs, role, suffix));
        read.push(unit_path(Platform::Darwin, &dirs, role, suffix));
    }
    // The Claude login file is only sized: the probe never reads a secret.
    json!({ "read": read, "size": [l.env_file], "digest": [l.bin] })
}

/// Read-only, CommonJS so any Node runs it from stdin. Prints one JSON line of Facts.
pub const PROBE_SCRIPT: &str = r#"
const fs = require("fs"), os = require("os"), path = require("path"), cp = require("child_process"), crypto = require("crypto");
const spec = JSON.parse(process.argv[2]);
const home = os.homedir();
const configHome = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
const at = (p) => p.replaceAll("{home}", home).replaceAll("{config}", configHome);
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
const which = (bin) => (process.env.PATH || "").split(":").map((d) => path.join(d, bin)).find((f) => { try { fs.accessSync(f, fs.constants.X_OK); return true; } catch { return false; } }) || null;
const digest = (p) => { try { return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); } catch { return null; } };
let linger = "unknown";
if (process.platform === "linux") {
  try { linger = cp.execFileSync("loginctl", ["show-user", os.userInfo().username, "-p", "Linger", "--value"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || "unknown"; } catch {}
}
const files = {}, sizes = {}, digests = {};
for (const p of spec.read) files[at(p)] = read(at(p));
for (const p of spec.size) { try { sizes[at(p)] = fs.statSync(at(p)).size; } catch { sizes[at(p)] = null; } }
for (const p of spec.digest) digests[at(p)] = digest(at(p));
console.log(JSON.stringify({ home, configHome, user: os.userInfo().username, uid: process.getuid(), platform: process.platform, arch: process.arch,
  nodePath: process.execPath, nodeVersion: process.version, path: process.env.PATH || "", claude: which("claude"), linger, files, sizes, digests }));
"#;

/// Finds a Node even where a non-interactive SSH shell's PATH lacks it (Homebrew, ~/.local), then runs the probe from stdin.
pub fn probe_command(suffix: &str) -> String {
    [
        "N=$(command -v node || true)".to_owned(),
        r#"for c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.local/bin/node"; do [ -n "$N" ] && break; [ -x "$c" ] && N=$c; done"#.into(),
        r#"[ -n "$N" ] || { echo '{"error":"no-node"}'; exit 0; }"#.into(),
        format!(r#"exec "$N" - {}"#, q(&probe_spec(suffix).to_string())),
    ]
    .join("; ")
}

/// The OS and architecture of the running fleetd, in Node's names (what the probe reports).
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

pub struct MachineAddInput {
    pub machine_id: String,
    pub tags: Vec<String>,
    pub hub_url: String,
    pub unit_suffix: String,
    pub t3_port: u16,
    pub t3_version: String,
    pub git_identity: Option<GitIdentity>,
    /// sha256 of the fleetd binary this hub copies to the machine: the one running now.
    pub binary_digest: String,
    /// `local_target()` of that binary; for now it only sets up machines it can run on.
    pub binary_target: (String, String),
    pub version: String,
    /// The hub already holds a node key for this machine id.
    pub hub_has_node_key: bool,
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
    /// Things the user should know or do by hand (linger, the Claude login).
    pub notes: Vec<String>,
    /// The node will (re)connect during this run, so `machine add` waits for a fresh machine.online.
    pub node_restarts: bool,
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

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).to_owned()).collect()
}

/// Every remote command `fleetd machine add` runs, in order, for a machine in the state `facts` describes. Steps whose
/// result is already in place are left out, so a re-run on a set-up machine only checks that both services run.
pub fn plan_machine_add(facts: &Facts, input: &MachineAddInput) -> Result<MachinePlan, String> {
    let major: u32 = facts
        .node_version
        .strip_prefix('v')
        .and_then(|v| v.split_once('.'))
        .and_then(|(major, _)| major.parse().ok())
        .unwrap_or(0);
    if major < MIN_NODE_MAJOR {
        return Err(format!(
            "Node {MIN_NODE_MAJOR} or newer is needed on the machine; it has {} at {}",
            facts.node_version, facts.node_path
        ));
    }
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
        return Err(format!(
            "the machine is {}-{} and this fleetd is a {os}-{arch} build: machine add copies the running fleetd to the machine, so for now it sets up machines of its own OS and architecture only",
            facts.platform, facts.arch
        ));
    }
    if facts.home.chars().any(char::is_whitespace)
        || facts.node_path.chars().any(char::is_whitespace)
    {
        return Err(format!(
            "the machine's home ({}) and Node path ({}) must not contain spaces",
            facts.home, facts.node_path
        ));
    }

    let l = machine_layout(&facts.home);
    let dirs = Dirs {
        home: &facts.home,
        config_home: &facts.config_home,
    };
    let unit_file = |role: Role| unit_path(platform, &dirs, role, &input.unit_suffix);
    let services = ServiceManager::new(platform, facts.uid, &input.unit_suffix, unit_file);
    let node_dir = dirname(&facts.node_path).to_owned();
    let mut path_dirs = vec![l.bin_dir.clone(), node_dir.clone()];
    path_dirs.extend(
        facts
            .path
            .split(':')
            .filter(|dir| *dir != l.bin_dir && *dir != node_dir && !dir.is_empty())
            .map(str::to_owned),
    );
    let service_path = path_dirs.join(":");
    let t3_url = format!("http://127.0.0.1:{}", input.t3_port);
    let mut common = vec![
        ("HOME".to_owned(), facts.home.clone()),
        ("PATH".into(), service_path),
        ("LANG".into(), "C.UTF-8".into()),
    ];
    common.extend(git_identity_env(input.git_identity.as_ref()));

    let mut t3_env = common.clone();
    t3_env.extend([
        ("T3CODE_HOME".to_owned(), l.t3_home.clone()),
        // Every Claude process this T3 starts keeps its config apart from the user's own ~/.claude.
        ("CLAUDE_CONFIG_DIR".into(), l.claude_dir.clone()),
        ("CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS".into(), "2".into()),
        ("T3CODE_TELEMETRY_ENABLED".into(), "false".into()),
        ("T3CODE_NO_BROWSER".into(), "true".into()),
        // Leads run `fleetd` from their shell and reach the hub through this node.
        (
            "FLEETD_NODE_SOCK".into(),
            format!("{}/node.sock", l.node_home),
        ),
    ]);
    // T3 is a Node app and runs with the machine's Node; fleetd itself is the one binary.
    let t3_spec = ServiceSpec {
        role: Role::T3,
        suffix: input.unit_suffix.clone(),
        description: "T3 Code for fleetd".into(),
        program: vec![
            facts.node_path.clone(),
            l.t3_bin.clone(),
            "serve".into(),
            "--base-dir".into(),
            l.t3_home.clone(),
            "--host".into(),
            "127.0.0.1".into(),
            "--port".into(),
            input.t3_port.to_string(),
            "--no-browser".into(),
        ],
        env: t3_env,
        env_file: Some(l.env_file.clone()),
        working_directory: facts.home.clone(),
        log_path: format!("{}/t3.log", l.logs),
    };
    let node_spec = ServiceSpec {
        role: Role::Node,
        suffix: input.unit_suffix.clone(),
        description: "fleetd node".into(),
        program: vec![
            l.bin.clone(),
            "node".into(),
            "run".into(),
            "--home".into(),
            l.node_home.clone(),
        ],
        env: common,
        env_file: None,
        working_directory: facts.home.clone(),
        log_path: format!("{}/node.log", l.logs),
    };

    // The node runs T3's CLI with a scrubbed environment, so T3's home goes in through env(1).
    let t3_cmd = vec![
        "/usr/bin/env".to_owned(),
        format!("T3CODE_HOME={}", l.t3_home),
        facts.node_path.clone(),
        l.t3_bin.clone(),
    ];
    let t3_restart_cmd = services.restart_argv(Role::T3);
    let desired_node = json!({
        "hub": input.hub_url,
        "machineId": input.machine_id,
        "name": input.machine_id,
        "tags": input.tags,
        "t3Home": l.t3_home,
        "t3Url": t3_url,
        "t3Cmd": t3_cmd,
        "t3RestartCmd": t3_restart_cmd,
    });

    let mut steps = Vec::new();
    let mut notes = Vec::new();
    steps.push(step(
        "create fleetd's directories",
        format!(
            "mkdir -p {} && chmod 700 {}",
            [
                &l.node_home,
                &l.claude_dir,
                &l.logs,
                &l.bin_dir,
                &l.npm_prefix
            ]
            .map(|d| q(d))
            .join(" "),
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
                q(&l.legacy_cli_dir)
            ),
            stdin: Some(Stdin::Binary),
            writes: None,
        });
    }

    let installed_t3 = facts
        .file(&l.t3_package)
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .and_then(|pkg| {
            pkg.get("version")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    let t3_installs = installed_t3.as_deref() != Some(input.t3_version.as_str());
    if t3_installs {
        steps.push(step(
            format!("install T3 {} from npm", input.t3_version),
            // npm's own shebang needs node on PATH. `t3 --version` fetches T3's verified executable into its home now, not at first start.
            format!(
                "PATH={}:\"$PATH\" npm_config_cache={} {} install --global --prefix {} --no-fund --no-audit --loglevel=error t3@{} && T3CODE_HOME={} {} {} --version",
                q(&node_dir),
                q(&format!("{}/.npm", facts.home.trim_end_matches('/'))),
                q(&format!("{node_dir}/npm")),
                q(&l.npm_prefix),
                input.t3_version,
                q(&l.t3_home),
                q(&facts.node_path),
                q(&l.t3_bin)
            ),
        ));
    }

    let settings =
        apply_fleetd_settings(facts.file(&l.t3_settings), &l.claude_dir).map_err(|error| {
            format!(
                "{} is not valid JSON ({error}); fix or remove it, then run again",
                l.t3_settings
            )
        })?;
    let settings_change = Some(settings.as_str()) != facts.file(&l.t3_settings);
    if settings_change {
        steps.push(write_file(
            "configure the fleetd Claude instance in T3's settings",
            &l.t3_settings,
            settings,
            "600",
        ));
    }
    let login_size = facts.sizes.get(&l.env_file).copied().flatten();
    if login_size.is_none() {
        steps.push(step(
            "create the fleetd instance's Claude login file (empty, 0600)",
            format!("[ -e {f} ] || (umask 077 && : > {f})", f = q(&l.env_file)),
        ));
    }

    let mut unit_state = Vec::new();
    for (role, spec) in [(Role::T3, &t3_spec), (Role::Node, &node_spec)] {
        let text = render_unit(platform, spec);
        let existing = facts.file(&unit_file(role));
        let changed = existing != Some(text.as_str());
        if changed {
            let title = if role == Role::T3 {
                "write the T3 service"
            } else {
                "write the node service"
            };
            steps.push(write_file(title, &unit_file(role), text, "644"));
        }
        unit_state.push((changed, existing.is_some()));
    }
    let [(t3_changed, t3_existed), (node_changed, node_existed)] = [unit_state[0], unit_state[1]];

    steps.push(if t3_changed || settings_change || t3_installs {
        step(
            "(re)start T3",
            services.restart(Role::T3, t3_changed && t3_existed),
        )
    } else {
        step("make sure T3 runs", services.ensure_running(Role::T3))
    });
    let wait = r#"const u=process.argv[1]+"/.well-known/t3/environment";const end=Date.now()+180000;(async()=>{for(;;){try{const r=await fetch(u);if(r.ok){console.log((await r.json()).serverVersion);return}}catch{}if(Date.now()>end){console.error("T3 did not answer at "+u+" within 3 min");process.exit(1)}await new Promise(r=>setTimeout(r,1000))}})()"#;
    steps.push(step(
        "wait for T3 to answer",
        format!("{} -e {} {t3_url}", q(&facts.node_path), q(wait)),
    ));

    let existing_node = facts
        .file(&l.node_config)
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .filter(Value::is_object);
    let enrolled = existing_node.as_ref().is_some_and(|node| {
        node.get("enrolled") == Some(&Value::Bool(true))
            && node.get("machineId").and_then(Value::as_str) == Some(input.machine_id.as_str())
            && node.get("hub").and_then(Value::as_str) == Some(input.hub_url.as_str())
    });
    let enrolls = !input.hub_has_node_key || !enrolled;
    // Field by field, so key order in the file does not matter; cmdRoots is the user's to set and is kept.
    let owned = |c: &Value| NODE_CONFIG_OWNED.map(|k| c.get(k).cloned().unwrap_or(Value::Null));
    let node_config_change = !enrolls
        && existing_node
            .as_ref()
            .is_some_and(|node| owned(node) != owned(&desired_node));
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
            "--t3-home".into(),
            l.t3_home.clone(),
            "--t3-url".into(),
            t3_url.clone(),
            "--t3-cmd".into(),
            t3_cmd.join(" "),
            "--t3-restart-cmd".into(),
            t3_restart_cmd.join(" "),
        ];
        if !input.tags.is_empty() {
            argv.extend(["--tags".to_owned(), input.tags.join(",")]);
        }
        argv.extend(strings(&["--home"]));
        argv.extend([l.node_home.clone(), "--enroll-only".into()]);
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
    } else if node_config_change {
        // `{ ...desired, ...cmdRoots, enrolled: true }`, in that key order.
        let mut config = Object::default();
        for key in NODE_CONFIG_OWNED {
            config.insert(key, Json::from(desired_node[key].clone()));
        }
        if let Some(roots) = existing_node.as_ref().and_then(|node| node.get("cmdRoots")) {
            config.insert("cmdRoots", Json::from(roots.clone()));
        }
        config.insert("enrolled", Json::Bool(true));
        let text = format!("{}\n", Json::Object(config).pretty());
        steps.push(write_file(
            "update the node's settings",
            &l.node_config,
            text,
            "600",
        ));
    }
    // A new binary is new node code: the running node keeps the old one until it restarts.
    let node_restarts = enrolls || node_config_change || node_changed || binary_changes;
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

    if platform == Platform::Linux && facts.linger != "yes" {
        notes.push(format!(
            "linger is {} for {u}, so both services stop when {u} logs out. Have an admin run: sudo loginctl enable-linger {u}",
            facts.linger,
            u = facts.user
        ));
    }
    if platform == Platform::Darwin {
        notes.push(format!("launchd runs both services while {} is logged in; keep that user logged in on this Mac.", facts.user));
    }
    if facts.claude.is_none() {
        notes.push("no `claude` on the machine's PATH: install Claude Code there before fleetd runs turns on it.".into());
    }
    if login_size.is_none_or(|size| size == 0) {
        notes.push(format!(
            "the fleetd instance logs in from {} (0600): put CLAUDE_CODE_OAUTH_TOKEN=… (from `claude setup-token`) or ANTHROPIC_BASE_URL=… and ANTHROPIC_AUTH_TOKEN=… there, then restart T3.",
            l.env_file
        ));
    }
    if input.git_identity.is_none() {
        notes.push(r#"no commit identity on the hub: run `fleetd init --git-identity "Name <id+user@users.noreply.github.com>"`, then add this machine again."#.into());
    }
    Ok(MachinePlan {
        platform,
        layout: l,
        steps,
        notes,
        node_restarts,
    })
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
        node_path: "/usr/bin/node".into(),
        node_version: "v24.0.0".into(),
        path: "/usr/local/bin:/usr/bin:/bin".into(),
        claude: Some(format!("/home/{user}/.local/bin/claude")),
        linger: "yes".into(),
        files: HashMap::new(),
        sizes: HashMap::new(),
        digests: HashMap::new(),
    }
}

/// Commands that undo `machine add`: the node always, T3 and its data only with `purge_t3`.
pub fn plan_machine_remove(
    platform: Platform,
    home: &str,
    config_home: &str,
    uid: u32,
    suffix: &str,
    purge_t3: bool,
) -> Vec<Step> {
    let l = machine_layout(home);
    let dirs = Dirs { home, config_home };
    let unit_file = |role: Role| unit_path(platform, &dirs, role, suffix);
    let services = ServiceManager::new(platform, uid, suffix, unit_file);
    let mut steps = vec![
        step(
            "stop and remove the node service",
            format!(
                "{}; rm -f {}",
                services.remove(Role::Node),
                q(&unit_file(Role::Node))
            ),
        ),
        step(
            "delete the node's key and settings, and the fleetd binary",
            format!(
                "rm -rf {}",
                [&l.node_home, &l.legacy_cli_dir, &l.bin]
                    .map(|p| q(p))
                    .join(" ")
            ),
        ),
    ];
    if purge_t3 {
        steps.push(step(
            "stop and remove the T3 service",
            format!(
                "{}; rm -f {}",
                services.remove(Role::T3),
                q(&unit_file(Role::T3))
            ),
        ));
        steps.push(step(
            "delete T3, its data and the fleetd Claude config",
            format!(
                "rm -rf {}; rmdir {} 2>/dev/null || true",
                [
                    &l.t3_home,
                    &l.claude_dir,
                    &l.env_file,
                    &l.npm_prefix,
                    &l.logs
                ]
                .map(|p| q(p))
                .join(" "),
                [l.bin_dir.as_str(), dirname(&l.bin_dir), l.fleetd.as_str()]
                    .map(q)
                    .join(" ")
            ),
        ));
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
            tags: vec!["macos".into(), "xcode".into()],
            hub_url: "https://forge.example.ts.net".into(),
            unit_suffix: String::new(),
            t3_port: 3774,
            t3_version: "0.1.1-nightly.20261017.3238".into(),
            git_identity: Some(GitIdentity {
                name: "wynn-dev".into(),
                email: "1+wynn-dev@users.noreply.github.com".into(),
            }),
            binary_digest: "b".repeat(64),
            binary_target: ("linux".into(), "x64".into()),
            version: "0.0.0".into(),
            hub_has_node_key: false,
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

    /// The `--dry-run` output: every command on a fresh Linux machine, in order.
    #[test]
    fn fresh_linux_plan_matches_snapshot() {
        let plan = plan_machine_add(&fresh_facts("wynn", "x64"), &input()).unwrap();
        let actual = format!(
            "{}\n",
            serde_json::to_string_pretty(&summary(&plan)).unwrap()
        );
        // FLEETD_UPDATE_SNAPSHOTS=1 rewrites the file after a deliberate change; review its diff.
        if std::env::var_os("FLEETD_UPDATE_SNAPSHOTS").is_some() {
            std::fs::write(
                concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/src/cli/setup/snapshots/machine_add_fresh.json"
                ),
                &actual,
            )
            .unwrap();
        }
        assert_eq!(actual, include_str!("snapshots/machine_add_fresh.json"));
        assert!(plan.node_restarts);
        let node_unit = plan
            .steps
            .iter()
            .find(|s| s.title == "write the node service")
            .unwrap();
        let Some(Stdin::Text { text, .. }) = &node_unit.stdin else {
            panic!("unit text")
        };
        assert!(text.contains("ExecStart=/home/wynn/.local/share/fleetd/bin/fleetd node run --home /home/wynn/.fleetd/node\n"));
    }

    /// A second run on a set-up machine only makes sure both services run.
    #[test]
    fn rerun_is_idempotent() {
        let first = plan_machine_add(&fresh_facts("wynn", "x64"), &input()).unwrap();
        let mut facts = fresh_facts("wynn", "x64");
        let l = machine_layout(&facts.home);
        for s in &first.steps {
            if let (Some(file), Some(Stdin::Text { text, .. })) = (&s.writes, &s.stdin) {
                facts.files.insert(file.clone(), Some(text.clone()));
            }
        }
        let node = json!({ "hub": "https://forge.example.ts.net", "machineId": "mac-mini", "name": "mac-mini", "tags": ["macos", "xcode"],
            "t3Home": l.t3_home, "t3Url": "http://127.0.0.1:3774", "t3Cmd": ["/usr/bin/env", format!("T3CODE_HOME={}", l.t3_home), "/usr/bin/node", l.t3_bin],
            "t3RestartCmd": ["/usr/bin/env", "XDG_RUNTIME_DIR=/run/user/1000", "systemctl", "--user", "restart", "fleetd-t3.service"], "enrolled": true });
        facts
            .files
            .insert(l.node_config.clone(), Some(node.to_string()));
        facts.files.insert(
            l.t3_package.clone(),
            Some(json!({ "name": "t3", "version": input().t3_version }).to_string()),
        );
        facts.sizes.insert(l.env_file.clone(), Some(0));
        facts.digests.insert(l.bin.clone(), Some("b".repeat(64)));
        let again = plan_machine_add(
            &facts,
            &MachineAddInput {
                hub_has_node_key: true,
                ..input()
            },
        )
        .unwrap();
        let titles: Vec<&str> = again.steps.iter().map(|s| s.title.as_str()).collect();
        assert_eq!(
            titles,
            [
                "create fleetd's directories",
                "make sure T3 runs",
                "wait for T3 to answer",
                "make sure the node runs"
            ]
        );
        assert!(!again.node_restarts);
        let newer = plan_machine_add(
            &facts,
            &MachineAddInput {
                hub_has_node_key: true,
                binary_digest: "c".repeat(64),
                ..input()
            },
        )
        .unwrap();
        let titles: Vec<&str> = newer.steps.iter().map(|s| s.title.as_str()).collect();
        assert_eq!(
            titles,
            [
                "create fleetd's directories",
                "install fleetd 0.0.0",
                "make sure T3 runs",
                "wait for T3 to answer",
                "(re)start the node"
            ]
        );
    }

    #[test]
    fn refuses_another_arch_old_node_and_unknown_os() {
        let facts = fresh_facts("wynn", "arm64");
        assert!(
            plan_machine_add(&facts, &input())
                .err()
                .unwrap()
                .starts_with("the machine is linux-arm64 and this fleetd is a linux-x64 build")
        );
        let old = Facts {
            node_version: "v22.11.0".into(),
            ..fresh_facts("wynn", "x64")
        };
        assert_eq!(
            plan_machine_add(&old, &input()).err().unwrap(),
            "Node 24 or newer is needed on the machine; it has v22.11.0 at /usr/bin/node"
        );
        let win = Facts {
            platform: "win32".into(),
            ..fresh_facts("wynn", "x64")
        };
        assert!(plan_machine_add(&win, &input()).is_err());
    }
}
