use std::collections::HashMap;

use fleetd_contracts::node_link::{
    CAP_AGENTS_MAC, CAP_CLAUDE_ACCOUNTS, CAP_MAC_TOOL, CAP_MCP_SERVERS, CAP_ONEPASSWORD,
    CAP_SELF_UPDATE, CAP_SESSION_IOS, CAP_TELEGRAM, MacCheckId, MacCheckState,
};

use super::checks::{self, Pods, Probe, Ran};
use super::tools::ToolsState;

/// A Mac set up as the guide says, unless a test changes it.
struct Fake {
    runs: HashMap<String, Ran>,
    /// The Xcode bundles in /Applications.
    xcodes: Vec<String>,
    /// The directories that are there.
    dirs: Vec<String>,
    accessibility: Option<bool>,
    screen: Option<bool>,
    console: Option<String>,
    awake: Result<(), String>,
    tools: ToolsState,
    pods: Pods,
}

fn ran(code: i32, out: &str) -> Ran {
    Ran {
        code: Some(code),
        out: out.into(),
    }
}

impl Default for Fake {
    fn default() -> Self {
        let runs = [
            (
                "dseditgroup -o checkmember -m agents _developer",
                ran(0, "yes agents is a member of _developer\n"),
            ),
            (
                "DevToolsSecurity -status",
                ran(0, "Developer mode is currently enabled.\n"),
            ),
            ("xcode-select -p", ran(0, "/Applications/Xcode.app/Contents/Developer\n")),
            ("xcodebuild -license check", ran(0, "")),
            ("xcodebuild -checkFirstLaunchStatus", ran(0, "")),
            ("xcodebuild -version", ran(0, "Xcode 26.0\nBuild version 17A324\n")),
            (
                "xcrun simctl list runtimes",
                ran(
                    0,
                    "== Runtimes ==\niOS 26.0 (26.0 - 23A343) - com.apple.CoreSimulator.SimRuntime.iOS-26-0\n",
                ),
            ),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v))
        .collect();
        Self {
            runs,
            xcodes: vec!["/Applications/Xcode.app".into()],
            dirs: vec!["/Applications/Xcode.app/Contents/Developer".into()],
            accessibility: Some(true),
            screen: Some(true),
            console: Some("agents".into()),
            awake: Ok(()),
            tools: ToolsState::Ready(super::tools::versions()),
            pods: Pods {
                pod: Some(ran(0, "1.16.2\n")),
                brew: Some("/opt/homebrew/bin/brew".into()),
                brew_at: "/opt/homebrew/bin/brew".into(),
            },
        }
    }
}

impl Probe for Fake {
    fn user(&self) -> String {
        "agents".into()
    }
    fn run(&self, program: &str, args: &[&str]) -> Ran {
        let key = std::iter::once(program)
            .chain(args.iter().copied())
            .collect::<Vec<_>>()
            .join(" ");
        self.runs.get(&key).cloned().unwrap_or_default()
    }
    fn xcodes(&self) -> Vec<String> {
        self.xcodes.clone()
    }
    fn is_dir(&self, path: &str) -> bool {
        self.dirs.iter().any(|d| d == path)
    }
    fn accessibility(&self) -> Option<bool> {
        self.accessibility
    }
    fn screen_recording(&self) -> Option<bool> {
        self.screen
    }
    fn console_user(&self) -> Option<String> {
        self.console.clone()
    }
    fn awake(&self) -> Result<(), String> {
        self.awake.clone()
    }
    fn tools(&self) -> ToolsState {
        self.tools.clone()
    }
    fn pods(&self) -> Pods {
        self.pods.clone()
    }
}

/// A check's state, message, and its fix with its command after it.
fn verdict(fake: &Fake, id: MacCheckId) -> (MacCheckState, String, Option<String>) {
    let health = checks::run(fake);
    let c = health
        .checks
        .iter()
        .find(|c| c.id == id)
        .unwrap_or_else(|| panic!("no {id:?} check"));
    let fix = c.fix.as_ref().map(|f| match &c.command {
        Some(command) => format!("{f}: {command}"),
        None => f.to_string(),
    });
    (c.state, c.message.to_string(), fix)
}

