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

pub const NODE_SOCKET_PATH: &str = ".fleetd/node/node.sock";
const SERVES_FIX: &str =
    "say what this serves: --serves done:<n> | issue:<ref> | defect:<text> | ask:<id>";

pub const LEAD_USAGE: &str = r#"  brief create --workstream <W> (--json '<Brief>' | --file <path>) [--amend <A>]
             freeze the brief of a draft workstream and start it
  ask --key <k> --class <product|money|credential|irreversible> --text "<short question>"
      [--context "<1-2 lines of background>"] --option '<key>|<Label>|<what happens if picked>'
      --option '...' (2 to 6) --rec <option key> --why "<one line: why you recommend it>"
      [--blocks "<step>"] [--proceeded] [--workstream <W>]
             the human sees the labels and consequences as choices; keys are only recorded
  ask --kind do --key <k> --class <c> --text <t> --step '<json>' [--step '<json>' ...]
      [--verify '<check json>']
             a step is {"text","where":"<machine>|browser","command"?,"expect"?}; --verify is a
             cmd or http check fleetd runs once the human ticks it done (a failure reopens it)
             ask the human; answers already in the decision log come back at once
  ask --kind secret --key <k> --sink env:<machine>:<path>|file:<machine>:<path> [--env-name <N>]
      --text <t> [--class credential]
             the human enters it in the desktop app, sealed to that machine; an env: sink writes the line
             <N>=<value> (N defaults to the key uppercased, . and - as _). You get its fingerprint, never the value
  gated run --class irreversible|money|credential --argv '<json array>' --reason <r> [--cwd <abs>]
      [--secret-env NAME=<secret key> ...] [--timeout <sec>] [--workstream <W>]
             a command the node runs exactly as stored, in the project workspace by default, only after
             a human approves it; secrets come from the node's own sinks. The result arrives in a wake
  ask withdraw <A> [--use <D>]
  decide --key <k> --value <v> [--why <w>] [--scope project|workstream] [--workstream <W>]
             log a decision you made yourself
  status set "<one line>" [--workstream <W>]
  decisions search "<query>"
  task spawn --workstream <W> --title <t> --prompt <p> [--kind write|read|review] [--areas a,b]
      [--model <m>] [--effort low|medium|high|max] [--tier S|M|L]
      [--serves done:<n>|issue:<ref>|defect:<text>|ask:<A>] [--pr <url>] [--qa] [--item P<n>]
             delegate work to a subagent; writers need --areas and --serves and get their own
             branch; a review task needs --pr, and --qa marks it a QA run; --item links it to
             that plan item
  task list [--state <s>] [--workstream <W>]
  task status <T>
  task message <T> "<text>" [--now]
             steer a running task (at its next step; --now stops its current step), answer a
             waiting one, or continue an ended one
  task cancel <T> [--reason <r>]
  claim done --workstream <W>
             fleetd runs the workstream's done-when checks itself; only all of them passing makes
             it done (exit 1 when a check did not pass)
  review verdict --task <T> --sha <full head SHA> --blocking <n> --non-blocking <n> --summary "<s>"
      [--baseline <n> --candidate <n>]
             the last step of a review task; a research judge also reports its metric for the
             baseline and the candidate, and fleetd computes GO, STOP or INCONCLUSIVE
  change enqueue --pr <url> [--task <T>] [--workstream <W>] [--serves <s>] [--tier S|M|L]
      [--item P<n>]
             put a PR on its repo's merge train (a write task's PR goes on by itself); its body
             needs a 'Source: <serves>' line. Only the train merges. --item links the PR to
             that plan item
  change status <X>
  plan milestone "<title>" [--position <n>]
  plan add "<title>" --milestone M<n> [--workstream <W>] [--must|--polish] [--size s|m|l]
      [--after P1,P2] [--pr <url>] [--check <n>] [--why "<note>"] [--steer S<n>]
  plan edit P<n> [--title <t>] [--size s|m|l] [--must|--polish] [--milestone M<n>]
      [--workstream <W>] [--after P1,P2] [--pr +<url>|--pr=-<url>] [--check +<n>|--check=-<n>]
      [--position <n>] [--why "<note>"] [--steer S<n>]
  plan drop P<n> (--why "<reason>" | --steer S<n>)
  plan show [--workstream <W>]
             keep the project's plan: milestones of must or polish items sized s, m or l
             (relative size, never hours). Link work with --item; only fleetd marks an item
             done, once its PRs merged through the train and its done-when checks passed.
             Changing scope after a milestone's first 10 minutes needs --why, and the status
             view shows it as a marker. --steer S<n> says the human's steer asked for it: it
             stands in for --why and acknowledges the steer
  inventory  the project's open work ranked: failing checks, open issues (gh), open asks and
             TODO/FIXME markers; with nothing left that has a value source and no open child, the
             project's finish-all workstream goes idle
  workstream spawn --text "<intent>" --serves issue:<#n|url>|defect:<text>|done:<n>
      [--template bugfix|feature|research]
             a finish-all lead starts a child workstream for one item with a value source
             lead-side commands reach the hub through the local node (FLEETD_NODE_SOCK, default
             ~/.fleetd/node/node.sock); exit 0 ok, 1 checks failed, 2 usage, 3 refused, 4 hub unreachable
