//! The brief's floor under a pinned playbook: its required check types, and for research the pre-registered fields.
//! Pure; `Workstreams::brief_create` applies it at freeze and on every amend.
use fleetd_contracts::ledger::{Brief, CheckType, PlaybookName};
use fleetd_contracts::playbooks::RESEARCH_FIELDS_FIX;

use super::Playbook;

fn type_list(types: &[CheckType]) -> String {
    let names: Vec<&str> = types.iter().map(|t| t.as_str()).collect();
    match names.split_last() {
        Some((last, [])) => (*last).to_string(),
        Some((last, rest)) => format!("{} or {last}", rest.join(", ")),
        None => String::new(),
    }
}

/// The research fields a brief lacks, by path.
fn missing_research_fields(brief: &Brief) -> Vec<&'static str> {
    let mut missing = Vec::new();
    if brief.baseline.is_none() {
        missing.push("baseline");
    }
    if brief.metric.is_none() {
        missing.push("metric");
    }
    if brief.decision_rule.is_none() {
        missing.push("decisionRule");
    }
    if !brief
        .budget
        .as_ref()
        .is_some_and(|b| b.size.is_some() || b.agent_hours.is_some())
    {
        missing.push("budget.size");
    }
    missing
}

/// Why the brief falls short of the playbook, e.g. "bugfix needs a failing repro check (type test or cmd)"; None
/// when it doesn't.
pub fn floor_refusal(playbook: &Playbook, brief: &Brief) -> Option<String> {
    let types: Vec<CheckType> = brief.done_when.iter().map(|c| c.check_type()).collect();
    let mut unmet: Vec<String> = playbook
        .required_checks
        .iter()
        .filter(|required| !required.any_of.iter().any(|t| types.contains(t)))
        .map(|required| {
            format!(
                "{} needs {} (type {})",
                playbook.name.as_str(),
                required.label.as_deref().unwrap_or("a check"),
                type_list(&required.any_of)
            )
        })
        .collect();
    if playbook.name == PlaybookName::Research {
        let missing = missing_research_fields(brief);
        if !missing.is_empty() {
            unmet.push(format!(
                "{RESEARCH_FIELDS_FIX}; missing {}",
                missing.join(", ")
            ));
        }
    }
    if unmet.is_empty() {
        None
    } else {
        Some(unmet.join("; "))
    }
}