#[test]
fn a_mac_set_up_as_the_guide_says_passes_every_check() {
    let health = checks::run(&Fake::default());
    assert_eq!(health.user.as_str(), "agents");
    let ids: Vec<_> = health.checks.iter().map(|c| c.id).collect();
    assert_eq!(ids, MacCheckId::ALL, "every check, in the guide's order");
    for c in health.checks.iter() {
        assert_eq!(
            c.state,
            MacCheckState::Ok,
            "{:?}: {}",
            c.id,
            c.message.as_str()
        );
        assert!(c.fix.is_none() && c.command.is_none(), "{:?}", c.id);
    }
}

/// Developer Mode off passed setup once and left every simulator's installs hanging behind a password prompt at the
/// Mac's screen: the check fails on it, with the command that turns it on, and on `_developer` too.
#[test]
fn the_developer_check_needs_developer_mode_on_and_the_group() {
    let off = ran(0, "Developer mode is currently disabled.\n");
    let not_member = ran(0, "no agents is NOT a member of _developer\n");
    let mut fake = Fake::default();
    fake.runs
        .insert("DevToolsSecurity -status".into(), off.clone());
    let (state, message, fix) = verdict(&fake, MacCheckId::Developer);
    assert_eq!(state, MacCheckState::Fail);
    assert!(message.starts_with("Developer Mode is off"), "{message}");
    assert_eq!(
        fix.as_deref(),
        Some("In your own (admin) account's Terminal: sudo DevToolsSecurity -enable")
    );

    let member = "dseditgroup -o checkmember -m agents _developer";
    let mut fake = Fake::default();
    fake.runs.insert(member.into(), not_member.clone());
    let (state, _, fix) = verdict(&fake, MacCheckId::Developer);
    assert_eq!(state, MacCheckState::Fail);
    assert!(
        fix.as_deref()
            .unwrap()
            .ends_with(": sudo dseditgroup -o edit -a agents -t user _developer"),
        "{fix:?}"
    );

    fake.runs.insert("DevToolsSecurity -status".into(), off);
    let (state, _, fix) = verdict(&fake, MacCheckId::Developer);
    assert_eq!(state, MacCheckState::Fail);
    assert!(
        fix.as_deref().unwrap().ends_with(
            ": sudo DevToolsSecurity -enable && sudo dseditgroup -o edit -a agents -t user _developer"
        ),
        "{fix:?}"
    );

    // Neither said: unknown, with both commands.
    let fake = Fake {
        runs: HashMap::new(),
        ..Fake::default()
    };
    assert_eq!(
        verdict(&fake, MacCheckId::Developer).0,
        MacCheckState::Unknown
    );
}

/// `mac sim start` refuses while the node's last checks have the developer check failing, and only then.
#[test]
fn a_failing_developer_check_blocks_simulators() {
    let dir = tempfile::tempdir().unwrap();
    assert!(
        checks::blocks_simulators(dir.path()).is_none(),
        "no checks yet"
    );
    let write = |fake: &Fake| {
        std::fs::write(
            super::health_file(dir.path()),
            serde_json::to_vec(&checks::run(fake)).unwrap(),
        )
        .unwrap();
    };
    write(&Fake::default());
    assert!(checks::blocks_simulators(dir.path()).is_none());
    let mut fake = Fake::default();
    fake.runs.insert(
        "DevToolsSecurity -status".into(),
        ran(0, "Developer mode is currently disabled.\n"),
    );
    write(&fake);
    let check = checks::blocks_simulators(dir.path()).expect("blocked");
    assert_eq!(
        check.command.as_ref().map(|c| c.as_str()),
        Some("sudo DevToolsSecurity -enable")
    );
}

/// The Xcode check and the simulator one, with the Xcode check's fix and command.
fn xcode_verdict(fake: &Fake) -> (MacCheckState, String, Option<String>, MacCheckState) {
    let (state, message, fix) = verdict(fake, MacCheckId::Xcode);
    (state, message, fix, verdict(fake, MacCheckId::IosRuntime).0)
}