"#;

const LEAD_COMMANDS: &[&str] = &[
    "brief",
    "ask",
    "decide",
    "status",
    "decisions",
    "task",
    "claim",
    "review",
    "change",
    "gated",
    "workstream",
    "inventory",
    "plan",
];

/// `status` is a lead call only as `status set`; any other `fleetd status` is the human's progress view.
pub fn is_lead_command(argv: &[String]) -> bool {
    match argv.first().map(String::as_str) {
        Some("status") => argv.get(1).map(String::as_str) == Some("set"),
        Some(command) => LEAD_COMMANDS.contains(&command),
        None => false,
    }
}

fn usage(message: &str) -> CliResult {
    CliResult::err(2, format!("fleetd: {message}\n\nusage:\n{LEAD_USAGE}"))
}

const OPTIONS: &[(&str, Kind)] = &[
    ("workstream", Kind::Str),
    ("json", Kind::Str),
    ("file", Kind::Str),
    ("amend", Kind::Str),
    ("kind", Kind::Str),
    ("key", Kind::Str),
    ("class", Kind::Str),
    ("text", Kind::Str),
    ("rec", Kind::Str),
    ("options", Kind::Str),
    ("option", Kind::Multi),
    ("context", Kind::Str),
    ("step", Kind::Multi),
    ("blocks", Kind::Str),
    ("proceeded", Kind::Bool),
    ("use", Kind::Str),
    ("value", Kind::Str),
    ("why", Kind::Str),
    ("scope", Kind::Str),
    ("title", Kind::Str),
    ("prompt", Kind::Str),
    ("areas", Kind::Str),
    ("model", Kind::Str),
    ("effort", Kind::Str),
    ("tier", Kind::Str),
    ("serves", Kind::Str),
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
    ("verify", Kind::Str),
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
    ("milestone", Kind::Str),
    ("must", Kind::Bool),
    ("polish", Kind::Bool),
    ("size", Kind::Str),
    ("after", Kind::Str),
    ("check", Kind::Str),
    ("position", Kind::Str),
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

fn split_list(value: &str) -> Vec<Value> {
    value
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(|item| Value::String(item.to_owned()))
        .collect()
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
            only(&["workstream", "json", "file", "amend"])?;
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
                ("amend", s(v.str("amend"))),
            ])
        }
        Some("ask") => {
            if sub == Some("withdraw") {
                only(&["use"])?;
                if rest.len() != 1 {
                    return Err("expected fleetd ask withdraw <A> [--use <D>]".into());
                }
                defined(vec![
                    ("op", s(Some("ask_withdraw"))),
                    ("askId", s(Some(rest[0]))),
                    ("use", s(v.str("use"))),
                ])
            } else {
                if let Some(sub) = sub {
                    return Err(format!("unexpected '{sub}': put the question in --text"));
                }
                only(&[
                    "kind",
                    "key",
                    "class",
                    "text",
                    "rec",
                    "why",
                    "options",
                    "option",
                    "context",
                    "step",
                    "verify",
                    "sink",
                    "env-name",
                    "blocks",
                    "proceeded",
                    "workstream",
                ])?;
                // A secret is a credential unless the lead says otherwise.
                let class = v.str("class").or(if v.str("kind") == Some("secret") {
                    Some("credential")
                } else {
                    None
                });
                for (flag, value) in [
                    ("key", v.str("key")),
                    ("class", class),
                    ("text", v.str("text")),
                ] {
                    if value.is_none() {
                        return Err(format!("--{flag} is required"));
                    }
                }
                if v.str("kind") == Some("secret") && v.str("sink").is_none() {
                    return Err(
                        "a secret ask needs --sink env:<machine>:<path> or file:<machine>:<path>"
                            .into(),
                    );
                }
                let verify = v
                    .str("verify")
                    .map(|text| parse_json("--verify", text))
                    .transpose()?;
                // `key|Label|what happens`: the label and consequence may hold commas; only the first two '|' split.
                let mut options: Vec<Value> = v
                    .multi("option")
                    .iter()
                    .map(|o| {
                        let mut parts = o.splitn(3, '|').map(str::trim);
                        defined(vec![
                            ("key", parts.next().map(|k| Value::String(k.to_owned()))),
                            (
                                "label",
                                parts
                                    .next()
                                    .filter(|l| !l.is_empty())
                                    .map(|l| Value::String(l.to_owned())),
                            ),
                            (
                                "consequence",
                                parts
                                    .next()
                                    .filter(|c| !c.is_empty())
                                    .map(|c| Value::String(c.to_owned())),
                            ),
                        ])
                    })
                    .collect();
                if let Some(bare) = v.str("options") {
                    options.extend(split_list(bare));
                }
                let mut steps = Vec::new();
                for (i, step) in v.multi("step").iter().enumerate() {
                    steps.push(parse_json(&format!("--step {}", i + 1), step)?);
                }
                defined(vec![
                    ("op", s(Some("ask"))),
                    ("kind", s(v.str("kind"))),
                    ("key", s(v.str("key"))),
                    ("class", s(class)),
                    ("text", s(v.str("text"))),
                    ("context", s(v.str("context"))),
                    ("recommendation", s(v.str("rec"))),
                    ("recommendationWhy", s(v.str("why"))),
                    (
                        "options",
                        (!options.is_empty()).then_some(Value::Array(options)),
                    ),
                    ("steps", (!steps.is_empty()).then_some(Value::Array(steps))),
                    ("verify", verify),
                    ("sink", s(v.str("sink"))),
                    ("envName", s(v.str("env-name"))),
                    ("blocks", s(v.str("blocks"))),
                    (
                        "proceededOnRec",
                        v.flag("proceeded").then_some(Value::Bool(true)),
                    ),
                    ("workstreamId", s(v.str("workstream"))),
                ])
            }
        }
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
        Some("status") => {
            if sub != Some("set") {
                return Err(r#"expected fleetd status set "<one line>""#.into());
            }
            only(&["workstream"])?;
            if rest.is_empty() {
                return Err(r#"expected fleetd status set "<one line>""#.into());
            }
            defined(vec![
                ("op", s(Some("status_set"))),
                ("text", Some(Value::String(rest.join(" ")))),
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
                    "areas",
                    "model",
                    "effort",
                    "tier",
                    "serves",
                    "pr",
                    "qa",
                    "item",
                ])?;
                required(&["workstream", "title", "prompt"])?;
                // The contract refuses it too, but this says it in one plain line.
                if v.str("kind").unwrap_or("write") == "write" && v.str("serves").is_none() {
                    return Err(format!("a write task needs --serves: {SERVES_FIX}"));
                }
                defined(vec![
                    ("op", s(Some("task_spawn"))),
                    ("workstreamId", s(v.str("workstream"))),
                    ("title", s(v.str("title"))),
                    ("prompt", s(v.str("prompt"))),
                    ("kind", s(v.str("kind"))),
                    ("areas", v.str("areas").map(|a| Value::Array(split_list(a)))),
                    ("model", s(v.str("model"))),
                    ("effort", s(v.str("effort"))),
                    ("tier", s(v.str("tier"))),
                    ("serves", s(v.str("serves"))),
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
        Some("claim") => {
            if sub != Some("done") || !rest.is_empty() {
                return Err("expected fleetd claim done --workstream <W>".into());
            }
            only(&["workstream"])?;
            required(&["workstream"])?;
            json!({ "op": "claim_done", "workstreamId": v.str("workstream") })
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
                only(&["pr", "task", "workstream", "serves", "tier", "item"])?;
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
                    ("serves", s(v.str("serves"))),
                    ("tier", s(v.str("tier"))),
                    ("item", s(v.str("item"))),
                ])
            }
            Some("status") => {
                only(&[])?;
                if rest.len() != 1 {
                    return Err("expected fleetd change status <X>".into());
                }
                json!({ "op": "change_status", "changeId": rest[0] })
            }
            _ => return Err("expected fleetd change enqueue|status".into()),
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
        Some("workstream") => {
            if sub != Some("spawn") || !rest.is_empty() {
                return Err(
                    r#"expected fleetd workstream spawn --text "<intent>" --serves <value source>"#
                        .into(),
                );
            }
            only(&["text", "serves", "template"])?;
            required(&["text", "serves"])?;
            defined(vec![
                ("op", s(Some("workstream_spawn"))),
                ("text", s(v.str("text"))),
                ("serves", s(v.str("serves"))),
                ("template", s(v.str("template"))),
            ])
        }
        Some("plan") => {
            let weight = || -> Result<Option<Value>, String> {
                match (v.flag("must"), v.flag("polish")) {
                    (true, true) => Err("give one of --must and --polish".into()),
                    (true, false) => Ok(s(Some("must"))),
                    (false, true) => Ok(s(Some("polish"))),
                    (false, false) => Ok(None),
                }
            };
            let size = || -> Result<Option<Value>, String> {
                match v.str("size").map(str::to_lowercase).as_deref() {
                    None => Ok(None),
                    Some(size @ ("s" | "m" | "l")) => Ok(s(Some(size))),
                    Some(_) => Err(format!(
                        "--size is s, m or l, got '{}'",
                        v.str("size").unwrap_or("")
                    )),
                }
            };
            let whole = |flag: &str| -> Result<Option<Value>, String> {
                match v.str(flag) {
                    None => Ok(None),
                    Some(n) if all_digits(n) => Ok(Some(number(n))),
                    Some(n) => Err(format!("--{flag} is a whole number, got '{n}'")),
                }
            };
            let after = v.str("after").map(|a| Value::Array(split_list(a)));
            let title = rest.join(" ");
            // `--steer S12`: the change answers that steer, which also acknowledges it, and stands in for --why.
            let steer = match v.str("steer") {
                None => None,
                Some(id) if is_steer_id(id) => s(Some(id)),
                Some(id) => return Err(format!("--steer is a steer id like S12, got '{id}'")),
            };
            match sub {
                Some("milestone") => {
                    only(&["position"])?;
                    if title.is_empty() {
                        return Err(r#"expected fleetd plan milestone "<title>""#.into());
                    }
                    defined(vec![
                        ("op", s(Some("plan_milestone"))),
                        ("title", Some(Value::String(title))),
                        ("position", whole("position")?),
                    ])
                }
                Some("add") => {
                    only(&[
                        "milestone",
                        "workstream",
                        "must",
                        "polish",
                        "size",
                        "after",
                        "pr",
                        "check",
                        "why",
                        "steer",
                    ])?;
                    if title.is_empty() {
                        return Err(r#"expected fleetd plan add "<title>" --milestone M<n>"#.into());
                    }
                    required(&["milestone"])?;
                    defined(vec![
                        ("op", s(Some("plan_add"))),
                        ("title", Some(Value::String(title))),
                        ("milestoneId", s(v.str("milestone"))),
                        ("workstreamId", s(v.str("workstream"))),
                        ("weight", weight()?),
                        ("size", size()?),
                        ("after", after),
                        ("pr", s(v.str("pr"))),
                        ("check", whole("check")?),
                        ("why", s(v.str("why"))),
                        ("steer", steer),
                    ])
                }
                Some("edit") => {
                    only(&[
                        "title",
                        "size",
                        "must",
                        "polish",
                        "milestone",
                        "workstream",
                        "after",
                        "pr",
                        "check",
                        "position",
                        "why",
                        "steer",
                    ])?;
                    let [item] = rest.as_slice() else {
                        return Err("expected fleetd plan edit P<n> [--title <t>] …".into());
                    };
                    // `+x` adds, `-x` removes, a bare value adds.
                    let signed = |flag: &str| match v.str(flag) {
                        None => (None, false),
                        Some(given) => match given.strip_prefix('-') {
                            Some(value) => (Some(value), true),
                            None => (Some(given.strip_prefix('+').unwrap_or(given)), false),
                        },
                    };
                    let (pr, pr_remove) = signed("pr");
                    let (check, check_remove) = signed("check");
                    let check = match check {
                        Some(n) if !all_digits(n) => {
                            return Err(format!(
                                "--check is +<n> or -<n>, a done-when index, got '{}'",
                                v.str("check").unwrap_or("")
                            ));
                        }
                        other => other.map(number),
                    };
                    let one = |value: Option<Value>| value.map(|v| Value::Array(vec![v]));
                    let pr = pr.map(|url| Value::String(url.to_owned()));
                    defined(vec![
                        ("op", s(Some("plan_edit"))),
                        ("itemId", s(Some(item))),
                        ("title", s(v.str("title"))),
                        ("size", size()?),
                        ("weight", weight()?),
                        ("milestoneId", s(v.str("milestone"))),
                        ("workstreamId", s(v.str("workstream"))),
                        ("after", after),
                        (if pr_remove { "prRemove" } else { "prAdd" }, one(pr)),
                        (
                            if check_remove {
                                "checkRemove"
                            } else {
                                "checkAdd"
                            },
                            one(check),
                        ),
                        ("position", whole("position")?),
                        ("why", s(v.str("why"))),
                        ("steer", steer),
                    ])
                }
                Some("drop") => {
                    only(&["why", "steer"])?;
                    let [item] = rest.as_slice() else {
                        return Err(r#"expected fleetd plan drop P<n> --why "<reason>""#.into());
                    };
                    if steer.is_none() {
                        required(&["why"])?;
                    }
                    defined(vec![
                        ("op", s(Some("plan_drop"))),
                        ("itemId", s(Some(item))),
                        ("why", s(v.str("why"))),
                        ("steer", steer),
                    ])
                }
                Some("show") => {
                    only(&["workstream"])?;
                    if let Some(first) = rest.first() {
                        return Err(format!(
                            "unexpected '{first}': fleetd plan show [--workstream <W>]"
                        ));
                    }
                    defined(vec![
                        ("op", s(Some("plan_show"))),
                        ("workstreamId", s(v.str("workstream"))),
                    ])
                }
                _ => return Err("expected fleetd plan milestone|add|edit|drop|show".into()),
            }
        }
        Some("inventory") => {
            if sub.is_some() {
                return Err("expected fleetd inventory".into());
            }
            only(&[])?;
            json!({ "op": "inventory" })
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
        None => super::home_dir().join(NODE_SOCKET_PATH),
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

/// A JS number as `${n}` prints it.
pub fn js_number(value: &Value) -> String {
    match value.as_f64() {
        Some(n) if n.is_finite() && n.fract() == 0.0 && n.abs() < 1e21 => format!("{}", n as i128),
        Some(n) => format!("{n}"),
        None => value.to_string(),
    }
}

fn js(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::String(s)) => s.clone(),
        Some(v @ Value::Number(_)) => js_number(v),
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
    let where_ = if st(task, "kind") == "write" {
        format!(
            ", {}",
            arr(task, "areas")
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(",")
        )
    } else {
        String::new()
    };
    let why = match opt(task, "queuedReason") {
        Some(reason) if st(task, "state") == "queued" => format!(" ({})", js(Some(reason))),
        _ => String::new(),
    };
    format!(
        "{} {}{} [{}{}, {}/{}] {}{}",
        st(task, "taskId"),
        st(task, "state"),
        why,
        st(task, "kind"),
        where_,
        st(task, "model"),
        st(task, "effort"),
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

/// One line per check fleetd ran, ✓ only for a pass, with the evidence of any that did not pass.
fn claim_lines(claim: &Value) -> Vec<String> {
    arr(claim, "results")
        .iter()
        .flat_map(|r| {
            let pass = st(r, "result") == "pass";
            let head = format!(
                "{} done:{} {}: {}{}",
                if pass { "✓" } else { "✗" },
                js(opt(r, "checkIndex")),
                st(&r["spec"], "type"),
                st(r, "result"),
                opt(r, "exitCode")
                    .map(|code| format!(", exit {}", js(Some(code))))
                    .unwrap_or_default()
            );
            let evidence = st(r, "evidence");
            if pass || evidence.trim().is_empty() {
                vec![head]
            } else {
                std::iter::once(head)
                    .chain(quoted(evidence).into_iter().map(|line| format!("  {line}")))
                    .collect()
            }
        })
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
            "  workstream {}{}{}, attempt {}",
            st(task, "workstreamId"),
            opt(task, "serves")
                .map(|s| format!(", serves {}", js(Some(s))))
                .unwrap_or_default(),
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
            "{} {}#{} {}{} (tier {}, serves {}{})",
            st(change, "changeId"),
            st(change, "repo"),
            js(opt(change, "prNumber")),
            st(change, "state"),
            where_,
            st(change, "tier"),
            st(change, "serves"),
            opt(change, "taskId")
                .map(|t| format!(", by {}", js(Some(t))))
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
                "Brief for {} frozen (hash {}); the workstream is {}.",
                st(result, "workstreamId"),
                short(st(result, "briefHash")),
                st(result, "state")
            ));
            next = "carry on with the workstream. Changing this brief later needs a human-answered ask and --amend.".into();
        }
        "ask" => {
            let decision = opt(result, "decision");
            let state = st(result, "state");
            let ask_id = st(result, "askId");
            if let (true, Some(decision)) = (state == "auto", decision) {
                lines.push(format!(
                    "Already decided, so not asked: {}.",
                    decision_line(decision)
                ));
                next = "use this answer and do not ask again.".into();
            } else if state != "open" {
                lines.push(format!("{ask_id} is {state}."));
                if let Some(decision) = decision {
                    lines.push(format!("Answer: {}.", decision_line(decision)));
                }
                next = "carry on.".into();
            } else {
                lines.push(if result.get("attached") == Some(&Value::Bool(true)) {
                    format!("An ask with this key is already open as {ask_id}; yours was attached to it.")
                } else {
                    format!("Filed {ask_id}. It goes to the human in the next batch.")
                });
                let candidates = arr(result, "candidates");
                if !candidates.is_empty() {
                    lines.push("Decisions that may already answer it:".into());
                    lines.extend(candidates.iter().map(|d| format!("  {}", decision_line(d))));
                    next = format!(
                        "if one of these answers it, run fleetd ask withdraw {ask_id} --use <D>; otherwise carry on without waiting. The answer arrives in a later wake."
                    );
                } else {
                    next = "carry on without waiting; the answer arrives in a later wake.".into();
                }
            }
        }
        "ask_withdraw" => {
            lines.push(format!(
                "{} is {}.",
                st(result, "askId"),
                st(result, "state")
            ));
            next = "carry on.".into();
        }
        "decide" => {
            lines.push(format!("Logged {}.", decision_line(&result["decision"])));
            next = "carry on. This key will not be asked again in this scope.".into();
        }
        "status_set" => {
            lines.push(format!("Status set for {}.", st(result, "workstreamId")));
            next = "carry on.".into();
        }
        "decisions_search" => {
            let decisions = arr(result, "decisions");
            if decisions.is_empty() {
                lines.push("No decisions match.".into());
                next = "decide it yourself and log it with fleetd decide; use fleetd ask only for product, money, credential or irreversible calls.".into();
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
                "{} cancelled; its slot and areas are free.",
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
        "claim_done" => {
            let (claim_id, ws, state) = (
                st(result, "claimId"),
                st(result, "workstreamId"),
                st(result, "state"),
            );
            match opt(result, "claim") {
                None => {
                    lines.push(format!(
                        "{claim_id} on {ws} is still running its checks; {ws} is {state}."
                    ));
                    next = "carry on with other work; the outcome arrives in a wake.".into();
                }
                Some(claim) if st(claim, "outcome") == "pass" => {
                    lines.push(format!(
                        "{claim_id} on {ws} passed: fleetd ran all {} done-when checks and each passed. {ws} is {state}.",
                        arr(claim, "results").len()
                    ));
                    lines.extend(claim_lines(claim));
                    next = format!("spawn nothing more for {ws}.");
                }
                Some(claim) => {
                    let results = arr(claim, "results");
                    let failing = results.iter().filter(|r| st(r, "result") != "pass").count();
                    lines.push(format!(
                        "{claim_id} on {ws} failed: {failing} of {} checks did not pass. {ws} is {state}, not done.",
                        results.len()
                    ));
                    lines.extend(claim_lines(claim));
                    next = "fix what failed, then claim again.".into();
                }
            }
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
        "workstream_spawn" => {
            let playbook = opt(result, "playbook")
                .and_then(Value::as_str)
                .map(|p| format!(" on {}", p.split('@').next().unwrap_or(p)))
                .unwrap_or_default();
            lines.push(format!(
                "Spawned {}, a child of {}{playbook}.",
                st(result, "workstreamId"),
                st(result, "parent")
            ));
            next = format!(
                "register its brief with fleetd brief create --workstream {} when its intent wake arrives.",
                st(result, "workstreamId")
            );
        }
        "inventory" => {
            lines.push(st(result, "text").to_owned());
            next = if result.get("idle") == Some(&Value::Bool(true)) {
                "stop: nothing is left with a value source.".into()
            } else if result.get("spawnable").and_then(Value::as_f64) == Some(0.0) {
                "nothing new to spawn; wait for the open children.".into()
            } else {
                "fleetd workstream spawn --text \"<intent>\" --serves <the item's value source>, highest first.".into()
            };
        }
        "change_enqueue" | "change_status" => {
            lines.extend(change_lines(&result["change"]));
            next = "don't merge it yourself; the train merges and the outcome arrives in a wake."
                .into();
        }
        "plan_milestone" => {
            let m = &result["milestone"];
            lines.push(format!(
                "Added {} {}.",
                st(m, "milestoneId"),
                st(m, "title")
            ));
            next = format!(
                "add its items: fleetd plan add \"<title>\" --milestone {} --size s|m|l",
                st(m, "milestoneId")
            );
        }
        "plan_add" | "plan_edit" | "plan_drop" => {
            let item = &result["item"];
            let verb = match st(result, "op") {
                "plan_add" => "Added",
                "plan_edit" => "Edited",
                _ => "Dropped",
            };
            lines.push(format!(
                "{verb} {} in {}: {} ({}, {}){}.",
                st(item, "itemId"),
                st(item, "milestoneId"),
                st(item, "title"),
                st(item, "weight"),
                st(item, "size"),
                opt(item, "workstreamId")
                    .map(|w| format!(", order {}", js(Some(w))))
                    .unwrap_or_default()
            ));
            if let Some(change) = opt(result, "change") {
                let pct = match (opt(change, "pctBefore"), opt(change, "pctAfter")) {
                    (Some(before), Some(after)) => {
                        format!(" ({}% → {}%)", js(Some(before)), js(Some(after)))
                    }
                    _ => String::new(),
                };
                lines.push(format!(
                    "Scope change recorded: {}{pct}; the status view shows it as a marker.",
                    st(change, "note")
                ));
            }
            next = if st(result, "op") == "plan_drop" {
                "carry on.".into()
            } else {
                format!(
                    "link work to it with --item {} on fleetd task spawn; fleetd marks it done once its PRs merged through the train and its checks passed.",
                    st(item, "itemId")
                )
            };
        }
        "plan_show" => {
            lines.push(st(result, "text").trim_end().to_owned());
            next = "link work with --item; only fleetd marks items done. Scope changes need --why."
                .into();
        }
        "gated_run" => {
            lines.push(format!(
                "{} {}: the command is stored and waits for a human to approve it; nothing runs before that.",
                st(result, "askId"),
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

/// `fleetd brief|ask|decide|status|decisions|task|claim|review|change|gated|workstream|inventory …`.
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
        // A claim that ran and failed is an answer, not a refusal, but it must not read as success to a script.
        let failed = st(result, "op") == "claim_done"
            && opt(result, "claim").is_some_and(|claim| st(claim, "outcome") == "fail");
        return CliResult {
            code: if failed { 1 } else { 0 },
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
    fn plan_steer_takes_a_steer_id_and_stands_in_for_why() {
        assert!(
            parse(&["plan", "drop", "P3"])
                .unwrap_err()
                .contains("--why is required")
        );
        assert!(
            parse(&["plan", "drop", "P3", "--steer", "12"])
                .unwrap_err()
                .contains("like S12")
        );
        assert!(
            parse(&["plan", "drop", "P3", "--steer", "S0"])
                .unwrap_err()
                .contains("like S12")
        );
        // The steer's own words become the note, on the hub.
        let dropped = parse(&["plan", "drop", "P3", "--steer", "S12"]).unwrap();
        assert_eq!(dropped.get("why"), None);
        assert_eq!(dropped["steer"], json!("S12"));
        let added = parse(&[
            "plan",
            "add",
            "API first",
            "--milestone",
            "M1",
            "--steer",
            "S12",
        ])
        .unwrap();
        assert_eq!(added["steer"], json!("S12"));
    }

    fn decision() -> Value {
        json!({ "decisionId": "D3", "key": "api.health.path", "scope": { "kind": "project", "projectRef": { "machineId": "lab-a", "projectId": "p" } },
            "value": "/healthz", "source": "human", "state": "active", "at": "2026-10-17T10:00:00.000Z" })
    }

    #[test]
    fn fills_the_contract_defaults() {
        let ask = parse(&[
            "ask",
            "--key",
            "api.health.path",
            "--class",
            "product",
            "--text",
            "Path?",
            "--context",
            "The load balancer probes it.",
            "--rec",
            "/healthz",
            "--why",
            "The probe expects it.",
            "--option",
            "/healthz|/healthz|Matches the probe, no config change.",
            "--option",
            "/health | Shorter | The probe config changes too, then it works|",
        ])
        .unwrap();
        assert_eq!(ask["kind"], "decide");
        assert_eq!(ask["blocks"], "nothing");
        assert_eq!(ask["proceededOnRec"], false);
        assert_eq!(ask["context"], "The load balancer probes it.");
        assert_eq!(ask["recommendationWhy"], "The probe expects it.");
        assert_eq!(
            ask["options"],
            json!([
                { "key": "/healthz", "label": "/healthz", "consequence": "Matches the probe, no config change." },
                { "key": "/health", "label": "Shorter", "consequence": "The probe config changes too, then it works|" }
            ])
        );
        // The old bare form still parses; the hub then refuses it with the command to send instead.
        let bare = parse(&[
            "ask",
            "--key",
            "a.b",
            "--class",
            "product",
            "--text",
            "t",
            "--rec",
            "x",
            "--options",
            "x, y",
        ])
        .unwrap();
        assert_eq!(bare["options"], json!([{ "key": "x" }, { "key": "y" }]));
        assert_eq!(
            parse(&["decide", "--key", "a.b", "--value", "v"]).unwrap()["scope"],
            "workstream"
        );
        let secret = parse(&[
            "ask",
            "--kind",
            "secret",
            "--key",
            "stripe.test_key",
            "--sink",
            "env:lab-a:/srv/app/.env",
            "--text",
            "t",
        ])
        .unwrap();
        assert_eq!(secret["class"], "credential");
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
    fn takes_a_do_asks_steps_and_verify_as_json() {
        let step1 = json!({ "text": "Create the DNS record", "where": "browser" });
        let step2 = json!({ "text": "Reload", "where": "lab-a", "command": "systemctl --user reload caddy", "expect": "no output" });
        let verify = json!({ "type": "http", "url": "https://example.com/health", "status": 200 });
        let call = parse(&[
            "ask",
            "--kind",
            "do",
            "--key",
            "dns.health",
            "--class",
            "irreversible",
            "--text",
            "Add DNS",
            "--step",
            &step1.to_string(),
            "--step",
            &step2.to_string(),
            "--verify",
            &verify.to_string(),
        ])
        .unwrap();
        assert_eq!(call["steps"], json!([step1, step2]));
        assert_eq!(call["verify"]["url"], "https://example.com/health");
        let base = [
            "ask", "--kind", "do", "--key", "a.b", "--class", "product", "--text", "t",
        ];
        let with = |extra: &[&str]| parse(&[&base[..], extra].concat());
        assert!(
            with(&["--step", "{text"])
                .unwrap_err()
                .starts_with("--step 1 is not valid JSON (")
        );
        assert!(
            with(&["--step", &step1.to_string(), "--step", "nope"])
                .unwrap_err()
                .starts_with("--step 2 is not valid JSON (")
        );
        assert!(
            with(&["--step", &step1.to_string(), "--verify", "{"])
                .unwrap_err()
                .starts_with("--verify is not valid JSON (")
        );
        // The contract's own checks: a do ask needs a step, and a step command takes no <placeholders>.
        assert!(with(&[]).unwrap_err().starts_with("invalid input: "));
        let placeholder =
            json!({ "text": "x", "where": "browser", "command": "login <token>" }).to_string();
        assert!(
            with(&["--step", &placeholder])
                .unwrap_err()
                .starts_with("invalid input: ")
        );
    }

    #[test]
    fn explains_usage_errors_in_one_line() {
        let cases: &[(&[&str], &str)] = &[
            (
                &["ask", "--class", "product", "--text", "t", "--rec", "r"],
                "--key is required",
            ),
            (
                &["ask", "--key", "a.b", "--text", "t", "--rec", "r"],
                "--class is required",
            ),
            (
                &["ask", "--kind", "secret", "--key", "a.b", "--text", "t"],
                "a secret ask needs --sink env:<machine>:<path> or file:<machine>:<path>",
            ),
            (
                &["ask", "--key", "a.b", "--value", "v"],
                "--value does not apply to fleetd ask",
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
                &["status", "show"],
                r#"expected fleetd status set "<one line>""#,
            ),
            (
                &["decisions", "search", "x", "--workstream", "W1"],
                "--workstream does not apply to fleetd decisions search",
            ),
            (
                &[
                    "task",
                    "spawn",
                    "--workstream",
                    "W1",
                    "--title",
                    "x",
                    "--areas",
                    "docs",
                    "--prompt",
                    "y",
                ],
                "a write task needs --serves: say what this serves: --serves done:<n> | issue:<ref> | defect:<text> | ask:<id>",
            ),
            (
                &["task", "run"],
                "expected fleetd task spawn|list|status|message|cancel",
            ),
            (
                &["claim", "W1"],
                "expected fleetd claim done --workstream <W>",
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
            (
                &["inventory", "--text", "x"],
                "--text does not apply to fleetd inventory",
            ),
        ];
        for (args, expected) in cases {
            assert_eq!(parse(args).unwrap_err(), *expected, "{args:?}");
        }
        assert!(
            parse(&["ask", "--bogus"])
                .unwrap_err()
                .starts_with("Unknown option '--bogus'")
        );
        assert!(
            parse(&[
                "ask", "--key", "API.Path", "--class", "product", "--text", "t", "--rec", "r"
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
    fn plan_calls_fill_defaults_and_split_signed_links() {
        let add = parse(&[
            "plan",
            "add",
            "full",
            "lab",
            "run",
            "--milestone",
            "M1",
            "--polish",
            "--size",
            "L",
            "--after",
            "P1, P2",
            "--check",
            "2",
        ])
        .unwrap();
        assert_eq!(add["title"], "full lab run");
        assert_eq!(
            (&add["weight"], &add["size"]),
            (&json!("polish"), &json!("l"))
        );
        assert_eq!(
            (&add["after"], &add["check"]),
            (&json!(["P1", "P2"]), &json!(2))
        );
        assert_eq!(
            parse(&["plan", "add", "x", "--milestone", "M1"]).unwrap()["size"],
            Value::Null,
            "no size goes as none: the hub counts it as m and warns"
        );
        let edit = parse(&[
            "plan",
            "edit",
            "P3",
            "--pr=-https://github.com/acme/storefront/pull/9",
            "--check",
            "+1",
        ])
        .unwrap();
        assert_eq!(
            edit["prRemove"],
            json!(["https://github.com/acme/storefront/pull/9"])
        );
        assert_eq!(edit["checkAdd"], json!([1]));
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
        for (args, error) in [
            (&["plan", "add", "x"][..], "--milestone is required"),
            (
                &[
                    "plan",
                    "add",
                    "x",
                    "--milestone",
                    "M1",
                    "--must",
                    "--polish",
                ],
                "give one of --must and --polish",
            ),
            (&["plan", "drop", "P3"], "--why is required"),
            (
                &["plan", "add", "x", "--milestone", "M1", "--size", "xl"],
                "--size is s, m or l, got 'xl'",
            ),
        ] {
            assert_eq!(parse(args).unwrap_err(), error, "{args:?}");
        }
        assert!(
            parse(&["plan", "edit", "W3", "--size", "s"])
                .unwrap_err()
                .starts_with("invalid input")
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
            "ask",
            "--key",
            "api.health.path",
            "--class",
            "product",
            "--text",
            "Path?",
            "--rec",
            "/healthz",
        ];
        let filed = command(&ask, Ok(json!({ "t": "lead_result", "id": "x", "result": { "op": "ask", "state": "open", "askId": "A1" } }))).0;
        assert_eq!(
            filed,
            CliResult { code: 0, stdout: "Filed A1. It goes to the human in the next batch.\nNext: carry on without waiting; the answer arrives in a later wake.\n".into(), stderr: String::new() }
        );
        let refused = command(&ask, Ok(json!({ "error": { "code": "invalid", "message": "naming is not a class you ask about", "fix": "decide this yourself" } }))).0;
        assert_eq!(
            refused,
            CliResult::err(
                3,
                "Refused: naming is not a class you ask about\nNext: decide this yourself\n".into()
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
        let claim = json!({ "op": "claim_done", "claimId": "C1", "workstreamId": "W1", "state": "verifying", "claim": {
            "outcome": "fail", "results": [
                { "checkIndex": 0, "spec": { "type": "http" }, "result": "pass", "evidence": "GET → 200" },
                { "checkIndex": 1, "spec": { "type": "cmd" }, "result": "fail", "evidence": "`test -f docs/x.md` in /w exited 1 (expected 0)", "exitCode": 1 },
            ] } });
        let failed = command(
            &["claim", "done", "--workstream", "W1"],
            Ok(json!({ "result": claim })),
        )
        .0;
        assert_eq!(failed.code, 1);
        assert_eq!(
            failed.stdout,
            "C1 on W1 failed: 1 of 2 checks did not pass. W1 is verifying, not done.\n✓ done:0 http: pass\n✗ done:1 cmd: fail, exit 1\n    > `test -f docs/x.md` in /w exited 1 (expected 0)\nNext: fix what failed, then claim again.\n"
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
