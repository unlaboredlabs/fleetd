//! The human digest's text: plain text, short lines (DESIGN §4). Facts only from
//! state: ✓ marks checks fleetd ran and saw pass, and a workstream's own status line is marked "lead says", since
//! nothing backs it.
use std::collections::HashMap;

use chrono::TimeZone;
use chrono_tz::Tz;
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::ledger::{Decision, HumanRequest, RequestState, Workstream, WorkstreamState};

use super::{js_prefix, project_key};
/// Same text as `playbooks::finish_all_rules::FINISH_ALL_IDLE`.
pub const FINISH_ALL_IDLE: &str = "finish-all: nothing left with a value source";

/// What backs a workstream's status beyond the lead's word: the checks its latest claim passed.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct WorkstreamFacts {
    /// How many checks the latest finished claim passed.
    pub passed: usize,
}

/// What the 09:00/18:00 digest is rendered from; the caller gathers it.
#[derive(Clone, Debug, Default)]
pub struct DigestInput {
    pub now_ms: i64,
    /// IANA zone from `policy.tz`; `None` (an unknown zone) renders in UTC.
    pub tz: Option<Tz>,
    /// Open secret and approval requests: what needs a person in a project's chat.
    pub requests: Vec<HumanRequest>,
    /// Workstreams worth a line: live ones, plus those that finished or failed since the last digest.
    pub workstreams: Vec<Workstream>,
    /// Lead decisions since the last digest, newest first.
    pub decided_without_you: Vec<Decision>,
    /// Display names by `machineId/projectId`; the project id is used when missing.
    pub project_names: HashMap<String, String>,
    /// Checks passed, as fleetd measured them; absent ones show none.
    pub facts: HashMap<String, WorkstreamFacts>,
    /// Lines from the train area: merges since the last digest and the state of each train.
    pub train: Vec<String>,
}

const DECIDED_MAX: usize = 5;
const TEXT_MAX: usize = 120;

fn clip(text: &str, max: usize) -> String {
    if text.encode_utf16().count() > max {
        format!("{}…", js_prefix(text, max - 1))
    } else {
        text.to_string()
    }
}

/// en-GB `{weekday: short, day: numeric, month: short, hour: 2-digit, minute: 2-digit}`: "Sat 17 Oct, 09:05".
fn when(now_ms: i64, tz: Option<Tz>) -> String {
    const FORMAT: &str = "%a %-d %b, %H:%M";
    match tz {
        Some(tz) => tz
            .timestamp_millis_opt(now_ms)
            .single()
            .map(|t| t.format(FORMAT).to_string())
            .unwrap_or_default(),
        None => format!(
            "{} UTC",
            chrono_tz::UTC
                .timestamp_millis_opt(now_ms)
                .single()
                .map(|t| t.format(FORMAT).to_string())
                .unwrap_or_default()
        ),
    }
}

fn is_running(state: &WorkstreamState) -> bool {
    matches!(
        state,
        WorkstreamState::Draft
            | WorkstreamState::Running
            | WorkstreamState::Converging
            | WorkstreamState::Verifying
    )
}

/// Same rule as `playbooks::finish_all_rules::is_finish_all`.
fn is_finish_all(w: &Workstream) -> bool {
    w.playbook
        .as_deref()
        .is_some_and(|p| p.starts_with("finish-all@"))
}

/// What a request waits for, in a few words.
fn waits_for(r: &HumanRequest) -> String {
    match (&r.secret, &r.gated, &r.permission) {
        (Some(secret), _, _) => format!("enter secret {}", secret.key),
        (_, Some(gated), _) => format!("approve or deny: {}", clip(&gated.reason, 80)),
        (_, _, Some(p)) => format!("approve or deny: {} {}", p.tool_name, clip(&p.summary, 60)),
        _ => clip(&r.text, TEXT_MAX),
    }
}

pub fn render_human_digest(input: &DigestInput) -> String {
    let project = |r: Option<&ProjectRef>| match r {
        None => "unrouted".to_string(),
        Some(r) => input
            .project_names
            .get(&project_key(r))
            .cloned()
            .unwrap_or_else(|| r.project_id.to_string()),
    };
    let open: Vec<&HumanRequest> = input
        .requests
        .iter()
        .filter(|r| r.state == RequestState::Open)
        .collect();
    let running: Vec<&Workstream> = input
        .workstreams
        .iter()
        .filter(|w| is_running(&w.state))
        .collect();
    let done: Vec<&Workstream> = input
        .workstreams
        .iter()
        .filter(|w| w.state == WorkstreamState::Done)
        .collect();
    let failed: Vec<&Workstream> = input
        .workstreams
        .iter()
        .filter(|w| w.state == WorkstreamState::Failed)
        .collect();

    let mut lines = vec![format!("fleetd digest · {}", when(input.now_ms, input.tz))];
    let mut head = vec![if open.is_empty() {
        "Nothing needs you".to_string()
    } else {
        format!("{} need you", open.len())
    }];
    head.push(format!("{} running", running.len()));
    head.push(format!("{} done", done.len()));
    if !failed.is_empty() {
        head.push(format!("{} failed", failed.len()));
    }
    lines.push(head.join(" · "));

    for r in &open {
        lines.push(format!(
            "{}: {} (in its chat)",
            project(Some(&r.project_ref)),
            waits_for(r)
        ));
    }
    let status = |w: &Workstream| {
        let title = if w.title.is_empty() {
            w.source.text.to_string()
        } else {
            w.title.to_string()
        };
        format!(
            "{} {}: {}",
            w.workstream_id,
            project(Some(&w.project_ref)),
            clip(&title, 60)
        )
    };
    let says = |w: &Workstream| {
        w.headline
            .as_ref()
            .map(|h| format!(" — lead says: {}", clip(h, 80)))
            .unwrap_or_default()
    };
    let checked = |w: &Workstream| {
        let total = w.brief.as_ref().map_or(0, |b| b.done_when.len());
        let passed = input
            .facts
            .get(w.workstream_id.as_str())
            .map_or(0, |f| f.passed);
        if total == 0 || passed == 0 {
            String::new()
        } else {
            format!(" · ✓ {passed} of {total} checks")
        }
    };
    // Only a passing claim makes a workstream done, so done ones are checked by definition.
    for w in &done {
        lines.push(format!("Done: {}{}", status(w), checked(w)));
    }
    for w in &failed {
        lines.push(format!("Failed: {}{}", status(w), says(w)));
    }
    if !input.decided_without_you.is_empty() {
        let shown = &input.decided_without_you[..input.decided_without_you.len().min(DECIDED_MAX)];
        let list: Vec<String> = shown
            .iter()
            .map(|d| format!("{}={} ({})", d.key, clip(&d.value, 40), d.decision_id))
            .collect();
        lines.push(format!(
            "Decided without you ({}): {} · reply \"forget {}\" to undo one",
            input.decided_without_you.len(),
            list.join("; "),
            shown[0].decision_id
        ));
    }
    for w in &running {
        lines.push(format!("Running: {}{}{}", status(w), says(w), checked(w)));
    }
    // Finish-all's finish line; other idle workstreams stay quiet.
    for w in input
        .workstreams
        .iter()
        .filter(|w| w.state == WorkstreamState::Idle && is_finish_all(w))
    {
        lines.push(format!("Idle: {} · {FINISH_ALL_IDLE}", status(w)));
    }
    lines.extend(input.train.iter().cloned());
    lines.join("\n")
}
