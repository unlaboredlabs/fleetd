//! The nightly worktree sweep: hub work, no model turn. A task's worktree goes when it ends (a reader's) or when its PR
//! merges (a writer's); a cancelled writer's, one whose PR closed unmerged, and a removal that failed stay behind.
//! Around 04:00 in `policy.tz` (else the hub's zone), and once soon after the hub starts, the sweep has the node remove
//! the worktree of every task that ended over `policy.worktree_days` (3) days ago, through its safe removal. One
//! holding work that exists only there (uncommitted changes, unpushed commits) is kept and the person is told once in
//! the project's chat, in one line a sweep listing all it kept there; one the node couldn't remove (offline, a git
//! error) is tried again the next night, up to [`MAX_TRIES`] times, then given up on with one line to the person. A
//! session its node doesn't know counts as removed, as does a removal done at the task's end or merge. A project that
//! keeps its finished worktrees (`keep_worktrees`) is left alone. Each sweep also cancels tasks still queued under an
//! order that has closed: they would never start.
use std::sync::Arc;
use std::time::Duration;

use chrono::{TimeZone, Timelike};
use chrono_tz::Tz;
use fleetd_contracts::chat::{KeptWorktree, WORKTREES_KEPT_MAX, WorktreesKept};
use fleetd_contracts::ids::{MachineId, ProjectRef};
use fleetd_contracts::ledger::WorkstreamState;
use fleetd_contracts::prim::{Line, List};
use fleetd_contracts::tasks::Task;

use super::ports::PortError;
use super::{TaskCaller, TaskRecords, Tasks};
use crate::hub::attention::{POLICY_TZ_KEY, hub_zone, zone};
use crate::hub::store::{iso_ms, now_ms};
use crate::node::worktree::{KEPT, UNCOMMITTED, UNPUSHED};

/// The global decision setting how many days after its task ended a worktree goes.
pub const WORKTREE_DAYS_KEY: &str = "policy.worktree_days";
pub const WORKTREE_DAYS: i64 = 3;
/// The local hour the sweep runs at.
const HOUR: u32 = 4;
/// The first sweep after the hub starts, once its nodes have had time to link.
const AFTER_START: Duration = Duration::from_secs(10 * 60);
const DAY_MS: i64 = 86_400_000;
/// Failed tries, one a night, before the sweep gives a worktree up: a week, for a machine that is gone for good.
pub const MAX_TRIES: i64 = 7;

/// What one sweep did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Swept {
    pub removed: usize,
    /// Kept for work only there.
    pub kept: usize,
    /// Not removed now (node offline, a git error); tried again next time, or given up on after [`MAX_TRIES`].
    pub failed: usize,
}

