//! work_claim, work_list and work_done: the work ledger for sessions fleetd doesn't run (a person's own Claude Code,
//! or the `fleetd work` CLI). A claim is checked against the work in flight before it is stored: an exact match
//! (someone else's issue, PR, branch or item) refuses it, and only a person's session may claim it `anyway`, so a lead
//! or an agent never overrides a person's claim; a strong match refuses it once, until `notDuplicateOf` names it with a
//! reason; weak matches are only listed.
use std::sync::Arc;
use std::time::Duration;

use fleetd_contracts::auth::Role;
use fleetd_contracts::ids::{ProjectRef, Timestamp};
use fleetd_contracts::mcp::{
    ErrorCode, WorkClaimInput, WorkClaimOutput, WorkClaimStatus, WorkDoneInput, WorkDoneOutcome,
    WorkDoneOutput, WorkListInput, WorkListOutput,
};
use fleetd_contracts::prim::{Line, List};
use fleetd_contracts::work::{
    BranchName, Claim, ClaimId, ClaimObserved, ClaimOwner, ClaimOwnerKind, ClaimState,
    MatchStrength, RepoKey, WorkItem, WorkItemKind, WorkKey, WorkMatch, WorkScope,
};

use super::bind::{self, NodeGit};
use super::check::{matcher_keys, matcher_scope, matches_in};
use super::matcher::{self, Key};
use super::{Ending, NewClaim, Work, store};
use crate::hub::api::{
    Caller, Hub, Registry, ToolError, cap, error, is_human, readable, require, unknown_project,
};
use crate::hub::store::{StoreError, iso_ms};

/// Matches a claim's answer shows.
const MATCHES_MAX: usize = 10;
/// Items work_list shows.
const ITEMS_MAX: usize = 100;
/// The base when nothing says otherwise.
const DEFAULT_BASE: &str = "main";
/// How long a call waits on the nodes to read unbound projects' remotes before it answers without them.
const BIND_WAIT: Duration = Duration::from_secs(3);

pub fn register(tools: &mut Registry) {
    tools.add("work_claim", work_claim);
    tools.add("work_list", work_list);
    tools.add("work_done", work_done);
}

/// Binds every project on the caller's machines that has no repo and base recorded yet (one added before the
/// ledger, or while its node was away), reading each from its checkout. It waits at most `BIND_WAIT`; the rest are
/// read on a later call.
async fn bind_unbound(hub: &Hub, caller: &Caller, node: &dyn NodeGit) -> Result<(), StoreError> {
    let mut unbound = Vec::new();
    for summary in hub.store.projects_list(None, None)? {
        let r = ProjectRef {
            machine_id: summary.machine_id,
            project_id: summary.project_id,
        };
        if readable(caller, &r.machine_id) && hub.work.scope_of(&r)?.is_none() {
            unbound.push((r, summary.workspace_root));
        }
    }
    let binds = futures_util::future::join_all(
        unbound
            .iter()
            .map(|(r, root)| bind::bind_with(hub, node, r, root)),
    );
    if let Ok(results) = tokio::time::timeout(BIND_WAIT, binds).await {
        for result in results {
            result?;
        }
    }
    Ok(())
}

fn repo_bound(hub: &Hub, repo_key: &RepoKey) -> Result<bool, StoreError> {
    Ok(!hub
        .db
        .with(|c| Ok(store::bases_of(c, repo_key)?))?
        .is_empty())
}

