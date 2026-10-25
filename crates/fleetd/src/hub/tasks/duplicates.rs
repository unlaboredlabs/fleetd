//! The duplicate check at a writer's spawn: its title, prompt, item, PR and paths against the work in flight on its
//! project's repo and base (`Work::check`), whichever project, agent or person's session holds it.
//!
//! - exact (the item or PR the spawn names, held elsewhere): refused. `notDuplicateOf` with a reason
//!   lets it through, except over a person's own claim: that work is theirs, and the lead asks in chat.
//! - strong: refused once; the same call naming the ids in `notDuplicateOf`, with `notDuplicateWhy`, goes through,
//!   and the override is logged.
//! - weak: listed in the result.
use std::collections::HashSet;

use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::mcp::ErrorCode;
use fleetd_contracts::plan::PlanItemId;
use fleetd_contracts::tasks::{PrUrl, TaskId};
use fleetd_contracts::work::{
    ClaimOwnerKind, MatchStrength, WorkItem, WorkItemKind, WorkKey, WorkMatch, WorkScope,
};

use super::SpawnInput;
use super::ports::TaskError;
use crate::hub::work::check::{matcher_keys, matcher_scope, project_owner};
use crate::hub::work::matcher::{self, Key, KeyFrom};

/// Lines of work elsewhere in a spawn's result and in a writer's prompt.
pub const ELSEWHERE_MAX: usize = 3;
/// Matches named in a refusal.
const REFUSED_MAX: usize = 5;

/// The spawn's note when its project has no repo and base to check in.
pub const UNBOUND: &str = "no repo bound; duplicate check skipped";

/// New work as the matcher reads it: held by its project, with its item and PR declared.
pub fn intent(
    project: &ProjectRef,
    scope: &WorkScope,
    title: &str,
    prompt: &str,
    item: Option<&PlanItemId>,
    pr: Option<&PrUrl>,
    paths: impl IntoIterator<Item = String>,
) -> matcher::Work {
    let scope = matcher_scope(scope);
    let mut work = matcher::Work::read(Some(project_owner(project)), title, prompt, &scope);
    let declared = item
        .map(|i| WorkKey::Item(i.clone()))
        .into_iter()
        .chain(pr.map(|pr| WorkKey::Pr(pr.clone())))
        .flat_map(|k| matcher_keys(&k, &scope));
    for key in declared {
        match work.keys.iter_mut().find(|k| k.key == key) {
            Some(known) => known.from = KeyFrom::Declared,
            None => work.keys.push(Key::declared(key)),
        }
    }
    work.paths.extend(paths);
    work
}

/// The spawn's intent.
pub fn spawn_intent(input: &SpawnInput, project: &ProjectRef, scope: &WorkScope) -> matcher::Work {
    intent(
        project,
        scope,
        input.title.as_str(),
        input.prompt.as_str(),
        input.item.as_ref(),
        input.pr.as_ref(),
        input.paths.iter().flatten().map(|p| p.as_str().to_owned()),
    )
}

fn human_claim(item: &WorkItem) -> bool {
    item.kind == WorkItemKind::Claim
        && item
            .owner
            .as_ref()
            .is_some_and(|o| o.kind == ClaimOwnerKind::HumanSession)
}

fn holder(item: &WorkItem) -> String {
    match &item.owner {
        Some(owner) => {
            let who = match owner.kind {
                ClaimOwnerKind::HumanSession => "a person's session",
                ClaimOwnerKind::AgentKey => "an agent key",
                ClaimOwnerKind::Lead => "a lead",
            };
            match &owner.label {
                Some(label) => format!("{who}, {label}"),
                None => who.to_owned(),
            }
        }
        None => match &item.project_ref {
            Some(p) => format!("project {}", p.project_id),
            None => "outside fleetd".to_owned(),
        },
    }
}

/// `T12 "dark mode toggle" (running, project shop): same item P5`; a writer whose node didn't say what it changed
/// (`unknown`) is marked "changes unknown".
pub fn line(m: &WorkMatch, unknown: &HashSet<TaskId>) -> String {
    let item = &m.item;
    let unseen = if item.task_id.as_ref().is_some_and(|t| unknown.contains(t)) {
        ", changes unknown"
    } else {
        ""
    };
    format!(
        "{} \"{}\" ({}, {}{unseen}): {}",
        item.id,
        item.title,
        item.state,
        holder(item),
        m.why
    )
}

