//! The Mac screen without a Mac: what macOS says about the console, the gate made of it, keys, agent-desktop's
//! commands, and the lease end to end on a fake screen. On a Mac (`FLEETD_REQUIRE_MAC_SCREEN=1` in mac.yml) the last
//! test reads the real screen through ScreenCaptureKit and moves the pointer with CGEvent.
use std::sync::{Arc, Mutex};

use fleetd_contracts::browser::{BrowserControlTo, DesktopAction, DesktopCall};
use fleetd_contracts::lead_calls::LeadCall;
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::prim::Text;

use super::console::{self, Console, ConsoleUser};
use super::keys::{self, Key};
use super::{Blocked, agent_desktop, blocked_by, observes};
use crate::node::browser::upload::{HubCalls, HubFuture};
use crate::node::desktop::screen::{Raw, Screen};
use crate::node::desktop::{DesktopConfig, Desktops, x11};

/// `ioreg -n Root -d1 -a` on a Mac with two sessions: the person's in the background, agents' on the screen.
const IOREG: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
	<dict>
		<key>IOConsoleLocked</key>
		<false/>
		<key>IOConsoleUsers</key>
		<array>
			<dict>
				<key>kCGSSessionAuditIDKey</key>
				<integer>100008</integer>
				<key>kCGSSessionOnConsoleKey</key>
				<false/>
				<key>kCGSSessionUserIDKey</key>
				<integer>501</integer>
				<key>kCGSSessionUserNameKey</key>
				<string>ana</string>
				<key>kCGSessionLongUserNameKey</key>
				<string>Ana &amp; Co</string>
			</dict>
			<dict>
				<key>kCGSSessionOnConsoleKey</key>
				<true/>
				<key>kCGSSessionUserIDKey</key>
				<integer>502</integer>
				<key>kCGSSessionUserNameKey</key>
				<string>agents</string>
				<key>kSCSecuritySessionID</key>
				<integer>100011</integer>
				<key>kCGSSessionSystemSafeBoot</key>
				<false/>
			</dict>
		</array>
		<key>IORegistryEntryName</key>
		<string>Root</string>
		<key>IOKitBuildVersion</key>
		<data>RGFyd2lu</data>
	</dict>
</array>
</plist>
"#;

#[test]
fn ioreg_says_which_session_has_the_screen() {
    let users = console::parse(IOREG).unwrap();
    assert_eq!(
        users,
        [
            ConsoleUser {
                uid: 501,
                name: "ana".into(),
                on_console: false,
                locked: false
            },
            ConsoleUser {
                uid: 502,
                name: "agents".into(),
                on_console: true,
                locked: false
            },
        ]
    );
    assert_eq!(console::state(502, &users), Console::OnScreen);
    assert_eq!(
        console::state(501, &users),
        Console::Background {
            who: Some("agents".into())
        }
    );
    assert_eq!(console::state(503, &users), Console::NotLoggedIn);
    let locked = IOREG.replace(
        "<key>kSCSecuritySessionID</key>",
        "<key>CGSSessionScreenIsLocked</key>\n<true/>\n<key>kSCSecuritySessionID</key>",
    );
    let users = console::parse(&locked).unwrap();
    assert_eq!(console::state(502, &users), Console::Locked);
    // At the login window after a restart, nobody is logged in.
    let nobody = console::parse(
        "<plist><array><dict><key>IORegistryEntryName</key><string>Root</string></dict></array></plist>",
    )
    .unwrap();
    assert!(nobody.is_empty());
    assert!(console::parse("ioreg: no such entry").is_err());
}

#[test]
fn the_gate_says_exactly_why_and_how_to_fix_it() {
    let on = Console::OnScreen;
    assert_eq!(blocked_by("agents", false, &on, true, true), None);
    let admin = blocked_by("ana", true, &on, true, true).unwrap();
    assert!(admin.message.contains("ana, an administrator"), "{admin:?}");
    assert!(admin.message.contains("standard user"), "{admin:?}");
    let background = Console::Background {
        who: Some("ana".into()),
    };
    let away = blocked_by("agents", false, &background, true, true).unwrap();
    assert!(
        away.message.contains("ana has the Mac's screen"),
        "{away:?}"
    );
    assert!(away.message.contains("black frames"), "{away:?}");
    let locked = blocked_by("agents", false, &Console::Locked, true, true).unwrap();
    assert!(locked.message.contains("locked"), "{locked:?}");
    assert!(
        locked.message.contains("Require password: Never"),
        "{locked:?}"
    );
    let out = blocked_by("agents", false, &Console::NotLoggedIn, true, true).unwrap();
    assert!(out.message.contains("log in as agents"), "{out:?}");
    let capture = blocked_by("agents", false, &on, false, true).unwrap();
    assert!(capture.message.contains("Screen Recording"), "{capture:?}");
    let fix = capture.fix.unwrap();
    assert!(fix.contains("Privacy_ScreenCapture"), "{fix}");
    assert!(fix.contains("launchctl kickstart -k"), "{fix}");
    let ax = blocked_by("agents", false, &on, true, false).unwrap();
    assert!(ax.fix.unwrap().contains("Privacy_Accessibility"));
}

