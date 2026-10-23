//! Lead-side commands. Their reader is an LLM running inside a lead or task, so every output says what to do next.
//! One call to the hub through the local node's socket: one JSON line out, one back.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use fleetd_contracts::lead_calls::{LeadCall, LeadSocketFrame};
use serde_json::{Map, Value, json};

use super::CliResult;
use super::args::{self, Kind, Spec};

/// Under the fleetd dir.
pub const NODE_SOCKET_PATH: &str = "node/node.sock";

pub const LEAD_USAGE: &str = r#"  brief create --workstream <W> (--json '<Brief>' | --file <path>)
             set the brief of a draft workstream and start it, or edit it
  request secret --key <k> --sink env:<machine>:<path>|file:<machine>:<path> [--env-name <N>]
      --text <t> [--workstream <W>]
             the human enters it in a masked field in the project's chat, sealed to that machine; an env:
             sink writes the line <N>=<value> (N defaults to the key uppercased, . and - as _). You get
             its fingerprint in a wake, never the value
  gated run --class irreversible|money|credential --argv '<json array>' --reason <r> [--cwd <abs>]
      [--secret-env NAME=<secret key> ...] [--timeout <sec>] [--workstream <W>]
             a command the node runs exactly as stored, in the project workspace by default, only after
             a human approves it in the project's chat; secrets come from the node's own sinks. The result
             arrives in a wake
  request withdraw <Q>
             take back a secret request or a command approval the human said in chat is not needed
  decide --key <k> --value <v> [--why <w>] [--scope project|workstream] [--workstream <W>]
             log a decision you made yourself
  decisions search "<query>"
  task spawn --workstream <W> --title <t> --prompt <p> [--kind write|read|review]
      [--profile high|medium] [--pr <url>] [--qa] [--item P<n>]
             delegate work to a subagent; writers get their own branch; a review task needs --pr, and --qa marks it a QA run; --item links it to
             that plan item
  task list [--state <s>] [--workstream <W>]
  task status <T>
  task message <T> "<text>" [--now]
             steer a running task (at its next step; --now stops its current step), answer a
             waiting one, or continue an ended one
  task cancel <T> [--reason <r>]
  close --workstream <W> --why "<why>"
             the workstream is done, and why; it stops nothing
  review verdict --task <T> --sha <full head SHA> --blocking <n> --non-blocking <n> --summary "<s>"
      [--baseline <n> --candidate <n>]
             the last step of a review task; a research judge also reports its metric for the
             baseline and the candidate, and fleetd computes GO, STOP or INCONCLUSIVE
  change enqueue --pr <url> [--task <T>] [--workstream <W>] [--item P<n>]
             put a PR on its repo's merge train (a write task's PR goes on by itself). Only the
             train merges. --item links the PR to that plan item
  plan [--workstream <W> --items '<json>'] [--why "<note>"] [--steer S<n>]
             set a workstream's plan items, in order: [{id?, title, weight?, size?, after?,
             milestone?}], must or polish, sized s, m or l (relative size, never hours); its
             open items left out are dropped. Without --items: the plan. Link work with --item;
             only fleetd marks an item done, once its PR merged through the train. --steer S<n>
             says the human's steer asked for it and acknowledges the steer
  workstream open --text "<intent>" [--template bugfix|feature|research]
             open a workstream for work taken from the chat: a draft to brief
             lead-side commands reach the hub through the local node (FLEETD_NODE_SOCK, default
             ~/.fleetd/node/node.sock); exit 0 ok, 2 usage, 3 refused, 4 hub unreachable
"#;

const LEAD_COMMANDS: &[&str] = &[
    "brief",
    "request",
    "decide",
    "decisions",
    "task",
    "close",
    "review",
    "change",
    "gated",
    "workstream",
    "plan",
];

pub fn is_lead_command(argv: &[String]) -> bool {
    argv.first()
        .is_some_and(|command| LEAD_COMMANDS.contains(&command.as_str()))
}

fn usage(message: &str) -> CliResult {
    CliResult::err(2, format!("fleetd: {message}\n\nusage:\n{LEAD_USAGE}"))
}

const OPTIONS: &[(&str, Kind)] = &[
    ("workstream", Kind::Str),
    ("json", Kind::Str),
    ("file", Kind::Str),
    ("kind", Kind::Str),
    ("key", Kind::Str),
    ("class", Kind::Str),
    ("text", Kind::Str),
    ("value", Kind::Str),
    ("why", Kind::Str),
    ("scope", Kind::Str),
    ("title", Kind::Str),
    ("prompt", Kind::Str),
    ("profile", Kind::Str),
    ("pr", Kind::Str),
    ("qa", Kind::Bool),
    ("now", Kind::Bool),
    ("state", Kind::Str),
    ("reason", Kind::Str),
    ("task", Kind::Str),
    ("sha", Kind::Str),
    ("blocking", Kind::Str),
    ("non-blocking", Kind::Str),
    ("summary", Kind::Str),
    ("sink", Kind::Str),
    ("env-name", Kind::Str),
    ("argv", Kind::Str),
    ("cwd", Kind::Str),
    ("secret-env", Kind::Multi),
    ("timeout", Kind::Str),
    ("baseline", Kind::Str),
    ("candidate", Kind::Str),
    ("template", Kind::Str),
    ("item", Kind::Str),
    ("items", Kind::Str),
    ("steer", Kind::Str),
];

/// `S` and a positive number, as `SteerId`.
fn is_steer_id(id: &str) -> bool {
    id.strip_prefix('S').is_some_and(|n| {
        !n.is_empty() && !n.starts_with('0') && n.bytes().all(|b| b.is_ascii_digit())
    })
}

fn parse_json(flag: &str, text: &str) -> Result<Value, String> {
    serde_json::from_str(text).map_err(|error| format!("{flag} is not valid JSON ({error})"))
}

/// Builds an object from the fields that are present, in order, as `definedOnly` did.
fn defined(fields: Vec<(&str, Option<Value>)>) -> Value {
    Value::Object(
        fields
            .into_iter()
            .filter_map(|(key, value)| value.map(|value| (key.to_owned(), value)))
            .collect(),
    )
}

fn s(value: Option<&str>) -> Option<Value> {
    value.map(|v| Value::String(v.to_owned()))
}

fn all_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}

