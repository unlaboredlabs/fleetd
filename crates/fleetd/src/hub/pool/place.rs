//! Placement on cloud machines (D306), deterministic: a task goes to a cloud machine only when its project's own
//! machine is at its agent limit (its cap, or no disk room for another agent), never for memory, PSI or load. In order:
//! 1. its project's own machine, while it has room (the slot board, `Board::place`);
//! 2. an awake cloud machine, caught up, with room: the one running the most agents, so work packs and the rest go
//!    idle and stop;
//! 3. waking a sleeping one ([`Pool::wake_for_work`]), within the start budget and the money budget, one at a time;
//! 4. else it queues, its line saying why ("…; cloud paused: today's boat.dev budget ($3.00) is spent").
//!
//! It may go only when cloud machines are on, its project opted in, and its kind may: reviews and readers, and writers
//! once the admin turns them on (`pool_settings.writers`). Never a Navi's, and never a project with secret variables,
//! which only its own machine holds. A task placed on one records it (`Task.ranOn`), and every later turn of it runs
//! there, where its worktree is: a follow-up wakes that machine, and waits while it can't.
//!
//! Each cloud machine holds a **pool checkout** of each opted-in project's repos: a clone registered on it under the
//! home checkout's project id, so `(boat-2, <id>)` is the home checkout's twin. [`ensure_checkouts`] clones what's
//! missing at each catch-up and gives each the home checkout's plain variables; the launch takes the home checkout's
//! policy and worktree setup. A cloud machine hosts no project of its own, so its checkouts never show as projects.
use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use fleetd_contracts::ids::{MachineId, ProjectRef};
use fleetd_contracts::project_settings::{EnvVarKind, EnvVarSet};
use fleetd_contracts::tasks::{Task, TaskKind};

use super::ledger::State;
use super::{Pool, Why};
use crate::hub::api::Hub;

/// The cloud machines a new task may run on now, as placement sees them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Room {
    /// Whether it may run on one at all; when it may not and the pool is on, why (for its queued line).
    pub eligible: Result<(), Option<String>>,
    /// Awake, caught up and holding its checkout, in slot order.
    pub awake: Vec<MachineId>,
    /// An awake one still cloning its checkout: the task waits for it rather than waking another.
    pub cloning: Option<MachineId>,
    /// Why no cloud machine takes work now, even an awake one: not yet reconciled with boat, or the money budget spent.
    pub closed: Option<String>,
}

impl Default for Room {
    /// Not eligible, and nothing to say: cloud machines are off.
    fn default() -> Room {
        Room {
            eligible: Err(None),
            awake: Vec::new(),
            cloning: None,
            closed: None,
        }
    }
}

impl Pool {
    /// Why no work may go to a cloud machine now, even an awake one; None: it may.
    pub fn closed(&self) -> Option<String> {
        if !self.ready() {
            return Some("cloud machines wait for the hub's first check of boat.dev".into());
        }
        let s = match self.ledger.settings() {
            Ok(s) => s,
            Err(e) => return Some(format!("the pool's ledger can't be read: {e}")),
        };
        if !s.enabled {
            return Some("cloud machines are off".into());
        }
        match self.budget(&s, self.now()) {
            Ok(b) => b.line(),
            Err(e) => Some(format!("the pool's ledger can't be read: {e}")),
        }
    }

    /// The awake cloud machines caught up for work, in slot order.
    pub fn awake(&self) -> Vec<String> {
        self.ledger
            .slots()
            .unwrap_or_default()
            .into_iter()
            .filter(|r| r.state == State::Awake && self.fleet.ready(&r.slot))
            .map(|r| r.slot)
            .collect()
    }

