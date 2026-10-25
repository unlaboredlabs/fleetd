//! The work ledger: one view of the work in flight on a repo's base branch, across every project on that repo, so
//! nothing is built twice. Tasks and Changes stay their own source of truth; this area adds claims (intent fleetd
//! can't otherwise see, such as a human's own session) and the repo and base each project's work lands on.
//! (`hub/ledger` is the decision log, a different thing.)
//!
//! A claim lasts `CLAIM_TTL_MS` from its last renewal; the sweep expires it, and the view keeps an expired claim,
//! as weak, for `EXPIRED_SHOWN_MS`.
pub mod bind;
pub mod check;
pub mod matcher;
pub mod store;
pub mod tools;
pub mod view;

pub use bind::bind_from_root;

#[cfg(test)]
mod matcher_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod tools_tests;

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{ProjectRef, ThreadRef, Timestamp};
use fleetd_contracts::prim::{Line, List};
use fleetd_contracts::tasks::{TaskId, TaskKind};
use fleetd_contracts::train::Change;
use fleetd_contracts::verification::CommitSha;
use fleetd_contracts::work::{
    BranchName, CLAIM_KEYS_MAX, CLAIM_PATHS_MAX, CLAIM_TTL_MS, Claim, ClaimEnd, ClaimId,
    ClaimObserved, ClaimOwner, ClaimState, EXPIRED_SHOWN_MS, MatchStrength, RepoKey, WorkEventData,
    WorkItem, WorkKey, WorkMatch, WorkPath, WorkScope,
};

use crate::clock::Clock;
use crate::hub::api::Hub;
use crate::hub::store::{EventLog, HubDb, NewEvent, StoreError, iso_ms, now_ms, parse_ms};
use crate::hub::sweep::SweepCheck;
use crate::hub::tasks::records::TaskRecords;
use crate::hub::train::records::{ChangeRecords, ListFilter};

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Tasks and Changes read per project for the view.
const PROJECT_ROWS: usize = 200;

/// What the view asks the nodes: `serve` wires it to the tasks' ports, tests to a fake.
pub trait WorkPorts: Send + Sync {
    /// The paths a thread's worktree has changed so far; `None` when its node could not say.
    fn changed_paths<'a>(&'a self, thread: &'a ThreadRef) -> BoxFut<'a, Option<Vec<String>>>;
}

/// The tasks' own ports: a writer's changed paths are what `also_writing` reads.
pub struct TaskPaths(pub Arc<dyn crate::hub::tasks::ports::TaskPorts>);

impl WorkPorts for TaskPaths {
    fn changed_paths<'a>(&'a self, thread: &'a ThreadRef) -> BoxFut<'a, Option<Vec<String>>> {
        Box::pin(async move { self.0.changes(thread).await.map(|c| c.paths) })
    }
}

/// Ports for a `Work` that never reads the view, such as the CLI's releasing a revoked key's claims.
pub struct NoPorts;

impl WorkPorts for NoPorts {
    fn changed_paths<'a>(&'a self, _thread: &'a ThreadRef) -> BoxFut<'a, Option<Vec<String>>> {
        Box::pin(async { None })
    }
}

/// The scope's writers' changed paths, by task, and the writers whose node didn't say (or not in time).
#[derive(Clone, Debug, Default)]
pub struct Observed {
    pub paths: HashMap<TaskId, Vec<String>>,
    pub unknown: HashSet<TaskId>,
}

/// A claim as asked for; the hub numbers it and sets its state and times.
#[derive(Clone, Debug)]
pub struct NewClaim {
    pub scope: WorkScope,
    pub project_ref: Option<ProjectRef>,
    pub owner: ClaimOwner,
    pub title: Line<1, 120>,
    pub keys: List<WorkKey, 0, CLAIM_KEYS_MAX>,
    pub branch: Option<BranchName>,
    pub paths: List<WorkPath, 0, CLAIM_PATHS_MAX>,
    pub author_email: Option<Line<1, 200>>,
}

/// How a claim ends, other than expiring.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ending {
    Landed,
    Released,
}

pub struct Work {
    db: Arc<HubDb>,
    events: Arc<EventLog>,
    clock: Arc<dyn Clock>,
    ports: Arc<dyn WorkPorts>,
}

