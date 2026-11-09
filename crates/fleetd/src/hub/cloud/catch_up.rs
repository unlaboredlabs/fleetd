//! A cloud machine's catch-up (review B1): fleetd acts on machines that are online, so a cloud machine, asleep most of
//! the time, misses what happened meanwhile. At each of its hellos (its node linked: `machine.online`, or
//! `machine.linked` after a quick restart, or `machine.degraded`: a new one's claude isn't logged in until this brings
//! the hub's Claude configuration), before it counts as ready for work ([`super::Cloud::ready`]), the hub delivers it,
//! in this order:
//! 1. its build: a node behind the hub's is updated and restarts, and the rest waits for that next hello; one on the
//!    hub's build gets the Claude Code it was tested with (`Updates::catch_up`);
//! 2. what it must forget, kept while it slept ([`super::outbox`]);
//! 3. the hub's Claude configuration, resealed to it ([`super::claude`]);
//! 4. its worktrees due to go, which the nightly sweep leaves while it sleeps (`Tasks::sweep_worktrees_on`);
//! 5. its orders' `GH_TOKEN`s, delivered again: one handed over before it slept may have ended meanwhile
//!    (`sessions::redeliver_on`).
//!
//! Once ready, its pool checkouts are cloned where missing and given their home checkouts' plain variables
//! (`pool::place::ensure_checkouts`, off the catch-up), and the tasks queue runs again: work waiting for it goes on.
//!
//! An order's variables to drop need nothing here: the hub keeps them until their machine is back
//! (projects/order_env.rs). A step that fails is logged; the others still run. Only a catch-up whose update and Claude
//! steps went through makes the machine ready for work, so nothing runs on an old fleetd, an old Claude or without the
//! hub's Claude configuration: a failed one is tried again a minute later, up to [`RETRIES`] times, and at the next
//! hello, and hub/pool stops a machine that isn't ready within its wake's 5 minutes.
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::MachineId;

use fleetd_contracts::node_link::{CAP_CLAUDE_ACCOUNTS, CAP_ONEPASSWORD};

use super::claude::{self, Brought};
use super::is_pool;
use super::outbox::Missed;
use crate::hub::api::Hub;
use crate::hub::store::WaitInput;
use crate::hub::tasks::worktrees::Swept;
use crate::hub::update::NodeCatchUp;

/// How long a hello waits for the hub's link to the node to go live.
const LINK_WAIT: Duration = Duration::from_secs(30);
/// A catch-up that left the machine not ready is tried again this often, this many times, while its link stays.
const RETRY_EVERY: Duration = Duration::from_secs(60);
pub const RETRIES: u32 = 3;

/// What one catch-up did.
#[derive(Debug, Default)]
pub struct Report {
    /// Its node is updating, and restarts: the rest waits for its next hello.
    pub restarting: bool,
    /// Missed items its node took.
    pub forgotten: usize,
    pub claude: Option<Brought>,
    pub worktrees: Swept,
    /// Orders' GitHub tokens delivered to it again.
    pub github: usize,
    /// Each step that failed, in one line; tried again at the next hello.
    pub problems: Vec<String>,
    /// Its update and Claude steps went through: it is ready for work.
    pub ready: bool,
}

/// Replays what the machine missed, oldest first, dropping each item its node took.
async fn replay(hub: &Hub, machine_id: &MachineId, report: &mut Report) {
    let items = match hub.db.cloud_outbox().list(machine_id) {
        Ok(items) => items,
        Err(e) => {
            return report
                .problems
                .push(format!("missed forgets not read: {e}"));
        }
    };
    for (id, item) in items {
        let can = |cap| hub.link.node_can(machine_id, cap);
        let done = match &item {
            Missed::ClaudeForget { account } if can(CAP_CLAUDE_ACCOUNTS) => hub
                .executors
                .claude_account_secret(machine_id, account.clone(), None)
                .await
                .map(|_| ())
                .map_err(|e| e.to_string()),
            Missed::OnePasswordForget { person_id } if can(CAP_ONEPASSWORD) => hub
                .executors
                .onepassword_token(machine_id, person_id.clone(), None)
                .await
                .map(|_| ())
                .map_err(|e| e.to_string()),
            _ => Err("its node is too old to take it".to_owned()),
        };
        match done.and_then(|()| hub.db.cloud_outbox().done(id).map_err(|e| e.to_string())) {
            Ok(()) => report.forgotten += 1,
            Err(e) => report.problems.push(format!("{item:?} not forgotten: {e}")),
        }
    }
}