/// Every way Xcode isn't usable warns with its one command, and only the simulator check waits for it: the rest of
/// setup passes (docs: agents-mac.md#xcode). None says xcode-select's own error.
#[test]
fn a_missing_or_misplaced_xcode_warns_with_its_one_fix_and_holds_up_only_simulators() {
    let rest_passes = |fake: &Fake| {
        checks::run(fake)
            .checks
            .iter()
            .filter(|c| !matches!(c.id, MacCheckId::Xcode | MacCheckId::IosRuntime))
            .all(|c| c.state == MacCheckState::Ok)
    };
    let invalid = ran(
        1,
        "xcode-select: error: invalid developer directory '/Applications/Xcode.app'\n",
    );

    // No Xcode at all: the App Store's page.
    let mut fake = Fake {
        xcodes: vec![],
        dirs: vec![],
        ..Fake::default()
    };
    fake.runs.insert("xcode-select -p".into(), invalid.clone());
    let (state, message, fix, sim) = xcode_verdict(&fake);
    assert_eq!((state, sim), (MacCheckState::Warn, MacCheckState::Warn));
    assert_eq!(
        message,
        "Xcode isn't installed. iOS simulators and builds wait for it; everything else works."
    );
    assert!(
        fix.as_deref()
            .unwrap()
            .starts_with("Install Xcode from the App Store")
            && fix
                .as_deref()
                .unwrap()
                .ends_with("open \"macappstore://apps.apple.com/app/id497799835\""),
        "{fix:?}"
    );
    assert!(rest_passes(&fake));

    // Under another name, with xcode-select pointing at a removed copy: the switch to the one there.
    fake.xcodes = vec!["/Applications/Xcode-beta.app".into()];
    fake.runs.insert(
        "xcode-select -p".into(),
        ran(0, "/Applications/Xcode.app/Contents/Developer\n"),
    );
    let (state, message, fix, sim) = xcode_verdict(&fake);
    assert_eq!((state, sim), (MacCheckState::Warn, MacCheckState::Warn));
    assert_eq!(
        message,
        "Xcode-beta.app is in /Applications, but xcode-select points at /Applications/Xcode.app/Contents/Developer, \
         which isn't there. iOS simulators and builds wait for it; everything else works."
    );
    assert!(
        fix.unwrap()
            .ends_with(": sudo xcode-select -s /Applications/Xcode-beta.app/Contents/Developer")
    );
    // xcode-select failing outright says the same, never its error.
    fake.runs.insert("xcode-select -p".into(), invalid);
    let (_, message, fix, _) = xcode_verdict(&fake);
    assert!(message.contains("no Xcode is selected") && !message.contains("error"));
    assert!(
        fix.unwrap()
            .ends_with("/Applications/Xcode-beta.app/Contents/Developer")
    );
    // A name with a space in it is quoted.
    fake.xcodes = vec!["/Applications/Xcode 26.app".into()];
    assert!(
        xcode_verdict(&fake)
            .2
            .unwrap()
            .ends_with("sudo xcode-select -s '/Applications/Xcode 26.app/Contents/Developer'")
    );
    assert!(rest_passes(&fake));

    // Only the Command Line Tools: the same switch.
    let mut fake = Fake::default();
    fake.runs.insert(
        "xcode-select -p".into(),
        ran(0, "/Library/Developer/CommandLineTools\n"),
    );
    fake.dirs.push("/Library/Developer/CommandLineTools".into());
    let (state, message, fix, sim) = xcode_verdict(&fake);
    assert_eq!((state, sim), (MacCheckState::Warn, MacCheckState::Warn));
    assert!(message.starts_with(
        "Xcode.app is in /Applications, but only the Command Line Tools are selected."
    ));
    assert!(
        fix.unwrap()
            .ends_with(": sudo xcode-select -s /Applications/Xcode.app/Contents/Developer")
    );
    assert!(rest_passes(&fake));

    // Selected, but its licence not accepted, then its first launch not run.
    let mut fake = Fake::default();
    fake.runs
        .insert("xcodebuild -license check".into(), ran(69, ""));
    let (state, _, fix, sim) = xcode_verdict(&fake);
    assert_eq!((state, sim), (MacCheckState::Warn, MacCheckState::Warn));
    assert!(
        fix.unwrap()
            .ends_with("sudo xcodebuild -license accept && sudo xcodebuild -runFirstLaunch")
    );
    fake.runs
        .insert("xcodebuild -license check".into(), ran(0, ""));
    fake.runs
        .insert("xcodebuild -checkFirstLaunchStatus".into(), ran(69, ""));
    let (state, _, fix, _) = xcode_verdict(&fake);
    assert_eq!(state, MacCheckState::Warn);
    assert!(fix.unwrap().ends_with(": sudo xcodebuild -runFirstLaunch"));
    assert!(rest_passes(&fake));

    let (_, message, _) = verdict(&Fake::default(), MacCheckId::Xcode);
    assert_eq!(
        message,
        "Xcode 26.0 at /Applications/Xcode.app/Contents/Developer, licence accepted."
    );
}

