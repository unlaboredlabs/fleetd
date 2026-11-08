//! `fleetd mac` (the `mac` on every agent session's PATH): the agents' Mac, from an agent on any machine. Each command
//! goes to the agent's own node, which seals it to the Mac (node/mac_tool). `mac run` prints the command's output as
//! it comes and exits with its exit code.
use std::io::Write;
use std::path::Path;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde_json::{Value, json};

use super::agent_mcp::{env_deps, send_call, send_to_node};

/// One step: past the node's own wait for the Mac (node/mac_tool/client.rs `SEND_WAIT`, 180 s) plus its wait for a
/// restarting hub's link (node/lead.rs `RELINK_WAIT`, 30 s).
const STEP_WAIT: Duration = Duration::from_secs(230);
/// A push or pull: many steps in one call.
const FILES_WAIT: Duration = Duration::from_secs(3600);

/// Exit codes of `mac` itself, apart from a command's own: the Mac can't be used now (none, offline, refused), and a
/// usage mistake.
pub const UNAVAILABLE: u8 = 69;
pub const USAGE: u8 = 64;

pub const HELP: &str = "\
mac: the agents' Mac, from wherever you run (fleetd's shared Mac for builds and iOS simulators).

  mac push                         your worktree as it is now (commits, changes, new files) becomes your folder on
                                   the Mac; only what changed goes across
  mac run [--bg] [--env NAME]... [--] <command line>
                                   runs it in your folder there with the Mac's shell, as ssh would; prints its output
                                   and exits with its exit code. --bg runs it on and prints its job number
  mac logs <job> [-f]              a job's output so far (-f: follow it to its end)
  mac ps                           your jobs
  mac kill <job>                   ends a job
  mac pull <path> [to]             a file or folder from your folder on the Mac into your worktree
  mac sim start [--device <type>]  an iOS simulator of your own on the Mac, booted (a plain iPhone; --device \"iPad
                                   Pro 13-inch (M5)\" another type, as xcrun simctl list devicetypes names it, booted
                                   from nothing: a minute or two). From then on agent-device drives it, running on
                                   the Mac (its files land in your folder there: mac pull them). In
                                   mac run, $FLEETD_MAC_SIM is its udid and $FLEETD_MAC_SIM_SET the device set plain
                                   simctl needs: xcrun simctl --set \"$FLEETD_MAC_SIM_SET\" <command> \"$FLEETD_MAC_SIM\"
  mac sim end                      ends it (30 minutes with no mac command ends it too)

Your folder there is $FLEETD_MAC_DIR, the pushed worktree $FLEETD_MAC_REPO; xcodebuild builds into your own
$FLEETD_MAC_DERIVED_DATA, and $FLEETD_MAC_CACHE is shared by every agent; pod (CocoaPods) and the Mac's other
Homebrew commands are on the PATH there. None of your secrets go to the Mac unless you name them with --env NAME. Every mac run lands in your action log.
";

pub fn run(args: &[String]) -> u8 {
    match args.first().map(String::as_str) {
        None | Some("-h" | "--help" | "help") => {
            print!("{HELP}");
            0
        }
        Some("push") => print_done(call(json!({ "step": "push" }), FILES_WAIT)),
        Some("run") => match parse_run(&args[1..]) {
            Ok((line, env, background)) => run_command(line, env, background),
            Err(why) => usage(&why),
        },
        Some("logs") => {
            let follow = args[1..].iter().any(|a| a == "-f" || a == "--follow");
            match args[1..]
                .iter()
                .find(|a| !a.starts_with('-'))
                .and_then(|j| j.parse::<u32>().ok())
            {
                Some(job) => follow_job(job, follow),
                None => usage("mac logs <job> [-f]"),
            }
        }
        Some("ps") => print_done(call(json!({ "step": "ps" }), STEP_WAIT)),
        Some("kill") => match args.get(1).and_then(|j| j.parse::<u32>().ok()) {
            Some(job) => print_done(call(json!({ "step": "kill", "job": job }), STEP_WAIT)),
            None => usage("mac kill <job>"),
        },
        Some("pull") => match args.get(1) {
            Some(path) => print_done(call(
                json!({ "step": "pull", "path": path, "to": args.get(2) }),
                FILES_WAIT,
            )),
            None => usage("mac pull <path> [to]"),
        },
        Some("sim") => match args.get(1).map(String::as_str) {
            Some("start") => match sim_device(&args[2..]) {
                Ok(device) => print_done(call(
                    json!({ "step": "sim_start", "device": device }),
                    STEP_WAIT,
                )),
                Err(why) => usage(why),
            },
            Some("end") => print_done(call(json!({ "step": "sim_end" }), STEP_WAIT)),
            _ => usage("mac sim start [--device <type>] | mac sim end"),
        },
        // The forwarding agent-device's while the session holds a simulator on the Mac (node/mac_tool/client.rs).
        Some("agent-device") => {
            let mut line = vec!["agent-device".to_owned()];
            line.extend(args[1..].iter().map(|a| sh_quote(a)));
            run_command(line, Vec::new(), false)
        }
        Some(other) => usage(&format!("mac has no command {other}")),
    }
}

