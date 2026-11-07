use std::collections::HashMap;

use fleetd_contracts::node_link::{
    CAP_AGENTS_MAC, CAP_CLAUDE_ACCOUNTS, CAP_MAC_TOOL, CAP_MCP_SERVERS, CAP_ONEPASSWORD,
    CAP_SELF_UPDATE, CAP_SESSION_IOS, CAP_TELEGRAM, MacCheckId, MacCheckState,
};

use super::checks::{self, Probe, Ran};
use super::tools::ToolsState;

/// A Mac set up as the guide says, unless a test changes it.
struct Fake {
    runs: HashMap<String, Ran>,
    accessibility: Option<bool>,
    screen: Option<bool>,
    console: Option<String>,
    awake: Result<(), String>,
    tools: ToolsState,
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
            accessibility: Some(true),
            screen: Some(true),
            console: Some("agents".into()),
            awake: Ok(()),
            tools: ToolsState::Ready(super::tools::versions()),
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

#[test]
fn xcode_fails_at_its_first_missing_step_with_that_steps_command() {
    let mut fake = Fake::default();
    fake.runs.insert(
        "xcode-select -p".into(),
        ran(0, "/Library/Developer/CommandLineTools\n"),
    );
    let (state, _, fix) = verdict(&fake, MacCheckId::Xcode);
    assert_eq!(state, MacCheckState::Fail);
    assert!(
        fix.unwrap()
            .contains("sudo xcode-select -s /Applications/Xcode.app")
    );
    fake.runs.insert(
        "xcode-select -p".into(),
        ran(0, "/Applications/Xcode.app/Contents/Developer\n"),
    );
    fake.runs
        .insert("xcodebuild -license check".into(), ran(69, ""));
    assert!(
        verdict(&fake, MacCheckId::Xcode)
            .2
            .unwrap()
            .ends_with("sudo xcodebuild -license accept")
    );
    fake.runs
        .insert("xcodebuild -license check".into(), ran(0, ""));
    fake.runs
        .insert("xcodebuild -checkFirstLaunchStatus".into(), ran(69, ""));
    assert!(
        verdict(&fake, MacCheckId::Xcode)
            .2
            .unwrap()
            .ends_with("sudo xcodebuild -runFirstLaunch")
    );
    let (_, message, _) = verdict(&Fake::default(), MacCheckId::Xcode);
    assert_eq!(
        message,
        "Xcode 26.0 at /Applications/Xcode.app/Contents/Developer, licence accepted."
    );
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
    assert!(fix.contains("Privacy_Accessibility"), "{fix}");
    assert!(fix.starts_with("At the Mac: System Settings"), "{fix}");
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
        mem_per_agent_gb: None,
        disk_per_agent_gb: None,
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