/// The scope a call names: its repo (any remote form), else its project's. The base is the one given, else the
/// project's, else that of a project on the repo, else "main". A repo no project is bound to has the caller's unbound
/// projects read first; when still none is, the answer's warning says the agents' work may be missing.
async fn scope_for(
    hub: &Hub,
    caller: &Caller,
    node: &dyn NodeGit,
    repo: Option<&Line<1, 500>>,
    project: Option<&ProjectRef>,
    base: Option<&BranchName>,
) -> Result<(WorkScope, Option<String>), ToolError> {
    let bound = match project {
        Some(r) => {
            require(caller, Role::Read, Some(&r.machine_id))?;
            let Some(summary) = hub.store.project_get(r)? else {
                return Err(unknown_project(r));
            };
            match hub.work.scope_of(r)? {
                Some(scope) => Some(scope),
                None => bind::bind_with(hub, node, r, &summary.workspace_root).await?,
            }
        }
        None => None,
    };
    let repo_key = match repo {
        Some(remote) => RepoKey::of(remote.as_str()).ok_or_else(|| {
            error(
                ErrorCode::Invalid,
                format!("'{remote}' is not a git remote."),
                "Pass the repo's origin URL: git remote get-url origin.",
            )
        })?,
        None => match &bound {
            Some(scope) => scope.repo_key.clone(),
            None => {
                let r = project.expect("repo or projectRef, as the input checks");
                return Err(error(
                    ErrorCode::Invalid,
                    format!("{}/{} has no repo bound yet.", r.machine_id, r.project_id),
                    "Pass repo (its origin URL) instead.",
                ));
            }
        },
    };
    let mut warning = None;
    if !repo_bound(hub, &repo_key)? {
        bind_unbound(hub, caller, node).await?;
        if !repo_bound(hub, &repo_key)? {
            warning = Some(format!(
                "no project bound to {repo_key} yet; agents' work may be missing"
            ));
        }
    }
    let base = match base {
        Some(base) => base.clone(),
        None => match bound.filter(|b| b.repo_key == repo_key) {
            Some(scope) => scope.base,
            None => hub
                .db
                .with(|c| Ok(store::bases_of(c, &repo_key)?))?
                .into_iter()
                .find_map(|b| Line::new(b).ok())
                .unwrap_or_else(|| Line::unchecked(DEFAULT_BASE)),
        },
    };
    Ok((WorkScope { repo_key, base }, warning))
}

/// A person's own session only with a human key. Any other key may be a fleetd agent that loaded the person's MCP
/// config, so its claims are an agent key's, and it never claims taken work.
fn owner_of(caller: &Caller) -> ClaimOwner {
    ClaimOwner {
        kind: if is_human(caller) {
            ClaimOwnerKind::HumanSession
        } else {
            ClaimOwnerKind::AgentKey
        },
        key_id: Line::new(caller.key_id.as_str()).unwrap_or_else(|_| {
            Line::unchecked(caller.key_id.as_str().chars().take(200).collect::<String>())
        }),
        label: Line::new(caller.name.chars().take(120).collect::<String>()).ok(),
    }
}

/// Items on machines the key can't read are left out of what it is shown.
fn visible(caller: &Caller, item: &WorkItem) -> bool {
    item.project_ref
        .as_ref()
        .is_none_or(|r| readable(caller, &r.machine_id))
}

fn is_mine(caller: &Caller, item: &WorkItem) -> bool {
    item.owner
        .as_ref()
        .is_some_and(|o| o.key_id.as_str() == caller.key_id.as_str())
}

/// "T12 (an agent of devbox/shop): dark mode toggle".
pub fn describe(item: &WorkItem) -> String {
    let project = item
        .project_ref
        .as_ref()
        .map(|r| format!("{}/{}", r.machine_id, r.project_id));
    let who = match (item.kind, &item.owner) {
        (WorkItemKind::Task, _) => format!("an agent of {}", project.unwrap_or_default()),
        (WorkItemKind::Change, _) => {
            format!("a PR on {}'s merge train", project.unwrap_or_default())
        }
        (WorkItemKind::Claim, Some(owner)) => {
            let name = owner
                .label
                .as_ref()
                .map_or(owner.key_id.as_str(), |l| l.as_str());
            match owner.kind {
                ClaimOwnerKind::HumanSession => format!("{name}'s session"),
                ClaimOwnerKind::AgentKey => format!("a session on key {name}"),
                ClaimOwnerKind::Lead => format!("the lead of {name}"),
            }
        }
        (WorkItemKind::Claim, None) => "a claim".into(),
        (WorkItemKind::Pr, _) => "an open PR".into(),
    };
    let state = if item.state.as_str() == "expired" {
        ", expired"
    } else {
        ""
    };
    format!("{} ({who}{state}): {}", item.id, item.title)
}

