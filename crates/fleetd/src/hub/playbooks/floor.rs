//! The brief's floor under a pinned playbook: for research, the pre-registered fields. Pure; `Workstreams::brief_create`
//! applies it on every brief.
use fleetd_contracts::ledger::{Brief, PlaybookName};
use fleetd_contracts::playbooks::research_brief_rule;

use super::Playbook;

/// Why the brief falls short of the playbook, e.g. "a research brief needs baseline, ...; missing metric"; None when
/// it doesn't.
pub fn floor_refusal(playbook: &Playbook, brief: &Brief) -> Option<String> {
    if playbook.name != PlaybookName::Research {
        return None;
    }
    research_brief_rule(brief).err()
}
