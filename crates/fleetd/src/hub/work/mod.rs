//! The work ledger: one view of the work in flight on a repo's base branch, across every project on that repo, so
//! nothing is built twice. Tasks and Changes stay their own source of truth; this area adds claims (intent fleetd
//! can't otherwise see, such as a human's own session) and the repo and base each project's work lands on.
//! (`hub/ledger` is the decision log, a different thing.)
//!
//! A claim lasts `CLAIM_TTL_MS` from its last renewal; the sweep expires it, and the view keeps an expired claim,
//! as weak, for `EXPIRED_SHOWN_MS`.
pub mod matcher;
pub mod store;
pub mod view;

#[cfg(test)]
mod matcher_tests;
#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{ProjectRef, ThreadRef, Timestamp};
use fleetd_contracts::prim::{Line, List};
use fleetd_contracts::tasks::{TaskId, TaskKind};
use fleetd_contracts::train::Change;
use fleetd_contracts::verification::CommitSha;
use fleetd_contracts::work::{
    BranchName, CLAIM_KEYS_MAX, CLAIM_PATHS_MAX, CLAIM_TTL_MS, Claim, ClaimEnd, ClaimId,
    ClaimObserved, ClaimOwner, ClaimState, EXPIRED_SHOWN_MS, RepoKey, WorkEventData, WorkItem,
    WorkKey, WorkPath, WorkScope,
};

use crate::clock::Clock;
use crate::hub::api::Hub;
use crate::hub::store::{EventLog, HubDb, NewEvent, StoreError, iso_ms, now_ms};
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
            observed: None,
            author_email: new.author_email,
            state: ClaimState::Active,
            end: None,
            created_at: at.clone(),
            renewed_at: at,
            expires_at: Timestamp(iso_ms(now + CLAIM_TTL_MS)),
        };
        let claim = self.db.transaction(|c| Ok(store::insert(c, claim)?))?;
        self.announce(
            &claim,
            format!("{} claimed: {}", claim.claim_id, claim.title),
        )?;
        Ok(claim)
    }

    /// Extends an active or expired claim by `CLAIM_TTL_MS` from now, with what its branch changed when given. An
    /// expired claim is active again (its work is clearly going on). `None` for an unknown, landed or released one.
    pub fn renew(
        &self,
        claim_id: &ClaimId,
        observed: Option<ClaimObserved>,
    ) -> Result<Option<Claim>, StoreError> {
        let now = self.now();
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
                let reason = "not renewed for 12 h";
                let claim = ended(claim, ClaimState::Expired, now, reason, None);
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
        let mut sources = self.sources(scope)?;
        let threads: Vec<(TaskId, ThreadRef)> = sources
            .tasks
            .iter()
            .chain(&sources.change_tasks)
            .filter(|t| t.kind == TaskKind::Write)
            .filter_map(|t| Some((t.task_id.clone(), t.thread_ref.clone()?)))
            .collect();
        let paths = futures_util::future::join_all(
            threads
                .iter()
                .map(|(_, thread)| self.ports.changed_paths(thread)),
        )
        .await;
        sources.observed = threads
            .into_iter()
            .zip(paths)
            .filter_map(|((task_id, _), paths)| Some((task_id, paths?)))
            .collect::<HashMap<_, _>>();
        Ok(view::items(&sources))
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
            .filter(|c| {
                RepoKey::of(&format!("github.com/{}", c.repo)).as_ref() == Some(&scope.repo_key)
            })
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