/// The bundles setup looks for: Xcode.app first, then by name; a folder without a developer directory isn't one.
#[test]
fn the_xcodes_in_applications_are_found_by_name() {
    let dir = tempfile::tempdir().unwrap();
    for name in [
        "Xcode-beta.app",
        "Xcode.app",
        "Xcode 26.app",
        "Xcode-old.app",
        "Other.app",
    ] {
        let app = dir.path().join(name);
        std::fs::create_dir_all(if name == "Xcode-old.app" {
            app
        } else {
            app.join("Contents/Developer")
        })
        .unwrap();
    }
    let found: Vec<_> = super::xcode::in_applications(dir.path())
        .iter()
        .map(|p| super::xcode::name(p).to_owned())
        .collect();
    assert_eq!(found, ["Xcode.app", "Xcode 26.app", "Xcode-beta.app"]);
    assert!(super::xcode::in_applications(&dir.path().join("gone")).is_empty());
}

#[test]
fn an_unavailable_runtime_is_no_runtime() {
    let mut fake = Fake::default();
    assert_eq!(verdict(&fake, MacCheckId::IosRuntime).1, "iOS 26.0 (26.0");
    fake.runs.insert(
        "xcrun simctl list runtimes".into(),
        ran(
            0,
            "== Runtimes ==\niOS 18.0 (18.0 - 22A3354) - x (unavailable, runtime missing)\n",
        ),
    );
    let (state, _, fix) = verdict(&fake, MacCheckId::IosRuntime);
    assert_eq!(state, MacCheckState::Fail);
    assert!(fix.unwrap().ends_with("xcodebuild -downloadPlatform iOS"));
}

#[test]
fn a_missing_grant_deep_links_its_pane() {
    let fake = Fake {
        accessibility: Some(false),
        screen: None,
        ..Fake::default()
    };
    let (state, _, fix) = verdict(&fake, MacCheckId::Accessibility);
    assert_eq!(state, MacCheckState::Fail);
    let fix = fix.unwrap();
    assert!(fix.starts_with("In Terminal at the Mac"), "{fix}");
    assert!(
        fix.ends_with("fleetd node grants --ask accessibility"),
        "{fix}"
    );
    assert_eq!(
        verdict(&fake, MacCheckId::ScreenRecording).0,
        MacCheckState::Unknown
    );
    assert!(checks::pane(MacCheckId::ScreenRecording).ends_with("Privacy_ScreenCapture"));
}

#[test]
fn a_gui_session_behind_someone_else_warns() {
    let mut fake = Fake {
        console: Some("ada".into()),
        ..Fake::default()
    };
    let (state, message, _) = verdict(&fake, MacCheckId::GuiSession);
    assert_eq!(state, MacCheckState::Warn);
    assert!(
        message.starts_with("background: ada is at the Mac's screen"),
        "{message}"
    );
    fake.console = Some("root".into());
    let (_, message, _) = verdict(&fake, MacCheckId::GuiSession);
    assert!(
        message.starts_with("background: the login window"),
        "{message}"
    );
}