    /// Wakes a cloud machine for work, off the caller's lock: `slot`, a task's own; else none while one is waking
    /// already (named instead), else the first asleep one. Ok names the machine coming; Err is the one line why none
    /// does (the budget, the start budget, boat's backoff, a broken machine). The wake itself checks everything again
    /// and boat's pre-flight; a refusal there holds the next starts with its own line.
    pub fn wake_for_work(self: &Arc<Self>, slot: Option<&str>) -> Result<String, String> {
        let rows = self.ledger.slots().map_err(|e| e.to_string())?;
        let coming = |state: State| matches!(state, State::Waking | State::Creating);
        let pick = match slot {
            Some(slot) => {
                let row = rows
                    .iter()
                    .find(|r| r.slot == slot)
                    .ok_or_else(|| format!("{slot} is no longer a cloud machine"))?;
                match row.state {
                    State::Awake | State::Waking | State::Creating => return Ok(slot.to_owned()),
                    State::Broken => {
                        return Err(format!(
                            "{slot} doesn't come back: Reset it in Settings › Cloud"
                        ));
                    }
                    State::Failed | State::Gone => {
                        return Err(format!(
                            "{slot} has no machine: Reset it in Settings › Cloud"
                        ));
                    }
                    State::Asleep | State::Stopping => slot.to_owned(),
                }
            }
            None => {
                let waking = self.waking.lock().unwrap().iter().next().cloned();
                if let Some(slot) = waking.or_else(|| {
                    rows.iter()
                        .find(|r| coming(r.state))
                        .map(|r| r.slot.clone())
                }) {
                    return Ok(slot);
                }
                rows.iter()
                    .find(|r| r.state == State::Asleep && r.sandbox_id.is_some())
                    .map(|r| r.slot.clone())
                    .ok_or_else(|| {
                        let n = rows.iter().filter(|r| r.state == State::Awake).count();
                        format!("the cloud machines are busy ({n} of {} awake)", rows.len())
                    })?
            }
        };
        if let Some(line) = self.closed().or_else(|| self.start_held()) {
            return Err(line);
        }
        if !self.waking.lock().unwrap().insert(pick.clone()) {
            return Ok(pick);
        }
        let (pool, slot) = (self.clone(), pick.clone());
        tokio::spawn(async move {
            if let Err(why) = pool.wake(&slot, Why::Need).await {
                tracing::warn!(slot, why, "pool: wake for work refused");
            }
            pool.waking.lock().unwrap().remove(&slot);
        });
        Ok(pick)
    }
}

/// Whether a task of `kind` may run on a cloud machine with `writers` on.
pub fn kind_may(kind: TaskKind, writers: bool) -> bool {
    match kind {
        TaskKind::Review | TaskKind::Read => true,
        TaskKind::Write => writers,
    }
}

/// The checkout's twin on cloud machine `m`: the clone registered there under the home checkout's project id.
pub fn twin(m: &MachineId, checkout: &ProjectRef) -> ProjectRef {
    ProjectRef {
        machine_id: m.clone(),
        project_id: checkout.project_id.clone(),
    }
}

/// The cloud machines a new task working in `checkout` may run on now.
pub fn room(hub: &Arc<Hub>, task: &Task, checkout: &ProjectRef) -> Room {
    let mut room = Room {
        eligible: eligible(hub, task, checkout),
        ..Room::default()
    };
    if room.eligible.is_err() {
        return room;
    }
    room.closed = hub.pool.closed();
    if room.closed.is_some() {
        return room;
    }
    for slot in hub.pool.awake() {
        let Ok(m) = MachineId::new(&slot) else {
            continue;
        };
        if !hub.executors.is_connected(&m) {
            continue;
        }
        if hub
            .store
            .project_get(&twin(&m, checkout))
            .ok()
            .flatten()
            .is_some()
        {
            room.awake.push(m);
        } else if room.cloning.is_none() {
            // Opted in while it was awake, or its clone failed: cloned now, and the task waits for that.
            hub.cloud.cloning.ensure(hub, &m);
            room.cloning = Some(m);
        }
    }
    room
}

/// Whether the task may run on a cloud machine at all. Err(None): cloud machines are off or its project didn't opt in,
/// which its queued line needn't say; Err(Some(why)): it opted in, but this task may not.
fn eligible(hub: &Hub, task: &Task, checkout: &ProjectRef) -> Result<(), Option<String>> {
    let s = hub.pool.ledger().settings().map_err(|_| None)?;
    if !s.enabled || !s.has_key || !s.projects.contains(&task.project_ref) {
        return Err(None);
    }
    if crate::hub::integrations::is_navi(&hub.db, &task.project_ref).unwrap_or(true) {
        return Err(None);
    }
    if !kind_may(task.kind, s.writers) {
        return Err(Some(
            "writers don't run on cloud machines unless a hub admin turns them on in Settings › Cloud".into(),
        ));
    }
    let secrets = hub
        .db
        .project_settings()
        .env(checkout)
        .map_err(|_| None)?
        .iter()
        .any(|v| v.kind == EnvVarKind::Secret);
    if secrets {
        return Err(Some(
            "not for cloud: its project's secret variables are only on its own machine".into(),
        ));
    }
    Ok(())
}

