//! The agents' Mac's setup checks (docs: agents-mac.md), run by the node as its own user, so each tests what a
//! process of that user can do. Each is a pure verdict on what a [`Probe`] read; [`Live`] reads the Mac, tests fake it.
//! A failing check says exactly what the person does, and where: in an admin's Terminal, or at the Mac in the account
//! the node runs in (yours, an admin's, or a user of its own for agents: D309).
use std::process::{Command, Stdio};

use fleetd_contracts::node_link::{MacCheck, MacCheckId, MacCheckState, MacHealth};
use fleetd_contracts::prim::Text;

use super::tools::ToolsState;
use super::xcode::{self, Located};

/// What a command said: its exit code (None when it didn't run or was killed), stdout and stderr together.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Ran {
    pub code: Option<i32>,
    pub out: String,
}

impl Ran {
    fn ok(&self) -> bool {
        self.code == Some(0)
    }
}

/// What the checks read of the Mac.
pub trait Probe {
    /// The macOS user the node runs as.
    fn user(&self) -> String;
    /// A command, never through a shell.
    fn run(&self, program: &str, args: &[&str]) -> Ran;
    /// The Xcode bundles in /Applications ([`xcode::in_applications`]).
    fn xcodes(&self) -> Vec<String>;
    fn is_dir(&self, path: &str) -> bool;
    /// `AXIsProcessTrusted()`; None where it can't be asked.
    fn accessibility(&self) -> Option<bool>;
    /// `CGPreflightScreenCaptureAccess()`; None where it can't be asked.
    fn screen_recording(&self) -> Option<bool>;
    /// Who owns the Mac's screen (/dev/console): a user, or `root` at the login window.
    fn console_user(&self) -> Option<String>;
    /// The keep-awake assertion: held, or why not.
    fn awake(&self) -> Result<(), String>;
    fn tools(&self) -> ToolsState;
    /// CocoaPods, from Homebrew ([`HOMEBREW_BINS`]).
    fn pods(&self) -> Pods;
}

/// Where Homebrew puts its commands: Apple silicon's, then Intel's. Jobs get both on their PATH (mac_tool/jobs.rs).
pub const HOMEBREW_BINS: [&str; 2] = ["/opt/homebrew/bin", "/usr/local/bin"];

/// Homebrew's own install line, from brew.sh: it asks for the account's password itself.
pub const HOMEBREW_INSTALL: &str = "/bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"";

/// What the tools check reads of CocoaPods, which `pod install` and `expo prebuild --platform ios` need: the Mac's own
/// Ruby is too old for any current CocoaPods, so it comes from Homebrew, the person's.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Pods {
    /// `pod --version`, from the first of Homebrew's bins that has `pod`; None where none has.
    pub pod: Option<Ran>,
    /// `brew`, where it is; None before Homebrew is installed.
    pub brew: Option<String>,
    /// Where `brew` lands once installed, on this Mac's chip.
    pub brew_at: String,
}

/// Every check, in the order the guide shows them.
pub fn run(probe: &dyn Probe) -> MacHealth {
    let user = probe.user();
    // xcodebuild runs only once an Xcode is selected: before that it says xcode-select's error, not what to do.
    let selected = probe.run("xcode-select", &["-p"]);
    let located = xcode::locate(
        selected.ok().then_some(selected.out.as_str()),
        &probe.xcodes(),
        |p| probe.is_dir(p),
    );
    let xcode = match located {
        Located::Selected(path) => xcode_ready(
            &path,
            &probe.run("xcodebuild", &["-license", "check"]),
            &probe.run("xcodebuild", &["-checkFirstLaunchStatus"]),
            &probe.run("xcodebuild", &["-version"]),
        ),
        other => no_xcode(&other),
    };
    let checks = vec![
        developer(
            &user,
            &probe.run(
                "dseditgroup",
                &["-o", "checkmember", "-m", &user, "_developer"],
            ),
            &probe.run("DevToolsSecurity", &["-status"]),
        ),
        xcode.clone(),
        if xcode.state == Pass {
            ios_runtime(&probe.run("xcrun", &["simctl", "list", "runtimes"]))
        } else {
            waits_for_xcode()
        },
        grant(MacCheckId::Accessibility, probe.accessibility()),
        grant(MacCheckId::ScreenRecording, probe.screen_recording()),
        gui_session(&user, probe.console_user().as_deref()),
        tools(&probe.tools(), &probe.pods()),
        keep_awake(probe.awake()),
    ];
    super::health(&user, checks)
}

/// What the person does: where, and the command to paste there when there is one.
pub struct Fix {
    pub label: String,
    pub command: Option<String>,
}