/// `mac sim start`'s arguments: nothing, or `--device <type>` (`--device=<type>`).
pub fn sim_device(args: &[String]) -> Result<Option<String>, &'static str> {
    const USAGE: &str =
        "mac sim start [--device <type>], a type as xcrun simctl list devicetypes names it";
    match args {
        [] => Ok(None),
        [flag, device] if flag == "--device" && !device.trim().is_empty() => {
            Ok(Some(device.clone()))
        }
        [one] => match one.strip_prefix("--device=") {
            Some(device) if !device.trim().is_empty() => Ok(Some(device.to_owned())),
            _ => Err(USAGE),
        },
        _ => Err(USAGE),
    }
}

fn usage(why: &str) -> u8 {
    eprintln!("mac: {why}\nmac: see mac --help");
    USAGE
}

/// `run`'s command line, the variables it names with their values from this environment, and `--bg`.
pub fn parse_run(args: &[String]) -> Result<(Vec<String>, Vec<Value>, bool), String> {
    parse_run_with(args, |name| std::env::var(name).ok())
}

pub fn parse_run_with(
    args: &[String],
    var: impl Fn(&str) -> Option<String>,
) -> Result<(Vec<String>, Vec<Value>, bool), String> {
    let (mut env, mut background, mut i) = (Vec::new(), false, 0);
    while i < args.len() {
        match args[i].as_str() {
            "--" => {
                i += 1;
                break;
            }
            "--bg" => background = true,
            "--env" => {
                let name = args.get(i + 1).ok_or("--env needs a variable's name")?;
                let value = var(name).ok_or(format!("--env {name}: {name} isn't set here"))?;
                env.push(json!({ "name": name, "value": value }));
                i += 1;
            }
            flag if flag.starts_with("--env=") => {
                let name = &flag["--env=".len()..];
                let value = var(name).ok_or(format!("--env {name}: {name} isn't set here"))?;
                env.push(json!({ "name": name, "value": value }));
            }
            _ => break,
        }
        i += 1;
    }
    let line: Vec<String> = args[i..].to_vec();
    if line.is_empty() {
        return Err("mac run needs a command line".into());
    }
    Ok((line, env, background))
}

/// `arg` as one word for the Mac's shell.
pub fn sh_quote(arg: &str) -> String {
    let plain = !arg.is_empty()
        && arg
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./=:@,+%^".contains(c));
    if plain {
        arg.to_owned()
    } else {
        format!("'{}'", arg.replace('\'', r"'\''"))
    }
}

/// The node's answer: the result, or the error's lines and the exit code for it.
fn call(step: Value, wait: Duration) -> Result<Value, (String, u8)> {
    let send = |socket: &Path, frame: &Value| send_to_node(socket, frame, wait);
    let deps = env_deps(&send);
    let mut call = step;
    call["op"] = json!("mac");
    answer(send_call(call, &deps))
}

