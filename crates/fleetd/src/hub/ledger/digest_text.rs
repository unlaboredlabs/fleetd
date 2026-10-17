//! The human digest's text (TS `ledger/HumanDigest.ts`): plain text, phone width (DESIGN §4). Facts only from
//! state: ✓ marks checks fleetd ran and saw pass, and a workstream's own status line is marked "lead says", since
//! nothing backs it.
use std::collections::HashMap;

use chrono::TimeZone;
use chrono_tz::Tz;
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::ledger::{Ask, AskKind, AskState, Decision, Workstream, WorkstreamState};

use super::repo::batch_n;
use super::{js_prefix, project_key};

const PLAYBOOK_ASK_PREFIX: &str = "playbook.";
/// TS `playbooks/finishAllRules.ts` FINISH_ALL_IDLE.
pub const FINISH_ALL_IDLE: &str = "finish-all: nothing left with a value source";

/// What backs a workstream's status beyond the lead's word: the checks its latest claim passed and its ETA.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct WorkstreamFacts {
    /// How many checks the latest finished claim passed.
    pub passed: usize,
    /// `etaText` of the calibrated estimate.
    pub eta: Option<String>,
}

/// What the 09:00/18:00 digest is rendered from; the caller gathers it.
#[derive(Clone, Debug, Default)]
pub struct DigestInput {
    pub now_ms: i64,
    /// IANA zone from `policy.tz`; `None` (an unknown zone) renders in UTC.
    pub tz: Option<Tz>,
    /// Open asks.
    pub asks: Vec<Ask>,
    /// Workstreams worth a line: live ones, plus those that finished or failed since the last digest.
    pub workstreams: Vec<Workstream>,
    /// Lead decisions since the last digest, newest first.
    pub decided_without_you: Vec<Decision>,
    /// Display names by `machineId/projectId`; the project id is used when missing.
    pub project_names: HashMap<String, String>,
    /// Checks passed and ETAs, as fleetd measured them; absent ones show none.
    pub facts: HashMap<String, WorkstreamFacts>,
    /// Lines from the train area: merges since the last digest and the state of each train.
    pub train: Vec<String>,
    /// M12: the retro's advise-only proposals.
    pub suggested: Vec<String>,
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

/// TS `isFinishAll`.
fn is_finish_all(w: &Workstream) -> bool {
    w.playbook
        .as_deref()
        .is_some_and(|p| p.starts_with("finish-all@"))
}

fn kind_or_class(ask: &Ask) -> String {
    if ask.kind == AskKind::Do {
        return "do".into();
    }
    match serde_json::to_value(ask.class) {
        Ok(serde_json::Value::String(s)) => s,
        _ => String::new(),
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
    let ask_project = |ask: &Ask| {
        if ask.project_ref.is_none() && ask.key.starts_with(PLAYBOOK_ASK_PREFIX) {
            "playbooks".to_string()
        } else {
            project(ask.project_ref.as_ref())
        }
    };
    let batch_of = |ask: &Ask| ask.batch_id.as_deref().and_then(batch_n);
    let open: Vec<&Ask> = input
        .asks
        .iter()
        .filter(|a| a.state == AskState::Open)
        .collect();
    let latest = open
        .iter()
        .filter_map(|a| batch_of(a))
        .max()
        .unwrap_or(0)
        .max(0);
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
        format!(
            "{}{} need you",
            if latest > 0 {
                format!("B{latest} · ")
            } else {
                String::new()
            },
            open.len()
        )
    }];
    head.push(format!("{} running", running.len()));
    head.push(format!("{} done", done.len()));
    if !failed.is_empty() {
        head.push(format!("{} failed", failed.len()));
    }
    lines.push(head.join(" · "));

    let mut ordered = open.clone();
    ordered.sort_by_key(|a| {
        (
            batch_of(a).unwrap_or(i64::MAX),
            a.number.map(|n| n.get()).unwrap_or(0),
        )
    });
    for ask in ordered {
        let number = ask.number.map(|n| n.get().to_string());
        let label = match batch_of(ask) {
            None => ask.ask_id.to_string(),
            Some(n) if n == latest => number.clone().unwrap_or_default(),
            Some(n) => format!("#B{n} {}", number.clone().unwrap_or_default()),
        };
        let mut line = format!(
            "{label} [{}] {}: {}",
            kind_or_class(ask),
            ask_project(ask),
            clip(&ask.text, TEXT_MAX)
        );
        if ask.kind == AskKind::Do {
            let steps = ask.steps.as_ref().map_or(0, |s| s.len());
            line += &format!(
                " ({steps} step{}; reply \"{} done\" when finished)",
                if steps == 1 { "" } else { "s" },
                number.unwrap_or_else(|| ask.ask_id.to_string())
            );
        } else {
            if let Some(options) = ask.options.as_ref().filter(|o| !o.is_empty()) {
                let shown: Vec<String> = options
                    .iter()
                    .enumerate()
                    .map(|(i, o)| format!("{}) {}", &"abcdef"[i..i + 1], clip(o, 40)))
                    .collect();
                line += &format!(" {}", shown.join(" "));
            }
            if let Some(rec) = &ask.recommendation {
                line += &format!(" rec: {}", clip(rec, 60));
            }
            if ask.proceeded_on_rec {
                line += " (proceeded) — override?";
            }
        }
        if ask.blocks.as_str() != "nothing" {
            line += &format!("   (blocks: {})", clip(&ask.blocks, 60));
        }
        lines.push(line);
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
    let eta = |w: &Workstream| {
        input
            .facts
            .get(w.workstream_id.as_str())
            .and_then(|f| f.eta.as_ref())
            .map(|e| format!(" · {e}"))
            .unwrap_or_default()
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
        lines.push(format!(
            "Running: {}{}{}{}",
            status(w),
            says(w),
            checked(w),
            eta(w)
        ));
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
    lines.extend(input.suggested.iter().cloned());
    lines.join("\n")
}