fn check(id: MacCheckId, state: MacCheckState, message: &str, fix: Option<Fix>) -> MacCheck {
    let (fix, command) = match fix {
        Some(f) => (Some(f.label), f.command),
        None => (None, None),
    };
    MacCheck {
        id,
        state,
        message: Text::unchecked(super::clip(message, 500)),
        fix: fix.map(|f| Text::unchecked(super::clip(&f, 300))),
        command: command.map(|c| Text::unchecked(super::clip(&c, 300))),
    }
}

fn said(label: impl Into<String>) -> Option<Fix> {
    Some(Fix {
        label: label.into(),
        command: None,
    })
}

use MacCheckState::{Fail, Ok as Pass, Unknown, Warn};

/// In the person's own account, which is an admin's: the only place an admin step happens.
fn yours(command: impl Into<String>) -> Option<Fix> {
    Some(Fix {
        label: "In your own (admin) account's Terminal".into(),
        command: Some(command.into()),
    })
}

/// `dseditgroup -o checkmember` ("yes <user> is a member of _developer", or "no ...") and `DevToolsSecurity -status`
/// ("Developer mode is currently enabled.", or "... disabled."). Both are needed: with Developer Mode off, each
/// simulator's XCTest runner waits on a "Developer Tools Access" password prompt at the Mac's screen, and that
/// simulator's installs and launches hang behind it.
pub fn developer(user: &str, member: &Ran, devtools: &Ran) -> MacCheck {
    let join = format!("sudo dseditgroup -o edit -a {user} -t user _developer");
    let enable = "sudo DevToolsSecurity -enable";
    let member = member.out.split_whitespace().next();
    let mode = if devtools.out.contains("disabled") {
        Some(false)
    } else if devtools.out.contains("enabled") {
        Some(true)
    } else {
        None
    };
    match (member, mode) {
        (Some("yes"), Some(true)) => check(
            MacCheckId::Developer,
            Pass,
            &format!(
                "{user} is in _developer and Developer Mode is on: simulators and debugging ask for no password."
            ),
            None,
        ),
        (Some("yes"), Some(false)) => check(
            MacCheckId::Developer,
            Fail,
            "Developer Mode is off, so each iOS simulator's test runner waits on a password prompt at the Mac's \
             screen, and installs into that simulator hang.",
            yours(enable),
        ),
        (Some("no"), Some(true)) => check(
            MacCheckId::Developer,
            Fail,
            &format!("{user} isn't in _developer, so Xcode would ask for an admin's password."),
            yours(join),
        ),
        (Some("no"), Some(false)) => check(
            MacCheckId::Developer,
            Fail,
            &format!(
                "{user} isn't in _developer and Developer Mode is off, so Xcode asks for an admin's password and \
                 installs into iOS simulators hang."
            ),
            yours(format!("{enable} && {join}")),
        ),
        _ => check(
            MacCheckId::Developer,
            Unknown,
            &format!(
                "dseditgroup and DevToolsSecurity didn't say whether {user} is in _developer with Developer Mode on."
            ),
            yours(format!("{enable} && {join}")),
        ),
    }
}

/// The developer check, when it fails: iOS simulators would hang on its password prompt, so `mac sim start` refuses
/// with its fix instead. From the node's last checks at `home` ([`super::read_health`]).
pub fn blocks_simulators(home: &std::path::Path) -> Option<MacCheck> {
    let (health, _) = super::read_health(home)?;
    health
        .checks
        .iter()
        .find(|c| c.id == MacCheckId::Developer && c.state == Fail)
        .cloned()
}

/// Xcode isn't usable yet: not installed, or not the one selected. Only iOS simulators and builds wait for it, so it
/// warns, and setup finishes; the node checks again every [`super::CHECK_EVERY`].
pub fn no_xcode(located: &Located) -> MacCheck {
    match located {
        Located::Unselected { found, why } => check(
            MacCheckId::Xcode,
            Warn,
            &format!(
                "{} is in /Applications, but {why}. iOS simulators and builds wait for it; everything else works.",
                xcode::name(found)
            ),
            yours(xcode::switch(found)),
        ),
        _ => check(
            MacCheckId::Xcode,
            Warn,
            "Xcode isn't installed. iOS simulators and builds wait for it; everything else works.",
            Some(Fix {
                label: "Install Xcode from the App Store; this check looks again by itself".into(),
                command: Some(format!("open \"{}\"", xcode::APP_STORE)),
            }),
        ),
    }
}

