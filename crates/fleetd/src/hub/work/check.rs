//! New work against the work in flight: the in-flight view's items become the matcher's candidates, and its
//! matches come back as `WorkMatch`es with the item they name. Callers decide what each strength does: `work_claim`
//! here, `spawn_agent` in the tasks.
//!
//! Owners: a task or Change is held by its project, as `<machineId>/<projectId>` (a lead's `ClaimOwner.key_id`), so
//! a lead splitting its own item is not a duplicate; a claim by its owner's key. Expired claims match as weak only.
use std::collections::HashMap;

use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::work::{
    ClaimState, MatchStrength, WorkItem, WorkItemKind, WorkKey, WorkMatch, WorkScope,
};

use super::Work;
use super::matcher::{self, Candidate, Key, Scope, Strength};
use crate::hub::store::StoreError;

/// Who holds a project's tasks and Changes, as the matcher compares owners: `<machineId>/<projectId>`.
pub fn project_owner(project: &ProjectRef) -> String {
    format!("{}/{}", project.machine_id, project.project_id)
}

/// The matcher's scope for a work scope: its repo turns the repo's own PR and issue URLs into `#12`.
pub fn matcher_scope(scope: &WorkScope) -> Scope {
    Scope {
        repo: Some(scope.repo_key.as_str().to_owned()),
        base: Some(scope.base.as_str().to_owned()),
    }
}

/// A declared key as the matcher keys it: issues and PRs by the ref they are written as (`#12`, `ABC-123`, or
/// `owner/repo#12` in another repo), branches as they are.
pub fn matcher_keys(key: &WorkKey, scope: &Scope) -> Vec<matcher::WorkKey> {
    match key {
        WorkKey::Branch(branch) => vec![matcher::WorkKey::Branch(branch.as_str().to_owned())],
        WorkKey::Issue(text) => {
            let keys = matcher::keys_in(text.as_str(), scope);
            if keys.is_empty() {
                vec![matcher::WorkKey::Ref(text.as_str().to_owned())]
            } else {
                keys
            }
        }
        WorkKey::Pr(url) => {
            let keys = matcher::keys_in(url.as_str(), scope);
            if keys.is_empty() {
                vec![matcher::WorkKey::Ref(url.as_str().to_owned())]
            } else {
                keys
            }
        }
    }
}

fn owner_of(item: &WorkItem) -> Option<String> {
    match &item.owner {
        Some(owner) => Some(owner.key_id.as_str().to_owned()),
        None => item.project_ref.as_ref().map(project_owner),
    }
}

fn candidate(item: &WorkItem, scope: &Scope) -> Candidate {
    let mut work = matcher::Work::read(owner_of(item), item.title.as_str(), "", scope);
    for key in item.keys.iter().flat_map(|k| matcher_keys(k, scope)) {
        if !work.keys.iter().any(|k| k.key == key) {
            work.keys.push(Key::declared(key));
        }
    }
    work.paths
        .extend(item.paths.iter().map(|p| p.as_str().to_owned()));
    let expired = item.kind == WorkItemKind::Claim
        && item.state.as_str() == super::store::state_str(ClaimState::Expired);
    Candidate {
        id: item.id.as_str().to_owned(),
        work,
        weak_only: expired,
    }
}

fn strength(s: Strength) -> MatchStrength {
    match s {
        Strength::Weak => MatchStrength::Weak,
        Strength::Strong => MatchStrength::Strong,
        Strength::Exact => MatchStrength::Exact,
    }
}

/// The items `intent` may repeat, strongest first, weak ones included. Pure: `Work::check` reads the items.
pub fn matches_in(items: &[WorkItem], intent: &matcher::Work, scope: &WorkScope) -> Vec<WorkMatch> {
    let scope = matcher_scope(scope);
    let candidates: Vec<Candidate> = items.iter().map(|i| candidate(i, &scope)).collect();
    let by_id: HashMap<&str, &WorkItem> = items.iter().map(|i| (i.id.as_str(), i)).collect();
    matcher::matches(intent, &candidates, &scope)
        .into_iter()
        .filter_map(|m| {
            Some(WorkMatch {
                strength: strength(m.strength),
                why: m.why,
                item: (*by_id.get(m.id.as_str())?).clone(),
            })
        })
        .collect()
}

impl Work {
    /// What `intent` may repeat among the scope's work in flight, strongest first, weak ones included.
    pub async fn check(
        &self,
        scope: &WorkScope,
        intent: &matcher::Work,
    ) -> Result<Vec<WorkMatch>, StoreError> {
        let items = self.in_flight(scope).await?;
        Ok(matches_in(&items, intent, scope))
    }
}