/// `/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i`
fn is_decimal(text: &str) -> bool {
    let text = text.strip_prefix(['+', '-']).unwrap_or(text);
    let (mantissa, exponent) = match text.find(['e', 'E']) {
        Some(at) => (&text[..at], Some(&text[at + 1..])),
        None => (text, None),
    };
    let mantissa_ok = match mantissa.split_once('.') {
        Some(("", frac)) => all_digits(frac),
        Some((whole, frac)) => all_digits(whole) && (frac.is_empty() || all_digits(frac)),
        None => all_digits(mantissa),
    };
    let exponent_ok = exponent.is_none_or(|e| all_digits(e.strip_prefix(['+', '-']).unwrap_or(e)));
    mantissa_ok && exponent_ok
}

fn is_sha(text: &str) -> bool {
    (text.len() == 40 || text.len() == 64)
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn number(text: &str) -> Value {
    let parsed: f64 = text.trim().parse().unwrap_or(f64::NAN);
    serde_json::Number::from_f64(parsed).map_or(Value::Null, Value::Number)
}

/// The call `argv` asks for, validated against the contract; an error is a usage line.
pub fn parse_lead_args(
    argv: &[String],
    read_file: &dyn Fn(&str) -> std::io::Result<String>,
) -> Result<Value, String> {
    let v = args::parse(
        argv,
        &Spec {
            options: OPTIONS,
            positionals: true,
        },
    )?;
    let mut positionals = v.positionals.iter().map(String::as_str);
    let command = positionals.next();
    let sub = positionals.next();
    let rest: Vec<&str> = positionals.collect();
    // Flags that belong to a command; any other flag given is a usage error.
    let only = |allowed: &[&str]| -> Result<(), String> {
        match v.keys().find(|flag| !allowed.contains(flag)) {
            None => Ok(()),
            Some(extra) => Err(format!(
                "--{extra} does not apply to fleetd {}{}",
                command.unwrap_or(""),
                sub.map(|sub| format!(" {sub}")).unwrap_or_default()
            )),
        }
    };
    let required = |flags: &[&str]| -> Result<(), String> {
        match flags.iter().find(|flag| v.str(flag).is_none()) {
            Some(flag) => Err(format!("--{flag} is required")),
            None => Ok(()),
        }
    };

    let raw = match command {
        Some("brief") => {
            if sub != Some("create") || !rest.is_empty() {
                return Err(
                    "expected fleetd brief create --workstream <W> --json '<Brief>'".into(),
                );
            }
            only(&["workstream", "json", "file"])?;
            required(&["workstream"])?;
            if v.str("json").is_none() == v.str("file").is_none() {
                return Err("give the brief with exactly one of --json and --file".into());
            }
            let text = match (v.str("json"), v.str("file")) {
                (Some(json), _) => json.to_owned(),
                (None, Some(file)) => {
                    read_file(file).map_err(|_| format!("cannot read --file {file}"))?
                }
                (None, None) => unreachable!(),
            };
            let brief = parse_json(
                if v.str("json").is_some() {
                    "--json"
                } else {
                    "--file"
                },
                &text,
            )?;
            defined(vec![
                ("op", s(Some("brief_create"))),
                ("workstreamId", s(v.str("workstream"))),
                ("brief", Some(brief)),
            ])
        }
        Some("request") => match sub {
            Some("secret") if rest.is_empty() => {
                only(&["key", "sink", "env-name", "text", "workstream"])?;
                required(&["key", "sink", "text"])?;
                defined(vec![
                    ("op", s(Some("request_secret"))),
                    ("key", s(v.str("key"))),
                    ("sink", s(v.str("sink"))),
                    ("envName", s(v.str("env-name"))),
                    ("text", s(v.str("text"))),
                    ("workstreamId", s(v.str("workstream"))),
                ])
            }
            Some("withdraw") if rest.len() == 1 => {
                only(&[])?;
                defined(vec![
                    ("op", s(Some("request_withdraw"))),
                    ("requestId", s(Some(rest[0]))),
                ])
            }
            _ => {
                return Err(
                    "expected fleetd request secret --key <k> --sink <sink> --text <t> or fleetd request withdraw <Q>"
                        .into(),
                );
            }
        },
        Some("decide") => {
            if let Some(sub) = sub {
                return Err(format!("unexpected '{sub}': give the value with --value"));
            }
            only(&["key", "value", "why", "scope", "workstream"])?;
            required(&["key", "value"])?;
            defined(vec![
                ("op", s(Some("decide"))),
                ("key", s(v.str("key"))),
                ("value", s(v.str("value"))),
                ("why", s(v.str("why"))),
                ("scope", s(v.str("scope"))),
                ("workstreamId", s(v.str("workstream"))),
            ])
        }
        Some("decisions") => {
            if sub != Some("search") {
                return Err(r#"expected fleetd decisions search "<query>""#.into());
            }
            only(&[])?;
            if rest.is_empty() {
                return Err(r#"expected fleetd decisions search "<query>""#.into());
            }
            json!({ "op": "decisions_search", "query": rest.join(" ") })
        }
        Some("task") => match sub {
            Some("spawn") => {
                if let Some(first) = rest.first() {
                    return Err(format!(
                        "unexpected '{first}': put the task's instructions in --prompt"
                    ));
                }
                only(&[
                    "workstream",
                    "title",
                    "prompt",
                    "kind",
                    "profile",
                    "pr",
                    "qa",
                    "item",
                ])?;
                required(&["workstream", "title", "prompt"])?;
                defined(vec![
                    ("op", s(Some("task_spawn"))),
                    ("workstreamId", s(v.str("workstream"))),
                    ("title", s(v.str("title"))),
                    ("prompt", s(v.str("prompt"))),
                    ("kind", s(v.str("kind"))),
                    ("profile", s(v.str("profile"))),
                    ("pr", s(v.str("pr"))),
                    ("qa", v.flag("qa").then_some(Value::Bool(true))),
                    ("item", s(v.str("item"))),
                ])
            }
            Some("list") => {
                only(&["state", "workstream"])?;
                if let Some(first) = rest.first() {
                    return Err(format!(
                        "unexpected '{first}': filter with --state or --workstream"
                    ));
                }
                defined(vec![
                    ("op", s(Some("task_list"))),
                    ("state", s(v.str("state"))),
                    ("workstreamId", s(v.str("workstream"))),
                ])
            }
            Some("status") => {
                only(&[])?;
                if rest.len() != 1 {
                    return Err("expected fleetd task status <T>".into());
                }
                json!({ "op": "task_status", "taskId": rest[0] })
            }
            Some("message") => {
                only(&["now"])?;
                if rest.len() < 2 {
                    return Err(r#"expected fleetd task message <T> "<text>" [--now]"#.into());
                }
                defined(vec![
                    ("op", s(Some("task_message"))),
                    ("taskId", s(Some(rest[0]))),
                    ("message", Some(Value::String(rest[1..].join(" ")))),
                    ("now", v.flag("now").then_some(Value::Bool(true))),
                ])
            }
            Some("cancel") => {
                only(&["reason"])?;
                if rest.len() != 1 {
                    return Err("expected fleetd task cancel <T> [--reason <r>]".into());
                }
                defined(vec![
                    ("op", s(Some("task_cancel"))),
                    ("taskId", s(Some(rest[0]))),
                    ("reason", s(v.str("reason"))),
                ])
            }
            _ => return Err("expected fleetd task spawn|list|status|message|cancel".into()),
        },
        Some("close") => {
            if sub.is_some() || !rest.is_empty() {
                return Err(r#"expected fleetd close --workstream <W> --why "<why>""#.into());
            }
            only(&["workstream", "why"])?;
            required(&["workstream", "why"])?;
            defined(vec![
                ("op", s(Some("close"))),
                ("workstreamId", s(v.str("workstream"))),
                ("why", s(v.str("why"))),
            ])
        }
        Some("review") => {
            if sub != Some("verdict") || !rest.is_empty() {
                return Err(r#"expected fleetd review verdict --task <T> --sha <sha> --blocking <n> --non-blocking <n> --summary "<s>""#.into());
            }
            only(&[
                "task",
                "sha",
                "blocking",
                "non-blocking",
                "summary",
                "baseline",
                "candidate",
            ])?;
            if v.str("baseline").is_none() != v.str("candidate").is_none() {
                return Err(
                    "give --baseline and --candidate together: the metric measured for each".into(),
                );
            }
            for flag in ["baseline", "candidate"] {
                if let Some(value) = v.str(flag)
                    && !is_decimal(value.trim())
                {
                    return Err(format!("--{flag} is a number, got '{value}'"));
                }
            }
            required(&["task", "sha", "blocking", "non-blocking", "summary"])?;
            let given = v.str("sha").unwrap_or_default();
            let sha = given.trim().to_lowercase();
            if !is_sha(&sha) {
                return Err(format!(
                    "--sha must be the full commit SHA (40 hex characters; `git rev-parse HEAD` or `gh pr view <url> --json headRefOid`), got '{given}'"
                ));
            }
            for flag in ["blocking", "non-blocking"] {
                let value = v.str(flag).unwrap_or_default();
                if !all_digits(value) {
                    return Err(format!("--{flag} is a count of findings, got '{value}'"));
                }
            }
            let mut call = json!({
                "op": "review_verdict",
                "taskId": v.str("task"),
                "prHeadSha": sha,
                "blocking": number(v.str("blocking").unwrap_or_default()),
                "nonBlocking": number(v.str("non-blocking").unwrap_or_default()),
                "summary": v.str("summary"),
            });
            if let (Some(baseline), Some(candidate)) = (v.str("baseline"), v.str("candidate")) {
                call["metricValues"] =
                    json!({ "baseline": number(baseline), "candidate": number(candidate) });
            }
            call
        }
        Some("change") => match sub {
            Some("enqueue") => {
                only(&["pr", "task", "workstream", "item"])?;
                if rest.len() > 1 || (rest.len() == 1 && v.str("pr").is_some()) {
                    return Err("expected fleetd change enqueue --pr <url>".into());
                }
                let Some(pr_url) = v.str("pr").or(rest.first().copied()) else {
                    return Err("--pr is required".into());
                };
                defined(vec![
                    ("op", s(Some("change_enqueue"))),
                    ("prUrl", s(Some(pr_url))),
                    ("taskId", s(v.str("task"))),
                    ("workstreamId", s(v.str("workstream"))),
                    ("item", s(v.str("item"))),
                ])
            }
            _ => return Err("expected fleetd change enqueue".into()),
        },
        Some("gated") => {
            if sub != Some("run") || !rest.is_empty() {
                return Err(
                    "expected fleetd gated run --class <c> --argv '<json array>' --reason <r>"
                        .into(),
                );
            }
            only(&[
                "class",
                "argv",
                "reason",
                "cwd",
                "secret-env",
                "timeout",
                "workstream",
            ])?;
            required(&["class", "argv", "reason"])?;
            let words = parse_json("--argv", v.str("argv").unwrap_or_default())?;
            if !words
                .as_array()
                .is_some_and(|items| items.iter().all(Value::is_string))
            {
                return Err(
                    r#"--argv is a JSON array of strings, e.g. '["sh","-c","echo hi"]'"#.into(),
                );
            }
            let mut secret_env = Vec::new();
            for entry in v.multi("secret-env") {
                match entry.find('=') {
                    Some(at) if at > 0 && at != entry.len() - 1 => {
                        secret_env
                            .push(json!({ "name": &entry[..at], "secretKey": &entry[at + 1..] }));
                    }
                    _ => return Err(format!("--secret-env is NAME=<secret key>, got '{entry}'")),
                }
            }
            if let Some(timeout) = v.str("timeout")
                && !all_digits(timeout)
            {
                return Err(format!("--timeout is whole seconds, got '{timeout}'"));
            }
            defined(vec![
                ("op", s(Some("gated_run"))),
                ("argv", Some(words)),
                ("cwd", s(v.str("cwd"))),
                ("class", s(v.str("class"))),
                ("reason", s(v.str("reason"))),
                (
                    "secretEnv",
                    (!secret_env.is_empty()).then_some(Value::Array(secret_env)),
                ),
                ("timeoutSec", v.str("timeout").map(number)),
                ("workstreamId", s(v.str("workstream"))),
            ])
        }
        Some("workstream") if sub == Some("open") && rest.is_empty() => {
            only(&["text", "template"])?;
            required(&["text"])?;
            defined(vec![
                ("op", s(Some("workstream_open"))),
                ("text", s(v.str("text"))),
                ("template", s(v.str("template"))),
            ])
        }
        Some("workstream") => {
            return Err(r#"expected fleetd workstream open --text "<intent>""#.into());
        }
        Some("plan") => {
            if sub.is_some() || !rest.is_empty() {
                return Err(r#"expected fleetd plan [--workstream <W> --items '<json>'] [--why "<note>"] [--steer S<n>]"#.into());
            }
            only(&["workstream", "items", "why", "steer"])?;
            if v.str("items").is_some() {
                required(&["workstream"])?;
            }
            let items = match v.str("items") {
                None => None,
                Some(json) => Some(
                    serde_json::from_str::<Value>(json)
                        .ok()
                        .filter(Value::is_array)
                        .ok_or("--items is a JSON array of {id?, title, weight?, size?, after?, milestone?}")?,
                ),
            };
            // `--steer S12`: the change answers that steer, which also acknowledges it.
            let steer = match v.str("steer") {
                None => None,
                Some(id) if is_steer_id(id) => s(Some(id)),
                Some(id) => return Err(format!("--steer is a steer id like S12, got '{id}'")),
            };
            defined(vec![
                ("op", s(Some("plan"))),
                ("workstreamId", s(v.str("workstream"))),
                ("items", items),
                ("why", s(v.str("why"))),
                ("steer", steer),
            ])
        }
        other => return Err(format!("unknown command '{}'", other.unwrap_or(""))),
    };
    validate_call(raw)
}

/// Decodes the call against the contract (filling its defaults) and encodes it back for the wire.
fn validate_call(raw: Value) -> Result<Value, String> {
    let call: LeadCall = serde_json::from_value(raw)
        .map_err(|error| format!("invalid input: {}", error.to_string().replace('\n', " ")))?;
    serde_json::to_value(&call).map_err(|error| format!("invalid input: {error}"))
}

/// `path.normalize` for an absolute path: `.` and `..` resolved lexically, a trailing slash kept.
fn normalize(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            part => parts.push(part),
        }
    }
    let mut out = format!("/{}", parts.join("/"));
    if path.ends_with('/') && out != "/" {
        out.push('/');
    }
    out
}

/// The working directory as the caller's shell names it. The node keeps workspace roots as written, symlinks included,
/// and starts agents there, so the shell's logical `PWD` matches a root where the kernel's resolved path may not.
pub fn caller_cwd(pwd: Option<&str>, physical: &Path) -> String {
    let physical_text = physical.to_string_lossy().into_owned();
    let Some(logical) = pwd.filter(|p| p.starts_with('/')) else {
        return physical_text;
    };
    match (
        std::fs::canonicalize(logical),
        std::fs::canonicalize(physical),
    ) {
        (Ok(a), Ok(b)) if a == b => normalize(logical),
        _ => physical_text,
    }
}

pub fn node_socket_path(env_sock: Option<&str>) -> PathBuf {
    match env_sock.filter(|s| !s.is_empty()) {
        Some(sock) => PathBuf::from(sock),
        None => crate::home::fleetd_dir().join(NODE_SOCKET_PATH),
    }
}

/// One frame out, one frame back over the node's socket. The node answers within ~35 s; `timeout` is a backstop.
/// `Err` is why the node could not be asked or did not answer.
pub fn send_to_node(socket: &Path, frame: &Value, timeout: Duration) -> Result<Value, String> {
    let shown = socket.display();
    let mut conn = UnixStream::connect(socket).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused => format!(
            "fleetd hub unreachable: no fleetd node is listening at {shown} (set FLEETD_NODE_SOCK if it is elsewhere) — tell the human the node is down and carry on"
        ),
        _ => format!("cannot reach the fleetd node at {shown}: {error}"),
    })?;
    let started = Instant::now();
    let timed_out = || {
        format!(
            "the fleetd node did not answer within {} s; the call may or may not have gone through — try again shortly",
            timeout.as_secs()
        )
    };
    conn.write_all(format!("{frame}\n").as_bytes())
        .map_err(|error| format!("cannot reach the fleetd node at {shown}: {error}"))?;
    conn.set_read_timeout(Some(
        timeout
            .saturating_sub(started.elapsed())
            .max(Duration::from_millis(1)),
    ))
    .map_err(|error| format!("cannot reach the fleetd node at {shown}: {error}"))?;
    let mut line = String::new();
    match BufReader::new(conn).read_line(&mut line) {
        Ok(_) if line.ends_with('\n') => {}
        Ok(_) => {
            return Err(
                "the fleetd node closed the connection without answering — try again shortly"
                    .into(),
            );
        }
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
            ) =>
        {
            return Err(timed_out());
        }
        Err(error) => return Err(format!("cannot reach the fleetd node at {shown}: {error}")),
    }
    decode_result_frame(line.trim_end_matches('\n'))
        .ok_or_else(|| "the fleetd node sent an answer this CLI cannot read; check that node and CLI versions match".to_owned())
}

/// The node's answer, checked against the contract (a `lead_result` with exactly one of result and error).
fn decode_result_frame(line: &str) -> Option<Value> {
    match serde_json::from_str::<LeadSocketFrame>(line).ok()? {
        LeadSocketFrame::LeadResult(_) => serde_json::from_str(line).ok(),
        LeadSocketFrame::LeadCall(_) => None,
    }
}

// ---- output ----

fn st<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn opt<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key).filter(|v| !v.is_null())
}

fn arr<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn js(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::String(s)) => s.clone(),
        Some(v) => v.to_string(),
    }
}

