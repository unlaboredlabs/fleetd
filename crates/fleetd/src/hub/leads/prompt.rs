//! The lead's first message: the `lead.start` prompt, `lead.voice`, `lead.profiles` while the project allows medium,
//! the digest, the human's custom instructions, then the memory (`user.md` and the project's `MEMORY.md`). A project
//! with repos besides its own directory has them listed after that (`repos_block`).
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::repos::ProjectRepo;

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

/// The project's repos for the lead's first message, by name, each with its checkout and where its work lands; none
/// for a project that is only its own repo, or a plain folder with none, whose message is as before.
pub fn repos_block(project_ref: &ProjectRef, repos: &[ProjectRepo]) -> Option<String> {
    if repos.iter().all(|r| &r.checkout == project_ref) {
        return None;
    }
    let lines: Vec<String> = repos
        .iter()
        .map(|r| {
            let path = r.path.as_deref().unwrap_or(r.checkout.project_id.as_str());
            let lands = match (&r.repo_key, &r.base) {
                (Some(key), Some(base)) => format!(", {key} on {base}"),
                (Some(key), None) => format!(", {key}"),
                _ => ", no remote".to_owned(),
            };
            let own = if &r.checkout == project_ref {
                " (the project's own directory)"
            } else {
                ""
            };
            format!("- `{}`: {path}{lands}{own}", r.name)
        })
        .collect();
    Some(format!(
        "## Repos\nThis project holds these repos, each a checkout on {}:\n{}",
        project_ref.machine_id,
        lines.join("\n")
    ))
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
        // The lead keeps the human's checklist as it runs the work.
        assert!(off.contains("Keep the checklist current with `checklist`"));
        let voice = off.find("## Your voice").unwrap();
        assert!(
            off.find("spawn_agent").unwrap() < voice
                && voice < off.find("```fleetd-block").unwrap()
        );
    }
    /// A project that is only its own repo, or a plain folder, starts as before; one with more lists them all.
    #[test]
    fn the_repos_are_listed_only_beside_the_projects_own() {
        let r = ProjectRef {
            machine_id: MachineId::unchecked("devbox"),
            project_id: ProjectId::unchecked("p1"),
        };
        let repo = |n: &str, of: &str, key: Option<&str>| ProjectRepo {
            repo_id: fleetd_contracts::repos::RepoId::unchecked(format!("R{}", n.len())),
            name: fleetd_contracts::repos::RepoName::unchecked(n),
            checkout: ProjectRef {
                project_id: ProjectId::unchecked(of),
                ..r.clone()
            },
            path: Some(format!("/work/{n}")),
            repo_key: key.map(fleetd_contracts::work::RepoKey::unchecked),
            base: key.map(|_| fleetd_contracts::prim::Line::unchecked("main")),
        };
        let own = repo("app", "p1", Some("github.com/acme/app"));
        assert_eq!(repos_block(&r, &[]), None);
        assert_eq!(repos_block(&r, std::slice::from_ref(&own)), None);
        let block = repos_block(&r, &[own, repo("notes", "p2", None)]).unwrap();
        assert_eq!(
            block,
            "## Repos\nThis project holds these repos, each a checkout on devbox:\n\
             - `app`: /work/app, github.com/acme/app on main (the project's own directory)\n\
             - `notes`: /work/notes, no remote"
        );
    }
}
