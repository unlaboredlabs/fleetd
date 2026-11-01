//! iOS screens on another machine than their agent's (W176). agent-device drives a simulator over simctl and its
//! XCTest runner, which no relay carries, so the agent's commands travel instead: while the hub has placed the agent's
//! screen elsewhere, its node puts a forwarding `agent-device` first on the agent's PATH ([`install_forwarder`]),
//! which runs `fleetd agent-device`. Its node sends the command through the hub (`device`, [`DeviceCall`]) to the node
//! hosting the screen, which runs the real agent-device against that screen's clone and answers with its output.
//!
//! The hosting machine is a person's own Mac, so it runs only what [`parse`] allows: agent-device commands that
//! drive the screen, with flags that can't pick another device, another config, a script or a server, and paths only
//! in the screen's own folder ([`Work`]). Files go both ways: what a command reads (an app to install) is read by the
//! agent's node from its worktree and sent first, a piece at a time ([`map`]); what it writes (a screenshot) comes back
//! the same way into the worktree.
use std::collections::HashMap;
use std::io::{Read, Seek, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::browser::{DeviceCall, DeviceDone, DeviceFile};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};

/// The most of a file one `put` or `get` carries: well inside the hub link's frames, base64 and all.
pub const PIECE: usize = 4 << 20;
/// The most a command reads in files, together, and the most of a file it writes that comes back.
pub const FILE_MAX: u64 = 64 << 20;
/// The most of a command's stdout, and of its stderr, that comes back.
pub const OUTPUT_MAX: usize = 1 << 20;
/// How long a command may run on the screen's node.
pub const RUN_WAIT: Duration = Duration::from_secs(100);
/// What the screen's node answers, with exit code 75, while the screen's XCTest runner is still starting (it can take
/// minutes, past what a command may wait on the way): the agent's `fleetd agent-device` sends the command again until
/// it runs, so it waits for the runner instead of starting one of its own.
pub const RUNNER_STARTING: &str =
    "fleetd: the screen's XCTest runner is still starting; the command waits for it.\n";

/// What the screen's node says when a command is refused.
const ONLY: &str =
    "fleetd runs only agent-device commands that drive the screen on another machine";

fn refuse(message: impl Into<String>, fix: &str) -> McpToolError {
    McpToolError::new(ErrorCode::Invalid, message).with_fix(fix)
}

/// What a flag takes after it.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Take {
    Nothing,
    Text,
    /// A file the command writes.
    Out,
}

/// What an argument is, by where it stands in the command.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Role {
    Plain,
    /// A file the command reads.
    In,
    /// A file the command writes.
    Out,
    /// Inline JSON, else a file the command reads (`push`'s payload).
    InOrJson,
}

/// Which of a command's positional arguments are files.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Files {
    None,
    /// `install <path>`, `install <app> <path>`, `reinstall <app> <path>`: the last.
    Install,
    /// `screenshot <path>` (or `--out <path>`).
    Screenshot,
    /// `record start <path>` (or `--out <path>`), `record stop`.
    Record,
    /// `push <bundle> <payload>`.
    Push,
    /// `open [app or URL] [URL]`: never a path or a file URL on the screen's machine.
    Open,
    /// `logs path <path>`: the app log, which agent-device keeps on the screen's machine, comes back there.
    Logs,
}