pub fn answer(frame: Result<Value, String>) -> Result<Value, (String, u8)> {
    let frame = frame.map_err(|why| (format!("mac: {why}\n"), UNAVAILABLE))?;
    if frame["result"].is_object() {
        return Ok(frame["result"].clone());
    }
    let error = &frame["error"];
    let mut text = format!(
        "mac: {}\n",
        error["message"]
            .as_str()
            .unwrap_or("the node sent no answer")
    );
    if let Some(fix) = error["fix"].as_str() {
        text.push_str(&format!("mac: {fix}\n"));
    }
    let code = match error["code"].as_str() {
        Some("machine_offline" | "forbidden") => UNAVAILABLE,
        _ => 1,
    };
    Err((text, code))
}

/// What a step that isn't `run` or `logs` printed.
pub fn shown(result: &Value) -> String {
    match result["step"].as_str() {
        Some("push") => format!(
            "pushed: {} ({} KB sent)\n",
            result["folder"].as_str().unwrap_or("?"),
            result["sentBytes"].as_u64().unwrap_or(0).div_ceil(1024)
        ),
        Some("ps") => {
            let jobs = result["jobs"].as_array().cloned().unwrap_or_default();
            if jobs.is_empty() {
                return "no jobs\n".into();
            }
            jobs.iter()
                .map(|j| {
                    let state = match (j["running"].as_bool(), j["exitCode"].as_i64()) {
                        (Some(true), _) => "running".to_owned(),
                        (_, Some(code)) => format!("exited {code}"),
                        _ => "ended".to_owned(),
                    };
                    format!(
                        "{:>4}  {:<10} {}{}\n",
                        j["job"].as_u64().unwrap_or(0),
                        state,
                        if j["background"].as_bool() == Some(true) {
                            "--bg "
                        } else {
                            ""
                        },
                        j["command"].as_str().unwrap_or("")
                    )
                })
                .collect()
        }
        Some("kill") => match result["killed"].as_bool() {
            Some(true) => format!("job {} ends\n", result["job"]),
            _ => format!("job {} isn't running\n", result["job"]),
        },
        Some("pull") => format!(
            "pulled: {} ({} KB)\n",
            result["path"].as_str().unwrap_or("?"),
            result["bytes"].as_u64().unwrap_or(0).div_ceil(1024)
        ),
        Some("run") => format!("job {}\n", result["job"]),
        Some("sim_start") => format!(
            "your simulator: {} ({}). Drive it with agent-device, which runs on the Mac now; end it with mac sim end. \
             Plain simctl there needs fleetd's device set: mac run -- 'xcrun simctl --set \"$FLEETD_MAC_SIM_SET\" \
             install \"$FLEETD_MAC_SIM\" <app>'\n",
            result["device"].as_str().unwrap_or("?"),
            result["udid"].as_str().unwrap_or("?")
        ),
        Some("sim_end") => match result["ended"].as_bool() {
            Some(true) => "your simulator ended\n".into(),
            _ => "you had no simulator on the Mac\n".into(),
        },
        _ => format!("{result}\n"),
    }
}

fn print_done(result: Result<Value, (String, u8)>) -> u8 {
    match result {
        Ok(result) => {
            print!("{}", shown(&result));
            0
        }
        Err((text, code)) => {
            eprint!("{text}");
            code
        }
    }
}

fn run_command(line: Vec<String>, env: Vec<Value>, background: bool) -> u8 {
    let step = json!({ "step": "run", "args": line, "env": env, "background": background });
    let job = match call(step, STEP_WAIT) {
        Ok(result) => result["job"].as_u64().unwrap_or(0) as u32,
        Err((text, code)) => {
            eprint!("{text}");
            return code;
        }
    };
    if background {
        println!("job {job} runs on the Mac: mac logs {job} -f follows it, mac kill {job} ends it");
        return 0;
    }
    follow_job(job, true)
}

