//! The lead's first message: the `lead.start` prompt, the project's areas (a fixed line fleetd fills), the digest,
//! then the human's custom instructions.
use fleetd_contracts::ids::ProjectRef;

use crate::hub::prompts::PromptSet;

pub fn render_lead_start(
    set: &PromptSet,
    project_ref: &ProjectRef,
    title: &str,
    areas: Option<(Vec<String>, bool)>,
    digest: &str,
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
    let areas = areas
        .filter(|(names, _)| !names.is_empty())
        .map(|(names, inferred)| {
            let source = if inferred {
                "inferred"
            } else {
                "from .fleetd/policy.yaml"
            };
            format!(
                "\n\nWriter areas in this project ({source}): {}.",
                names.join(", ")
            )
        })
        .unwrap_or_default();
    set.with_instructions(format!("{}{areas}\n\n{digest}", start.trim_end()))
}

#[cfg(test)]
mod tests {
    use fleetd_contracts::ids::{MachineId, ProjectId};

    use super::*;

    #[test]
    fn the_first_message_names_the_areas_and_where_they_come_from() {
        let r = ProjectRef {
            machine_id: MachineId::unchecked("devbox"),
            project_id: ProjectId::unchecked("p1"),
        };
        let set = PromptSet::defaults();
        let areas = Some((vec!["all".into(), "docs".into(), "hub".into()], true));
        let text = render_lead_start(set, &r, "storefront", areas, "DIGEST");
        let line = "Writer areas in this project (inferred): all, docs, hub.";
        let (at, digest) = (text.find(line).unwrap(), text.find("DIGEST").unwrap());
        assert!(
            text.find("storefront").unwrap() < at && at < digest,
            "{text}"
        );
        let set_by_file = render_lead_start(
            set,
            &r,
            "storefront",
            Some((vec!["docs".into()], false)),
            "D",
        );
        assert!(set_by_file.contains("(from .fleetd/policy.yaml): docs."));
        assert!(!render_lead_start(set, &r, "storefront", None, "D").contains("Writer areas"));
    }
}