/// A full Xcode selected at `path`: its licence, then its first launch.
pub fn xcode_ready(path: &str, license: &Ran, first_launch: &Ran, version: &Ran) -> MacCheck {
    if !license.ok() {
        return check(
            MacCheckId::Xcode,
            Warn,
            "Xcode's licence isn't accepted, so xcodebuild and simctl refuse to run. iOS simulators wait for it.",
            yours(xcode::ACCEPT),
        );
    }
    if !first_launch.ok() {
        return check(
            MacCheckId::Xcode,
            Warn,
            "Xcode's first launch hasn't run: its system components aren't installed. iOS simulators wait for it.",
            yours(xcode::FIRST_LAUNCH),
        );
    }
    let name = version.out.lines().next().unwrap_or("Xcode").trim();
    check(
        MacCheckId::Xcode,
        Pass,
        &format!("{name} at {path}, licence accepted."),
        None,
    )
}

/// The simulator check while Xcode isn't usable: the Xcode check says what to do.
pub fn waits_for_xcode() -> MacCheck {
    check(
        MacCheckId::IosRuntime,
        Warn,
        "Waits for Xcode: the Xcode check says what it needs.",
        None,
    )
}

/// `xcrun simctl list runtimes`: a line like "iOS 26.0 (26.0 - 23A343) - com.apple...", without "unavailable".
pub fn ios_runtime(ran: &Ran) -> MacCheck {
    let runtime = ran
        .out
        .lines()
        .map(str::trim)
        .rfind(|l| l.starts_with("iOS ") && !l.contains("unavailable"));
    match runtime {
        Some(line) if ran.ok() => check(
            MacCheckId::IosRuntime,
            Pass,
            line.split(" - ").next().unwrap_or(line),
            None,
        ),
        _ => check(
            MacCheckId::IosRuntime,
            Fail,
            "No iOS simulator runtime is installed.",
            yours("xcodebuild -downloadPlatform iOS"),
        ),
    }
}

/// System Settings' pane for a grant, by its URL.
pub fn pane(id: MacCheckId) -> &'static str {
    match id {
        MacCheckId::ScreenRecording => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        }
        _ => "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    }
}

fn grant_words(id: MacCheckId) -> (&'static str, &'static str) {
    match id {
        MacCheckId::ScreenRecording => (
            "Screen Recording",
            "the node can't show or record the Mac's screen",
        ),
        _ => (
            "Accessibility",
            "the node can't click or type in the Mac's apps",
        ),
    }
}

/// Has the node ask macOS for the grant (its prompt, and fleetd in the list), then opens the grant's pane.
pub fn ask_command(id: MacCheckId) -> String {
    format!("fleetd node grants --ask {}", id.as_str())
}

pub fn grant(id: MacCheckId, granted: Option<bool>) -> MacCheck {
    let (what, why) = grant_words(id);
    match granted {
        Some(true) => check(id, Pass, &format!("fleetd has {what}."), None),
        Some(false) => check(
            id,
            Fail,
            &format!("fleetd doesn't have {what}, so {why}."),
            Some(Fix {
                label: format!(
                    "In Terminal at the Mac, then turn on fleetd in System Settings › Privacy & Security › {what}, \
                     which this opens once macOS has asked. macOS asks again from time to time: turn it on again then"
                ),
                command: Some(ask_command(id)),
            }),
        ),
        None => check(
            id,
            Unknown,
            &format!("The node can't ask macOS about {what} here."),
            None,
        ),
    }
}

/// A grant macOS stopped counting with an update to this version (grants.rs's `lost`): the switch may still read on.
pub fn lost_grant(id: MacCheckId) -> MacCheck {
    let (what, why) = grant_words(id);
    check(
        id,
        Fail,
        &format!(
            "macOS stopped counting fleetd's {what} with the update to {}, so {why}.",
            crate::version_label(crate::version())
        ),
        Some(Fix {
            label: format!(
                "In Terminal at the Mac, then turn fleetd off and on again in System Settings › Privacy & Security \
                 › {what}, which this opens once macOS has asked"
            ),
            command: Some(ask_command(id)),
        }),
    )
}

pub fn gui_session(user: &str, console: Option<&str>) -> MacCheck {
    match console {
        Some(c) if c == user => check(
            MacCheckId::GuiSession,
            Pass,
            &format!("console: {user} is at the Mac's screen, so agents can drive its apps."),
            None,
        ),
        Some(c) => {
            let who = match c {
                "root" | "" => "the login window".to_owned(),
                other => other.to_owned(),
            };
            check(
                MacCheckId::GuiSession,
                Warn,
                &format!(
                    "background: {who} is at the Mac's screen. Builds and simulators work; the Mac's own apps need \
                     {user} at the screen."
                ),
                said(format!(
                    "At the Mac, switch to {user} (or use a Mac nobody else sits at)"
                )),
            )
        }
        None => check(
            MacCheckId::GuiSession,
            Unknown,
            "The node couldn't tell who is at the Mac's screen.",
            None,
        ),
    }
}

