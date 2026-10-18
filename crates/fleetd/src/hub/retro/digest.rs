//! The human digest's lines for advise-only retro proposals. Pure.
use super::types::RetroProposal;

const SHOWN: usize = 3;

/// Newest first in, at most three lines out, plus how to turn them on.
pub fn suggested_lines(suggested: &[RetroProposal]) -> Vec<String> {
    if suggested.is_empty() {
        return Vec::new();
    }
    let mut lines: Vec<String> = suggested
        .iter()
        .take(SHOWN)
        .map(|p| {
            let aim = if p.metric.class == "agent_minutes_per_done" {
                "agent-minutes per done workstream".to_string()
            } else {
                format!("{} incidents", p.metric.class)
            };
            format!(
                "Suggested {}: {} {} ({}) · fixes {} · aims to cut {aim} over {} d",
                p.proposal_id,
                p.playbook,
                p.kind,
                p.fields.join(", "),
                p.fixes_incidents.join(", "),
                p.metric.window_days
            )
        })
        .collect();
    let more = if suggested.len() > SHOWN {
        format!(" (+{} more)", suggested.len() - SHOWN)
    } else {
        String::new()
    };
    lines.push(format!("Retro suggestions{more} apply only once policy.retro.apply = true; retro_proposals has the diffs."));
    lines
}