/// What the claim is, as the matcher reads it: its title's own keys and paths, and the ones declared.
fn intent_of(owner: &ClaimOwner, input: &WorkClaimInput, scope: &WorkScope) -> matcher::Work {
    let mscope = matcher_scope(scope);
    let mut intent = matcher::Work::read(
        Some(owner.key_id.as_str().to_owned()),
        input.title.as_str(),
        "",
        &mscope,
    );
    let declared = input
        .keys
        .iter()
        .flat_map(|k| k.iter().cloned())
        .chain(input.branch.clone().map(WorkKey::Branch));
    for key in declared.flat_map(|k| matcher_keys(&k, &mscope)) {
        if !intent.keys.iter().any(|k| k.key == key) {
            intent.keys.push(Key::declared(key));
        }
    }
    let paths = input.paths.iter().flat_map(|p| p.iter());
    let changed = input.changed.iter().flat_map(|p| p.iter());
    intent
        .paths
        .extend(paths.chain(changed).map(|p| p.as_str().to_owned()));
    intent
}

fn observed_of(input: &WorkClaimInput, now: i64) -> Option<ClaimObserved> {
    input.changed.as_ref().map(|paths| ClaimObserved {
        paths: paths.clone(),
        head_sha: input.head_sha.clone(),
        at: Timestamp(iso_ms(now)),
    })
}

impl Work {
    /// The owner's active claim in the scope on the same branch (or, with no branch, the same title).
    fn own_claim(
        &self,
        scope: &WorkScope,
        owner: &ClaimOwner,
        branch: Option<&BranchName>,
        title: &str,
    ) -> Result<Option<Claim>, StoreError> {
        let claims = self.db.with(|c| Ok(store::in_scope(c, scope, i64::MAX)?))?;
        Ok(claims.into_iter().find(|c| {
            c.state == ClaimState::Active
                && c.owner.key_id == owner.key_id
                && match branch {
                    Some(b) => c.branch.as_ref() == Some(b),
                    None => c.branch.is_none() && c.title.as_str().eq_ignore_ascii_case(title),
                }
        }))
    }

    /// Renews the claim and replaces what it says with `new`'s; the observed paths only when given.
    fn revise(
        &self,
        claim_id: &fleetd_contracts::work::ClaimId,
        new: NewClaim,
        observed: Option<ClaimObserved>,
    ) -> Result<Option<Claim>, StoreError> {
        let Some(_) = self.renew(claim_id, observed)? else {
            return Ok(None);
        };
        self.db.transaction(|c| {
            let Some(mut claim) = store::get(c, claim_id)? else {
                return Ok(None);
            };
            claim.title = new.title;
            claim.keys = new.keys;
            claim.paths = new.paths;
            if new.author_email.is_some() {
                claim.author_email = new.author_email;
            }
            if new.project_ref.is_some() {
                claim.project_ref = new.project_ref;
            }
            store::put(c, &claim)?;
            Ok(Some(claim))
        })
    }
}

/// `items` with its claims replaced by `claims`, as read where the claim is saved.
fn with_claims(items: &[WorkItem], claims: Vec<Claim>) -> Vec<WorkItem> {
    let mut out: Vec<WorkItem> = items
        .iter()
        .filter(|i| i.kind != WorkItemKind::Claim)
        .cloned()
        .collect();
    out.extend(super::view::items(&super::view::Sources {
        claims,
        ..Default::default()
    }));
    out
}

async fn work_claim(
    hub: Arc<Hub>,
    caller: Caller,
    input: WorkClaimInput,
) -> Result<WorkClaimOutput, ToolError> {
    claim_on(&hub, &caller, &input, hub.node_commands.as_ref()).await
}