fn short(text: &str) -> &str {
    text.get(..12).unwrap_or(text)
}

fn scope_label(decision: &Value) -> String {
    let scope = &decision["scope"];
    if st(scope, "kind") == "workstream" {
        format!("workstream {}", st(scope, "workstreamId"))
    } else {
        st(scope, "kind").to_owned()
    }
}

fn decision_line(decision: &Value) -> String {
    format!(
        "{} {} = {} ({}, by {})",
        st(decision, "decisionId"),
        st(decision, "key"),
        st(decision, "value"),
        scope_label(decision),
        st(decision, "source")
    )
}

fn task_line(task: &Value) -> String {
    let why = match opt(task, "queuedReason") {
        Some(reason) if st(task, "state") == "queued" => format!(" ({})", js(Some(reason))),
        _ => String::new(),
    };
    format!(
        "{} {}{} [{}, {}] {}{}",
        st(task, "taskId"),
        st(task, "state"),
        why,
        st(task, "kind"),
        st(task, "profile"),
        st(task, "title"),
        opt(task, "branch")
            .map(|b| format!(" on {}", js(Some(b))))
            .unwrap_or_default()
    )
}

fn quoted(text: &str) -> Vec<String> {
    text.trim()
        .split('\n')
        .map(|line| format!("  > {line}").trim_end().to_owned())
        .collect()
}

