//! `fleetd usage`: each machine's usage pause over the hub's MCP endpoint (usage_status), and `fleetd usage resume
//! <machine>` to lift one now (usage_resume), the same as the app's Resume. On the hub machine both use the CLI's own
//! key and the address the hub listens on (`fleetd init` saved it), so nobody makes a key or calls the endpoint by
//! hand.

use chrono_tz::Tz;
use serde_json::{Value, json};

use super::args::{self, Kind, Spec};
use super::time::{Hub, local};

pub const USAGE_USAGE: &str = r#"  usage [<machine>] [--json] [--hub <url> --key-file <path> | --home <dir>]
             each machine's Claude usage pause: open or not, why, until when, and how much is parked
  usage resume <machine> [--json] [--hub <url> --key-file <path> | --home <dir>]
             lift the machine's usage pause now and send every parked agent "continue", like
             Resume in the app; one whose login is still limited parks again with the real reset.
             --json adds pauseLifted (null when the pause couldn't be read first). On the hub
             machine neither needs --hub or --key-file
"#;

#[derive(Debug, PartialEq)]
pub struct UsageArgs {
    /// Both, or neither for the hub on this machine.
    pub hub: Option<(String, String)>,
    pub home: Option<String>,
    pub resume: bool,
    /// The machine; empty for every machine (status only).
    pub machine: String,
    pub json: bool,
}

pub fn parse_usage_args(argv: &[String]) -> Result<UsageArgs, String> {
    const OPTIONS: &[(&str, Kind)] = &[
        ("hub", Kind::Str),
        ("key-file", Kind::Str),
        ("home", Kind::Str),
        ("json", Kind::Bool),
    ];
    let v = args::parse(
        argv,
        &Spec {
            options: OPTIONS,
            positionals: true,
        },
    )?;
    let hub = match (
        v.str("hub").filter(|s| !s.is_empty()),
        v.str("key-file").filter(|s| !s.is_empty()),
    ) {
        (Some(hub), Some(key_file)) => Some((hub.to_owned(), key_file.to_owned())),
        (None, None) => None,
        (Some(_), None) => return Err("--hub needs --key-file".into()),
        (None, Some(_)) => return Err("--key-file needs --hub".into()),
    };
    let (resume, machine) = match v.positionals.as_slice() {
        [] => (false, String::new()),
        [verb, machine] if verb == "resume" => (true, machine.clone()),
        [verb] if verb == "resume" => return Err("usage resume needs the machine".into()),
        [machine] => (false, machine.clone()),
        _ => return Err("too many arguments".into()),
    };
    if !machine.is_empty() && !super::is_machine_id(&machine) {
        return Err(format!("not a machine id: {machine}"));
    }
    Ok(UsageArgs {
        hub,
        home: v.string("home"),
        resume,
        machine,
        json: v.flag("json"),
    })
}

/// `fleetd usage …`: exit 0, 1 when the hub refused the call, 2 on bad arguments, 3 when it refused the key, 4 when
/// it cannot be reached.
pub async fn usage_command(argv: &[String]) -> u8 {
    let args = match parse_usage_args(argv) {
        Ok(args) => args,
        Err(error) => {
            eprint!("fleetd: {error}\n\nusage:\n{USAGE_USAGE}");
            return 2;
        }
    };
    let mut hub = match Hub::connect(&args.hub, args.home.as_deref(), "usage").await {
        Ok(hub) => hub,
        Err(code) => return code,
    };
    match run(&mut hub, &args, crate::hub::attention::hub_zone()).await {
        Ok(()) => 0,
        Err(code) => code,
    }
}

async fn run(hub: &mut Hub, args: &UsageArgs, zone: Tz) -> Result<(), u8> {
    if args.resume {
        // Read first, best-effort: usage_resume answers with the state after, when the pause is already gone. A failed
        // read never holds the resume back; it only leaves out whether the pause was lifted.
        let was_paused = hub
            .try_call("usage_status", json!({ "machineId": args.machine }))
            .await
            .as_ref()
            .and_then(|before| before.get("machines")?.as_array()?.first().cloned())
            .map(|m| text(&m, &["breaker", "state"]) == Some("open"));
        let mut out = hub
            .call("usage_resume", json!({ "machineId": args.machine }))
            .await?;
        if args.json {
            // Whether this lifted the pause; null when the read before it failed.
            out["pauseLifted"] = json!(was_paused);
            println!("{out}");
        } else {
            println!("{}", resumed_line(&args.machine, was_paused, &out));
        }
        return Ok(());
    }
    let input = if args.machine.is_empty() {
        json!({})
    } else {
        json!({ "machineId": args.machine })
    };
    let out = hub.call("usage_status", input).await?;
    if args.json {
        println!("{out}");
        return Ok(());
    }
    for line in status_lines(&out, zone) {
        println!("{line}");
    }
    Ok(())
}

fn text<'a>(v: &'a Value, path: &[&str]) -> Option<&'a str> {
    path.iter().try_fold(v, |v, k| v.get(k))?.as_str()
}