/// work_claim, reading unbound projects through `node`.
pub(super) async fn claim_on(
    hub: &Hub,
    caller: &Caller,
    input: &WorkClaimInput,
    node: &dyn NodeGit,
) -> Result<WorkClaimOutput, ToolError> {
    if let Some(r) = &input.project_ref {
        require(caller, Role::Operate, Some(&r.machine_id))?;
    }
    let (scope, warning) = scope_for(
        hub,
        caller,
        node,
        input.repo.as_ref(),
        input.project_ref.as_ref(),
        input.base.as_ref(),
    )
    .await?;
    // Reading the view asks each writer's node for its paths, which takes a while; `settle` reads the claims again
    // where it saves the claim.
    let items = hub.work.in_flight(&scope).await?;
    let mut out = settle(hub, caller, input, &scope, &items)?;
    out.warning = warning;
    Ok(out)
}

/// What `matches` say about the claim: go ahead, with a note for `work.claimed` when it overrides one; or the answer
/// that refuses it.
fn decide(
    caller: &Caller,
    person: bool,
    input: &WorkClaimInput,
    found: &[WorkMatch],
) -> Result<Option<String>, Box<WorkClaimOutput>> {
    let others: Vec<&WorkMatch> = found.iter().filter(|m| !is_mine(caller, &m.item)).collect();
    let name_of = |m: &WorkMatch| {
        if visible(caller, &m.item) {
            describe(&m.item)
        } else {
            format!("{} (on a machine this key can't read)", m.item.id)
        }
    };
    let refuse =
        |status, message: String, next: String| answer(caller, found, status, None, message, next);
    if let Some(exact) = others.iter().find(|m| m.strength == MatchStrength::Exact) {
        let held = name_of(exact);
        if person && input.anyway == Some(true) {
            return Ok(Some(format!(
                "anyway, though {} holds it: {}",
                exact.item.id, exact.why
            )));
        }
        let next = if person {
            format!(
                "Tell the user before going on: {held}. To claim it anyway, call again with anyway: true."
            )
        } else {
            format!(
                "Tell the user before going on: {held}. Only a person can claim taken work, with a human key: \
                 `fleetd work claim --anyway`."
            )
        };
        return Err(Box::new(refuse(
            WorkClaimStatus::Taken,
            format!("taken by {held} ({})", exact.why),
            next,
        )));
    }
    let acknowledged = input.not_duplicate_of.as_ref();
    let unacknowledged: Vec<&&WorkMatch> = others
        .iter()
        .filter(|m| m.strength == MatchStrength::Strong)
        .filter(|m| {
            !acknowledged.is_some_and(|ids| ids.iter().any(|id| id.as_str() == m.item.id.as_str()))
        })
        .collect();
    if let Some(first) = unacknowledged.first() {
        let ids: Vec<String> = unacknowledged
            .iter()
            .map(|m| format!("\"{}\"", m.item.id))
            .collect();
        return Err(Box::new(refuse(
            WorkClaimStatus::PossibleDuplicate,
            format!("may repeat {} ({})", name_of(first), first.why),
            format!(
                "Tell the user before going on. If it is different work, call again with notDuplicateOf: [{}] and notDuplicateWhy.",
                ids.join(", ")
            ),
        )));
    }
    Ok(match (acknowledged, input.not_duplicate_why.as_ref()) {
        (Some(ids), Some(why)) => {
            let ids: Vec<&str> = ids.iter().map(|i| i.as_str()).collect();
            Some(format!("not a duplicate of {}: {why}", ids.join(", ")))
        }
        _ => None,
    })
}

/// The answer, with the matches the caller may see (not its own), strongest first.
fn answer(
    caller: &Caller,
    found: &[WorkMatch],
    status: WorkClaimStatus,
    claim: Option<Claim>,
    message: String,
    next: String,
) -> WorkClaimOutput {
    let shown: Vec<WorkMatch> = found
        .iter()
        .filter(|m| visible(caller, &m.item) && !is_mine(caller, &m.item))
        .cloned()
        .collect();
    let matches = cap(shown, MATCHES_MAX);
    WorkClaimOutput {
        status,
        claim,
        matches: List::unchecked(matches.items),
        message,
        warning: None,
        next: Some(next),
        truncated: matches.truncated,
    }
}

