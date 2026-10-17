//! `fleetd retro run`: asks the hub to run the retro now, over its MCP endpoint (retro_run, admin on every machine),
//! and prints what it proposed and dropped.

use std::time::Duration;

use serde_json::{Value, json};

use super::args::{self, Kind, Spec};
use super::lead::js_number;
use super::mcp_client::McpClient;

pub const RETRO_USAGE: &str = r#"  retro run --hub <url> --key-file <path> [--window 14d] [--advise]
             run the retro now: one claude -p turn over the window's incidents
             (1-28 days) proposes playbook changes; --advise only suggests them
"#;

#[derive(Debug, PartialEq)]
pub struct RetroArgs {
    pub hub: String,
    pub key_file: String,
    pub window_days: u32,
    pub advise: bool,
}

pub fn parse_retro_args(argv: &[String]) -> Result<RetroArgs, String> {
    let command = argv.first().map(String::as_str);
    if command != Some("run") {
        return Err(match command {
            None => "missing retro command".into(),
            Some(other) => format!("unknown retro command '{other}'"),
        });
    }
    const OPTIONS: &[(&str, Kind)] = &[
        ("hub", Kind::Str),
        ("key-file", Kind::Str),
        ("window", Kind::Str),
        ("advise", Kind::Bool),
    ];
    let v = args::parse(
        &argv[1..],
        &Spec {
            options: OPTIONS,
            positionals: false,
        },
    )?;
    let Some(hub) = v.str("hub").filter(|s| !s.is_empty()) else {
        return Err("--hub is required".into());
    };
    let Some(key_file) = v.str("key-file").filter(|s| !s.is_empty()) else {
        return Err("--key-file is required".into());
    };
    // /^([1-9]\d?)d?$/
    let window = v.str("window").unwrap_or("14d");
    let digits = window.strip_suffix('d').unwrap_or(window);
    let days = (matches!(digits.len(), 1 | 2)
        && !digits.starts_with('0')
        && digits.bytes().all(|b| b.is_ascii_digit()))
    .then(|| digits.parse::<u32>().ok())
    .flatten()
    .filter(|days| (1..=28).contains(days));
    let Some(window_days) = days else {
        return Err(format!("--window must be 1d to 28d, got '{window}'"));
    };
    Ok(RetroArgs {
        hub: hub.to_owned(),
        key_file: key_file.to_owned(),
        window_days,
        advise: v.flag("advise"),
    })
}

fn st<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn strings(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default()
}

fn line(p: &Value) -> String {
    format!(
        "  {} {} {} ({}): {} · fixes {} · {} down over {} d{}",
        st(p, "proposalId"),
        st(p, "playbook"),
        st(p, "kind"),
        strings(p, "fields"),
        st(p, "state"),
        strings(p, "fixesIncidents"),
        st(&p["metric"], "class"),
        js_number(&p["metric"]["windowDays"]),
        p.get("note")
            .and_then(Value::as_str)
            .map(|note| format!(" · {note}"))
            .unwrap_or_default()
    )
}

/// What `retro run` prints.
pub fn render_run(run: &Value, proposals: &[Value], next: Option<&str>) -> String {
    let incidents = run.get("incidents").and_then(Value::as_u64).unwrap_or(0);
    let dropped = run
        .get("dropped")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let mut lines = vec![format!(
        "retro run {} ({}{}): {} incident{} in {} d, {} proposed, {} dropped",
        js_number(&run["run"]),
        st(run, "trigger"),
        if run.get("advise") == Some(&Value::Bool(true)) {
            ", advise-only"
        } else {
            ""
        },
        incidents,
        if incidents == 1 { "" } else { "s" },
        js_number(&run["windowDays"]),
        proposals.len(),
        dropped.len()
    )];
    lines.extend(proposals.iter().map(line));
    lines.extend(dropped.iter().map(|d| {
        format!(
            "  dropped #{}{}: {}",
            d.get("index").and_then(Value::as_u64).unwrap_or(0) + 1,
            d.get("playbook")
                .and_then(Value::as_str)
                .map(|p| format!(" {p}"))
                .unwrap_or_default(),
            st(d, "reason")
        )
    }));
    if let Some(usage) = run.get("usage").filter(|u| !u.is_null()) {
        let tokens = match usage.get("inputTokens").filter(|t| !t.is_null()) {
            None => String::new(),
            Some(input) => format!(
                ", {} in / {} out tokens",
                js_number(input),
                usage
                    .get("outputTokens")
                    .map(js_number)
                    .unwrap_or("0".into())
            ),
        };
        let ok = if usage.get("ok") == Some(&Value::Bool(true)) {
            String::new()
        } else {
            format!(
                " (no usable answer: {})",
                usage
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
            )
        };
        let seconds = usage
            .get("durationMs")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            / 1000.0;
        lines.push(format!(
            "usage: {}, {seconds:.1} s{tokens}{ok}",
            st(usage, "model")
        ));
    }
    if let Some(next) = next {
        lines.push(next.to_owned());
    }
    lines.join("\n")
}

/// `fleetd retro …`: exit 0 when the run happened, 1 when the hub refused it, 2 on bad flags.
pub async fn retro_command(argv: &[String]) -> u8 {
    let args = match parse_retro_args(argv) {
        Ok(args) => args,
        Err(error) => {
            eprint!("fleetd: {error}\n\nusage:\n{RETRO_USAGE}");
            return 2;
        }
    };
    let key = match std::fs::read_to_string(&args.key_file) {
        Ok(key) => key.trim().to_owned(),
        Err(error) => {
            eprintln!("fleetd retro: cannot read --key-file: {error}");
            return 2;
        }
    };
    let mut arguments = json!({ "windowDays": args.window_days });
    if args.advise {
        arguments["advise"] = Value::Bool(true);
    }
    // A run is one claude turn, which can take a few minutes.
    let timeout = Duration::from_secs(290);
    let result = async {
        let mut client = McpClient::connect(&args.hub, &key, "fleetd-retro", timeout).await?;
        client.call_tool("retro_run", arguments, timeout).await
    }
    .await;
    match result {
        Err(error) => {
            eprintln!("fleetd retro: {}", error.message());
            1
        }
        Ok(result) if result.is_error => {
            let body = result.body;
            let fix = body
                .get("fix")
                .and_then(Value::as_str)
                .map(|fix| format!("\n  fix: {fix}"))
                .unwrap_or_default();
            eprintln!(
                "fleetd retro: {}{fix}",
                body.get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("undefined")
            );
            1
        }
        Ok(result) => {
            let body = result.body;
            let proposals = body
                .get("proposals")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            println!(
                "{}",
                render_run(
                    &body["run"],
                    &proposals,
                    body.get("next").and_then(Value::as_str)
                )
            );
            0
        }
    }
}