impl Work {
    pub fn new(
        db: Arc<HubDb>,
        events: Arc<EventLog>,
        clock: Arc<dyn Clock>,
        ports: Arc<dyn WorkPorts>,
    ) -> Arc<Self> {
        Arc::new(Self {
            db,
            events,
            clock,
            ports,
        })
    }

    fn now(&self) -> i64 {
        now_ms(self.clock.as_ref())
    }

    /// Records the repo and base the project's work lands on, so its tasks and Changes are in that scope's view.
    pub fn bind_project(&self, project: &ProjectRef, scope: &WorkScope) -> Result<(), StoreError> {
        let now = self.now();
        self.db.with(|c| Ok(store::bind(c, project, scope, now)?))
    }

    pub fn scope_of(&self, project: &ProjectRef) -> Result<Option<WorkScope>, StoreError> {
        self.db.with(|c| Ok(store::scope_of(c, project)?))
    }

    pub fn get(&self, claim_id: &ClaimId) -> Result<Option<Claim>, StoreError> {
        self.db.with(|c| Ok(store::get(c, claim_id)?))
    }

    /// Stores an active claim, good for `CLAIM_TTL_MS`, and announces it (`work.claimed`).
    pub fn claim(&self, new: NewClaim) -> Result<Claim, StoreError> {
        self.claim_noted(new, None)
    }

    /// `claim`, with a note in its `work.claimed` summary: why it went ahead despite a match.
    pub fn claim_noted(&self, new: NewClaim, note: Option<&str>) -> Result<Claim, StoreError> {
        let note = note.map(str::to_owned);
        match self.claim_if(new, None, |_| Ok::<_, std::convert::Infallible>((note, ())))? {
            Ok((claim, ())) => Ok(claim),
            Err(never) => match never {},
        }
    }

    /// Stores an active claim, with what its branch changed when given, only if `check` passes on the scope's claims
    /// (active ones, and those expired in the last `EXPIRED_SHOWN_MS`) as read in the same transaction. So two claims
    /// made at once can't both pass a check that each would fail against the other. `check` returns the note for
    /// `work.claimed`, or why the claim is refused.
    pub fn claim_if<T, R>(
        &self,
        new: NewClaim,
        observed: Option<ClaimObserved>,
        check: impl FnOnce(Vec<Claim>) -> Result<(Option<String>, T), R>,
    ) -> Result<Result<(Claim, T), R>, StoreError> {
        let now = self.now();
        let at = Timestamp(iso_ms(now));
        let claim = Claim {
            claim_id: ClaimId::unchecked("C0"),
            repo_key: new.scope.repo_key,
            base: new.scope.base,
            project_ref: new.project_ref,
            owner: new.owner,
            title: new.title,
            keys: new.keys,
            branch: new.branch,
            paths: new.paths,
            observed,
            author_email: new.author_email,
            state: ClaimState::Active,
            end: None,
            created_at: at.clone(),
            renewed_at: at,
            expires_at: Timestamp(iso_ms(now + CLAIM_TTL_MS)),
        };
        let scope = WorkScope {
            repo_key: claim.repo_key.clone(),
            base: claim.base.clone(),
        };
        let saved = self.db.transaction(|c| {
            let claims = store::in_scope(c, &scope, now - EXPIRED_SHOWN_MS)?;
            Ok(match check(claims) {
                Ok((note, out)) => Ok((store::insert(c, claim)?, note, out)),
                Err(refused) => Err(refused),
            })
        })?;
        let (claim, note, out) = match saved {
            Ok(saved) => saved,
            Err(refused) => return Ok(Err(refused)),
        };
        let note = note.map(|n| format!(" ({n})")).unwrap_or_default();
        self.announce(
            &claim,
            format!("{} claimed: {}{note}", claim.claim_id, claim.title),
        )?;
        Ok(Ok((claim, out)))
    }

