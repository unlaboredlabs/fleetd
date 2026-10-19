//! The fixed metrics a retro change is judged by. They are code, not something the retro can edit. Counts are over
//! one playbook: incidents on workstreams that pinned it (any version), plus incidents on no workstream at all,
//! which no playbook owns and every playbook's leads can cause.
use super::types::RetroSnapshot;
use crate::hub::usage::ports::BoxFut;
use crate::hub::usage::time::parse_ms;
use serde_json::Value;
use std::collections::HashMap;

/// Any regression on one of these reverts a wording change, whatever its own metric did.
pub const GUARDED: [&str; 3] = ["false_claim", "polish_loop", "agent_minutes_per_done"];
pub const DAY_MS: i64 = 86_400_000;
const SCAN: usize = 5000;

/// What the metrics read from incidents, workstreams and tasks.
pub trait RetroWork: Send + Sync {
    /// Incidents (wire JSON) with `at` in [from_ms, to_ms), newest first, at most `limit`.
    fn incidents(&self, from_ms: i64, to_ms: Option<i64>, limit: usize) -> BoxFut<'_, Vec<Value>>;
    /// The playbook ref (`bugfix@<sha>`) a workstream pinned.
    fn workstream_playbook(&self, workstream_id: &str) -> BoxFut<'_, Option<String>>;
    /// Done workstreams: (id, playbook ref, updatedAt).
    fn done_workstreams(&self, limit: usize) -> BoxFut<'_, Vec<(String, Option<String>, String)>>;
    /// A workstream's tasks' (startedAt, endedAt).
    fn task_spans(&self, workstream_id: &str) -> BoxFut<'_, Vec<(Option<String>, Option<String>)>>;
}

fn round1(n: f64) -> f64 {
    (n * 10.0).round() / 10.0
}

async fn counts(
    work: &dyn RetroWork,
    playbook: &str,
    from_ms: i64,
    to_ms: i64,
) -> HashMap<String, u64> {
    let mut cache: HashMap<String, Option<String>> = HashMap::new();
    let mut by_class = HashMap::new();
    for incident in work.incidents(from_ms, Some(to_ms), SCAN).await {
        if let Some(ws) = incident.get("workstreamId").and_then(Value::as_str) {
            if !cache.contains_key(ws) {
                let name = work
                    .workstream_playbook(ws)
                    .await
                    .map(|r| r.split('@').next().unwrap_or("").to_string());
                cache.insert(ws.to_string(), name);
            }
            if cache[ws].as_deref() != Some(playbook) {
                continue;
            }
        }
        let class = incident
            .get("class")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        *by_class.entry(class).or_insert(0) += 1;
    }
    by_class
}

/// Mean task run minutes of the playbook's workstreams that finished in the window; `None` when none did.
async fn agent_minutes(
    work: &dyn RetroWork,
    playbook: &str,
    from_ms: i64,
    to_ms: i64,
) -> Option<f64> {
    let prefix = format!("{playbook}@");
    let done: Vec<String> = work
        .done_workstreams(SCAN)
        .await
        .into_iter()
        .filter(|(_, p, updated)| {
            p.as_deref().is_some_and(|p| p.starts_with(&prefix))
                && parse_ms(updated).is_some_and(|u| u >= from_ms && u < to_ms)
        })
        .map(|(id, _, _)| id)
        .collect();
    if done.is_empty() {
        return None;
    }
    let mut minutes = 0.0;
    for id in &done {
        for (start, end) in work.task_spans(id).await {
            if let (Some(s), Some(e)) = (
                start.as_deref().and_then(parse_ms),
                end.as_deref().and_then(parse_ms),
            ) {
                minutes += (e - s).max(0) as f64 / 60_000.0;
            }
        }
    }
    Some(round1(minutes / done.len() as f64))
}

/// The target metric and every guarded one over [from_ms, to_ms).
pub async fn snapshot(
    work: &dyn RetroWork,
    playbook: &str,
    target: &str,
    from_ms: i64,
    to_ms: i64,
) -> RetroSnapshot {
    let by_class = counts(work, playbook, from_ms, to_ms).await;
    let minutes = agent_minutes(work, playbook, from_ms, to_ms).await;
    let count = |c: &str| by_class.get(c).copied().unwrap_or(0);
    RetroSnapshot {
        target: if target == "agent_minutes_per_done" {
            minutes
        } else {
            Some(count(target) as f64)
        },
        false_claim: count("false_claim"),
        polish_loop: count("polish_loop"),
        agent_minutes_per_done: minutes,
    }
}

fn shown(n: Option<f64>) -> String {
    match n {
        None => "none".into(),
        Some(v) if v.fract() == 0.0 => format!("{}", v as i64),
        Some(v) => format!("{v}"),
    }
}

/// Kept when the target went down and no guarded metric went up; otherwise the reason it reverts. A metric with no
/// value on either side (no workstream finished) counts as unchanged.
pub fn judge(baseline: &RetroSnapshot, measured: &RetroSnapshot) -> Result<(), String> {
    match (baseline.target, measured.target) {
        (Some(b), Some(m)) if m < b => {}
        _ => {
            return Err(format!(
                "the metric did not improve ({} before, {} after)",
                shown(baseline.target),
                shown(measured.target)
            ));
        }
    }
    let guarded = |s: &RetroSnapshot, g: &str| -> Option<f64> {
        match g {
            "false_claim" => Some(s.false_claim as f64),
            "polish_loop" => Some(s.polish_loop as f64),
            _ => s.agent_minutes_per_done,
        }
    };
    for g in GUARDED {
        if let (Some(before), Some(after)) = (guarded(baseline, g), guarded(measured, g))
            && after > before
        {
            return Err(format!(
                "{g} regressed ({} before, {} after)",
                shown(Some(before)),
                shown(Some(after))
            ));
        }
    }
    Ok(())
}
