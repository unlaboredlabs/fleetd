//! The merge train in the lead digest: each train's state, PRs merged since the lead's last wake, PRs sent back to
//! their authors, and review waivers (the polish-loop rule's notes on a Change). The renderer is pure; `train_facts`
//! gathers its input.
use std::collections::HashMap;

use super::contract::{Change, ChangeState, ProjectRef, TrainState, state_str};
use super::records::{ChangeRecords, ListFilter};
use super::time::parse_iso;

pub struct TrainFacts {
    pub trains: Vec<TrainState>,
    /// Newest first.
    pub changes: Vec<Change>,
    /// Why review was waived for a Change's patch, by change id.
    pub waivers: HashMap<String, String>,
}

const PARKED: [ChangeState; 2] = [ChangeState::NeedsRebase, ChangeState::CiFailed];

fn one_line(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > max {
        format!("{}…", flat.chars().take(max - 1).collect::<String>())
    } else {
        flat
    }
}

fn short(sha: Option<&str>) -> String {
    sha.map(|s| format!(" as {}", &s[..s.len().min(12)]))
        .unwrap_or_default()
}

fn pr(c: &Change) -> String {
    format!("{}#{}", c.repo, c.pr_number)
}

fn by(c: &Change) -> String {
    c.task_id
        .as_ref()
        .map(|t| format!(", by {t}"))
        .unwrap_or_default()
}

fn updated_after(c: &Change, since_ms: Option<i64>) -> bool {
    // Date.parse(updatedAt) > since; an unreadable time compares false.
    since_ms.is_none_or(|since| parse_iso(c.updated_at.as_str()).is_some_and(|at| at > since))
}

fn state_of(changes: &[Change], train: &TrainState) -> String {
    let by_id: HashMap<&str, &Change> = changes.iter().map(|c| (c.change_id.as_str(), c)).collect();
    let queue: Vec<String> = train
        .queue
        .iter()
        .map(|id| match by_id.get(id.as_str()) {
            Some(c) => format!("{id} {}", state_str(c.state)),
            None => id.to_string(),
        })
        .collect();
    let mut parts = Vec::new();
    if let Some(head) = &train.head {
        let state = by_id
            .get(head.as_str())
            .map(|c| format!(" ({})", state_str(c.state)))
            .unwrap_or_default();
        parts.push(format!("now {head}{state}"));
    }
    parts.push(if queue.is_empty() {
        "queue empty".to_string()
    } else {
        let more = if queue.len() > 8 {
            format!(" +{}", queue.len() - 8)
        } else {
            String::new()
        };
        format!("queue {}{more}", queue[..queue.len().min(8)].join(", "))
    });
    parts.join("; ")
}

fn merged(changes: &[Change], since_ms: Option<i64>) -> impl Iterator<Item = &Change> {
    changes
        .iter()
        .filter(move |c| c.state == ChangeState::Merged && updated_after(c, since_ms))
}

/// Waived Changes still on the train, or merged since `since_ms`.
fn waived(facts: &TrainFacts, since_ms: Option<i64>) -> impl Iterator<Item = (&Change, &String)> {
    facts.changes.iter().filter_map(move |c| {
        let reason = facts.waivers.get(c.change_id.as_str())?;
        (c.state != ChangeState::Merged || updated_after(c, since_ms)).then_some((c, reason))
    })
}

/// The lead digest's "Merge train" lines. `since` is the lead's last wake.
pub fn lead_train_lines(facts: &TrainFacts, since: Option<&str>) -> Vec<String> {
    // Date.parse of an unreadable `since` is NaN: nothing is "after" it.
    let since_ms = since.map(|s| parse_iso(s).unwrap_or(i64::MAX));
    let mut lines: Vec<String> = facts
        .trains
        .iter()
        .map(|t| format!("- {}: {}", t.repo, state_of(&facts.changes, t)))
        .collect();
    let when = if since.is_some() {
        " since your last wake"
    } else {
        ""
    };
    lines.extend(merged(&facts.changes, since_ms).map(|c| {
        format!(
            "- {} merged{when}: {}{}{}",
            c.change_id,
            pr(c),
            short(c.merged_sha.as_deref()),
            c.task_id
                .as_ref()
                .map(|t| format!(" (by {t})"))
                .unwrap_or_default()
        )
    }));
    lines.extend(
        facts
            .changes
            .iter()
            .filter(|c| PARKED.contains(&c.state))
            .map(|c| {
                format!(
                    "- {} {}: {}{}; {}. Back with its author; the train retries its next push",
                    c.change_id,
                    state_str(c.state),
                    pr(c),
                    by(c),
                    one_line(c.last_error.as_deref().unwrap_or(""), 160)
                )
            }),
    );
    lines.extend(waived(facts, since_ms).map(|(c, reason)| {
        format!(
            "- {} {} ({}): review waived, {}",
            c.change_id,
            pr(c),
            state_str(c.state),
            one_line(reason, 200)
        )
    }));
    lines
}

/// Trains whose project passes `shown` and their 50 newest Changes.
pub fn train_facts(records: &ChangeRecords, shown: impl Fn(&ProjectRef) -> bool) -> TrainFacts {
    let trains: Vec<_> = records
        .trains()
        .into_iter()
        .filter(|t| shown(&t.project_ref))
        .collect();
    let changes: Vec<Change> = records
        .list(&ListFilter {
            limit: 200,
            ..Default::default()
        })
        .into_iter()
        .filter(|c| shown(&c.project_ref))
        .take(50)
        .collect();
    let ids: std::collections::HashSet<&str> =
        changes.iter().map(|c| c.change_id.as_str()).collect();
    let waivers = records
        .waivers()
        .into_iter()
        .filter(|(id, _)| ids.contains(id.as_str()))
        .collect();
    TrainFacts {
        trains: trains
            .iter()
            .take(10)
            .map(|t| records.train_state(&t.repo))
            .collect(),
        changes,
        waivers,
    }
}