/// Decides the claim against the work in flight (`items`, read before) and saves it. The claims are read again in
/// the transaction that saves it, and the decision is made again on them, so two claims made at once can't both
/// pass.
pub(super) fn settle(
    hub: &Hub,
    caller: &Caller,
    input: &WorkClaimInput,
    scope: &WorkScope,
    items: &[WorkItem],
) -> Result<WorkClaimOutput, ToolError> {
    let owner = owner_of(caller);
    let person = owner.kind == ClaimOwnerKind::HumanSession;
    let work = &hub.work;
    let intent = intent_of(&owner, input, scope);
    let now = crate::hub::store::now_ms(hub.clock.as_ref());
    let new = NewClaim {
        scope: scope.clone(),
        project_ref: input.project_ref.clone(),
        owner: owner.clone(),
        title: input.title.clone(),
        keys: input.keys.clone().unwrap_or_default(),
        branch: input.branch.clone(),
        paths: input.paths.clone().unwrap_or_default(),
        author_email: input.author_email.clone(),
    };
    let found = matches_in(items, &intent, scope);
    let next_done =
        |id: &ClaimId| format!("Call work_done with claimId {id} when it lands or you drop it.");

    // A fleetd agent on its own task's branch: the task is the claim, so there is nothing to add or refuse.
    if !person
        && let Some(branch) = &input.branch
        && let Some(task) = items.iter().find(|i| {
            matches!(i.kind, WorkItemKind::Task | WorkItemKind::Change)
                && i.keys.contains(&WorkKey::Branch(branch.clone()))
        })
    {
        let id = task
            .task_id
            .as_ref()
            .map_or(task.id.as_str(), |t| t.as_str());
        let found: Vec<WorkMatch> = found.into_iter().filter(|m| m.item.id != task.id).collect();
        return Ok(answer(
            caller,
            &found,
            WorkClaimStatus::Yours,
            None,
            format!("yours (task {id})"),
            format!(
                "Nothing to claim: fleetd tracks {branch} as task {id}. Go on with it; work_claim is for work fleetd \
                 doesn't track yet."
            ),
        ));
    }

    // The caller's own claim on this branch is the same work: renewed and updated, never claimed twice. Keys and paths
    // the renewal adds are checked as a new claim's would be: adding an issue someone else holds is taken.
    if let Some(own) = work.own_claim(scope, &owner, input.branch.as_ref(), input.title.as_str())? {
        let added_keys: Vec<WorkKey> = new
            .keys
            .iter()
            .filter(|k| !own.keys.contains(k))
            .cloned()
            .collect();
        let added_paths: Vec<String> = new
            .paths
            .iter()
            .filter(|p| !own.paths.contains(p))
            .map(|p| p.as_str().to_owned())
            .collect();
        if !added_keys.is_empty() || !added_paths.is_empty() {
            let mscope = matcher_scope(scope);
            let added = matcher::Work {
                owner: Some(owner.key_id.as_str().to_owned()),
                title: String::new(),
                keys: added_keys
                    .iter()
                    .flat_map(|k| matcher_keys(k, &mscope))
                    .map(Key::declared)
                    .collect(),
                paths: added_paths,
            };
            let found = matches_in(items, &added, scope);
            if let Err(refused) = decide(caller, person, input, &found) {
                return Ok(*refused);
            }
        }
        let claim = work
            .revise(&own.claim_id, new, observed_of(input, now))?
            .unwrap_or(own);
        let id = claim.claim_id.clone();
        return Ok(answer(
            caller,
            &found,
            WorkClaimStatus::Renewed,
            Some(claim),
            format!("renewed {id}"),
            next_done(&id),
        ));
    }
    if let Err(refused) = decide(caller, person, input, &found) {
        return Ok(*refused);
    }
    let saved = work.claim_if(
        new,
        observed_of(input, now),
        |claims| -> Result<_, Box<WorkClaimOutput>> {
            let found = matches_in(&with_claims(items, claims), &intent, scope);
            let note = decide(caller, person, input, &found)?;
            Ok((note.clone(), (note, found)))
        },
    )?;
    let (claim, (note, found)) = match saved {
        Ok(saved) => saved,
        Err(refused) => return Ok(*refused),
    };
    let id = claim.claim_id.clone();
    let message = match &note {
        Some(note) => format!("claimed {id} ({note})"),
        None => format!("claimed {id}"),
    };
    Ok(answer(
        caller,
        &found,
        WorkClaimStatus::Claimed,
        Some(claim),
        message,
        next_done(&id),
    ))
}

