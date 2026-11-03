//! `fleetd cloud stop`: the cloud machines' kill switch over the hub's MCP endpoint (cloud_stop), the same as Settings ›
//! Cloud's "Stop all cloud machines". On the hub machine it uses the CLI's own key and the address the hub listens on.
use serde_json::{Value, json};

use super::args::{self, Kind, Spec};
use super::time::Hub;

pub const CLOUD_USAGE: &str = r#"  cloud stop [--json] [--hub <url> --key-file <path>]
             the kill switch: turn cloud machines (boat.dev) off and stop every machine boat.dev
             lists with this hub's label, whether the hub's ledger knows it or not. They stay off
             until turned on again in Settings › Cloud. On the hub machine it needs neither --hub
             nor --key-file
"#;

#[derive(Debug, PartialEq)]
pub struct CloudArgs {
    pub hub: Option<(String, String)>,
    pub json: bool,
}

pub fn parse_cloud_args(argv: &[String]) -> Result<CloudArgs, String> {
    const OPTIONS: &[(&str, Kind)] = &[
        ("hub", Kind::Str),
        ("key-file", Kind::Str),
        ("json", Kind::Bool),
    ];
    let v = args::parse(
        argv,
        &Spec {
            options: OPTIONS,
            positionals: true,
        },
    )?;
    match v.positionals.as_slice() {
        [verb] if verb == "stop" => {}
        [] => return Err("cloud needs a command: stop".into()),
        [other, ..] => return Err(format!("unknown cloud command '{other}'")),
    }
    let hub = match (
        v.str("hub").filter(|s| !s.is_empty()),
        v.str("key-file").filter(|s| !s.is_empty()),
    ) {
        (Some(hub), Some(key_file)) => Some((hub.to_owned(), key_file.to_owned())),
        (None, None) => None,
        (Some(_), None) => return Err("--hub needs --key-file".into()),
        (None, Some(_)) => return Err("--key-file needs --hub".into()),
    };
    Ok(CloudArgs {
        hub,
        json: v.flag("json"),
    })
}

/// `fleetd cloud …`: exit 0, 1 when the hub refused the call or a stop failed, 2 on bad arguments, 3 when it refused
/// the key, 4 when it cannot be reached.
pub async fn cloud_command(argv: &[String]) -> u8 {
    let args = match parse_cloud_args(argv) {
        Ok(args) => args,
        Err(error) => {
            eprint!("fleetd: {error}\n\nusage:\n{CLOUD_USAGE}");
            return 2;
        }
    };
    let mut hub = match Hub::connect(&args.hub, None, "cloud").await {
        Ok(hub) => hub,
        Err(code) => return code,
    };
    let out = match hub.call("cloud_stop", json!({})).await {
        Ok(out) => out,
        Err(code) => return code,
    };
    if args.json {
        println!("{out}");
    } else {
        for line in stop_lines(&out) {
            println!("{line}");
        }
    }
    let failed = out
        .get("failed")
        .and_then(Value::as_array)
        .is_some_and(|f| !f.is_empty());
    u8::from(failed)
}

/// What the kill switch did, in plain lines.
pub fn stop_lines(out: &Value) -> Vec<String> {
    let list = |k: &str| -> Vec<String> {
        out.get(k)
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    };
    let stopped = list("stopped");
    let mut lines = vec![if stopped.is_empty() {
        "Cloud machines are off. None was running.".to_owned()
    } else {
        format!("Cloud machines are off. Stopped {}.", stopped.join(", "))
    }];
    for failed in list("failed") {
        lines.push(format!(
            "Not stopped: {failed}. Its lease stops it within 30 minutes."
        ));
    }
    if let Some(why) = out.get("unlisted").and_then(Value::as_str) {
        lines.push(format!(
            "boat.dev's list couldn't be read ({why}): stopped the machines the hub knows; leases stop any other within 30 minutes."
        ));
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn it_takes_stop_and_the_hub_options() {
        assert_eq!(
            parse_cloud_args(&argv(&["stop"])),
            Ok(CloudArgs {
                hub: None,
                json: false
            })
        );
        assert_eq!(
            parse_cloud_args(&argv(&[
                "stop",
                "--json",
                "--hub",
                "http://devbox:4790",
                "--key-file",
                "k"
            ])),
            Ok(CloudArgs {
                hub: Some(("http://devbox:4790".into(), "k".into())),
                json: true
            })
        );
        assert!(parse_cloud_args(&argv(&[])).is_err());
        assert!(parse_cloud_args(&argv(&["start"])).is_err());
        assert!(parse_cloud_args(&argv(&["stop", "--hub", "x"])).is_err());
    }

    #[test]
    fn it_says_what_stopped_and_what_didnt() {
        assert_eq!(
            stop_lines(&json!({ "stopped": [], "failed": [] })),
            ["Cloud machines are off. None was running."]
        );
        assert_eq!(
            stop_lines(&json!({
                "stopped": ["boat-1", "boat-3"],
                "failed": ["boat-2: boat.dev unreachable, retrying"],
                "unlisted": "boat.dev unreachable, retrying",
            })),
            [
                "Cloud machines are off. Stopped boat-1, boat-3.",
                "Not stopped: boat-2: boat.dev unreachable, retrying. Its lease stops it within 30 minutes.",
                "boat.dev's list couldn't be read (boat.dev unreachable, retrying): stopped the machines the hub knows; leases stop any other within 30 minutes.",
            ]
        );
    }
}