/// The next step for a task in this state.
fn task_next(task: &Value) -> String {
    let id = st(task, "taskId");
    match st(task, "state") {
        "queued" => format!(
            "nothing to do; {id} starts by itself once that clears, and its result arrives inline in a later wake. End your turn when you have nothing else to do."
        ),
        "running" => format!(
            "don't poll it. {id}'s result arrives inline in a later wake; end your turn when you have nothing else to do."
        ),
        "idle" => format!(
            "{id} is waiting for input: answer it with fleetd task message {id} \"<answer>\", or fleetd task cancel {id}."
        ),
        "done" | "failed" => format!(
            "judge the result. fleetd task message {id} \"<text>\" continues the same thread; or spawn a follow-up task."
        ),
        "cancelled" => "nothing; spawn a new task if the work is still needed.".into(),
        _ => "undefined".into(),
    }
}

/// Every field the lead may need about one task, then its result if it has one.
fn task_detail(task: &Value) -> Vec<String> {
    let mut lines = vec![
        task_line(task),
        format!(
            "  workstream {}{}, attempt {}",
            st(task, "workstreamId"),
            opt(task, "pr")
                .map(|pr| format!(
                    ", reviews {}{}",
                    js(Some(pr)),
                    if task.get("qa") == Some(&Value::Bool(true)) {
                        " (QA)"
                    } else {
                        ""
                    }
                ))
                .unwrap_or_default(),
            js(opt(task, "attempt"))
        ),
    ];
    if let Some(thread) = opt(task, "threadRef") {
        lines.push(format!(
            "  thread {}/{}",
            st(thread, "machineId"),
            st(thread, "threadId")
        ));
    }
    if let Some(result) = opt(task, "result") {
        lines.push(format!(
            "  result ({}{}):",
            st(result, "status"),
            opt(result, "prUrl")
                .map(|url| format!(", PR {}", js(Some(url))))
                .unwrap_or_default()
        ));
        let tail = st(result, "tail");
        if tail.trim().is_empty() {
            lines.push("  > (no final message)".into())
        } else {
            lines.extend(quoted(tail))
        }
    }
    lines
}