#[test]
fn tools_still_installing_are_unknown_and_a_failed_assertion_fails() {
    let fake = Fake {
        tools: ToolsState::Installing,
        awake: Err("IOKit's power assertions are not available".into()),
        ..Fake::default()
    };
    assert_eq!(verdict(&fake, MacCheckId::Tools).0, MacCheckState::Unknown);
    assert_eq!(verdict(&fake, MacCheckId::KeepAwake).0, MacCheckState::Fail);
}

/// CocoaPods comes from Homebrew (the Mac's own Ruby is too old for it): the tools check runs `pod --version`, and
/// without it warns with the one command that installs it, Homebrew first where there is none. Setup still ends.
#[test]
fn the_tools_check_runs_pod_and_says_how_to_install_cocoapods() {
    let (state, message, _) = verdict(&Fake::default(), MacCheckId::Tools);
    assert_eq!(state, MacCheckState::Ok);
    assert!(message.ends_with(" CocoaPods 1.16.2."), "{message}");
    // Ruby's warnings before the version don't hide it.
    let mut fake = Fake::default();
    fake.pods.pod = Some(ran(
        0,
        "WARNING: CocoaPods requires your terminal to be using UTF-8 encoding.\n1.16.2\n",
    ));
    assert!(
        verdict(&fake, MacCheckId::Tools)
            .1
            .ends_with(" CocoaPods 1.16.2.")
    );

    // Homebrew there, CocoaPods not.
    fake.pods.pod = None;
    let (state, message, fix) = verdict(&fake, MacCheckId::Tools);
    assert_eq!(state, MacCheckState::Warn);
    assert!(
        message.ends_with(
            "CocoaPods isn't installed, so pod install and expo prebuild --platform ios don't run; everything else works."
        ),
        "{message}"
    );
    assert_eq!(
        fix.as_deref(),
        Some("In your own (admin) account's Terminal: /opt/homebrew/bin/brew install cocoapods")
    );

    // No Homebrew either: its install line, then CocoaPods with the brew it puts on this Mac's chip.
    fake.pods = Pods {
        pod: None,
        brew: None,
        brew_at: "/usr/local/bin/brew".into(),
    };
    let fix = verdict(&fake, MacCheckId::Tools).2.unwrap();
    assert!(
        fix.ends_with(&format!(
            ": {} && /usr/local/bin/brew install cocoapods",
            checks::HOMEBREW_INSTALL
        )),
        "{fix}"
    );

    // A pod that doesn't run says its first line, and still only warns.
    fake.pods.pod = Some(ran(1, "\n/opt/homebrew/bin/pod: bad interpreter\n"));
    let (state, message, _) = verdict(&fake, MacCheckId::Tools);
    assert_eq!(state, MacCheckState::Warn);
    assert!(
        message.contains("CocoaPods doesn't run (/opt/homebrew/bin/pod: bad interpreter)"),
        "{message}"
    );

    // While the pinned tools install, or after they failed, that is what it says.
    fake.tools = ToolsState::Installing;
    assert_eq!(verdict(&fake, MacCheckId::Tools).0, MacCheckState::Unknown);
    fake.tools = ToolsState::Failed("offline".into());
    assert_eq!(verdict(&fake, MacCheckId::Tools).0, MacCheckState::Fail);
}

#[test]
fn the_mac_lists_no_call_that_carries_a_secret_a_claude_or_a_navi() {
    let all = [
        CAP_SELF_UPDATE,
        CAP_SESSION_IOS,
        CAP_CLAUDE_ACCOUNTS,
        CAP_ONEPASSWORD,
        CAP_MCP_SERVERS,
        CAP_TELEGRAM,
        fleetd_contracts::node_link::CAP_ASSISTANT,
        fleetd_contracts::node_link::CAP_ORDER_ENV,
        fleetd_contracts::node_link::CAP_CLAUDE_LOGIN,
    ]
    .map(str::to_owned);
    assert_eq!(
        super::capabilities(all, false),
        [CAP_AGENTS_MAC, CAP_SELF_UPDATE, CAP_SESSION_IOS]
    );
}