struct Command {
    name: &'static str,
    flags: &'static [&'static [(&'static str, Take)]],
    files: Files,
}

use Take::{Nothing as N, Out as O, Text as T};

/// Every command's.
const COMMON: &[(&str, Take)] = &[
    ("--json", N),
    ("--level", T),
    ("--cost", N),
    ("--help", N),
    ("-h", N),
];
const SETTLE: &[(&str, Take)] = &[("--settle", N), ("--settle-quiet", T), ("--timeout", T)];
const TREE: &[(&str, Take)] = &[
    ("--depth", T),
    ("-d", T),
    ("--scope", T),
    ("-s", T),
    ("--raw", N),
];
const TAP: &[(&str, Take)] = &[
    ("--count", T),
    ("--interval-ms", T),
    ("--hold-ms", T),
    ("--jitter-px", T),
    ("--double-tap", N),
    ("--verify", N),
];

const fn command(
    name: &'static str,
    flags: &'static [&'static [(&'static str, Take)]],
    files: Files,
) -> Command {
    Command { name, flags, files }
}

/// The commands a screen on another machine runs, with their flags. Not here, so refused: device lifecycle (`boot`,
/// `shutdown`, `devices`), scripts (`batch`, `replay`, `test`), servers and remote state (`mcp`, `daemon`, `proxy`,
/// `connect`, `auth`, `plugins`, `metro`, `web`), the host's clipboard and diagnostics, and every device or config
/// selector (`--platform`, `--udid`, `--device`, `--serial`, `--session`, `--config`).
const COMMANDS: &[Command] = &[
    command(
        "open",
        &[&[
            ("--metro-host", T),
            ("--metro-port", T),
            ("--bundle-url", T),
            ("--launch-url", T),
            ("--launch-args", T),
            ("--relaunch", N),
            ("--foreground", N),
            ("--no-record", N),
            ("--timeout", T),
            ("--wait", T),
        ]],
        Files::Open,
    ),
    command("close", &[], Files::None),
    command("install", &[], Files::Install),
    command("reinstall", &[], Files::Install),
    command("uninstall", &[], Files::None),
    command("apps", &[&[("--all", N)]], Files::None),
    command("appstate", &[], Files::None),
    command(
        "screenshot",
        &[&[
            ("--out", O),
            ("--overlay-refs", N),
            ("--crop-on", T),
            ("--pixel-density", T),
            ("--fullscreen", N),
            ("--full", N),
            ("-f", N),
            ("--scale", T),
            ("--no-stabilize", N),
            ("--normalize-status-bar", N),
        ]],
        Files::Screenshot,
    ),
    command(
        "record",
        &[&[
            ("--fps", T),
            ("--quality", T),
            ("--hide-touches", N),
            ("--scope", T),
            ("--out", O),
        ]],
        Files::Record,
    ),
    command(
        "snapshot",
        &[
            &[
                ("--diff", N),
                ("--record", N),
                ("--timeout", T),
                ("-i", N),
                ("--actions", N),
                ("--observe-only", N),
                ("--force-full", N),
            ],
            TREE,
        ],
        Files::None,
    ),
    command("press", &[TAP, SETTLE, TREE], Files::None),
    command(
        "click",
        &[TAP, SETTLE, TREE, &[("--button", T)]],
        Files::None,
    ),
    command(
        "fill",
        &[
            &[("--delay-ms", T), ("--record-as", T), ("--verify", N)],
            SETTLE,
            TREE,
        ],
        Files::None,
    ),
    command("type", &[&[("--delay-ms", T)]], Files::None),
    command(
        "scroll",
        &[
            &[
                ("--duration-ms", T),
                ("--pixels", T),
                ("--until", T),
                ("--max-passes", T),
            ],
            SETTLE,
        ],
        Files::None,
    ),
    command(
        "swipe",
        &[&[("--count", T), ("--pause-ms", T), ("--pattern", T)]],
        Files::None,
    ),
    command("longpress", &[SETTLE, TREE], Files::None),
    command(
        "gesture",
        &[&[
            ("--count", T),
            ("--pointer-count", T),
            ("--hold-ms", T),
            ("--pause-ms", T),
        ]],
        Files::None,
    ),
    command("wait", &[TREE], Files::None),
    command("get", &[TREE, &[("--record", N)]], Files::None),
    command("is", &[TREE, &[("--record", N)]], Files::None),
    command(
        "find",
        &[&[
            ("--record", N),
            ("--depth", T),
            ("-d", T),
            ("--raw", N),
            ("--first", N),
            ("--last", N),
        ]],
        Files::None,
    ),
    command(
        "back",
        &[&[("--in-app", N), ("--system", N)], SETTLE],
        Files::None,
    ),
    command("home", &[], Files::None),
    command("app-switcher", &[], Files::None),
    command("alert", &[], Files::None),
    command("keyboard", &[], Files::None),
    command("settings", &[&[("--app", T)]], Files::None),
    command("push", &[], Files::Push),
    command("orientation", &[], Files::None),
    command("focus", &[], Files::None),
    command("action-button", &[], Files::None),
    command("hardware-button", &[], Files::None),
    command("logs", &[&[("--restart", N)]], Files::Logs),
    command("capabilities", &[], Files::None),
    command("help", &[], Files::None),
];

/// A command as [`parse`] read it: its arguments, with `--flag=value` split in two, and what each one is.
#[derive(Debug, PartialEq)]
pub struct Parsed {
    pub command: &'static str,
    pub args: Vec<String>,
    pub roles: Vec<Role>,
}

/// A negative number stands where a positional argument does (`swipe 10 -20 …`), not a flag.
fn is_flag(arg: &str) -> bool {
    arg.starts_with('-') && !arg[1..].starts_with(|c: char| c.is_ascii_digit())
}

/// Reads an agent-device command against the commands and flags a screen on another machine runs: refused with the
/// reason when it names anything else.
pub fn parse(args: &[String]) -> Result<Parsed, McpToolError> {
    let all: Vec<&str> = COMMANDS.iter().map(|c| c.name).collect();
    let fix = format!(
        "use only these commands, the screen already chosen: {}",
        all.join(", ")
    );
    let Some(first) = args.first() else {
        return Ok(Parsed {
            command: "help",
            args: Vec::new(),
            roles: Vec::new(),
        });
    };
    if matches!(first.as_str(), "--help" | "-h" | "--version" | "-V") && args.len() == 1 {
        return Ok(Parsed {
            command: "help",
            args: args.to_vec(),
            roles: vec![Role::Plain],
        });
    }
    let Some(command) = COMMANDS.iter().find(|c| c.name == first) else {
        return Err(refuse(
            format!("agent-device `{first}` doesn't run here: {ONLY}."),
            &fix,
        ));
    };
    let flag = |name: &str| {
        COMMON
            .iter()
            .chain(command.flags.iter().flat_map(|f| f.iter()))
            .find(|(n, _)| *n == name)
            .map(|(_, take)| *take)
    };
    let mut parsed = Parsed {
        command: command.name,
        args: vec![first.clone()],
        roles: vec![Role::Plain],
    };
    let mut positional: Vec<usize> = Vec::new();
    let mut outs = 0;
    let mut rest = args[1..].iter();
    while let Some(arg) = rest.next() {
        if !is_flag(arg) {
            positional.push(parsed.args.len());
            parsed.args.push(arg.clone());
            parsed.roles.push(Role::Plain);
            continue;
        }
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) => (name, Some(value.to_owned())),
            None => (arg.as_str(), None),
        };
        let Some(take) = flag(name) else {
            return Err(refuse(
                format!(
                    "agent-device {} {name} doesn't run here: {ONLY}, on its own simulator.",
                    command.name
                ),
                &format!(
                    "leave {name} out (agent-device help {} lists the flags)",
                    command.name
                ),
            ));
        };
        parsed.args.push(name.to_owned());
        parsed.roles.push(Role::Plain);
        if take == Take::Nothing {
            if inline.is_some() {
                return Err(refuse(
                    format!("{name} takes no value."),
                    "leave the =value out",
                ));
            }
            continue;
        }
        let Some(value) = inline.or_else(|| rest.next().cloned()) else {
            return Err(refuse(format!("{name} needs a value."), "give it one"));
        };
        parsed.args.push(value);
        parsed.roles.push(if take == Take::Out {
            outs += 1;
            Role::Out
        } else {
            Role::Plain
        });
    }
    let at = |i: usize| positional.get(i).map(|&p| parsed.args[p].as_str());
    let mut role = |i: usize, role: Role| {
        if let Some(&p) = positional.get(i) {
            parsed.roles[p] = role;
        }
    };
    let named = |what: &str, example: &str| {
        refuse(
            format!(
                "agent-device {} needs a file name for {what} here.",
                command.name
            ),
            &format!("name one in your worktree, as in `agent-device {example}`"),
        )
    };
    match command.files {
        Files::None | Files::Open => {}
        Files::Install => match positional.len() {
            1 | 2 if command.name == "install" => role(positional.len() - 1, Role::In),
            2 => role(1, Role::In),
            _ => {
                return Err(refuse(
                    format!("agent-device {} takes an app and a file.", command.name),
                    "agent-device help install shows its shapes",
                ));
            }
        },
        Files::Screenshot => match (positional.len(), outs) {
            (1, 0) => role(0, Role::Out),
            (0, 1) => {}
            _ => return Err(named("the screenshot", "screenshot shots/home.png")),
        },
        Files::Record => match (at(0), positional.len(), outs) {
            (Some("start"), 2, 0) => role(1, Role::Out),
            (Some("start"), 1, 1) => {}
            (Some("start"), ..) => return Err(named("the recording", "record start run.mp4")),
            (Some("stop"), 1, 0) => {}
            _ => {
                return Err(refuse(
                    "Only `record start <file>` and `record stop` run here.",
                    "leave the rest out",
                ));
            }
        },
        Files::Logs => match (at(0), positional.len()) {
            (Some("path"), 2) => role(1, Role::Out),
            (Some("path"), _) => return Err(named("the log", "logs path logs/app.log")),
            (Some("start" | "stop" | "clear" | "doctor"), 1) | (Some("mark"), _) => {}
            _ => {
                return Err(refuse(
                    "Only `logs path <file>`, `logs start`, `logs stop`, `logs clear`, `logs doctor` and `logs mark \
                     [message]` run here.",
                    "leave the rest out",
                ));
            }
        },
        Files::Push => {
            if let Some(payload) = at(1)
                && !payload.trim_start().starts_with('{')
            {
                role(1, Role::InOrJson);
            }
        }
    }
    if command.files == Files::Open {
        let values = positional.iter().copied().chain(
            parsed
                .args
                .iter()
                .enumerate()
                .filter(|(_, a)| matches!(a.as_str(), "--launch-url" | "--bundle-url"))
                .map(|(i, _)| i + 1),
        );
        for i in values {
            let value = parsed.args[i].trim();
            if value.starts_with(['/', '~', '.']) || value.to_ascii_lowercase().starts_with("file:")
            {
                return Err(refuse(
                    format!(
                        "agent-device open {value} names a file on the screen's machine, which it doesn't open."
                    ),
                    "open an app by its bundle id or name, or a web or app URL",
                ));
            }
        }
    }
    // The macOS host's own privacy grants, which a simulator has none of.
    if command.name == "settings"
        && positional.iter().any(|&p| {
            matches!(
                parsed.args[p].as_str(),
                "accessibility" | "screen-recording" | "input-monitoring"
            )
        })
    {
        return Err(refuse(
            "Those settings are the host Mac's, not the simulator's.",
            "leave them out",
        ));
    }
    Ok(parsed)
}

/// A name a file has in a screen's folder: plain, with no path in it.
pub fn safe_name(name: &str) -> bool {
    (1..=128).contains(&name.len())
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-+@".contains(c))
}

/// `name`'s file name made plain for a screen's folder.
fn plain(name: &str) -> String {
    let plain: String = name
        .chars()
        .map(|c| match c {
            c if c.is_ascii_alphanumeric() || "._-+@".contains(c) => c,
            _ => '_',
        })
        .collect();
    let plain = plain.trim_start_matches('.');
    let plain: String = plain.chars().take(100).collect();
    if plain.is_empty() {
        "file".to_owned()
    } else {
        plain
    }
}

/// A file a command reads or writes, on the agent's side.
#[derive(Clone, Debug, PartialEq)]
pub struct Local {
    /// Its name in the screen's folder.
    pub name: String,
    pub path: PathBuf,
    /// As the agent wrote it, for what the command says back.
    pub shown: String,
}

/// An agent's command, ready for the screen's node: its file arguments read from, or to be written into, the agent's
/// worktree, each given a name in the screen's folder (`in/…`, `out/…`).
#[derive(Debug, PartialEq)]
pub struct Mapped {
    pub args: Vec<String>,
    pub inputs: Vec<Local>,
    pub outputs: Vec<Local>,
}

fn outside(shown: &str) -> McpToolError {
    refuse(
        format!(
            "{shown} is outside your worktree: only files in it go to the screen on another machine, or come back."
        ),
        "use a path in your worktree",
    )
}

/// The agent's command with its files mapped; `seq` numbers the names, so none is used twice in a session.
pub fn map(
    args: &[String],
    cwd: &Path,
    worktree: &Path,
    seq: &mut u64,
) -> Result<Mapped, McpToolError> {
    let parsed = parse(args)?;
    let root = std::fs::canonicalize(worktree).map_err(|e| {
        McpToolError::new(
            ErrorCode::Failed,
            format!("Your worktree {} can't be read: {e}.", worktree.display()),
        )
    })?;
    let mut mapped = Mapped {
        args: parsed.args.clone(),
        inputs: Vec::new(),
        outputs: Vec::new(),
    };
    let mut total = 0u64;
    for (i, role) in parsed.roles.iter().enumerate() {
        if *role == Role::Plain {
            continue;
        }
        let shown = parsed.args[i].clone();
        let path = cwd.join(&shown);
        *seq += 1;
        let name = format!(
            "{seq}-{}",
            plain(
                &path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default()
            )
        );
        if *role == Role::Out {
            let path = writable(&root, &path).ok_or_else(|| outside(&shown))?;
            mapped.args[i] = format!("out/{name}");
            mapped.outputs.push(Local { name, path, shown });
            continue;
        }
        let real = std::fs::canonicalize(&path).map_err(|e| {
            refuse(
                format!("{shown} can't be read: {e}."),
                "name a file that is there",
            )
        })?;
        if !real.starts_with(&root) {
            return Err(outside(&shown));
        }
        let meta = std::fs::metadata(&real).map_err(|e| {
            refuse(
                format!("{shown} can't be read: {e}."),
                "name a file that is there",
            )
        })?;
        if meta.is_dir() {
            return Err(refuse(
                format!("{shown} is a folder, and only files go to the screen on another machine."),
                "zip it first (`ditto -c -k --keepParent App.app App.zip`, or `zip -qry App.zip App.app`) and pass the .zip",
            ));
        }
        total += meta.len();
        if total > FILE_MAX {
            return Err(refuse(
                format!(
                    "The files this command reads come to more than {} MiB, the most that goes to a screen on another machine.",
                    FILE_MAX >> 20
                ),
                "send a smaller build (a Release build, zipped)",
            ));
        }
        mapped.args[i] = format!("in/{name}");
        mapped.inputs.push(Local {
            name,
            path: real,
            shown,
        });
    }
    Ok(mapped)
}

/// Where a file the command writes goes in the worktree, if inside it: its nearest folder that is there, resolved,
/// and the rest of its path, plain names only. None outside the worktree, or onto a symlink.
fn writable(root: &Path, path: &Path) -> Option<PathBuf> {
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    let mut at = path.to_path_buf();
    let base = loop {
        if let Ok(real) = std::fs::canonicalize(&at) {
            break real;
        }
        rest.push(at.file_name()?.to_owned());
        at = at.parent()?.to_path_buf();
    };
    let mut full = base;
    for part in rest.iter().rev() {
        match Path::new(part).components().next() {
            Some(Component::Normal(_)) => full.push(part),
            _ => return None,
        }
    }
    if rest.is_empty() {
        // The file is there already: it must be a file, not a folder or a link it would write through.
        let meta = std::fs::symlink_metadata(path).ok()?;
        if !meta.is_file() {
            return None;
        }
    }
    (full.starts_with(root) && full != root).then_some(full)
}

/// Writes a file a command wrote on the screen's node into the worktree: its folder made, checked inside the worktree
/// again, and the file replaced whole (never written through a link).
pub fn write_output(worktree: &Path, path: &Path, bytes: &[u8]) -> Result<(), String> {
    let root = std::fs::canonicalize(worktree).map_err(|e| e.to_string())?;
    let dir = path.parent().ok_or("no folder")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let real = std::fs::canonicalize(dir).map_err(|e| e.to_string())?;
    if !real.starts_with(&root) {
        return Err("outside the worktree".to_owned());
    }
    let target = real.join(path.file_name().ok_or("no file name")?);
    crate::node::secrets::write_atomic(&target, bytes).map_err(|e| e.to_string())
}

/// What the command said, with the screen's folder names put back as the agent wrote them.
pub fn shown_back(text: &str, files: &[&Local]) -> String {
    let mut text = text.to_owned();
    for file in files {
        for side in ["in", "out"] {
            text = text.replace(&format!("{side}/{}", file.name), &file.shown);
        }
    }
    text
}

/// The command as the action log shows it.
pub fn command_line(args: &[String]) -> String {
    let quoted: Vec<String> = args
        .iter()
        .map(|a| {
            if !a.is_empty()
                && a.chars()
                    .all(|c| c.is_ascii_alphanumeric() || "@~._-/:=+,".contains(c))
            {
                a.clone()
            } else {
                format!("'{}'", a.replace('\'', r"'\''"))
            }
        })
        .collect();
    format!("agent-device {}", quoted.join(" "))
}

// ---- sealed between the two nodes ----

/// Which way a sealed step goes.
#[derive(Clone, Copy)]
enum Way {
    Call,
    Answer,
}

/// A key of its own per way, from the session's relay key; a step's nonce is its count. So the hub can't read a
/// step, make one up, play one again or pass an answer off as another's.
fn sealer(relay_key: &[u8; 32], way: Way) -> crypto_secretbox::XSalsa20Poly1305 {
    use crypto_secretbox::KeyInit;
    use sha2::Digest;
    let label: &[u8] = match way {
        Way::Call => b"fleetd device 1: agent to runner",
        Way::Answer => b"fleetd device 1: runner to agent",
    };
    let key = sha2::Sha256::new()
        .chain_update(label)
        .chain_update(relay_key)
        .finalize();
    crypto_secretbox::XSalsa20Poly1305::new(crypto_secretbox::Key::from_slice(&key))
}

fn nonce(count: u64) -> crypto_secretbox::Nonce {
    let mut bytes = [0u8; 24];
    bytes[..8].copy_from_slice(&count.to_le_bytes());
    *crypto_secretbox::Nonce::from_slice(&bytes)
}

fn seal(relay_key: &[u8; 32], way: Way, count: u64, value: &impl serde::Serialize) -> String {
    use crypto_secretbox::aead::Aead;
    let plain =
        zeroize::Zeroizing::new(serde_json::to_vec(value).expect("a device step serializes"));
    let sealed = sealer(relay_key, way)
        .encrypt(&nonce(count), plain.as_slice())
        .expect("sealing fits");
    B64.encode(sealed)
}

fn open<T: serde::de::DeserializeOwned>(
    relay_key: &[u8; 32],
    way: Way,
    count: u64,
    data_b64: &str,
) -> Option<T> {
    use crypto_secretbox::aead::Aead;
    let sealed = B64.decode(data_b64).ok()?;
    let plain = zeroize::Zeroizing::new(
        sealer(relay_key, way)
            .decrypt(&nonce(count), sealed.as_slice())
            .ok()?,
    );
    serde_json::from_slice(&plain).ok()
}

/// A step, sealed by the agent's node as its `count`th.
pub fn seal_call(relay_key: &[u8; 32], count: u64, call: &DeviceCall) -> DeviceCall {
    DeviceCall::Sealed {
        count,
        data_b64: seal(relay_key, Way::Call, count, call),
    }
}

/// A sealed step, opened by the screen's node: None when it doesn't open, or is sealed again inside.
pub fn open_call(relay_key: &[u8; 32], count: u64, data_b64: &str) -> Option<DeviceCall> {
    open::<DeviceCall>(relay_key, Way::Call, count, data_b64)
        .filter(|call| !matches!(call, DeviceCall::Sealed { .. }))
}

pub fn seal_done(relay_key: &[u8; 32], count: u64, done: &DeviceDone) -> DeviceDone {
    DeviceDone::Sealed {
        data_b64: seal(relay_key, Way::Answer, count, done),
    }
}

/// The answer to the agent's `count`th step.
pub fn open_done(relay_key: &[u8; 32], count: u64, done: DeviceDone) -> Option<DeviceDone> {
    match done {
        DeviceDone::Sealed { data_b64 } => {
            open::<DeviceDone>(relay_key, Way::Answer, count, &data_b64)
                .filter(|done| !matches!(done, DeviceDone::Sealed { .. }))
        }
        _ => None,
    }
}

// ---- the screen's node ----

/// A hosted screen's own folder on the node that runs it: `in/` holds what its next command reads (gone after it),
/// `out/` what its commands wrote until the agent's node fetched it. The commands run in it; it goes with the screen.
pub struct Work {
    dir: PathBuf,
}

/// A command's outcome on the screen's node.
#[derive(Debug)]
pub struct Ran {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub files: Vec<DeviceFile>,
}

impl Ran {
    /// What the action log keeps of it, as a command's output there.
    pub fn output(&self) -> String {
        format!("{}{}", self.stdout, self.stderr)
    }

    pub fn done(self) -> DeviceDone {
        DeviceDone::Run {
            stdout: self.stdout,
            stderr: self.stderr,
            exit_code: self.exit_code,
            files: self.files,
        }
    }
}

fn failed(what: &str, e: impl std::fmt::Display) -> McpToolError {
    McpToolError::new(
        ErrorCode::Failed,
        format!("The screen's node could not {what}: {e}."),
    )
    .with_fix("try again; if it keeps failing, say so in your result")
}

impl Work {
    pub fn at(home: &Path, session: &str) -> Self {
        Self {
            dir: home.join("sessions").join(session).join("device-work"),
        }
    }

    #[cfg(test)]
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn ensure(&self) -> std::io::Result<()> {
        for dir in [self.dir.clone(), self.dir.join("in"), self.dir.join("out")] {
            crate::node::config::mkdir_private(&dir)?;
        }
        Ok(())
    }

    fn total_in(&self) -> u64 {
        std::fs::read_dir(self.dir.join("in"))
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| e.metadata().ok())
            .map(|m| m.len())
            .sum()
    }

    /// One piece of a file the next command reads, after the pieces before it.
    pub fn put(&self, name: &str, offset: u64, data_b64: &str) -> Result<DeviceDone, McpToolError> {
        if !safe_name(name) {
            return Err(refuse(
                format!("{name} is not a plain file name."),
                "send it under a plain one",
            ));
        }
        let data = B64
            .decode(data_b64)
            .map_err(|e| refuse(format!("the piece is not base64: {e}"), "send it again"))?;
        if data.len() > PIECE {
            return Err(refuse("the piece is too large", "send smaller pieces"));
        }
        self.ensure()
            .map_err(|e| failed("make the screen's folder", e))?;
        let path = self.dir.join("in").join(name);
        let had = match std::fs::symlink_metadata(&path) {
            Ok(meta) if meta.is_file() => meta.len(),
            Ok(_) => {
                return Err(refuse(
                    format!("{name} is not a file here."),
                    "send it under another name",
                ));
            }
            Err(_) => 0,
        };
        if had != offset {
            return Err(refuse(
                format!("{name} has {had} bytes here, not {offset}."),
                "send the file again from its start under a new name",
            ));
        }
        if self.total_in() + data.len() as u64 > FILE_MAX {
            return Err(refuse(
                format!(
                    "The files for one command come to more than {} MiB.",
                    FILE_MAX >> 20
                ),
                "send a smaller build",
            ));
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .custom_flags(nix::libc::O_NOFOLLOW)
            .open(&path)
            .map_err(|e| failed("keep the file", e))?;
        file.write_all(&data)
            .map_err(|e| failed("keep the file", e))?;
        Ok(DeviceDone::Put {
            bytes: offset + data.len() as u64,
        })
    }

    /// One piece of a file a command wrote; the file goes once its last piece is read.
    pub fn get(&self, name: &str, offset: u64) -> Result<DeviceDone, McpToolError> {
        let path = self.dir.join("out").join(name);
        let meta = std::fs::symlink_metadata(&path)
            .ok()
            .filter(|m| safe_name(name) && m.is_file())
            .ok_or_else(|| {
                McpToolError::new(ErrorCode::NotFound, format!("No file {name} here."))
            })?;
        let total = meta.len();
        if total > FILE_MAX {
            let _ = std::fs::remove_file(&path);
            return Err(refuse(
                format!(
                    "{name} is {} MiB, more than the {} MiB that come back.",
                    total >> 20,
                    FILE_MAX >> 20
                ),
                "make it smaller (a shorter recording)",
            ));
        }
        let mut file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_NOFOLLOW)
            .open(&path)
            .map_err(|e| failed("read the file", e))?;
        file.seek(std::io::SeekFrom::Start(offset))
            .map_err(|e| failed("read the file", e))?;
        let mut data = Vec::new();
        file.take(PIECE as u64)
            .read_to_end(&mut data)
            .map_err(|e| failed("read the file", e))?;
        if offset + data.len() as u64 >= total {
            let _ = std::fs::remove_file(&path);
        }
        Ok(DeviceDone::Get {
            data_b64: B64.encode(&data),
            total,
        })
    }

    /// A `put` or a `get`.
    pub fn step(&self, call: DeviceCall) -> Result<DeviceDone, McpToolError> {
        match call {
            DeviceCall::Put {
                name,
                offset,
                data_b64,
            } => self.put(&name, offset, &data_b64),
            DeviceCall::Get { name, offset } => self.get(&name, offset),
            DeviceCall::Run { .. } | DeviceCall::Sealed { .. } => {
                Err(refuse("not a file step", "send it as a run"))
            }
        }
    }

    /// Checks a command the agent's node sent: one [`parse`] allows, its files only in this folder (`in/` ones sent
    /// already), and an install only where the node allows it.
    pub fn check(&self, args: &[String], install: bool) -> Result<(), McpToolError> {
        let parsed = parse(args)?;
        if parsed.args != args {
            return Err(refuse(
                "the command is not in its plain form",
                "send it as the agent's node maps it",
            ));
        }
        if !install && matches!(parsed.command, "install" | "reinstall") {
            return Err(McpToolError::new(
                ErrorCode::Forbidden,
                format!(
                    "The Mac hosting this screen doesn't take apps from agents on other machines: its node.json has \
                     \"ios\": {{\"remoteInstall\": false}}, so `agent-device {}` is refused.",
                    parsed.command
                ),
            )
            .with_fix("say so in your result: a person sets \"remoteInstall\" to true (or leaves it out) in that Mac's node.json"));
        }
        for (arg, role) in parsed.args.iter().zip(&parsed.roles) {
            let (side, name) = match role {
                Role::Plain => continue,
                Role::Out => ("out", arg.strip_prefix("out/")),
                Role::In | Role::InOrJson => ("in", arg.strip_prefix("in/")),
            };
            let Some(name) = name.filter(|n| safe_name(n)) else {
                return Err(refuse(
                    format!("{arg} is not a file of this screen's folder."),
                    "send files as the agent's node maps them",
                ));
            };
            if side == "in"
                && !std::fs::symlink_metadata(self.dir.join("in").join(name))
                    .is_ok_and(|m| m.is_file())
            {
                return Err(refuse(format!("{arg} was not sent."), "send it first"));
            }
        }
        Ok(())
    }

    /// Runs a checked command with `program` (the node's agent-device wrapper) in this folder, with the node's own
    /// environment less any agent-device setting, then `env` (the screen's agent-device home and control file). The
    /// files it read go; the ones it wrote are listed.
    pub async fn run(
        &self,
        program: &Path,
        env: &[(String, String)],
        args: &[String],
        wait: Duration,
    ) -> Ran {
        if let Err(e) = self.ensure() {
            return Ran {
                stdout: String::new(),
                stderr: format!("fleetd: the screen's folder could not be made: {e}\n"),
                exit_code: 1,
                files: Vec::new(),
            };
        }
        // `logs path <file>`: agent-device takes no file there, and its log is copied into `out/` after it.
        let log = parse(args)
            .ok()
            .filter(|p| p.command == "logs")
            .and_then(|p| p.roles.iter().position(|r| *r == Role::Out));
        let mut run_args = self.paths(args);
        if let Some(i) = log {
            run_args.remove(i);
        }
        let mut command = tokio::process::Command::new(program);
        command
            .args(run_args)
            .current_dir(&self.dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().starts_with("AGENT_DEVICE_") {
                command.env_remove(key);
            }
        }
        command.envs(env.iter().map(|(k, v)| (k, v)));
        let (mut stdout, mut stderr, mut exit_code) = match command.spawn() {
            Err(e) => (
                String::new(),
                format!("fleetd: agent-device did not start: {e}\n"),
                1,
            ),
            Ok(child) => match tokio::time::timeout(wait, child.wait_with_output()).await {
                Ok(Ok(out)) => (
                    self.text(&out.stdout),
                    self.text(&out.stderr),
                    out.status.code().unwrap_or(1),
                ),
                Ok(Err(e)) => (
                    String::new(),
                    format!("fleetd: agent-device failed: {e}\n"),
                    1,
                ),
                Err(_) => (
                    String::new(),
                    format!(
                        "fleetd: agent-device ran past {} s and was stopped.\n",
                        wait.as_secs()
                    ),
                    124,
                ),
            },
        };
        let _ = std::fs::remove_dir_all(self.dir.join("in"));
        if let Some(i) = log
            && exit_code == 0
        {
            let out = &args[i];
            match self.bring_log(&stdout, out.strip_prefix("out/").unwrap_or(out)) {
                Ok(said) => stdout = stdout.replace(&said, out),
                Err(e) => {
                    stderr.push_str(&format!("fleetd: {e}\n"));
                    exit_code = 1;
                }
            }
        }
        Ran {
            stdout,
            stderr,
            exit_code,
            files: self.written(),
        }
    }

    /// The app log `logs path` named, in an agent-device home of this node (the screen's own, or the clone's it
    /// lends), copied into `out/` as `name`, its last [`FILE_MAX`] bytes if it is longer, so it comes back as a
    /// screenshot does. The path agent-device said, from its text or its `--json`.
    fn bring_log(&self, stdout: &str, name: &str) -> Result<String, String> {
        let said = serde_json::from_str::<serde_json::Value>(stdout)
            .ok()
            .and_then(|v| {
                let path = v.pointer("/data/path").or_else(|| v.get("path"))?;
                path.as_str().map(str::to_owned)
            })
            .unwrap_or_else(|| stdout.lines().next().unwrap_or_default().trim().to_owned());
        let home = self
            .dir
            .ancestors()
            .nth(3)
            .and_then(|home| std::fs::canonicalize(home).ok());
        let real = std::fs::canonicalize(&said).ok().filter(|real| {
            real.file_name().is_some_and(|n| n == "app.log")
                && home.as_ref().is_some_and(|home| real.starts_with(home))
                && real.is_file()
        });
        let Some(real) = real else {
            return Err(format!(
                "there is no app log to send back yet ({}): open the app, or run `agent-device logs start`, first",
                if said.is_empty() {
                    "agent-device named none"
                } else {
                    &said
                }
            ));
        };
        let copy = || -> std::io::Result<()> {
            let mut log = std::fs::File::open(&real)?;
            let len = log.metadata()?.len();
            log.seek(std::io::SeekFrom::Start(len.saturating_sub(FILE_MAX)))?;
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(nix::libc::O_NOFOLLOW)
                .open(self.dir.join("out").join(name))?;
            std::io::copy(&mut log.take(FILE_MAX), &mut file).map(drop)
        };
        copy().map_err(|e| format!("the app log {said} could not be copied: {e}"))?;
        Ok(said)
    }

    /// A checked command with its files (`in/…`, `out/…`) as full paths in this folder: agent-device's daemon reads
    /// `install`'s app from its own working directory, not the command's, and the session's daemon starts at
    /// session_start in the node's ([`super::ios::session::Session::start_runner`]), so `in/…` was looked for there.
    fn paths(&self, args: &[String]) -> Vec<String> {
        let Ok(parsed) = parse(args) else {
            return args.to_vec();
        };
        args.iter()
            .zip(&parsed.roles)
            .map(|(arg, role)| match role {
                Role::Plain => arg.clone(),
                _ => self.dir.join(arg).to_string_lossy().into_owned(),
            })
            .collect()
    }

    /// A checked command held back unrun, with exit code 75 and `stderr`: the files sent for it go, as a run's do, so
    /// the agent's node sends them again with the command and they never pile up past [`FILE_MAX`].
    pub fn held_back(&self, stderr: &str) -> Ran {
        let _ = std::fs::remove_dir_all(self.dir.join("in"));
        Ran {
            stdout: String::new(),
            stderr: stderr.to_owned(),
            exit_code: 75,
            files: Vec::new(),
        }
    }

    /// A command's output, cut short, with this folder's own path left out: the files in it go by their names alone.
    fn text(&self, bytes: &[u8]) -> String {
        let mut text = String::from_utf8_lossy(&bytes[..bytes.len().min(OUTPUT_MAX)]).into_owned();
        let mut dirs = vec![self.dir.clone()];
        if let Ok(real) = std::fs::canonicalize(&self.dir) {
            dirs.insert(0, real);
        }
        for dir in dirs {
            text = text.replace(&format!("{}/", dir.display()), "");
        }
        text
    }

    /// The files in `out/`, plain files only.
    fn written(&self) -> Vec<DeviceFile> {
        let mut files: Vec<DeviceFile> = std::fs::read_dir(self.dir.join("out"))
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                let meta = std::fs::symlink_metadata(e.path()).ok()?;
                (meta.is_file() && safe_name(&name)).then_some(DeviceFile {
                    name,
                    bytes: meta.len(),
                })
            })
            .collect();
        files.sort_by(|a, b| a.name.cmp(&b.name));
        files
    }

    /// The screen ended: its folder goes.
    pub fn remove(&self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

// ---- the agent's node ----

/// The folder put first on an agent session's PATH: it holds the forwarding `agent-device` only while the session's
/// screen runs on another machine, and isn't there otherwise.
pub fn bin_dir(home: &Path, thread: &str) -> PathBuf {
    home.join("sessions").join(thread).join("device-remote")
}

/// The forwarding `agent-device`: `exe` (this node's binary) sends each command to the node, which knows the session
/// by the calling process.
pub fn forwarder_script(exe: &str) -> String {
    format!(
        "#!/bin/sh\n\
         # fleetd's: agent-device commands for this session's screen on another machine, through the hub.\n\
         exec '{}' agent-device \"$@\"\n",
        exe.replace('\'', r"'\''")
    )
}

pub fn install_forwarder(home: &Path, thread: &str, exe: &str) -> std::io::Result<()> {
    let dir = bin_dir(home, thread);
    crate::node::config::mkdir_private(&dir)?;
    let bin = dir.join("agent-device");
    crate::node::secrets::write_atomic(&bin, forwarder_script(exe).as_bytes())?;
    std::fs::set_permissions(&bin, std::os::unix::fs::PermissionsExt::from_mode(0o700))
}

pub fn remove_forwarder(home: &Path, thread: &str) {
    let _ = std::fs::remove_dir_all(bin_dir(home, thread));
}

/// At the node's start: the forwarders and screen folders a stopped node left. Their screens went with it.
pub fn sweep(home: &Path) {
    for entry in std::fs::read_dir(home.join("sessions"))
        .into_iter()
        .flatten()
        .flatten()
    {
        for dir in ["device-remote", "device-work"] {
            let _ = std::fs::remove_dir_all(entry.path().join(dir));
        }
    }
}

/// The agent sessions whose screen runs on another machine, on their node: its id, and the files its commands will
/// write that are still to come back (`record start` writes at `record stop`).
#[derive(Clone, Default)]
pub struct Remotes(std::sync::Arc<std::sync::Mutex<HashMap<String, Remote>>>);

pub struct Remote {
    pub session_id: String,
    /// The key the agent's node sealed to the screen's node at the start: its steps go sealed with it.
    pub relay_key: zeroize::Zeroizing<[u8; 32]>,
    /// The steps sealed so far.
    pub count: u64,
    /// The file names given so far.
    pub seq: u64,
    pub outputs: HashMap<String, Local>,
    /// One command at a time, so its steps reach the screen's node in their order.
    pub turn: std::sync::Arc<tokio::sync::Mutex<()>>,
}

impl Remote {
    pub fn new(session_id: String, relay_key: zeroize::Zeroizing<[u8; 32]>) -> Self {
        Self {
            session_id,
            relay_key,
            count: 0,
            seq: 0,
            outputs: HashMap::new(),
            turn: Default::default(),
        }
    }
}

impl Remotes {
    pub fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Remote>> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn has(&self, thread: &str) -> bool {
        self.lock().contains_key(thread)
    }
}

#[cfg(test)]
#[path = "remote_tests.rs"]
mod tests;