    /// Extends an active or expired claim by `CLAIM_TTL_MS` from now, with what its branch changed when given. An
    /// expired claim is active again (its work is clearly going on), unless it has dropped out of the view and
    /// someone else has taken the same work since: then it is released, saying who. `None` for that, and for an
    /// unknown, landed or released one.
    pub fn renew(
        &self,
        claim_id: &ClaimId,
        observed: Option<ClaimObserved>,
    ) -> Result<Option<Claim>, StoreError> {
        let now = self.now();
        if let Some(claim) = self.get(claim_id)?
            && let Some(taker) = self.taken_since(&claim, now)?
        {
            let reason = format!("{taker} took the same work after this claim expired");
            let released = self.db.transaction(|c| {
                let Some(claim) =
                    store::get(c, claim_id)?.filter(|c| c.state == ClaimState::Expired)
                else {
                    return Ok(None);
                };
                let claim = ended(claim, ClaimState::Released, now, &reason, None);
                store::put(c, &claim)?;
                Ok(Some(claim))
            })?;
            if let Some(claim) = &released {
                self.announce_end(claim)?;
            }
            return Ok(None);
        }
        let renewed = self.db.transaction(|c| {
            let Some(mut claim) = store::get(c, claim_id)? else {
                return Ok(None);
            };
            if !matches!(claim.state, ClaimState::Active | ClaimState::Expired) {
                return Ok(None);
            }
            let revived = claim.state == ClaimState::Expired;
            claim.state = ClaimState::Active;
            claim.end = None;
            claim.renewed_at = Timestamp(iso_ms(now));
            claim.expires_at = Timestamp(iso_ms(now + CLAIM_TTL_MS));
            if observed.is_some() {
                claim.observed = observed;
            }
            store::put(c, &claim)?;
            Ok(Some((claim, revived)))
        })?;
        let Some((claim, revived)) = renewed else {
            return Ok(None);
        };
        if revived {
            self.announce(
                &claim,
                format!("{} is active again: {}", claim.claim_id, claim.title),
            )?;
        }
        Ok(Some(claim))
    }

    /// For an expired claim no longer in the view (`EXPIRED_SHOWN_MS`): the id of work in flight that is newer than
    /// its expiry, held by someone else, and shares one of its exact keys.
    fn taken_since(&self, claim: &Claim, now: i64) -> Result<Option<String>, StoreError> {
        let Some(end) = claim
            .end
            .as_ref()
            .filter(|_| claim.state == ClaimState::Expired)
        else {
            return Ok(None);
        };
        if parse_ms(end.at.as_str()).is_some_and(|at| at > now - EXPIRED_SHOWN_MS) {
            return Ok(None);
        }
        let scope = WorkScope {
            repo_key: claim.repo_key.clone(),
            base: claim.base.clone(),
        };
        // Timestamps are all the hub's own ISO form, so they compare as text.
        let items: Vec<WorkItem> = view::items(&self.sources(&scope)?)
            .into_iter()
            .filter(|i| i.since.as_str() > end.at.as_str())
            .filter(|i| i.claim_id.as_ref() != Some(&claim.claim_id))
            .collect();
        let ms = check::matcher_scope(&scope);
        let mut intent = matcher::Work::read(
            Some(claim.owner.key_id.as_str().to_owned()),
            claim.title.as_str(),
            "",
            &ms,
        );
        let declared = claim
            .keys
            .iter()
            .cloned()
            .chain(claim.branch.clone().map(WorkKey::Branch))
            .flat_map(|k| check::matcher_keys(&k, &ms));
        for key in declared {
            if !intent.keys.iter().any(|k| k.key == key) {
                intent.keys.push(matcher::Key::declared(key));
            }
        }
        Ok(check::matches_in(&items, &intent, &scope)
            .into_iter()
            .find(|m| m.strength == MatchStrength::Exact)
            .map(|m| m.item.id.as_str().to_owned()))
    }

    /// Ends an active claim as landed or released, and announces it (`work.ended`). `None` when it is unknown or
    /// not active.
    pub fn end(
        &self,
        claim_id: &ClaimId,
        ending: Ending,
        reason: &str,
        landing: Option<CommitSha>,
    ) -> Result<Option<Claim>, StoreError> {
        let state = match ending {
            Ending::Landed => ClaimState::Landed,
            Ending::Released => ClaimState::Released,
        };
        let now = self.now();
        let ended = self.db.transaction(|c| {
            let Some(claim) = store::get(c, claim_id)? else {
                return Ok(None);
            };
            if claim.state != ClaimState::Active {
                return Ok(None);
            }
            let claim = ended(claim, state, now, reason, landing);
            store::put(c, &claim)?;
            Ok(Some(claim))
        })?;
        if let Some(claim) = &ended {
            self.announce_end(claim)?;
        }
        Ok(ended)
    }