/// One catch-up of the cloud machine, for its link live now. Marks it ready for work once done, unless its node is
/// restarting into the hub's build.
pub async fn catch_up(hub: &Arc<Hub>, machine_id: &MachineId) -> Report {
    let mut report = Report::default();
    let Some(live_since) = hub.executors.live_since(machine_id) else {
        report.problems.push("its node isn't linked".into());
        return report;
    };
    let mut ready = true;
    match hub.updates.catch_up(machine_id).await {
        Ok(NodeCatchUp::Restarting) => {
            report.restarting = true;
            return report;
        }
        Ok(NodeCatchUp::Current) => {}
        Err(why) => {
            ready = false;
            report.problems.push(format!("not updated: {why}"));
        }
    }
    replay(hub, machine_id, &mut report).await;
    match claude::bring(hub, machine_id).await {
        Ok(brought) => report.claude = Some(brought),
        Err(why) => {
            ready = false;
            report.problems.push(format!("Claude not brought: {why}"));
        }
    }
    report.worktrees = hub.tasks.sweep_worktrees_on(machine_id).await;
    let (github, problems) = crate::hub::github_app::sessions::redeliver_on(hub, machine_id).await;
    report.github = github;
    report.problems.extend(problems);
    if ready {
        hub.cloud.set_caught_up(machine_id, live_since);
        hub.cloud.cloning.ensure(hub, machine_id);
        hub.tasks.retry_soon();
    }
    report.ready = ready;
    report
}

/// Catches the machine up, and again while a newer link came meanwhile; one at a time per machine.
async fn follow(hub: Arc<Hub>, running: Arc<Mutex<HashSet<MachineId>>>, machine_id: MachineId) {
    if !running.lock().unwrap().insert(machine_id.clone()) {
        return;
    }
    let _ = tokio::time::timeout(LINK_WAIT, hub.executors.await_live(&machine_id)).await;
    let mut retries = 0;
    loop {
        let live = hub.executors.live_since(&machine_id);
        let report = catch_up(&hub, &machine_id).await;
        if report.problems.is_empty() {
            tracing::info!(machine_id = %machine_id, ?report, "cloud machine caught up");
        } else if report.ready {
            tracing::warn!(machine_id = %machine_id, ?report, "cloud machine caught up, but not all of it");
        } else {
            tracing::warn!(machine_id = %machine_id, ?report, "cloud machine not caught up: no work goes there yet");
        }
        if report.restarting {
            break;
        }
        // A newer link came meanwhile: catch that one up.
        if hub.executors.live_since(&machine_id) != live {
            continue;
        }
        if report.ready || live.is_none() || retries >= RETRIES {
            break;
        }
        retries += 1;
        hub.clock.sleep(RETRY_EVERY).await;
    }
    running.lock().unwrap().remove(&machine_id);
}

/// Catches up each cloud machine as its node links, for the hub's life.
pub async fn run(hub: Arc<Hub>) {
    let running: Arc<Mutex<HashSet<MachineId>>> = Arc::default();
    let mut cursor = hub.events.head();
    loop {
        let input = WaitInput {
            cursor: Some(cursor),
            types: Some(vec![
                HubEventType::MachineOnline,
                HubEventType::MachineLinked,
                HubEventType::MachineDegraded,
            ]),
            machine_id: None,
            timeout_sec: 3600,
        };
        let page = match hub.events.wait(input).await {
            Ok(page) => page,
            Err(error) => {
                tracing::warn!(%error, "cloud catch-up: machine links not read");
                hub.clock.sleep(Duration::from_secs(1)).await;
                continue;
            }
        };
        cursor = page.cursor.max(cursor);
        for machine_id in page.events.into_iter().filter_map(|e| e.machine_id) {
            if is_pool(&hub, &machine_id) {
                tokio::spawn(follow(hub.clone(), running.clone(), machine_id));
            }
        }
    }
}