#[test]
fn keys_go_by_their_mac_keycodes() {
    assert_eq!(keys::of_sym(0x61), Key::Code(0x00, false)); // a
    assert_eq!(keys::of_sym(0x41), Key::Code(0x00, true)); // A
    assert_eq!(keys::of_sym(0x40), Key::Code(0x13, true)); // @
    assert_eq!(keys::of_sym(0xff0d), Key::Code(0x24, false)); // Return
    assert_eq!(keys::of_sym(0xff08), Key::Code(0x33, false)); // BackSpace is the Mac's Delete
    assert_eq!(keys::of_sym(0xffbe), Key::Code(0x7a, false)); // F1
    assert_eq!(keys::of_sym(0xffeb), Key::Modifier(0x37, keys::COMMAND));
    assert_eq!(keys::of_sym(0xffe9), Key::Modifier(0x3a, keys::OPTION));
    assert_eq!(keys::of_sym(0x0100_00e9 - 0x0100_0000), Key::Text('é'));
    assert_eq!(keys::of_sym(0x0100_4e2d), Key::Text('中'));
    // A Mac's names for its modifiers name them too: cmd+s, option+left.
    assert_eq!(x11::parse_chord("cmd+s").unwrap(), [0xffeb, 0x73]);
    assert_eq!(
        x11::parse_chord("command+option+Escape").unwrap(),
        [0xffeb, 0xffe9, 0xff1b]
    );
}