/// A Change: where it is on the train, its reviews, and why it is parked if it is.
fn change_lines(change: &Value) -> Vec<String> {
    let where_ = match opt(change, "position").and_then(Value::as_f64) {
        None => String::new(),
        Some(0.0) => ", next in line".into(),
        Some(_) => format!(", {} ahead of it", js(opt(change, "position"))),
    };
    let mut lines = vec![
        format!(
            "{} {}#{} {}{}{}",
            st(change, "changeId"),
            st(change, "repo"),
            js(opt(change, "prNumber")),
            st(change, "state"),
            where_,
            opt(change, "taskId")
                .map(|t| format!(" (by {})", js(Some(t))))
                .unwrap_or_default()
        ),
        format!(
            "  {} at {}{}",
            st(change, "prUrl"),
            short(st(change, "headSha")),
            opt(change, "mergedSha")
                .map(|m| format!(", merged as {}", short(m.as_str().unwrap_or(""))))
                .unwrap_or_default()
        ),
    ];
    let reviews = arr(change, "reviews");
    if !reviews.is_empty() {
        let shown: Vec<String> = reviews
            .iter()
            .map(|r| {
                format!(
                    "{} {} blocking at {}",
                    st(r, "taskId"),
                    js(opt(r, "blocking")),
                    short(st(r, "prHeadSha"))
                )
            })
            .collect();
        lines.push(format!("  reviews: {}", shown.join(", ")));
    }
    if let Some(error) = opt(change, "lastError") {
        lines.extend(quoted(error.as_str().unwrap_or("")));
    }
    lines
}

/// What happened, then `Next:` with the hub's hint or a default.
pub fn format_result(result: &Value) -> String {
    let mut lines: Vec<String> = Vec::new();
    let next: String;
    match st(result, "op") {
        "brief_create" => {
            lines.push(format!(
                "Brief for {} saved; the workstream is {}.",
                st(result, "workstreamId"),
                st(result, "state")
            ));
            next = "carry on with the workstream.".into();
        }
        "request_secret" => {
            lines.push(format!(
                "{} {}: the human enters it in the project's chat; the value never reaches you.",
                st(result, "requestId"),
                st(result, "state")
            ));
            next = "carry on with other work; its fingerprint arrives in a wake.".into();
        }
        "request_withdraw" => {
            lines.push(format!(
                "{} is {}.",
                st(result, "requestId"),
                st(result, "state")
            ));
            next = "carry on.".into();
        }
        "decide" => {
            lines.push(format!("Logged {}.", decision_line(&result["decision"])));
            next = "carry on. This key will not be asked again in this scope.".into();
        }
        "decisions_search" => {
            let decisions = arr(result, "decisions");
            if decisions.is_empty() {
                lines.push("No decisions match.".into());
                next = "decide it yourself and log it with fleetd decide; ask the human in chat only for product, money, credential or irreversible calls.".into();
            } else {
                lines.extend(decisions.iter().map(decision_line));
                next = "use these answers; do not ask about these keys again.".into();
            }
        }
        "task_spawn" => {
            let task = &result["task"];
            if st(task, "state") == "failed" {
                lines.push(format!("{} could not start.", st(task, "taskId")));
                lines.extend(task_detail(task));
                next = "fix what the result says, then spawn it again.".into();
            } else {
                let state = if st(task, "state") == "queued" {
                    format!(
                        "queued ({})",
                        opt(task, "queuedReason")
                            .and_then(Value::as_str)
                            .unwrap_or("waiting")
                    )
                } else {
                    st(task, "state").to_owned()
                };
                lines.push(format!("Spawned {}: {state}.", st(task, "taskId")));
                lines.push(task_line(task));
                next = task_next(task);
            }
        }
        "task_status" => {
            lines.extend(task_detail(&result["task"]));
            next = task_next(&result["task"]);
        }
        "task_message" => {
            let task = &result["task"];
            let queued = st(task, "state") == "queued";
            // The steer this message was sent as; its receipt reaches the lead's digest.
            let steer = ["steerId", "steer_id"]
                .iter()
                .find_map(|k| result.get(*k).and_then(Value::as_str))
                .map(|id| format!(" as steer {id}"))
                .unwrap_or_default();
            lines.push(if queued {
                format!(
                    "Message for {}{steer} held until it starts ({}).",
                    st(task, "taskId"),
                    opt(task, "queuedReason")
                        .and_then(Value::as_str)
                        .unwrap_or("queued")
                )
            } else {
                format!("Message sent to {}{steer}.", st(task, "taskId"))
            });
            lines.push(task_line(task));
            next = if queued {
                task_next(task)
            } else {
                format!(
                    "don't poll it. {}'s result arrives inline in a later wake.",
                    st(task, "taskId")
                )
            };
        }
        "task_cancel" => {
            lines.push(format!(
                "{} cancelled; its slot is free.",
                st(&result["task"], "taskId")
            ));
            next = task_next(&result["task"]);
        }
        "task_list" => {
            let tasks = arr(result, "tasks");
            if tasks.is_empty() {
                lines.push("No tasks.".into())
            } else {
                lines.extend(tasks.iter().map(task_line))
            }
            if result.get("truncated") == Some(&Value::Bool(true)) {
                lines.push("(older tasks not shown; filter with --state or --workstream)".into());
            }
            next = if tasks.is_empty() {
                "spawn work with fleetd task spawn.".into()
            } else {
                "fleetd task status <T> shows one task's result.".into()
            };
        }
        "close" => {
            lines.push(format!(
                "{} is {}.",
                st(result, "workstreamId"),
                st(result, "state")
            ));
            next = "tell the human in a line.".into();
        }
        "review_verdict" => {
            let v = &result["verdict"];
            let metric = opt(v, "metricValues")
                .map(|m| {
                    format!(
                        " Metric: baseline {}, candidate {}.",
                        js(opt(m, "baseline")),
                        js(opt(m, "candidate"))
                    )
                })
                .unwrap_or_default();
            lines.push(format!(
                "Recorded the verdict of {} at {}: {} blocking, {} non-blocking.{metric}",
                st(v, "taskId"),
                short(st(v, "prHeadSha")),
                js(opt(v, "blocking")),
                js(opt(v, "nonBlocking"))
            ));
            next = "end with your one-paragraph result and stop.".into();
        }
        "workstream_open" => {
            lines.push(format!("Opened {}.", st(result, "workstreamId")));
            next = format!(
                "brief it with fleetd brief create --workstream {}.",
                st(result, "workstreamId")
            );
        }
        "change_enqueue" => {
            lines.extend(change_lines(&result["change"]));
            next = "don't merge it yourself; the train merges and the outcome arrives in a wake."
                .into();
        }
        "plan" => {
            lines.push(st(result, "text").trim_end().to_owned());
            next = "link work with --item; only fleetd marks items done.".into();
        }
        "gated_run" => {
            lines.push(format!(
                "{} {}: the command is stored and waits for a human to approve it in the chat; nothing runs before that.",
                st(result, "requestId"),
                st(result, "state")
            ));
            next =
                "carry on with other work; the exit code and output tail arrive in a wake.".into();
        }
        _ => next = "undefined".into(),
    }
    if let Some(warning) = opt(result, "warning").and_then(Value::as_str) {
        lines.push(format!("Warning: {warning}"));
    }
    let next = opt(result, "next")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or(next);
    format!("{}\nNext: {next}\n", lines.join("\n"))
}