fn count(v: &Value, path: &[&str]) -> u64 {
    path.iter()
        .try_fold(v, |v, k| v.get(k))
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

/// What `usage resume` did, from whether the machine was paused before it and usage_resume's answer: "Resumed
/// forge: lifted its usage pause and sent "continue" to 3 parked agents. …".
pub fn resumed_line(machine: &str, was_paused: Option<bool>, out: &Value) -> String {
    let resumed = count(out, &["resumed"]);
    let agents = if resumed == 1 { "agent" } else { "agents" };
    let sent = format!("sent \"continue\" to {resumed} parked {agents}");
    let still = "One whose login is still limited parks again with the real reset.";
    match (was_paused, resumed) {
        (Some(false), 0) => format!(
            "Nothing to resume on {machine}: it wasn't paused and nothing was parked there."
        ),
        (Some(true), 0) => format!(
            "Resumed {machine}: lifted its usage pause; nothing was parked there, so its next turn tries the login."
        ),
        (Some(true), _) => format!("Resumed {machine}: lifted its usage pause and {sent}. {still}"),
        // Unknown whether it was paused (the read before failed): only what the resume says.
        (None, 0) => format!("Resumed {machine}: nothing was parked there."),
        (_, _) => format!("Resumed {machine}: {sent}. {still}"),
    }
}

/// One block per machine: its state and why, then since and until when paused, with the way on.
pub fn status_lines(out: &Value, zone: Tz) -> Vec<String> {
    let machines = out
        .get("machines")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if machines.is_empty() {
        return vec!["No machines.".into()];
    }
    let mut rows = Vec::new();
    let mut more = Vec::new();
    for m in &machines {
        let id = text(m, &["machineId"]).unwrap_or("?");
        let parked = count(m, &["parked", "leads"]) + count(m, &["parked", "tasks"]);
        let parked = match parked {
            0 => "nothing parked".to_owned(),
            1 => "1 parked".to_owned(),
            n => format!("{n} parked"),
        };
        if text(m, &["breaker", "state"]) == Some("open") {
            let mut when = Vec::new();
            if let Some(since) = text(m, &["breaker", "since"]) {
                when.push(format!("since {}", local(since, zone)));
            }
            if let Some(until) = text(m, &["breaker", "until"]) {
                when.push(format!("until {}", local(until, zone)));
            } else if let Some(check) = text(m, &["breaker", "checkAt"]) {
                when.push(format!("next check {}", local(check, zone)));
            }
            rows.push(vec![
                id.to_owned(),
                "paused".into(),
                parked,
                when.join(", "),
            ]);
            if let Some(message) = text(m, &["breaker", "message"]) {
                more.push(format!("{id}: {message}"));
            }
            more.push(format!("  to go on now: fleetd usage resume {id}"));
        } else {
            rows.push(vec![id.to_owned(), "ok".into(), parked, String::new()]);
        }
    }
    let widths: Vec<usize> = (0..4)
        .map(|c| rows.iter().map(|r| r[c].chars().count()).max().unwrap_or(0))
        .collect();
    let mut lines: Vec<String> = rows
        .iter()
        .map(|r| {
            r.iter()
                .zip(&widths)
                .map(|(cell, w)| format!("{cell:<w$}"))
                .collect::<Vec<_>>()
                .join("  ")
                .trim_end()
                .to_owned()
        })
        .collect();
    if !more.is_empty() {
        lines.push(String::new());
        lines.extend(more);
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(s: &[&str]) -> Vec<String> {
        s.iter().map(|a| a.to_string()).collect()
    }

    #[test]
    fn resume_takes_one_machine_and_needs_no_key_on_the_hub_machine() {
        let a = parse_usage_args(&argv(&["resume", "forge"])).unwrap();
        assert_eq!(
            a,
            UsageArgs {
                hub: None,
                home: None,
                resume: true,
                machine: "forge".into(),
                json: false,
            }
        );
        assert!(!parse_usage_args(&argv(&[])).unwrap().resume);
        assert_eq!(
            parse_usage_args(&argv(&["forge"])).unwrap().machine,
            "forge"
        );
        assert!(parse_usage_args(&argv(&["resume"])).is_err());
        assert!(parse_usage_args(&argv(&["resume", "Not A Machine"])).is_err());
        assert!(parse_usage_args(&argv(&["--hub", "http://h:4790", "resume", "forge"])).is_err());
    }

    #[test]
    fn a_paused_machine_says_why_until_when_and_how_to_go_on() {
        let out = json!({ "machines": [
            { "machineId": "forge", "login": "custom_base_url", "parked": { "leads": 0, "tasks": 3 },
              "breaker": { "state": "open", "class": "usage_limit", "since": "2026-10-25T22:40:38.000Z",
                           "until": "2026-10-25T23:40:38.000Z",
                           "message": "The usage limit was reached on forge's login; resets Sun 23:40 UTC; 3 tasks parked" },
              "lastEvents": [] },
            { "machineId": "lab-a", "login": "subscription", "parked": { "leads": 0, "tasks": 0 },
              "breaker": { "state": "closed" }, "lastEvents": [] },
        ] });
        assert_eq!(
            status_lines(&out, chrono_tz::UTC),
            [
                "forge  paused  3 parked        since 2026-10-25 22:40, until 2026-10-25 23:40",
                "lab-a  ok      nothing parked",
                "",
                "forge: The usage limit was reached on forge's login; resets Sun 23:40 UTC; 3 tasks parked",
                "  to go on now: fleetd usage resume forge",
            ]
        );
        // usage_resume answers with the state after: closed, whether or not it lifted a pause.
        let after =
            |n: u64| json!({ "resumed": n, "status": { "breaker": { "state": "closed" } } });
        assert_eq!(
            resumed_line("forge", Some(true), &after(3)),
            "Resumed forge: lifted its usage pause and sent \"continue\" to 3 parked agents. One whose login is \
             still limited parks again with the real reset."
        );
        assert_eq!(
            resumed_line("forge", Some(true), &after(0)),
            "Resumed forge: lifted its usage pause; nothing was parked there, so its next turn tries the login."
        );
        assert_eq!(
            resumed_line("forge", Some(false), &after(1)),
            "Resumed forge: sent \"continue\" to 1 parked agent. One whose login is still limited parks again with \
             the real reset."
        );
        assert_eq!(
            resumed_line("forge", Some(false), &after(0)),
            "Nothing to resume on forge: it wasn't paused and nothing was parked there."
        );
        // The read before failed: the resume still went, and the line says only what its answer says.
        assert_eq!(
            resumed_line("forge", None, &after(2)),
            "Resumed forge: sent \"continue\" to 2 parked agents. One whose login is still limited parks again with \
             the real reset."
        );
        assert_eq!(
            resumed_line("forge", None, &after(0)),
            "Resumed forge: nothing was parked there."
        );
    }
}