pub fn tools(state: &ToolsState, pods: &Pods) -> MacCheck {
    match state {
        ToolsState::Ready(versions) => cocoapods(versions, pods),
        ToolsState::Installing => check(
            MacCheckId::Tools,
            Unknown,
            "Installing the pinned Node.js, agent-device and agent-desktop.",
            None,
        ),
        ToolsState::Failed(why) => check(
            MacCheckId::Tools,
            Fail,
            &format!("The pinned tools didn't install: {why}"),
            said(
                "Check that the Mac reaches nodejs.org and registry.npmjs.org; the node tries again when it restarts",
            ),
        ),
    }
}

/// The pinned tools are in, and CocoaPods runs or not. Without it only iOS builds with Pods wait, so it warns with the
/// one command that installs it (Homebrew first where there is none), and setup ends; the check runs `pod` again
/// every [`super::CHECK_EVERY`].
fn cocoapods(versions: &str, pods: &Pods) -> MacCheck {
    let version = pods.pod.as_ref().filter(|ran| ran.ok()).and_then(|ran| {
        ran.out
            .lines()
            .map(str::trim)
            .rfind(|l| l.starts_with(|c: char| c.is_ascii_digit()))
    });
    if let Some(version) = version {
        return check(
            MacCheckId::Tools,
            Pass,
            &format!("{versions} CocoaPods {version}."),
            None,
        );
    }
    let missing = match &pods.pod {
        Some(ran) => format!(
            "CocoaPods doesn't run ({})",
            ran.out
                .lines()
                .map(str::trim)
                .find(|l| !l.is_empty())
                .unwrap_or("no output")
        ),
        None => "CocoaPods isn't installed".to_owned(),
    };
    let command = match &pods.brew {
        Some(brew) => format!("{brew} install cocoapods"),
        None => format!("{HOMEBREW_INSTALL} && {} install cocoapods", pods.brew_at),
    };
    check(
        MacCheckId::Tools,
        Warn,
        &format!(
            "{versions} {missing}, so pod install and expo prebuild --platform ios don't run; everything else works."
        ),
        yours(command),
    )
}

pub fn keep_awake(held: Result<(), String>) -> MacCheck {
    match held {
        Ok(()) => check(
            MacCheckId::KeepAwake,
            Pass,
            "fleetd keeps the Mac from sleeping while it is idle (a closed laptop lid still sleeps).",
            None,
        ),
        Err(why) => check(
            MacCheckId::KeepAwake,
            Fail,
            &format!("fleetd can't keep the Mac awake: {why}."),
            yours("sudo pmset -a sleep 0"),
        ),
    }
}

/// A command's exit code and output, never through a shell.
fn ran(command: &mut Command) -> Ran {
    match command.stdin(Stdio::null()).output() {
        Ok(out) => Ran {
            code: out.status.code(),
            out: format!(
                "{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            ),
        },
        Err(e) => Ran {
            code: None,
            out: e.to_string(),
        },
    }
}

/// The Mac itself.
pub struct Live {
    pub awake: Result<(), String>,
    pub tools: ToolsState,
}

impl Probe for Live {
    fn user(&self) -> String {
        super::user()
    }

    fn run(&self, program: &str, args: &[&str]) -> Ran {
        ran(Command::new(program).args(args))
    }

    fn xcodes(&self) -> Vec<String> {
        xcode::in_applications(std::path::Path::new("/Applications"))
    }

    fn is_dir(&self, path: &str) -> bool {
        std::path::Path::new(path).is_dir()
    }

    fn accessibility(&self) -> Option<bool> {
        super::tcc::accessibility()
    }

    fn screen_recording(&self) -> Option<bool> {
        super::tcc::screen_recording()
    }

    fn console_user(&self) -> Option<String> {
        let ran = self.run("stat", &["-f", "%Su", "/dev/console"]);
        ran.ok().then(|| ran.out.trim().to_owned())
    }

    fn awake(&self) -> Result<(), String> {
        self.awake.clone()
    }

    fn tools(&self) -> ToolsState {
        self.tools.clone()
    }

    fn pods(&self) -> Pods {
        let has = |name: &str| {
            HOMEBREW_BINS
                .iter()
                .map(|bin| format!("{bin}/{name}"))
                .find(|path| std::path::Path::new(path).is_file())
        };
        // CocoaPods refuses to run outside UTF-8, and a launchd service gets no LANG.
        let pod = has("pod").map(|pod| {
            ran(Command::new(pod)
                .arg("--version")
                .env("LANG", "en_US.UTF-8"))
        });
        let ours = if cfg!(target_arch = "aarch64") { 0 } else { 1 };
        Pods {
            pod,
            brew: has("brew"),
            brew_at: format!("{}/brew", HOMEBREW_BINS[ours]),
        }
    }
}