/// Where a lead command runs and how it reaches the node; tests swap `send`.
pub struct LeadDeps<'a> {
    pub pwd: Option<String>,
    pub sock: Option<String>,
    /// `FLEETD_THREAD_ID`: set inside a fleetd session, so the hub knows which agent is calling.
    pub thread: Option<String>,
    pub cwd: PathBuf,
    pub send: &'a dyn Fn(&Path, &Value) -> Result<Value, String>,
    pub read_file: &'a dyn Fn(&str) -> std::io::Result<String>,
}

/// `fleetd brief|request|decide|decisions|task|close|review|change|gated|workstream|plan …`.
pub fn lead_command(argv: &[String], deps: &LeadDeps) -> CliResult {
    let call = match parse_lead_args(argv, deps.read_file) {
        Ok(call) => call,
        Err(message) => return usage(&message),
    };
    let answer = match send_call(call, deps) {
        Ok(answer) => answer,
        Err(unreachable) => return CliResult::err(4, format!("fleetd: {unreachable}\n")),
    };
    if let Some(result) = opt(&answer, "result") {
        return CliResult {
            code: 0,
            stdout: format_result(result),
            stderr: String::new(),
        };
    }
    let error = answer
        .get("error")
        .cloned()
        .unwrap_or(Value::Object(Map::new()));
    let text = format!(
        "{}{}\n",
        st(&error, "message"),
        opt(&error, "fix")
            .map(|fix| format!("\nNext: {}", js(Some(fix))))
            .unwrap_or_default()
    );
    if st(&error, "code") == "machine_offline" {
        CliResult::err(4, format!("fleetd: {text}"))
    } else {
        CliResult::err(3, format!("Refused: {text}"))
    }
}

/// One lead call (`{"op": …, …}`) to the hub through the node; the answer frame, or why the node could not be asked.
pub fn send_call(call: Value, deps: &LeadDeps) -> Result<Value, String> {
    let mut frame = json!({
        "t": "lead_call",
        "id": format!("cli-{}", std::process::id()),
        "cwd": caller_cwd(deps.pwd.as_deref(), &deps.cwd),
        "call": call,
    });
    if let Some(thread) = deps.thread.as_deref().filter(|t| !t.is_empty()) {
        frame["threadId"] = thread.into();
    }
    (deps.send)(&node_socket_path(deps.sock.as_deref()), &frame)
}

pub fn run(argv: &[String]) -> CliResult {
    let send = |socket: &Path, frame: &Value| send_to_node(socket, frame, Duration::from_secs(60));
    let read_file = |file: &str| std::fs::read_to_string(file);
    lead_command(argv, &env_deps(&send, &read_file))
}

