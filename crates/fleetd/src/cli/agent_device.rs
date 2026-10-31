//! `fleetd agent-device <args>`: what the forwarding `agent-device` runs while an agent's iOS screen is on another
//! machine (node/device/remote.rs). The command goes to the agent's node over its socket, which knows the session by
//! this process and sends it on through the hub; its output and exit code come back as agent-device's own would.
use std::path::Path;
use std::time::Duration;

use serde_json::{Value, json};

use super::agent_mcp::{env_deps, send_call, send_to_node};

/// A command may send an app first and wait out a runner's start on the screen's machine.
const WAIT: Duration = Duration::from_secs(600);
/// How often a command is sent again while the screen's runner starts.
const STARTING_POLL: Duration = Duration::from_secs(1);

pub fn run(args: &[String]) -> u8 {
    let send = |socket: &Path, frame: &Value| send_to_node(socket, frame, WAIT);
    let deps = env_deps(&send);
    let call = json!({ "op": "device", "step": "run", "args": args });
    let started = std::time::Instant::now();
    let (stdout, stderr, code) = loop {
        let answered = answer(send_call(call.clone(), &deps));
        if !starting(&answered) || started.elapsed() > WAIT {
            break answered;
        }
        std::thread::sleep(STARTING_POLL);
    };
    use std::io::Write;
    let _ = std::io::stdout().write_all(stdout.as_bytes());
    let _ = std::io::stderr().write_all(stderr.as_bytes());
    code
}

/// Whether the screen's node held the command back while the screen's XCTest runner starts.
fn starting(answered: &(String, String, u8)) -> bool {
    answered.2 == 75 && answered.1 == crate::node::device::remote::RUNNER_STARTING
}

/// What to print, and the exit code, for the node's answer.
fn answer(frame: Result<Value, String>) -> (String, String, u8) {
    let frame = match frame {
        Ok(frame) => frame,
        Err(why) => return (String::new(), format!("fleetd: {why}\n"), 1),
    };
    let result = &frame["result"];
    if result["step"] == "run" {
        let code = result["exitCode"].as_i64().unwrap_or(1);
        return (
            result["stdout"].as_str().unwrap_or_default().to_owned(),
            result["stderr"].as_str().unwrap_or_default().to_owned(),
            u8::try_from(code).unwrap_or(1),
        );
    }
    let error = &frame["error"];
    let mut text = format!(
        "fleetd: {}\n",
        error["message"]
            .as_str()
            .unwrap_or("the node sent no answer")
    );
    if let Some(fix) = error["fix"].as_str() {
        text.push_str(&format!("fleetd: {fix}\n"));
    }
    (String::new(), text, 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_screens_output_and_exit_code_are_agent_devices_own() {
        let ran = json!({ "t": "browser_result", "id": "cli-1", "result": {
            "op": "device", "step": "run", "stdout": "@e1 [button] \"Send\"\n", "stderr": "", "exitCode": 75, "files": [],
        }});
        assert_eq!(
            answer(Ok(ran)),
            ("@e1 [button] \"Send\"\n".to_owned(), String::new(), 75)
        );
        let refused = json!({ "t": "browser_result", "id": "cli-1", "error": {
            "code": "invalid", "message": "agent-device `batch` doesn't run here.", "fix": "use only these commands",
        }});
        let (out, err, code) = answer(Ok(refused));
        assert_eq!((out.as_str(), code), ("", 1));
        assert_eq!(
            err,
            "fleetd: agent-device `batch` doesn't run here.\nfleetd: use only these commands\n"
        );
        assert_eq!(answer(Err("no node".into())).2, 1);
    }

    #[test]
    fn a_command_waits_while_the_screens_runner_starts_but_not_for_a_person() {
        let held = |stderr: &str| {
            answer(Ok(json!({ "result": {
                "op": "device", "step": "run", "stdout": "", "stderr": stderr, "exitCode": 75, "files": [],
            }})))
        };
        assert!(starting(&held(
            crate::node::device::remote::RUNNER_STARTING
        )));
        assert!(!starting(&held(crate::node::device::agent_device::PAUSED)));
    }

    #[test]
    fn the_command_reads_as_a_device_call() {
        let call: fleetd_contracts::browser::BrowserCall = serde_json::from_value(
            json!({ "op": "device", "step": "run", "args": ["snapshot", "-i"] }),
        )
        .unwrap();
        assert_eq!(
            call,
            fleetd_contracts::browser::BrowserCall::Device(
                fleetd_contracts::browser::DeviceCall::Run {
                    args: vec!["snapshot".into(), "-i".into()],
                }
            )
        );
    }
}