/// Prints the job's output from the start; following, until it ends, with its exit code.
fn follow_job(job: u32, follow: bool) -> u8 {
    let mut offset = 0u64;
    loop {
        let result = match call(
            json!({ "step": "logs", "job": job, "offset": offset }),
            STEP_WAIT,
        ) {
            Ok(result) => result,
            Err((text, code)) => {
                eprint!("{text}");
                return code;
            }
        };
        let data = B64
            .decode(result["dataB64"].as_str().unwrap_or_default())
            .unwrap_or_default();
        let mut out = std::io::stdout();
        let _ = out.write_all(&data);
        let _ = out.flush();
        offset = result["offset"].as_u64().unwrap_or(offset);
        if result["done"].as_bool() == Some(true) {
            let code = result["exitCode"].as_i64().unwrap_or(1);
            return u8::try_from(code).unwrap_or(1);
        }
        if !follow && data.is_empty() {
            return 0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|a| a.to_string()).collect()
    }

    #[test]
    fn run_takes_its_flags_then_the_command_line_and_only_named_variables() {
        let var = |name: &str| (name == "GH_TOKEN").then(|| "tok".to_owned());
        let (line, env, bg) = parse_run_with(
            &strings(&["--bg", "--env", "GH_TOKEN", "--", "xcodebuild", "-version"]),
            var,
        )
        .unwrap();
        assert_eq!(line, strings(&["xcodebuild", "-version"]));
        assert_eq!(env, vec![json!({ "name": "GH_TOKEN", "value": "tok" })]);
        assert!(bg);
        // Flags after the command line are the command's own.
        let (line, env, bg) = parse_run_with(&strings(&["ls", "--bg"]), var).unwrap();
        assert_eq!((line, env.len(), bg), (strings(&["ls", "--bg"]), 0, false));
        assert!(parse_run_with(&strings(&["--env", "NOPE", "ls"]), var).is_err());
        assert!(parse_run_with(&strings(&["--bg"]), var).is_err());
    }

    #[test]
    fn sim_start_takes_a_device_type_or_nothing() {
        assert_eq!(sim_device(&[]), Ok(None));
        let ipad = Some("iPad Pro 13-inch (M5)".to_owned());
        assert_eq!(
            sim_device(&strings(&["--device", "iPad Pro 13-inch (M5)"])),
            Ok(ipad.clone())
        );
        assert_eq!(
            sim_device(&strings(&["--device=iPad Pro 13-inch (M5)"])),
            Ok(ipad)
        );
        for wrong in [
            &["--device"][..],
            &["iPad"],
            &["--device", ""],
            &["--device", "a", "b"],
        ] {
            assert!(sim_device(&strings(wrong)).is_err(), "{wrong:?}");
        }
    }

    #[test]
    fn a_mac_that_cant_be_used_exits_69_and_says_what_to_do() {
        let refused = json!({ "t": "lead_result", "id": "cli-1", "error": {
            "code": "machine_offline", "message": "No agents' Mac is online.", "fix": "do without the Mac",
        }});
        let (text, code) = answer(Ok(refused)).unwrap_err();
        assert_eq!(code, UNAVAILABLE);
        assert_eq!(
            text,
            "mac: No agents' Mac is online.\nmac: do without the Mac\n"
        );
        assert_eq!(answer(Err("no node".into())).unwrap_err().1, UNAVAILABLE);
    }

    #[test]
    fn agent_devices_arguments_reach_the_macs_shell_as_they_were() {
        assert_eq!(sh_quote("snapshot"), "snapshot");
        assert_eq!(sh_quote("@e3"), "@e3");
        assert_eq!(sh_quote("hello world"), "'hello world'");
        assert_eq!(sh_quote("it's"), r"'it'\''s'");
        assert_eq!(sh_quote("$(rm -rf ~)"), "'$(rm -rf ~)'");
        assert_eq!(sh_quote(""), "''");
    }

    #[test]
    fn ps_lists_each_job_on_a_line() {
        let ps = json!({ "step": "ps", "jobs": [
            { "job": 1, "command": "xcodebuild test", "background": false, "running": false, "exitCode": 0, "startedMs": 1 },
            { "job": 2, "command": "npx expo start", "background": true, "running": true, "startedMs": 2 },
        ]});
        assert_eq!(
            shown(&ps),
            "   1  exited 0   xcodebuild test\n   2  running    --bg npx expo start\n"
        );
    }

    #[test]
    fn the_command_reads_as_a_mac_lead_call() {
        let call: fleetd_contracts::lead_calls::LeadCall =
            serde_json::from_value(json!({ "op": "mac", "step": "kill", "job": 3 })).unwrap();
        assert_eq!(
            call,
            fleetd_contracts::lead_calls::LeadCall::Mac(fleetd_contracts::mac::MacCall::Kill {
                job: 3
            })
        );
    }
}