    /// Releases every active claim the owner key holds: what happens when the key is revoked.
    pub fn release_owner(&self, key_id: &str, reason: &str) -> Result<Vec<Claim>, StoreError> {
        let now = self.now();
        let released = self.db.transaction(|c| {
            let mut out = Vec::new();
            for claim in store::active_of_owner(c, key_id)? {
                let claim = ended(claim, ClaimState::Released, now, reason, None);
                store::put(c, &claim)?;
                out.push(claim);
            }
            Ok(out)
        })?;
        for claim in &released {
            self.announce_end(claim)?;
        }
        Ok(released)
    }

    /// Expires every active claim not renewed in time; the sweep's check. Returns how many.
    pub fn expire_due(&self) -> Result<usize, StoreError> {
        let now = self.now();
        let expired = self.db.transaction(|c| {
            let mut out = Vec::new();
            for claim in store::due(c, now)? {
                let reason = format!("not renewed for {} h", CLAIM_TTL_MS / 3_600_000);
                let claim = ended(claim, ClaimState::Expired, now, &reason, None);
                store::put(c, &claim)?;
                out.push(claim);
            }
            Ok(out)
        })?;
        for claim in &expired {
            self.announce_end(claim)?;
        }
        Ok(expired.len())
    }

    /// The work in flight on the scope: live write tasks and Changes of every project bound to it, and its claims
    /// (expired ones for `EXPIRED_SHOWN_MS`, last). Each writer's changed paths are asked of its node.
    pub async fn in_flight(&self, scope: &WorkScope) -> Result<Vec<WorkItem>, StoreError> {
        let observed = self.observe(scope, None).await?;
        self.in_flight_observed(scope, &observed.paths)
    }

    /// What each of the scope's writers has changed so far, asked of their nodes at once. With `timeout`, a node
    /// that hasn't answered by then is not waited on: its writers are `unknown`, like those whose node couldn't say.
    pub async fn observe(
        &self,
        scope: &WorkScope,
        timeout: Option<Duration>,
    ) -> Result<Observed, StoreError> {
        let sources = self.sources(scope)?;
        let threads: Vec<(TaskId, ThreadRef)> = sources
            .tasks
            .iter()
            .chain(&sources.change_tasks)
            .filter(|t| t.kind == TaskKind::Write)
            .filter_map(|t| Some((t.task_id.clone(), t.thread_ref.clone()?)))
            .collect();
        let paths = futures_util::future::join_all(threads.iter().map(|(_, thread)| async move {
            let asked = self.ports.changed_paths(thread);
            match timeout {
                Some(t) => tokio::time::timeout(t, asked).await.ok().flatten(),
                None => asked.await,
            }
        }))
        .await;
        let mut observed = Observed::default();
        for ((task_id, _), paths) in threads.into_iter().zip(paths) {
            match paths {
                Some(paths) => {
                    observed.paths.insert(task_id, paths);
                }
                None => {
                    observed.unknown.insert(task_id);
                }
            }
        }
        Ok(observed)
    }

    /// `in_flight` with the writers' changed paths already gathered (`observe`): reads the store only, asks no node.
    pub fn in_flight_observed(
        &self,
        scope: &WorkScope,
        paths: &HashMap<TaskId, Vec<String>>,
    ) -> Result<Vec<WorkItem>, StoreError> {
        let mut sources = self.sources(scope)?;
        sources.observed = paths.clone();
        Ok(view::items(&sources))
    }

    /// `check` with the writers' changed paths already gathered: reads the store only, asks no node.
    pub fn check_observed(
        &self,
        scope: &WorkScope,
        intent: &matcher::Work,
        paths: &HashMap<TaskId, Vec<String>>,
    ) -> Result<Vec<WorkMatch>, StoreError> {
        Ok(check::matches_in(
            &self.in_flight_observed(scope, paths)?,
            intent,
            scope,
        ))
    }