fn ids(matches: &[&WorkMatch]) -> String {
    matches
        .iter()
        .map(|m| format!("\"{}\"", m.item.id))
        .collect::<Vec<_>>()
        .join(", ")
}

fn lines(matches: &[&WorkMatch], unknown: &HashSet<TaskId>) -> String {
    let mut out: Vec<String> = matches
        .iter()
        .take(REFUSED_MAX)
        .map(|m| line(m, unknown))
        .collect();
    if matches.len() > REFUSED_MAX {
        out.push(format!("+{} more", matches.len() - REFUSED_MAX));
    }
    out.join("; ")
}

/// What a spawn the check let through says, and what it overrode.
#[derive(Debug, Default)]
pub struct Passed {
    /// Weak matches, and those `notDuplicateOf` let through, at most `ELSEWHERE_MAX`.
    pub elsewhere: Vec<String>,
    /// The exact and strong matches `notDuplicateOf` let through.
    pub overridden: Vec<String>,
}

/// Refuses the spawn over the matches, or says what it lets through. `unknown`: writers whose node didn't say what
/// they changed in time, so their files weren't compared.
pub fn judge(
    matches: &[WorkMatch],
    input: &SpawnInput,
    unknown: &HashSet<TaskId>,
) -> Result<Passed, TaskError> {
    let acked: HashSet<&str> = input
        .not_duplicate_of
        .iter()
        .flatten()
        .map(|id| id.as_str())
        .collect();
    let human: Vec<&WorkMatch> = matches
        .iter()
        .filter(|m| m.strength == MatchStrength::Exact && human_claim(&m.item))
        .collect();
    if !human.is_empty() {
        return Err(TaskError::new(
            ErrorCode::Invalid,
            format!(
                "Taken by a person: {}. A person's claim can't be passed over with notDuplicateOf.",
                lines(&human, unknown)
            ),
        )
        .with_fix(
            "It is theirs and nothing passes it: ask them in chat to release it (`fleetd work done`, or drop it) if \
             they no longer need it, or pick other work.",
        ));
    }
    let refused: Vec<&WorkMatch> = matches
        .iter()
        .filter(|m| m.strength >= MatchStrength::Strong && !acked.contains(m.item.id.as_str()))
        .collect();
    if refused.iter().any(|m| m.strength == MatchStrength::Exact) {
        return Err(TaskError::new(
            ErrorCode::Invalid,
            format!("Taken: {}.", lines(&refused, unknown)),
        )
        .with_fix(format!(
            "It is already in flight: leave it to whoever holds it, or ask in chat. If this is different work, call \
             again with notDuplicateOf: [{}] and notDuplicateWhy.",
            ids(&refused)
        )));
    }
    if !refused.is_empty() {
        return Err(TaskError::new(
            ErrorCode::Invalid,
            format!("Possible duplicate: {}.", lines(&refused, unknown)),
        )
        .with_fix(format!(
            "If this is different work, call again with notDuplicateOf: [{}] and notDuplicateWhy; if not, don't \
             spawn it.",
            ids(&refused)
        )));
    }
    let overridden: Vec<String> = matches
        .iter()
        .filter(|m| m.strength >= MatchStrength::Strong)
        .map(|m| m.item.id.as_str().to_owned())
        .collect();
    Ok(Passed {
        elsewhere: matches
            .iter()
            .take(ELSEWHERE_MAX)
            .map(|m| line(m, unknown))
            .collect(),
        overridden,
    })
}

/// The matches a writer's prompt lists: the work in flight it may overlap, itself left out.
pub fn for_writer(matches: &[WorkMatch], task_id: &TaskId) -> Vec<String> {
    matches
        .iter()
        .filter(|m| m.item.task_id.as_ref() != Some(task_id))
        .take(ELSEWHERE_MAX)
        .map(|m| line(m, &HashSet::new()))
        .collect()
}
