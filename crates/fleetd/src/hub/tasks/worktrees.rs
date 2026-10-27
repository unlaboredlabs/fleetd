//! The nightly worktree sweep: hub work, no model turn. A task's worktree goes when it ends (a reader's) or when its PR
//! merges (a writer's); a cancelled writer's, one whose PR closed unmerged, and a removal that failed stay behind.
//! Around 04:00 in `policy.tz` (else the hub's zone), and once soon after the hub starts, the sweep has the node remove
//! the worktree of every task that ended over `policy.worktree_days` (3) days ago, through its safe removal. One
//! holding work that exists only there (uncommitted changes, unpushed commits) is kept and the person is told once in
//! the project's chat; one the node couldn't remove (offline, a git error) is tried again the next night. A project
//! that keeps its finished worktrees (`keep_worktrees`) is left alone.
use std::sync::Arc;
use std::time::Duration;

use chrono::{TimeZone, Timelike};
use chrono_tz::Tz;
use fleetd_contracts::tasks::Task;

use super::ports::PortError;
use super::{TaskRecords, Tasks};
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

/// What one sweep did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Swept {
    pub removed: usize,
    /// Kept for work only there.
    pub kept: usize,
    /// Not removed now (node offline, a git error); tried again next time.
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
                        let text = kept_line(&task, &message);
                        self.d.ports.tell_person(&task.project_ref, &text);
                    }
                    "flagged"
                }
                Err(error) => {
                    tracing::warn!(
                        task_id = id,
                        ?error,
                        "worktree sweep: not removed, tried again next time"
                    );
                    swept.failed += 1;
                    continue;
                }
            };
            if let Err(error) = self.db(|c| TaskRecords::set_worktree(c, &task.task_id, seen)) {
                tracing::warn!(task_id = id, %error, "worktree sweep: outcome not recorded");
            }
        }
        swept
    }
}

/// Whether the node kept the worktree for work that exists only there, by its own words (`worktree::remove`).
fn holds_work(message: &str) -> bool {
    message.contains(KEPT) && (message.contains(UNCOMMITTED) || message.contains(UNPUSHED))
}

/// The person's line for a worktree kept for its work: which agent's, where, why, and what frees it.
fn kept_line(task: &Task, message: &str) -> String {
    // `... kept <path>: <why>`
    let kept = message.rsplit_once(KEPT).map_or("", |(_, kept)| kept);
    let (path, why) = kept.split_once(": ").unwrap_or((kept, "it holds work"));
    let why = if why.starts_with("it ") {
        why.to_owned()
    } else {
        format!("it has {why}")
    };
    format!(
        "Kept the worktree of \"{}\" ({}) on {}: {why}, which exist nowhere else. It is at {path}. Push or delete \
         that work and the nightly cleanup removes the worktree.",
        task.title.as_str(),
        task.task_id.as_str(),
        task.project_ref.machine_id.as_str(),
    )
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