    fn sources(&self, scope: &WorkScope) -> Result<view::Sources, StoreError> {
        let since = self.now() - EXPIRED_SHOWN_MS;
        let (projects, claims, tasks) = self.db.with(|c| {
            let projects = store::projects_in(c, scope)?;
            let mut tasks = Vec::new();
            for project in &projects {
                tasks.extend(TaskRecords::live(c, project, PROJECT_ROWS)?);
            }
            Ok((projects, store::in_scope(c, scope, since)?, tasks))
        })?;
        // `ChangeRecords` takes the database's lock itself, so it is read outside the one above.
        let records = ChangeRecords::new(self.db.clone());
        let changes: Vec<Change> = projects
            .iter()
            .flat_map(|project| {
                records.list(&ListFilter {
                    project_ref: Some(project.clone()),
                    limit: PROJECT_ROWS as i64,
                    ..Default::default()
                })
            })
            .filter(|c| on_repo(&scope.repo_key, &c.repo))
            .filter(|c| !view::ENDED_CHANGE_STATES.contains(&c.state))
            .collect();
        let known: HashSet<&TaskId> = tasks.iter().map(|t| &t.task_id).collect();
        let missing: Vec<TaskId> = changes
            .iter()
            .filter_map(|c| c.task_id.clone())
            .filter(|t| !known.contains(t))
            .collect();
        let change_tasks = self.db.with(|c| {
            let mut out = Vec::new();
            for task_id in &missing {
                out.extend(TaskRecords::get(c, task_id)?.map(|s| s.task));
            }
            Ok(out)
        })?;
        Ok(view::Sources {
            tasks,
            changes,
            change_tasks,
            claims,
            observed: HashMap::new(),
        })
    }

    fn announce(&self, claim: &Claim, summary: String) -> Result<(), StoreError> {
        self.emit(HubEventType::WorkClaimed, claim, summary)
    }

    fn announce_end(&self, claim: &Claim) -> Result<(), StoreError> {
        let how = match claim.state {
            ClaimState::Landed => "landed",
            ClaimState::Released => "was released",
            ClaimState::Expired => "expired",
            ClaimState::Active => "is active",
        };
        self.emit(
            HubEventType::WorkEnded,
            claim,
            format!("{} {how}: {}", claim.claim_id, claim.title),
        )
    }

    fn emit(&self, kind: HubEventType, claim: &Claim, summary: String) -> Result<(), StoreError> {
        let data = WorkEventData {
            claim_id: claim.claim_id.clone(),
            repo_key: claim.repo_key.clone(),
            base: claim.base.clone(),
            project_ref: claim.project_ref.clone(),
            owner_kind: claim.owner.kind,
            state: claim.state,
            reason: claim.end.as_ref().map(|e| e.reason.as_str().to_owned()),
            landing: claim.end.as_ref().and_then(|e| e.landing.clone()),
        };
        self.events.append(NewEvent {
            at: Timestamp(iso_ms(self.now())),
            r#type: kind,
            machine_id: claim.project_ref.as_ref().map(|r| r.machine_id.clone()),
            project_id: claim.project_ref.as_ref().map(|r| r.project_id.clone()),
            thread_id: None,
            summary: summary.chars().take(200).collect(),
            data: Some(serde_json::to_value(data)?),
            attention: None,
        })?;
        Ok(())
    }
}

fn ended(
    mut claim: Claim,
    state: ClaimState,
    now: i64,
    reason: &str,
    landing: Option<CommitSha>,
) -> Claim {
    let reason: String = reason.chars().take(200).collect();
    claim.state = state;
    claim.end = Some(ClaimEnd {
        at: Timestamp(iso_ms(now)),
        reason: Line::new(reason).unwrap_or_else(|_| Line::unchecked("ended")),
        landing,
    });
    claim
}

/// Whether a Change's `owner/name` is the repo the key names, on whatever host it is: the key's path after its
/// host (`github.com`, a GitHub Enterprise or GitLab host, `host:port` of an ssh remote).
fn on_repo(key: &RepoKey, repo: &str) -> bool {
    key.as_str()
        .split_once('/')
        .is_some_and(|(host, path)| !host.is_empty() && path == repo.to_lowercase())
}

/// Adds the claims' expiry to every sweep.
pub fn register_sweep(hub: &Arc<Hub>) {
    let work = hub.work.clone();
    hub.sweep.register(SweepCheck {
        name: "work-claims".into(),
        run: Arc::new(move || {
            let result = work.expire_due().map(|_| ()).map_err(|e| e.to_string());
            Box::pin(async move { result })
        }),
    });
}
