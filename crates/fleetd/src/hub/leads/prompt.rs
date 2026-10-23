//! The lead's first message: the `lead.start` prompt, the digest, then the human's custom instructions.
use fleetd_contracts::ids::ProjectRef;

use crate::hub::prompts::PromptSet;

pub fn render_lead_start(
    set: &PromptSet,
    project_ref: &ProjectRef,
    title: &str,
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
    set.with_instructions(format!("{}\n\n{digest}", start.trim_end()))
}