#[test]
fn agent_desktop_commands_are_checked_before_they_run() {
    assert_eq!(
        agent_desktop::split(r#"snapshot --app "Visual Studio Code" -i 'a b' c\ d"#).unwrap(),
        [
            "snapshot",
            "--app",
            "Visual Studio Code",
            "-i",
            "a b",
            "c d"
        ]
    );
    assert!(agent_desktop::split("type 'open").is_err());
    let snapshot = agent_desktop::command("snapshot --app Finder -i").unwrap();
    assert!(snapshot.observing && !snapshot.cdp);
    assert!(
        !agent_desktop::command("click @s8f3k2p9:e12")
            .unwrap()
            .observing
    );
    assert!(
        !agent_desktop::command("permissions --request")
            .unwrap()
            .observing
    );
    assert!(agent_desktop::command("permissions").unwrap().observing);
    assert!(agent_desktop::command("launch Slack --cdp").unwrap().cdp);
    let flag_first = agent_desktop::command("--headed click @e1").unwrap_err();
    assert!(flag_first.contains("command first"), "{flag_first}");
    let exposed =
        agent_desktop::command("launch Slack --cdp -- --remote-debugging-address=0.0.0.0")
            .unwrap_err();
    assert!(exposed.contains("loopback"), "{exposed}");
    assert!(agent_desktop::command(r#"batch '[{"command":"launch","cdp":0}]'"#).is_err());
    assert!(agent_desktop::command("").is_err());
    let launched = r#"{"version":"2.6","ok":true,"command":"launch","data":{"app":"Slack","pid":4242,
        "cdp":{"port":9333,"http_endpoint":"http://127.0.0.1:9333","websocket_url":"ws://127.0.0.1:9333/x"}}}"#;
    assert_eq!(agent_desktop::launched_pid(launched), Some(4242));
    assert_eq!(
        agent_desktop::launched_pid(r#"{"ok":true,"data":{"pid":7}}"#),
        None,
        "no DevTools port, nothing to close"
    );
    let long = "x".repeat(agent_desktop::OUTPUT_CHARS + 10);
    assert!(agent_desktop::answer(&long, "", Some(0)).contains("[cut at"));
    assert_eq!(
        agent_desktop::answer("", "", Some(2)),
        "agent-desktop exited with code 2 and printed nothing."
    );
}

fn call(action: DesktopAction, text: Option<&str>) -> DesktopCall {
    DesktopCall {
        action,
        coordinate: Some([
            fleetd_contracts::prim::Int::unchecked(3),
            fleetd_contracts::prim::Int::unchecked(4),
        ]),
        start_coordinate: None,
        text: text.map(Text::unchecked),
        scroll_direction: None,
        scroll_amount: None,
        duration: None,
    }
}

#[test]
fn only_reading_actions_observe() {
    assert!(observes(&call(DesktopAction::Screenshot, None)));
    assert!(observes(&call(DesktopAction::CursorPosition, None)));
    assert!(observes(&call(
        DesktopAction::AgentDesktop,
        Some("snapshot -i")
    )));
    assert!(!observes(&call(
        DesktopAction::AgentDesktop,
        Some("click @e1")
    )));
    assert!(!observes(&call(DesktopAction::LeftClick, None)));
    assert!(!observes(&call(DesktopAction::Type, Some("hi"))));
    assert!(!observes(&call(
        DesktopAction::Launch,
        Some("open -a TextEdit")
    )));
}

/// A screen that keeps what it was asked to do.
#[derive(Default)]
struct FakeScreen {
    did: Mutex<Vec<String>>,
}

impl FakeScreen {
    fn did(&self, what: String) -> Result<(), String> {
        self.did.lock().unwrap().push(what);
        Ok(())
    }
}

impl Screen for FakeScreen {
    fn size(&self) -> (u32, u32) {
        (16, 16)
    }
    fn changed(&self) -> bool {
        true
    }
    fn grab_raw(&self) -> Result<Raw, String> {
        Ok(Raw {
            data: vec![90; 16 * 16 * 4],
            width: 16,
            height: 16,
        })
    }
    fn encode(&self, raw: &Raw) -> Result<Vec<u8>, String> {
        let mut out = Vec::new();
        jpeg_encoder::Encoder::new(&mut out, 70)
            .encode(&raw.data, 16, 16, jpeg_encoder::ColorType::Bgra)
            .map_err(|e| e.to_string())?;
        Ok(out)
    }
    fn sync(&self) -> Result<(), String> {
        Ok(())
    }
    fn move_to(&self, x: i64, y: i64) -> Result<(), String> {
        self.did(format!("move {x},{y}"))
    }
    fn button(&self, button: u8, down: bool) -> Result<(), String> {
        self.did(format!("button {button} {down}"))
    }
    fn click(&self, x: i64, y: i64, button: u8, count: u8) -> Result<(), String> {
        self.did(format!("click {x},{y} {button}x{count}"))
    }
    fn drag(&self, from: (i64, i64), to: (i64, i64)) -> Result<(), String> {
        self.did(format!("drag {from:?} {to:?}"))
    }
    fn scroll(&self, x: i64, y: i64, dx: i64, dy: i64) -> Result<(), String> {
        self.did(format!("scroll {x},{y} {dx},{dy}"))
    }
    fn pointer(&self) -> Result<(i64, i64), String> {
        Ok((3, 4))
    }
    fn key_sym(&self, sym: u32, down: bool, _shift: bool) -> Result<(), String> {
        self.did(format!("key {sym:x} {down}"))
    }
    fn chord(&self, chord: &str) -> Result<(), String> {
        self.did(format!("chord {chord}"))
    }
    fn type_text(&self, text: &str) -> Result<(), String> {
        self.did(format!("type {text}"))
    }
}

/// A hub that takes nothing: the sessions' reports go nowhere.
struct NoHub;

impl HubCalls for NoHub {
    fn call(&self, _thread: &str, _cwd: &str, _call: LeadCall) -> HubFuture {
        Box::pin(async { Err(McpToolError::new(ErrorCode::Failed, "no hub in this test")) })
    }
}

fn clear() -> Option<Blocked> {
    None
}

fn locked() -> Option<Blocked> {
    Some(Blocked {
        message: "the Mac's screen is locked".into(),
        fix: None,
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_session_holds_the_mac_others_observe_and_a_person_takes_it() {
    let home = tempfile::tempdir().unwrap();
    let desktops = Desktops::start(
        home.path(),
        DesktopConfig {
            enabled: Some(false),
            ..DesktopConfig::default()
        },
        Default::default(),
        Arc::new(NoHub),
        Arc::new(|_| Ok(crate::node::mask::Secrets(Vec::new()))),
        Arc::new(|_| None),
    )
    .await;
    *desktops.mac_gate.lock().unwrap() = clear;
    let screen = Arc::new(FakeScreen::default());
    let open = |thread: &'static str, purpose: &'static str| {
        let (desktops, screen) = (desktops.clone(), screen.clone());
        async move {
            let started = desktops
                .open_mac(
                    thread.into(),
                    "/work/app".into(),
                    purpose.into(),
                    screen,
                    Err("not on a Mac".into()),
                )
                .await
                .unwrap();
            serde_json::to_value(started).unwrap()
        }
    };
    let first = open("th-a", "Check the export dialog").await;
    assert_eq!(first["desktop"], "mac", "{first}");
    assert!(first["heldBy"].is_null(), "the first holds it: {first}");
    let second = open("th-b", "Read the settings").await;
    let held_by = second["heldBy"].as_str().unwrap_or_default();
    assert!(held_by.contains("Check the export dialog"), "{second}");

    // The observer reads the screen, and agent-desktop's reading commands get past the lease.
    let shot = desktops
        .act("th-b", call(DesktopAction::Screenshot, None))
        .await
        .unwrap();
    assert!(serde_json::to_value(shot).unwrap()["jpegB64"].is_string());
    let read = desktops
        .act(
            "th-b",
            call(DesktopAction::AgentDesktop, Some("snapshot -i")),
        )
        .await
        .unwrap_err();
    assert!(
        read.message.contains("isn't installed"),
        "past the lease: {read:?}"
    );
    // Acting is the holder's.
    let refused = desktops
        .act("th-b", call(DesktopAction::LeftClick, None))
        .await
        .unwrap_err();
    assert!(refused.message.contains("someone else's"), "{refused:?}");
    assert!(
        refused.message.contains("Check the export dialog"),
        "{refused:?}"
    );
    desktops
        .act("th-a", call(DesktopAction::LeftClick, None))
        .await
        .unwrap();
    assert_eq!(screen.did.lock().unwrap().as_slice(), ["click 3,4 1x1"]);

    // A person takes the observer's session over: the lease is theirs, and the agent that held it only observes.
    let b = desktops.live("th-b").unwrap();
    desktops.control(&b, BrowserControlTo::Human, "Ana");
    let a = desktops.live("th-a").unwrap();
    assert!(a.observing() && !b.observing());
    let taken = desktops
        .act("th-a", call(DesktopAction::Type, Some("hi")))
        .await
        .unwrap_err();
    assert!(
        taken.message.contains("a person has taken it over"),
        "{taken:?}"
    );

    // The person's session ends: the lease is free, and the next action takes it, unless the screen locked meanwhile.
    desktops.session_end("th-b").await.unwrap();
    *desktops.mac_gate.lock().unwrap() = locked;
    let blind = desktops
        .act("th-a", call(DesktopAction::Type, Some("hi")))
        .await
        .unwrap_err();
    assert!(blind.message.contains("locked"), "{blind:?}");
    *desktops.mac_gate.lock().unwrap() = clear;
    desktops
        .act("th-a", call(DesktopAction::Type, Some("hi")))
        .await
        .unwrap();
    assert!(!a.observing());
    assert_eq!(screen.did.lock().unwrap().last().unwrap(), "type hi");
    let ended = desktops.session_end("th-a").await.unwrap();
    assert_eq!(serde_json::to_value(ended).unwrap()["kind"], "mac");
    assert!(desktops.held_by().is_none());
    desktops.shutdown().await;
}

/// On a Mac set up for it (mac.yml's rust (macos), with FLEETD_REQUIRE_MAC_SCREEN=1): the gate as macOS answers it,
/// then a frame from ScreenCaptureKit and the pointer moved with CGEvent. Elsewhere it says so and passes.
#[cfg(target_os = "macos")]
#[test]
fn the_real_screen_reads_and_takes_input() {
    let required = std::env::var_os("FLEETD_REQUIRE_MAC_SCREEN").is_some();
    eprintln!("the Mac screen's gate here: {:?}", super::blocked());
    let screen = match super::input::MacScreen::open() {
        Ok(screen) => screen,
        Err(why) if !required => return eprintln!("no Mac screen here: {why}"),
        Err(why) => panic!("{why}"),
    };
    let raw = match screen.grab_raw() {
        Ok(raw) => raw,
        Err(why) if !required => return eprintln!("no frame here: {why}"),
        Err(why) => panic!("{why}"),
    };
    let (width, height) = screen.size();
    assert_eq!(
        (raw.width, raw.height),
        (width, height),
        "a frame in points"
    );
    assert_eq!(raw.data.len(), (width * height * 4) as usize);
    assert!(!screen.encode(&raw).unwrap().is_empty());
    screen.move_to(20, 30).unwrap();
    screen.sync().unwrap();
    assert_eq!(screen.pointer().unwrap(), (20, 30));
    screen.move_to(40, 50).unwrap();
    screen.sync().unwrap();
    assert_eq!(screen.pointer().unwrap(), (40, 50));
}