async fn work_list(
    hub: Arc<Hub>,
    caller: Caller,
    input: WorkListInput,
) -> Result<WorkListOutput, ToolError> {
    list_on(&hub, &caller, &input, hub.node_commands.as_ref()).await
}

/// work_list, reading unbound projects through `node`.
pub(super) async fn list_on(
    hub: &Hub,
    caller: &Caller,
    input: &WorkListInput,
    node: &dyn NodeGit,
) -> Result<WorkListOutput, ToolError> {
    let (scope, warning) = scope_for(
        hub,
        caller,
        node,
        input.repo.as_ref(),
        input.project_ref.as_ref(),
        input.base.as_ref(),
    )
    .await?;
    let items: Vec<WorkItem> = hub
        .work
        .in_flight(&scope)
        .await?
        .into_iter()
        .filter(|i| visible(caller, i))
        .collect();
    let next = if items.is_empty() {
        "Nothing is in flight here. Before a code change, call work_claim with a one-line title."
    } else {
        "Before a code change, call work_claim: it checks against these and claims in one call."
    };
    let items = cap(items, ITEMS_MAX);
    Ok(WorkListOutput {
        scope,
        items: List::unchecked(items.items),
        warning,
        next: Some(next.into()),
        truncated: items.truncated,
    })
}

async fn work_done(
    hub: Arc<Hub>,
    caller: Caller,
    input: WorkDoneInput,
) -> Result<WorkDoneOutput, ToolError> {
    let id = &input.claim_id;
    let not_found = || {
        error(
            ErrorCode::NotFound,
            format!("There is no claim {id}."),
            "work_list lists the claims in flight.",
        )
    };
    let claim = hub.work.get(id)?.ok_or_else(not_found)?;
    if let Some(r) = &claim.project_ref
        && !readable(&caller, &r.machine_id)
    {
        return Err(not_found());
    }
    if claim.owner.key_id.as_str() != caller.key_id.as_str() && !is_human(&caller) {
        return Err(error(
            ErrorCode::Forbidden,
            format!("{id} is held by another key."),
            "Only its owner, or a person's human key, can end it.",
        ));
    }
    if claim.state != ClaimState::Active {
        return Err(error(
            ErrorCode::Invalid,
            format!("{id} has already ended: {}.", store::state_str(claim.state)),
            "Nothing to do; work_claim makes a new one.",
        ));
    }
    let (ending, said) = match input.outcome {
        WorkDoneOutcome::Landed => (Ending::Landed, "landed"),
        WorkDoneOutcome::Dropped => (Ending::Released, "dropped"),
    };
    let reason = input
        .reason
        .as_ref()
        .map_or_else(|| format!("{said} (work_done)"), |r| r.as_str().to_owned());
    let ended = hub
        .work
        .end(id, ending, &reason, input.landing.clone())?
        .ok_or_else(|| {
            error(
                ErrorCode::Invalid,
                format!("{id} has already ended."),
                "Nothing to do; work_claim makes a new one.",
            )
        })?;
    Ok(WorkDoneOutput {
        claim: ended,
        next: None,
        truncated: None,
    })
}
