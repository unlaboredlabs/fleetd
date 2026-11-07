//! The agents' Mac's setup checks (docs: agents-mac.md), run by the node as its own user, so each tests what a
//! process of that user can do. Each is a pure verdict on what a [`Probe`] read; [`Live`] reads the Mac, tests fake it.
//! A failing check says exactly what the person does, and where: in an admin's Terminal, or at the Mac in the account
//! the node runs in (yours, an admin's, or a user of its own for agents: D309).
use std::path::PathBuf;
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
        tools(&probe.tools()),
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

/// `dseditgroup -o checkmember`: "yes <user> is a member of _developer", or "no ...".
pub fn developer(user: &str, ran: &Ran) -> MacCheck {
    let fix = || {
        yours(format!(
            "sudo dseditgroup -o edit -a {user} -t user _developer"
        ))
    };
    match ran.out.split_whitespace().next() {
        Some("yes") => check(
            MacCheckId::Developer,
            Pass,
            &format!("{user} is in _developer: simulators and debugging ask for no admin."),
            None,
        ),
        Some("no") => check(
            MacCheckId::Developer,
            Fail,
            &format!("{user} isn't in _developer, so Xcode would ask for an admin's password."),
            fix(),
        ),
        _ => check(
            MacCheckId::Developer,
            Unknown,
            &format!("dseditgroup didn't say whether {user} is in _developer."),
            fix(),
        ),
    }
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

pub fn grant(id: MacCheckId, granted: Option<bool>) -> MacCheck {
    let (what, why) = match id {
        MacCheckId::ScreenRecording => (
            "Screen Recording",
            "the node can't show or record the Mac's screen",
        ),
        _ => (
            "Accessibility",
            "the node can't click or type in the Mac's apps",
        ),
    };
    match granted {
        Some(true) => check(id, Pass, &format!("fleetd has {what}."), None),
        Some(false) => check(
            id,
            Fail,
            &format!("fleetd doesn't have {what}, so {why}."),
            Some(Fix {
                label: format!(
                    "At the Mac: System Settings › Privacy & Security › {what}, turn on \
                     fleetd. macOS asks again from time to time: turn it on again then. This opens the pane there"
                ),
                command: Some(format!("open \"{}\"", pane(id))),
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

pub fn tools(state: &ToolsState) -> MacCheck {
    match state {
        ToolsState::Ready(versions) => check(MacCheckId::Tools, Pass, versions, None),
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

/// The Mac itself.
pub struct Live {
    pub home: PathBuf,
    pub awake: Result<(), String>,
    pub tools: ToolsState,
}

impl Probe for Live {
    fn user(&self) -> String {
        super::user()
    }

    fn run(&self, program: &str, args: &[&str]) -> Ran {
        match Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .output()
        {
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
}