/// The opted-in projects' checkouts each cloud machine is cloning now, so one is cloned once at a time.
#[derive(Default)]
pub struct Cloning {
    running: Mutex<HashSet<MachineId>>,
}

impl Cloning {
    /// [`ensure_checkouts`] on `m`, off the caller; once at a time per machine. Runs the tasks queue again when done.
    pub fn ensure(&self, hub: &Arc<Hub>, m: &MachineId) {
        if !self.running.lock().unwrap().insert(m.clone()) {
            return;
        }
        let (hub, m) = (hub.clone(), m.clone());
        tokio::spawn(async move {
            let problems = ensure_checkouts(&hub, &m).await;
            for problem in &problems {
                tracing::warn!(machine_id = %m, problem, "cloud machine: pool checkout");
            }
            hub.cloud.cloning.running.lock().unwrap().remove(&m);
            hub.tasks.retry_soon();
        });
    }
}

/// Every opted-in project's checkouts on cloud machine `m`: each one missing cloned and registered under its home
/// checkout's project id, and each given its home checkout's plain variables. Returns what failed, one line each.
pub async fn ensure_checkouts(hub: &Hub, m: &MachineId) -> Vec<String> {
    let mut problems = Vec::new();
    let Ok(s) = hub.pool.ledger().settings() else {
        return vec!["the pool's ledger can't be read".into()];
    };
    for project in &s.projects {
        let repos = match hub.repos.repos_of(project) {
            Ok(repos) => repos,
            Err(e) => {
                problems.push(format!("{}'s repos not read: {e}", project.project_id));
                continue;
            }
        };
        for repo in repos {
            if let Err(why) = ensure_checkout(hub, m, &repo).await {
                problems.push(format!("{}: {why}", repo.name));
            }
        }
    }
    problems
}

async fn ensure_checkout(
    hub: &Hub,
    m: &MachineId,
    repo: &fleetd_contracts::repos::ProjectRepo,
) -> Result<(), String> {
    let home = &repo.checkout;
    let at = twin(m, home);
    if hub
        .store
        .project_get(&at)
        .map_err(|e| e.to_string())?
        .is_none()
    {
        let scope = match hub
            .work
            .scope_of_repo(&repo.repo_id)
            .map_err(|e| e.to_string())?
        {
            Some(scope) => Some(scope),
            None => hub.work.scope_of(home).map_err(|e| e.to_string())?,
        };
        let Some(scope) = scope else {
            return Err("it has no remote to clone from".into());
        };
        let key = scope.repo_key.as_str();
        let title = hub
            .store
            .project_get(home)
            .map_err(|e| e.to_string())?
            .map_or_else(|| repo.name.to_string(), |p| p.title.to_string());
        let root = hub
            .executors
            .repo_scan(m)
            .await
            .map_err(|e| e.to_string())?
            .clone_root;
        let tail = key.split_once('/').map_or(key, |(_, path)| path);
        let path = format!("{}/{tail}", root.trim_end_matches('/'));
        if let Some(other) = hub.executors.project_at(m, &path)
            && other != home.project_id
        {
            return Err(format!("{path} on {m} is another project's checkout"));
        }
        let facts = hub
            .executors
            .repo_inspect(m, &path)
            .await
            .map_err(|e| e.to_string())?;
        if !facts.exists {
            let run = hub.executors.clone_start();
            hub.executors
                .repo_clone(m, &run.add_id, &format!("https://{key}"), &path)
                .await
                .map_err(|e| e.to_string())?;
        }
        hub.executors
            .project_upsert(m, &home.project_id, &title, &path)
            .await
            .map_err(|e| e.to_string())?;
    }
    let plain: Vec<EnvVarSet> = hub
        .db
        .project_settings()
        .env(home)
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter_map(|v| {
            Some(EnvVarSet::Plain {
                name: v.name,
                value: v.value.filter(|_| v.kind == EnvVarKind::Plain)?,
            })
        })
        .collect();
    if !plain.is_empty() {
        hub.executors
            .project_env(m, &home.project_id, plain, Vec::new())
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