/// The real process's [`LeadDeps`].
pub fn env_deps<'a>(
    send: &'a dyn Fn(&Path, &Value) -> Result<Value, String>,
    read_file: &'a dyn Fn(&str) -> std::io::Result<String>,
) -> LeadDeps<'a> {
    LeadDeps {
        pwd: std::env::var("PWD").ok(),
        sock: std::env::var("FLEETD_NODE_SOCK").ok(),
        thread: std::env::var("FLEETD_THREAD_ID").ok(),
        cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")),
        send,
        read_file,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    fn parse(args: &[&str]) -> Result<Value, String> {
        parse_lead_args(&argv(args), &|_| Err(std::io::Error::other("no such file")))
    }

    #[test]
    fn task_message_now_is_a_steer_that_stops_the_step() {
        assert_eq!(
            parse(&["task", "message", "T88", "skip", "the", "docs"]).unwrap(),
            json!({ "op": "task_message", "taskId": "T88", "message": "skip the docs", "now": false })
        );
        assert_eq!(
            parse(&["task", "message", "T88", "stop that", "--now"]).unwrap(),
            json!({ "op": "task_message", "taskId": "T88", "message": "stop that", "now": true })
        );
    }

    #[test]
    fn workstream_open_takes_the_intent_and_an_optional_template() {
        assert_eq!(
            parse(&[
                "workstream",
                "open",
                "--text",
                "build schedules",
                "--template",
                "feature"
            ])
            .unwrap(),
            json!({ "op": "workstream_open", "text": "build schedules", "template": "feature" })
        );
        assert!(
            parse(&["workstream", "open"])
                .unwrap_err()
                .contains("--text")
        );
    }

    #[test]
    fn plan_takes_a_json_item_list_and_a_steer_id() {
        let set = parse(&[
            "plan",
            "--workstream",
            "W1",
            "--items",
            r#"[{"id":"P1","title":"api"},{"title":"docs","size":"s","after":["P1"]}]"#,
            "--steer",
            "S12",
        ])
        .unwrap();
        assert_eq!(set["items"][1]["after"], json!(["P1"]));
        assert_eq!(set["steer"], json!("S12"));
        assert_eq!(parse(&["plan"]).unwrap(), json!({ "op": "plan" }));
        assert_eq!(
            parse(&["plan", "--items", "[]"]).unwrap_err(),
            "--workstream is required"
        );
        assert!(
            parse(&["plan", "--workstream", "W1", "--items", "{}"])
                .unwrap_err()
                .starts_with("--items is a JSON array")
        );
        assert!(
            parse(&["plan", "--steer", "12"])
                .unwrap_err()
                .contains("like S12")
        );
        assert!(
            parse(&[
                "plan",
                "--workstream",
                "W1",
                "--items",
                r#"[{"title":"x","size":"xl"}]"#
            ])
            .unwrap_err()
            .starts_with("invalid input")
        );
    }

    fn decision() -> Value {
        json!({ "decisionId": "D3", "key": "api.health.path", "scope": { "kind": "project", "projectRef": { "machineId": "lab-a", "projectId": "p" } },
            "value": "/healthz", "source": "human", "state": "active", "at": "2026-10-17T10:00:00.000Z" })
    }

    #[test]
    fn close_needs_a_why() {
        let close = parse(&["close", "--workstream", "W1", "--why", "the page is live"]).unwrap();
        assert_eq!(
            close,
            json!({ "op": "close", "workstreamId": "W1", "why": "the page is live" })
        );
        let call: fleetd_contracts::lead_calls::LeadCall = serde_json::from_value(close).unwrap();
        assert!(matches!(
            call,
            fleetd_contracts::lead_calls::LeadCall::Close(c) if c.why.as_str() == "the page is live"
        ));
        assert_eq!(
            parse(&["close", "--workstream", "W1"]).unwrap_err(),
            "--why is required"
        );
    }

    #[test]
    fn fills_the_contract_defaults() {
        assert_eq!(
            parse(&["decide", "--key", "a.b", "--value", "v"]).unwrap()["scope"],
            "workstream"
        );
        let secret = parse(&[
            "request",
            "secret",
            "--key",
            "stripe.test_key",
            "--sink",
            "env:lab-a:/srv/app/.env",
            "--text",
            "t",
        ])
        .unwrap();
        assert_eq!(secret["op"], "request_secret");
        assert_eq!(secret["sink"], "env:lab-a:/srv/app/.env");
        assert_eq!(
            parse(&["request", "withdraw", "Q3"]).unwrap(),
            json!({ "op": "request_withdraw", "requestId": "Q3" })
        );
        let gated = parse(&[
            "gated",
            "run",
            "--class",
            "irreversible",
            "--argv",
            r#"["sh","-c","echo hi"]"#,
            "--reason",
            "r",
            "--secret-env",
            "STRIPE=stripe.test_key",
        ])
        .unwrap();
        assert_eq!(gated["timeoutSec"], 1800);
        assert_eq!(
            gated["secretEnv"],
            json!([{ "name": "STRIPE", "secretKey": "stripe.test_key" }])
        );
    }

    #[test]
    fn explains_usage_errors_in_one_line() {
        let cases: &[(&[&str], &str)] = &[
            (
                &["request", "secret", "--key", "a.b", "--text", "t"],
                "--sink is required",
            ),
            (
                &[
                    "request", "secret", "--key", "a.b", "--sink", "env:m:/e", "--text", "t",
                    "--value", "v",
                ],
                "--value does not apply to fleetd request secret",
            ),
            (
                &["request", "withdraw"],
                "expected fleetd request secret --key <k> --sink <sink> --text <t> or fleetd request withdraw <Q>",
            ),
            (
                &["brief", "create", "--workstream", "W1"],
                "give the brief with exactly one of --json and --file",
            ),
            (
                &[
                    "brief",
                    "create",
                    "--workstream",
                    "W1",
                    "--file",
                    "missing.json",
                ],
                "cannot read --file missing.json",
            ),
            (
                &["decisions", "search", "x", "--workstream", "W1"],
                "--workstream does not apply to fleetd decisions search",
            ),
            (
                &["task", "run"],
                "expected fleetd task spawn|list|status|message|cancel",
            ),
            (
                &["close", "W1"],
                r#"expected fleetd close --workstream <W> --why "<why>""#,
            ),
            (&["change", "enqueue"], "--pr is required"),
            (
                &[
                    "gated",
                    "run",
                    "--class",
                    "money",
                    "--reason",
                    "r",
                    "--argv",
                    r#""true""#,
                ],
                r#"--argv is a JSON array of strings, e.g. '["sh","-c","echo hi"]'"#,
            ),
            (
                &[
                    "gated",
                    "run",
                    "--class",
                    "money",
                    "--reason",
                    "r",
                    "--argv",
                    r#"["true"]"#,
                    "--secret-env",
                    "NOEQUALS",
                ],
                "--secret-env is NAME=<secret key>, got 'NOEQUALS'",
            ),
        ];
        for (args, expected) in cases {
            assert_eq!(parse(args).unwrap_err(), *expected, "{args:?}");
        }
        assert!(
            parse(&["request", "secret", "--bogus"])
                .unwrap_err()
                .starts_with("Unknown option '--bogus'")
        );
        assert!(
            parse(&[
                "request", "secret", "--key", "API.Path", "--sink", "env:m:/e", "--text", "t"
            ])
            .unwrap_err()
            .starts_with("invalid input: ")
        );
        assert!(
            parse(&[
                "gated",
                "run",
                "--class",
                "money",
                "--reason",
                "r",
                "--argv",
                r#"["true"]"#,
                "--timeout",
                "1801"
            ])
            .unwrap_err()
            .starts_with("invalid input: ")
        );
    }

    #[test]
    fn task_spawn_links_a_plan_item() {
        assert_eq!(
            parse(&[
                "task",
                "spawn",
                "--workstream",
                "W1",
                "--title",
                "t",
                "--prompt",
                "p",
                "--kind",
                "read",
                "--item",
                "P3"
            ])
            .unwrap()["item"],
            "P3"
        );
    }

    #[test]
    fn review_verdict_takes_full_shas_counts_and_metrics() {
        const SHA: &str = "0123456789abcdef0123456789abcdef01234567";
        let verdict = [
            "review",
            "verdict",
            "--task",
            "T3",
            "--blocking",
            "0",
            "--non-blocking",
            "2",
            "--summary",
            "ok",
        ];
        let with = |extra: &[&str]| parse(&[&verdict[..], extra].concat());
        let call = with(&[
            "--sha",
            &SHA.to_uppercase(),
            "--baseline",
            "0.5",
            "--candidate=-1.2e-3",
        ])
        .unwrap();
        assert_eq!(call["prHeadSha"], SHA);
        assert_eq!(
            call["metricValues"],
            json!({ "baseline": 0.5, "candidate": -0.0012 })
        );
        assert!(
            with(&["--sha", "0123abc"])
                .unwrap_err()
                .starts_with("--sha must be the full commit SHA")
        );
        assert_eq!(
            with(&["--sha", SHA, "--baseline", "0.5"]).unwrap_err(),
            "give --baseline and --candidate together: the metric measured for each"
        );
        assert_eq!(
            with(&["--sha", SHA, "--baseline", "half", "--candidate", "1"]).unwrap_err(),
            "--baseline is a number, got 'half'"
        );
        assert!(
            with(&["--sha", SHA, "--candidate", "-1", "--baseline", "1"])
                .unwrap_err()
                .contains("argument is ambiguous")
        );
    }

    fn command(args: &[&str], answer: Result<Value, String>) -> (CliResult, usize) {
        let calls = std::cell::Cell::new(0);
        let send = |_: &Path, frame: &Value| {
            calls.set(calls.get() + 1);
            assert_eq!(frame["t"], "lead_call");
            answer.clone()
        };
        let read_file = |_: &str| Err(std::io::Error::other("no file"));
        let deps = LeadDeps {
            pwd: None,
            sock: Some("/tmp/n.sock".into()),
            thread: None,
            cwd: "/src/api".into(),
            send: &send,
            read_file: &read_file,
        };
        (lead_command(&argv(args), &deps), calls.get())
    }

    #[test]
    fn exit_codes() {
        let ask = [
            "request",
            "secret",
            "--key",
            "stripe.test_key",
            "--sink",
            "env:lab-a:/srv/app/.env",
            "--text",
            "The test key",
        ];
        let filed = command(&ask, Ok(json!({ "t": "lead_result", "id": "x", "result": { "op": "request_secret", "state": "open", "requestId": "Q1" } }))).0;
        assert_eq!(
            filed,
            CliResult { code: 0, stdout: "Q1 open: the human enters it in the project's chat; the value never reaches you.\nNext: carry on with other work; its fingerprint arrives in a wake.\n".into(), stderr: String::new() }
        );
        let refused = command(&ask, Ok(json!({ "error": { "code": "invalid", "message": "no machine lab-a", "fix": "name a sink on a machine of this project" } }))).0;
        assert_eq!(
            refused,
            CliResult::err(
                3,
                "Refused: no machine lab-a\nNext: name a sink on a machine of this project\n"
                    .into()
            )
        );
        let offline = command(&ask, Ok(json!({ "error": { "code": "machine_offline", "message": "fleetd hub unreachable" } }))).0;
        assert_eq!(
            offline,
            CliResult::err(4, "fleetd: fleetd hub unreachable\n".into())
        );
        assert_eq!(
            command(&ask, Err("no node".into())).0,
            CliResult::err(4, "fleetd: no node\n".into())
        );
        let (usage, calls) = command(&["decide", "--key", "a.b"], Err("unused".into()));
        assert_eq!((usage.code, calls), (2, 0));
        assert!(
            usage
                .stderr
                .starts_with("fleetd: --value is required\n\nusage:\n")
        );
    }

    #[test]
    fn talks_to_a_node_socket_and_exits_4_when_none_listens() {
        let dir = std::env::temp_dir().join(format!("fleetd-cli-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let socket = dir.join("node.sock");
        let _ = std::fs::remove_file(&socket);
        let down = send_to_node(&socket, &json!({}), Duration::from_secs(5)).unwrap_err();
        assert!(down.starts_with(&format!(
            "fleetd hub unreachable: no fleetd node is listening at {}",
            socket.display()
        )));

        let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        let server = std::thread::spawn(move || {
            let (conn, _) = listener.accept().unwrap();
            let mut line = String::new();
            BufReader::new(&conn).read_line(&mut line).unwrap();
            let frame: Value = serde_json::from_str(&line).unwrap();
            let answer = json!({ "t": "lead_result", "id": frame["id"], "result": { "op": "decisions_search", "decisions": [decision()] } });
            (&conn).write_all(format!("{answer}\n").as_bytes()).unwrap();
            frame
        });
        let frame = json!({ "t": "lead_call", "id": "cli-1", "cwd": "/w", "call": { "op": "decisions_search", "query": "health" } });
        let answer = send_to_node(&socket, &frame, Duration::from_secs(5)).unwrap();
        assert_eq!(server.join().unwrap(), frame);
        assert_eq!(
            format_result(&answer["result"]),
            "D3 api.health.path = /healthz (project, by human)\nNext: use these answers; do not ask about these keys again.\n"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn caller_cwd_keeps_the_shells_logical_path() {
        let dir = std::env::temp_dir().join(format!("fleetd-cwd-{}", std::process::id()));
        let real = dir.join("real");
        let link = dir.join("link");
        std::fs::create_dir_all(real.join("src")).unwrap();
        let _ = std::os::unix::fs::symlink(&real, &link);
        let real_src = std::fs::canonicalize(real.join("src")).unwrap();
        let link_src = format!("{}/src", link.display());
        assert_eq!(caller_cwd(Some(&link_src), &real_src), link_src);
        assert_eq!(
            caller_cwd(Some(&format!("{}/./src/", link.display())), &real_src),
            format!("{link_src}/")
        );
        assert_eq!(caller_cwd(None, &real_src), real_src.display().to_string());
        assert_eq!(
            caller_cwd(Some("link"), &real_src),
            real_src.display().to_string()
        );
        assert_eq!(
            caller_cwd(Some(&link.display().to_string()), &real_src),
            real_src.display().to_string()
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