impl Tasks {
    /// One sweep of the worktrees of tasks that ended over `policy.worktree_days` days ago, one at a time.
    pub async fn sweep_worktrees(self: &Arc<Self>) -> Swept {
        let days = self
            .d
            .ports
            .global_decision(WORKTREE_DAYS_KEY)
            .and_then(|v| v.parse::<i64>().ok())
            .filter(|d| *d > 0)
            .unwrap_or(WORKTREE_DAYS);
        let before = iso_ms(now_ms(self.d.clock.as_ref()) - days * DAY_MS);
        let mut swept = Swept::default();
        let ended = match self.db(|c| TaskRecords::unswept(c, &before)) {
            Ok(ended) => ended,
            Err(error) => {
                tracing::warn!(%error, "worktree sweep: tasks not read");
                return swept;
            }
        };
        let mut given_up: Vec<(ProjectRef, Vec<String>)> = Vec::new();
        let mut kept: Vec<(ProjectRef, Vec<KeptWorktree>)> = Vec::new();
        for (task, flagged) in ended {
            let Some(thread) = &task.thread_ref else {
                continue;
            };
            if !matches!(
                self.d
                    .db
                    .project_settings()
                    .keep_worktrees(&task.project_ref),
                Ok(false)
            ) {
                continue;
            }
            let id = task.task_id.as_str();
            let seen = match self.d.ports.remove_worktree(thread).await {
                Ok(()) => {
                    swept.removed += 1;
                    "removed"
                }
                Err(PortError::Failed(message)) if holds_work(&message) => {
                    swept.kept += 1;
                    if !flagged {
                        let worktree = kept_worktree(&task, &thread.machine_id, &message);
                        match kept.iter_mut().find(|(r, _)| *r == task.project_ref) {
                            Some((_, items)) => items.push(worktree),
                            None => kept.push((task.project_ref.clone(), vec![worktree])),
                        }
                    }
                    "flagged"
                }
                Err(error) => {
                    swept.failed += 1;
                    let tries = self
                        .db(|c| TaskRecords::worktree_failed(c, &task.task_id))
                        .unwrap_or(MAX_TRIES);
                    if tries < MAX_TRIES {
                        tracing::warn!(
                            task_id = id,
                            ?error,
                            tries,
                            "worktree sweep: not removed, tried again next time"
                        );
                        continue;
                    }
                    tracing::warn!(
                        task_id = id,
                        ?error,
                        tries,
                        "worktree sweep: not removed, given up"
                    );
                    let named = format!("{id} on {}", thread.machine_id.as_str());
                    match given_up.iter_mut().find(|(r, _)| *r == task.project_ref) {
                        Some((_, ids)) => ids.push(named),
                        None => given_up.push((task.project_ref.clone(), vec![named])),
                    }
                    "given_up"
                }
            };
            if let Err(error) = self.db(|c| TaskRecords::set_worktree(c, &task.task_id, seen)) {
                tracing::warn!(task_id = id, %error, "worktree sweep: outcome not recorded");
            }
        }
        for (r, items) in kept {
            for chunk in items.chunks(WORKTREES_KEPT_MAX) {
                let items = List::unchecked(chunk.to_vec());
                self.d.ports.tell_kept(&r, WorktreesKept { items });
            }
        }
        for (r, ids) in given_up {
            let text = format!(
                "Stopped trying to remove the worktrees of finished agents {} after {MAX_TRIES} nightly tries: the \
                 machine was offline or git refused. If the machine is still in use, delete them by hand under \
                 ~/.fleetd/node/worktrees.",
                ids.join(", ")
            );
            self.d.ports.tell_person(&r, &text);
        }
        swept
    }

    /// Cancels the tasks still queued under an order that is no longer open, which the queue never starts: those of
    /// orders closed before `close` stopped its agents. Returns how many.
    pub async fn cancel_closed_queued(self: &Arc<Self>) -> usize {
        let queued = match self.db(TaskRecords::queued) {
            Ok(queued) => queued,
            Err(error) => {
                tracing::warn!(%error, "tasks under closed orders: queue not read");
                return 0;
            }
        };
        let mut cancelled = 0;
        for stored in queued {
            let task = stored.task;
            let Some(order) = self
                .workstream(&task.workstream_id)
                .filter(|w| w.state != WorkstreamState::Open)
            else {
                continue;
            };
            let caller = TaskCaller {
                project_ref: task.project_ref.clone(),
                by: "hub".to_owned(),
            };
            let reason = format!("Cancelled: its order {} is closed.", order.workstream_id);
            match self.cancel(&caller, &task.task_id, Some(&reason)).await {
                Ok(_) => {
                    tracing::info!(task_id = task.task_id.as_str(), workstream_id = %order.workstream_id, "a task queued under a closed order was cancelled");
                    cancelled += 1;
                }
                Err(error) => {
                    tracing::warn!(task_id = task.task_id.as_str(), message = %error.message, "a task queued under a closed order was not cancelled")
                }
            }
        }
        cancelled
    }
}

/// Whether the node kept the worktree for work that exists only there, by its own words (`worktree::remove`).
fn holds_work(message: &str) -> bool {
    message.contains(KEPT) && (message.contains(UNCOMMITTED) || message.contains(UNPUSHED))
}

/// A worktree kept for its work, as the person's line lists it: whose, what only it holds, and where.
fn kept_worktree(task: &Task, machine: &MachineId, message: &str) -> KeptWorktree {
    // `... kept <path>: <why>`
    let kept = message.rsplit_once(KEPT).map_or("", |(_, kept)| kept);
    let (path, why) = kept.split_once(": ").unwrap_or((kept, "work"));
    KeptWorktree {
        title: task.title.clone(),
        unsaved: Line::unchecked(unsaved(why)),
        machine_id: machine.clone(),
        path: Line::unchecked(path),
    }
}