/// The Mac lists `mac_tool` while its tool is on (a standard user on macOS), once, and never while it's off, whatever
/// the list it filters already holds.
#[test]
fn the_mac_lists_its_tool_only_while_it_is_on() {
    let with_tool = [CAP_SELF_UPDATE, CAP_MAC_TOOL].map(str::to_owned);
    assert_eq!(
        super::capabilities(with_tool.clone(), true),
        [CAP_AGENTS_MAC, CAP_SELF_UPDATE, CAP_MAC_TOOL]
    );
    assert_eq!(
        super::capabilities([CAP_SELF_UPDATE.to_owned()], true),
        [CAP_AGENTS_MAC, CAP_SELF_UPDATE, CAP_MAC_TOOL]
    );
    assert_eq!(
        super::capabilities(with_tool, false),
        [CAP_AGENTS_MAC, CAP_SELF_UPDATE]
    );
}

#[test]
fn the_mac_answers_only_the_runners_figures_and_a_projects_removal() {
    use fleetd_contracts::sessions::SessionCall;
    let call = |v: serde_json::Value| serde_json::from_value::<SessionCall>(v).unwrap();
    assert!(super::session_call_allowed(&SessionCall::RunnerInfo));
    assert!(super::session_call_allowed(&call(
        serde_json::json!({ "op": "project_remove", "projectId": "p1" })
    )));
    for refused in [
        serde_json::json!({ "op": "project_upsert", "projectId": "p1", "title": "t", "workspaceRoot": "/w" }),
        serde_json::json!({ "op": "repo_scan" }),
        serde_json::json!({ "op": "claude_models" }),
    ] {
        assert!(
            !super::session_call_allowed(&call(refused.clone())),
            "{refused}"
        );
    }
}

/// Only `agentsMac`, which the installer's `--mac` writes, makes the node the agents' Mac: never the Mac screen's own
/// switch, which Settings › Screens turns on and off.
#[test]
fn only_agents_mac_makes_the_node_the_agents_mac() {
    let config = |mac: Option<bool>, agents_mac: Option<bool>| crate::node::config::NodeConfig {
        hub: "http://devbox:4790".into(),
        machine_id: "mac".into(),
        name: "mac".into(),
        cmd_roots: None,
        claude_config_dir: None,
        min_free_gb: None,
        warm_builds: None,
        build_slots: None,
        enrolled: true,
        browser: None,
        device: None,
        ios: None,
        desktop: None,
        mac: mac.map(|on| crate::node::desktop::mac::MacConfig {
            enabled: Some(on),
            ..Default::default()
        }),
        agents_mac,
    };
    assert!(!super::is_agents_mac(&config(None, None)));
    assert!(!super::is_agents_mac(&config(Some(true), None)));
    assert!(!super::is_agents_mac(&config(None, Some(false))));
    // The screen turned off leaves it the agents' Mac.
    let on = config(Some(false), Some(true));
    assert!(super::is_agents_mac(&on));
    let text = serde_json::to_string(&on).unwrap();
    assert!(text.contains(r#""agentsMac":true"#), "{text}");
}

/// `mac sim` works on the agents' Mac whatever an older node.json says: a legacy `"ios": {"enabled": false}` (from when
/// the iOS screen kind could be turned off) is ignored, and its other settings kept. Elsewhere `enabled` stands.
#[test]
fn the_agents_mac_ignores_a_legacy_ios_off() {
    let off: crate::node::device::ios::IosConfig =
        serde_json::from_value(serde_json::json!({ "enabled": false, "pool": 2 })).unwrap();
    let on = super::ios_config(Some(off.clone()), true);
    assert_eq!(on.enabled, Some(true));
    assert_eq!(on.pool, Some(2));
    assert_eq!(super::ios_config(None, true).enabled, Some(true));
    assert_eq!(super::ios_config(Some(off), false).enabled, Some(false));
    assert_eq!(super::ios_config(None, false).enabled, None);
}
