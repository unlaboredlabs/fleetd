//! The agents' Mac's setup checks (docs: agents-mac.md), run by the node as its own user with no admin, so each tests what a
//! process of that user can do. Each is a pure verdict on what a [`Probe`] read; [`Live`] reads the Mac, tests fake it.
//! A failing check says exactly what the person does, and where: in their own (admin) account, or at the Mac as
//! fleetd agents.
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use fleetd_contracts::node_link::{MacCheck, MacCheckId, MacCheckState, MacHealth};
use fleetd_contracts::prim::Text;

use super::tools::ToolsState;

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
    /// Whether the node's user is a standard user that can't sudo (node/mac_tool's `admin_check`).
    fn admin(&self) -> Result<(), String>;
    /// Every other user's home under /Users, and whether it opens for this user; Err when /Users can't be listed.
    fn homes(&self) -> Result<Vec<(PathBuf, bool)>, String>;
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
    let checks = vec![
        standard_user(&user, probe.admin()),
        other_homes(probe.homes()),
        no_apple_id(
            &user,
            &probe.run("defaults", &["read", "MobileMeAccounts", "Accounts"]),
        ),
        no_secure_token(
            &user,
            &probe.run("sysadminctl", &["-secureTokenStatus", &user]),
        ),
        developer(
            &user,
            &probe.run(
                "dseditgroup",
                &["-o", "checkmember", "-m", &user, "_developer"],
            ),
        ),
        xcode(
            &probe.run("xcode-select", &["-p"]),
            &probe.run("xcodebuild", &["-license", "check"]),
            &probe.run("xcodebuild", &["-checkFirstLaunchStatus"]),
            &probe.run("xcodebuild", &["-version"]),
        ),
        ios_runtime(&probe.run("xcrun", &["simctl", "list", "runtimes"])),
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

pub fn standard_user(user: &str, admin: Result<(), String>) -> MacCheck {
    match admin {
        Ok(()) => check(
            MacCheckId::StandardUser,
            Pass,
            &format!("{user} is a standard user and can't sudo."),
            None,
        ),
        Err(why) => check(
            MacCheckId::StandardUser,
            Fail,
            &format!("{why}: agents would act as an admin of this Mac, so its tool stays off."),
            said(format!(
                "In your own account: System Settings › Users & Groups › {user} › turn off \"Allow this user to \
                 administer this computer\", and take {user} out of any sudoers file. Then restart its node."
            )),
        ),
    }
}

pub fn other_homes(homes: Result<Vec<(PathBuf, bool)>, String>) -> MacCheck {
    let homes = match homes {
        Ok(homes) => homes,
        Err(why) => {
            return check(
                MacCheckId::OtherHomes,
                Unknown,
                &format!("Couldn't list /Users: {why}."),
                None,
            );
        }
    };
    let open: Vec<&Path> = homes
        .iter()
        .filter(|(_, opens)| *opens)
        .map(|(p, _)| p.as_path())
        .collect();
    match open.first() {
        None => check(
            MacCheckId::OtherHomes,
            Pass,
            &format!(
                "No other user's home opens for agents ({} checked).",
                homes.len()
            ),
            None,
        ),
        Some(_) => {
            let shown: Vec<String> = open.iter().map(|p| p.display().to_string()).collect();
            let owners: Vec<String> = open
                .iter()
                .filter_map(|p| p.file_name())
                .map(|n| n.to_string_lossy().into_owned())
                .collect();
            check(
                MacCheckId::OtherHomes,
                Fail,
                &format!("fleetd agents can read {}.", shown.join(", ")),
                Some(Fix {
                    label: format!(
                        "In {}'s own Terminal (only the home folder itself, not -R)",
                        owners.join("'s, and in ")
                    ),
                    command: Some("chmod 700 ~".into()),
                }),
            )
        }
    }
}

/// `defaults read MobileMeAccounts Accounts`: the domain is missing, or lists no account, without an Apple ID.
pub fn no_apple_id(user: &str, ran: &Ran) -> MacCheck {
    if ran.ok() && ran.out.contains("AccountID") {
        return check(
            MacCheckId::NoAppleId,
            Fail,
            &format!(
                "An Apple ID is signed in for {user}: agents could reach its iCloud data and keychain."
            ),
            said(format!(
                "At the Mac, logged in as {user}: System Settings › your name › Sign Out. The agents' user keeps no Apple ID."
            )),
        );
    }
    check(
        MacCheckId::NoAppleId,
        Pass,
        &format!("No Apple ID is signed in for {user}."),
        None,
    )
}

/// `sysadminctl -secureTokenStatus <user>`, which says ENABLED or DISABLED (on stderr) without admin.
pub fn no_secure_token(user: &str, ran: &Ran) -> MacCheck {
    if ran.out.contains("DISABLED") {
        check(
            MacCheckId::NoSecureToken,
            Pass,
            &format!("{user} holds no secure token: its password can't unlock the disk."),
            None,
        )
    } else if ran.out.contains("ENABLED") {
        check(
            MacCheckId::NoSecureToken,
            Fail,
            &format!(
                "{user} holds a FileVault secure token: its password unlocks this Mac's disk."
            ),
            yours(format!(
                "sudo sysadminctl -secureTokenOff {user} -password - -adminUser $(whoami) -adminPassword -"
            )),
        )
    } else {
        check(
            MacCheckId::NoSecureToken,
            Unknown,
            &format!(
                "sysadminctl didn't say whether {user} holds a secure token: {}",
                ran.out.trim()
            ),
            None,
        )
    }
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

pub fn xcode(selected: &Ran, license: &Ran, first_launch: &Ran, version: &Ran) -> MacCheck {
    let path = selected.out.trim();
    if !selected.ok() || !path.contains(".app/Contents/Developer") {
        return check(
            MacCheckId::Xcode,
            Fail,
            "No full Xcode is selected (only the command line tools, or nothing).",
            Some(Fix {
                label: "Install Xcode from the App Store in your own account, then in its Terminal"
                    .into(),
                command: Some("sudo xcode-select -s /Applications/Xcode.app".into()),
            }),
        );
    }
    if !license.ok() {
        return check(
            MacCheckId::Xcode,
            Fail,
            "Xcode's licence isn't accepted, so xcodebuild and simctl refuse to run.",
            yours("sudo xcodebuild -license accept"),
        );
    }
    if !first_launch.ok() {
        return check(
            MacCheckId::Xcode,
            Fail,
            "Xcode's first launch hasn't run: its system components aren't installed.",
            yours("sudo xcodebuild -runFirstLaunch"),
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
                    "At the Mac, logged in as fleetd agents: System Settings › Privacy & Security › {what}, turn on \
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

/// Names under /Users that are nobody's home.
fn not_a_home(name: &str) -> bool {
    name.starts_with('.') || matches!(name, "Shared" | "Guest")
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

    fn admin(&self) -> Result<(), String> {
        crate::node::mac_tool::admin_check()
    }

    fn homes(&self) -> Result<Vec<(PathBuf, bool)>, String> {
        let own = std::env::home_dir();
        let entries = std::fs::read_dir("/Users").map_err(|e| e.to_string())?;
        Ok(entries
            .flatten()
            .filter(|e| !not_a_home(&e.file_name().to_string_lossy()))
            .map(|e| e.path())
            .filter(|p| p.is_dir() && Some(p.as_path()) != own.as_deref())
            .map(|p| {
                let opens = std::fs::read_dir(&p).is_ok();
                (p, opens)
            })
            .collect())
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
