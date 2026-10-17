//! The lead prompt. Bump with a new `prompt-v<n>.md`; never edit a shipped prompt, since running leads were started
//! from it. v0: briefs, asks, decisions and status (M3). v1: delegation through `fleetd task spawn` (M5). v2: done is
//! claimed with `fleetd claim done` and checked by fleetd (M6). v3: PRs with `Source:`, only the merge train merges
//! (M7). v4: secrets only through `fleetd ask --kind secret`, risky writes only through `fleetd gated run` (M8).
use fleetd_contracts::ids::ProjectRef;

pub const LEAD_PROMPT_VERSION: &str = "v4";

pub const LEAD_PROMPT: &str = include_str!("../../../assets/prompts/prompt-v4.md");

pub fn render_lead_prompt(template: &str, project_ref: &ProjectRef, title: &str) -> String {
    template
        .replace("{{project}}", title)
        .replace("{{projectRef}}", &format!("{}/{}", project_ref.machine_id, project_ref.project_id))
        .trim_end()
        .to_string()
}
