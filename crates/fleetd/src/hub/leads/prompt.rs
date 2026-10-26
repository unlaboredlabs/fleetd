//! The lead's first message: the `lead.start` prompt, `lead.voice`, `lead.profiles` while the project allows medium,
//! the digest, the human's custom instructions, then the memory (`user.md` and the project's `MEMORY.md`).
use fleetd_contracts::ids::ProjectRef;

use crate::hub::prompts::PromptSet;

/// An automation's order, and the tools that manage them.
const AUTOMATIONS: &str = "## Automations\nAn order that says \"From automation\" is a run of one of this project's \
automations: start its work without asking the human first; reviews, the train and approvals still apply. For \
recurring or triggered work the human asks for, use `automation_create`, `automation_list`, `automation_update`, \
`automation_pause`, `automation_delete`, `automation_run` and `automation_runs`.";

pub fn render_lead_start(
    set: &PromptSet,
    project_ref: &ProjectRef,
    title: &str,
    medium_allowed: bool,
    digest: &str,
    memory: &str,
) -> String {
    let start = set.render(
        "lead.start",
        &[
            ("project", &title),
            (
                "projectRef",
                &format!("{}/{}", project_ref.machine_id, project_ref.project_id),
            ),
        ],
    );
    // Without medium every task runs high, so the lead isn't told how to pick.
    let profiles = if medium_allowed {
        format!("\n\n{}", set.render("lead.profiles", &[]).trim_end())
    } else {
        String::new()
    };
    let voice = set.render("lead.voice", &[]);
    let first = set.with_instructions(format!(
        "{}\n\n{}{profiles}\n\n{AUTOMATIONS}\n\n{digest}",
        start.trim_end(),
        voice.trim_end()
    ));
    if memory.is_empty() {
        first
    } else {
        format!("{first}\n\n{memory}")
    }
}

#[cfg(test)]
mod tests {
    use fleetd_contracts::ids::{MachineId, ProjectId};

    use super::*;

    #[test]
    fn the_task_profiles_follow_lead_start_only_while_the_project_allows_medium() {
        let r = ProjectRef {
            machine_id: MachineId::unchecked("devbox"),
            project_id: ProjectId::unchecked("p1"),
        };
        let set = PromptSet::defaults();
        let text = render_lead_start(set, &r, "storefront", true, "DIGEST", "");
        let guide = text.find("## Task profiles").unwrap();
        assert!(
            text.find("spawn_agent").unwrap() < guide && guide < text.find("DIGEST").unwrap(),
            "{text}"
        );
        let off = render_lead_start(set, &r, "storefront", false, "D", "");
        assert!(!off.contains("## Task profiles") && off.contains("spawn_agent"));
        let voice = off.find("## Your voice").unwrap();
        assert!(
            off.find("spawn_agent").unwrap() < voice
                && voice < off.find("```fleetd-block").unwrap()
        );
    }
}