/// "uncommitted changes" or "2 unpushed commits", from the node's `<why>`.
fn unsaved(why: &str) -> String {
    let commits = why
        .strip_suffix(UNPUSHED)
        .and_then(|n| n.trim_end().strip_suffix("commit(s)"))
        .and_then(|n| n.trim().parse::<u64>().ok());
    match commits {
        Some(1) => "1 unpushed commit".to_owned(),
        Some(n) => format!("{n} unpushed commits"),
        None => why.strip_prefix("it has ").unwrap_or(why).to_owned(),
    }
}

/// The text of a line listing `n` kept worktrees: "Cleanup kept 6 worktrees with unsaved work".
pub fn kept_summary(n: usize) -> String {
    let worktrees = if n == 1 { "worktree" } else { "worktrees" };
    format!("Cleanup kept {n} {worktrees} with unsaved work")
}

/// The next `HOUR`:00 in `tz` after `now_ms`. A day whose `HOUR`:00 doesn't exist (a clock change) is skipped.
pub fn next_run_ms(now_ms: i64, tz: Tz) -> i64 {
    let now = tz
        .timestamp_millis_opt(now_ms)
        .single()
        .expect("a time in range");
    let mut day = now.date_naive();
    if now.hour() >= HOUR {
        day = day.succ_opt().expect("a next day");
    }
    loop {
        let at = day.and_hms_opt(HOUR, 0, 0).expect("a valid hour");
        if let Some(t) = tz.from_local_datetime(&at).earliest()
            && t.timestamp_millis() > now_ms
        {
            return t.timestamp_millis();
        }
        day = day.succ_opt().expect("a next day");
    }
}

/// The sweep soon after the start, then nightly, until the hub stops.
pub async fn run(tasks: Arc<Tasks>) {
    let clock = tasks.d.clock.clone();
    clock.sleep(AFTER_START).await;
    loop {
        let cancelled = tasks.cancel_closed_queued().await;
        if cancelled > 0 {
            tracing::info!(cancelled, "tasks queued under closed orders cancelled");
        }
        let swept = tasks.sweep_worktrees().await;
        if swept != Swept::default() {
            tracing::info!(?swept, "worktree sweep");
        }
        let tz = tasks
            .d
            .ports
            .global_decision(POLICY_TZ_KEY)
            .and_then(|name| zone(&name))
            .unwrap_or_else(hub_zone);
        let now = now_ms(clock.as_ref());
        let wait = (next_run_ms(now, tz) - now).max(60_000);
        clock.sleep(Duration::from_millis(wait as u64)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_sweep_runs_at_four_local_time_next() {
        let at = |s: &str| {
            chrono::DateTime::parse_from_rfc3339(s)
                .unwrap()
                .timestamp_millis()
        };
        let tz: Tz = "Europe/Berlin".parse().unwrap();
        // 23:30 Berlin (UTC+1 in winter): the next 04:00 is in four and a half hours.
        assert_eq!(
            next_run_ms(at("2026-11-03T22:30:00Z"), tz),
            at("2026-11-04T03:00:00Z")
        );
        // 02:00 local: today's 04:00.
        assert_eq!(
            next_run_ms(at("2026-11-04T01:00:00Z"), tz),
            at("2026-11-04T03:00:00Z")
        );
        // 04:00 sharp: tomorrow's.
        assert_eq!(
            next_run_ms(at("2026-11-04T03:00:00Z"), tz),
            at("2026-11-05T03:00:00Z")
        );
    }

    #[test]
    fn only_the_nodes_refusals_for_work_read_as_work_kept() {
        assert!(holds_work(
            "the node on devbox refused or failed the stop request: kept /w/t2: it has uncommitted changes"
        ));
        assert!(holds_work("kept /w/t2: 2 commit(s) not pushed"));
        assert!(!holds_work(
            "the node on devbox refused or failed the stop request: git worktree remove: locked"
        ));
    }
}
