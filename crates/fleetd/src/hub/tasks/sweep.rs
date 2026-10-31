//! What the hub sweep does for tasks, and the machine breaker's wiring.
//!
//! Orphans (G2): a task the hub thinks runs, on a machine whose node is linked, whose thread has had no event for
//! 2 min and no longer runs there. Either its run's end was never applied (the hub stopped between the end and its
//! follower, which starts after every event appended before it), and it is applied now, so the task resumes or ends
//! as it would have; or the node has no session for it any more, and it fails for its lead to decide on. The other
//! way round, a session the node runs that no task or lead owns is reported once (`thread.orphaned`): it may be an
//! agent nobody is watching, and only a person knows.
//!
//! The breaker (`breaker`): deaths that count open it, it holds dead agents on its machine from resuming, tells
//! their leads once (`machine.recovery_paused`), and closes after a quiet spell or when an agent there completes.
use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

use fleetd_contracts::events::{
    Attention, HubEvent, HubEventType, RecoveryPausedData, ThreadOrphanedData,
};
use fleetd_contracts::ids::{EventSeq, MachineId, ProjectRef, ThreadRef, Timestamp};
use fleetd_contracts::model::ThreadStatus;
use fleetd_contracts::prim::{Count, Text};
use fleetd_contracts::tasks::{Task, TaskId, TaskState};
use rusqlite::OptionalExtension;
use serde_json::{Value, json};

use super::breaker::{Opened, Paused};
use super::ports::WakeKind;
use super::recovery::Kind;
use super::{TaskFilter, TaskRecords, TaskResultStatus, Tasks};
use crate::hub::store::{NewEvent, StoreError, iso_ms, now_ms, parse_ms};

/// A running task's thread this quiet, that no longer runs on its linked node, is an orphan; a session no task or
/// lead owns is reported after this long.
pub const ORPHAN_MS: i64 = 2 * 60_000;

const END_EVENTS: [&str; 4] = [
    "thread.completed",
    "thread.failed",
    "thread.interrupted",
    "thread.usage_limited",
];

/// A session no task or lead owns, for the doctor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Unowned {
    pub thread_id: String,
    pub title: String,
}

/// "10:42 UTC" from epoch milliseconds.
pub fn clock_time(ms: i64) -> String {
    iso_ms(ms)
        .get(11..16)
        .map_or_else(String::new, |t| format!("{t} UTC"))
}

fn list(ids: &[TaskId]) -> String {
    ids.iter()
        .map(|t| t.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

/// The lead's line when its machine's breaker opens: once, with its own agents that now wait.
pub fn paused_lines(
    machine: &str,
    opened_by: &[TaskId],
    until_ms: i64,
    waiting: &[TaskId],
) -> String {
    let head = format!(
        "- Automatic recovery is paused on {machine}: {} agents died there within {} min ({}), claude exiting or \
         stalling each time.",
        opened_by.len(),
        super::breaker::WINDOW_MS / 60_000,
        list(opened_by)
    );
    let theirs = match waiting {
        [] => "None of yours waits on it".to_owned(),
        [one] => format!("{} waits to resume", one.as_str()),
        more => format!("{} wait to resume", list(more)),
    };
    format!(
        "{head}\n  > {theirs}; dead agents there resume again at {} if no other dies, or once one there completes. \
         To go on sooner, continue one with message_agent; stop_agent ends it.",
        clock_time(until_ms)
    )
}

impl Tasks {
    /// The sweep's check: the breakers' quiet spells, orphaned tasks, and sessions nobody owns.
    pub async fn sweep(self: &Arc<Self>) -> Result<(), String> {
        let _guard = self.lock.lock().await;
        // Events appended but not yet applied aren't orphans: apply them first.
        self.catch_up().await;
        self.retry_queue().await;
        let now = now_ms(self.d.clock.as_ref());
        let reconciled = self.reconcile(now).await.map_err(|e| e.to_string());
        let reported = self.unowned_sessions(now).map_err(|e| e.to_string());
        reconciled.and(reported)
    }

    async fn reconcile(self: &Arc<Self>, now: i64) -> Result<(), StoreError> {
        let filter = TaskFilter {
            state: Some(TaskState::Running),
            limit: 10_000,
            ..Default::default()
        };
        for task in self.db(|c| TaskRecords::list(c, &filter))? {
            let Some(thread) = task.thread_ref.clone() else {
                continue;
            };
            // Unreachable is not dead: it waits for its node, and the node's word on its return.
            if !self.d.ports.is_connected(&thread.machine_id)
                || self.continuing.lock().unwrap().contains_key(&task.task_id)
            {
                continue;
            }
            let row = self.d.store.thread_get(&thread)?;
            let known = row.as_ref().filter(|r| !r.thread.stale);
            if known.is_some_and(|r| {
                matches!(
                    r.thread.status,
                    ThreadStatus::Running | ThreadStatus::Waiting | ThreadStatus::Idle
                )
            }) {
                continue;
            }
            if self
                .last_event_ms(&thread)?
                .is_some_and(|at| now - at < ORPHAN_MS)
            {
                continue;
            }
            let Some(stored) = self.db(|c| TaskRecords::get(c, &task.task_id))? else {
                continue;
            };
            match known {
                Some(row) => {
                    let event = match self.end_event(&thread, row.last_run_id.as_deref())? {
                        Some(event) => event,
                        None => synthetic_end(&task, &thread, row, now),
                    };
                    tracing::warn!(
                        task_id = task.task_id.as_str(),
                        r#type = event.r#type.as_str(),
                        "sweep: a running task's end was never applied; applying it now"
                    );
                    self.on_thread_event(&event).await?;
                }
                None => {
                    let machine = thread.machine_id.as_str();
                    tracing::warn!(
                        task_id = task.task_id.as_str(),
                        machine,
                        "sweep: a running task's node has no session for it"
                    );
                    self.finish(
                        &stored,
                        TaskResultStatus::Failed,
                        Some(format!(
                            "[session_lost] the node on {machine} has no session for this agent any more"
                        )),
                        None,
                        Some("its node no longer has its session, so it can't be resumed in it"),
                    )
                    .await?;
                }
            }
        }
        Ok(())
    }

    /// When the hub last logged anything about the thread: its runs, or its task starting or queueing.
    fn last_event_ms(&self, thread: &ThreadRef) -> Result<Option<i64>, StoreError> {
        self.db(|c| {
            c.prepare_cached(
                "SELECT MAX(created_ms) FROM events WHERE machine_id = ? AND json_extract(data, '$.threadId') = ?",
            )?
            .query_row(
                [thread.machine_id.as_str(), thread.thread_id.as_str()],
                |r| r.get(0),
            )
        })
    }

    /// The first end the hub logged for the thread's run `run`, as the node reported it.
    fn end_event(
        &self,
        thread: &ThreadRef,
        run: Option<&str>,
    ) -> Result<Option<HubEvent>, StoreError> {
        let Some(run) = run else { return Ok(None) };
        let types = serde_json::to_string(&END_EVENTS)?;
        let row: Option<(i64, String)> = self.db(|c| {
            c.prepare_cached(
                "SELECT seq, data FROM events
                 WHERE type IN (SELECT value FROM json_each(?1)) AND machine_id = ?2
                   AND json_extract(data, '$.threadId') = ?3 AND json_extract(data, '$.data.runId') = ?4
                 ORDER BY seq LIMIT 1",
            )?
            .query_row(
                rusqlite::params![
                    types,
                    thread.machine_id.as_str(),
                    thread.thread_id.as_str(),
                    run
                ],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
        })?;
        let Some((seq, data)) = row else {
            return Ok(None);
        };
        Ok(Some(stored_event(seq, &data)?))
    }

    /// Reports each running session on a linked node that no task or lead owns, once it was so for `ORPHAN_MS`.
    fn unowned_sessions(&self, now: i64) -> Result<(), StoreError> {
        let mut seen = HashSet::new();
        for thread in self.d.store.threads_running()? {
            let r = ThreadRef {
                machine_id: thread.machine_id.clone(),
                thread_id: thread.thread_id.clone(),
            };
            if !self.d.ports.is_connected(&r.machine_id) || self.owned_thread(&r)? {
                continue;
            }
            seen.insert(r.clone());
            let report = {
                let mut unowned = self.unowned.lock().unwrap();
                let (since, reported) = unowned.entry(r.clone()).or_insert((now, false));
                let due = !*reported && now - *since >= ORPHAN_MS;
                *reported |= due;
                due.then_some(*since)
            };
            let Some(since) = report else { continue };
            let machine = r.machine_id.as_str();
            tracing::warn!(
                machine,
                thread = r.thread_id.as_str(),
                "sweep: a session nobody owns"
            );
            let data = ThreadOrphanedData {
                title: thread.title.clone(),
                since: Timestamp(iso_ms(since)),
            };
            self.d.events.append(NewEvent {
                at: Timestamp(iso_ms(now)),
                r#type: HubEventType::ThreadOrphaned,
                machine_id: Some(r.machine_id.clone()),
                project_id: Some(thread.project_id.clone()),
                thread_id: Some(r.thread_id.clone()),
                summary: render_summary(&format!(
                    "{machine} runs \"{}\", a session no agent or lead of this hub owns",
                    thread.title
                )),
                data: Some(serde_json::to_value(data)?),
                attention: Some(Attention::Loud),
            })?;
        }
        self.unowned.lock().unwrap().retain(|r, _| seen.contains(r));
        Ok(())
    }

    /// Whether a task (in any state), a lead, a memory refresh, a memory import or an approval check runs in the thread.
    fn owned_thread(&self, r: &ThreadRef) -> Result<bool, StoreError> {
        if self.db(|c| TaskRecords::by_thread(c, r))?.is_some() {
            return Ok(true);
        }
        self.db(|c| {
            c.prepare_cached(
                "SELECT EXISTS (SELECT 1 FROM leads WHERE machine_id = ?1 AND thread_id = ?2)
                   OR EXISTS (SELECT 1 FROM memory_refreshes WHERE machine_id = ?1 AND thread_id = ?2)
                   OR EXISTS (SELECT 1 FROM memory_imports WHERE machine_id = ?1 AND thread_id = ?2)
                   OR EXISTS (SELECT 1 FROM approval_checks WHERE machine_id = ?1 AND thread_id = ?2)",
            )?
            .query_row([r.machine_id.as_str(), r.thread_id.as_str()], |row| {
                row.get(0)
            })
        })
    }

    /// The reported sessions on the machine that no task or lead owns, for the doctor.
    pub fn unowned(&self, machine: &MachineId) -> Vec<Unowned> {
        let mut out: Vec<Unowned> = self
            .unowned
            .lock()
            .unwrap()
            .iter()
            .filter(|(r, (_, reported))| *reported && &r.machine_id == machine)
            .map(|(r, _)| Unowned {
                thread_id: r.thread_id.as_str().to_owned(),
                title: self
                    .d
                    .store
                    .thread_get(r)
                    .ok()
                    .flatten()
                    .map(|t| t.thread.title)
                    .unwrap_or_default(),
            })
            .collect();
        out.sort_by(|a, b| a.thread_id.cmp(&b.thread_id));
        out
    }

    /// The machine's breaker while it is open, for the doctor.
    pub fn recovery_paused_on(&self, machine: &MachineId) -> Option<Paused> {
        self.breakers.lock().unwrap().paused(machine)
    }

    /// Counts a death toward its machine's breaker; what opened, if this opened it. A node going away, a slept
    /// machine or a failure a resume can't fix never counts.
    pub(super) fn count_death(&self, task: &Task, kind: Kind) -> Option<Opened> {
        if !matches!(kind, Kind::Exited | Kind::Stalled) {
            return None;
        }
        let now = now_ms(self.d.clock.as_ref());
        self.breakers
            .lock()
            .unwrap()
            .death(&task.project_ref.machine_id, &task.task_id, now)
    }

    /// Whether the task waits on its machine's breaker.
    pub(super) fn held(&self, task: &Task) -> bool {
        self.breakers
            .lock()
            .unwrap()
            .holds(&task.project_ref.machine_id, &task.task_id)
    }

    /// A dead task about to resume waits instead while its machine's breaker is open, and says so.
    pub(super) fn hold_if_paused(
        &self,
        task_id: &TaskId,
        machine: &MachineId,
    ) -> Result<(), StoreError> {
        let Some(stored) = self.db(|c| TaskRecords::get(c, task_id))? else {
            return Ok(());
        };
        let recovering = stored.task.state == TaskState::Queued
            && stored
                .task
                .recovery
                .as_ref()
                .is_some_and(|r| r.next_at.is_some());
        let paused = {
            let mut breakers = self.breakers.lock().unwrap();
            if !recovering || !breakers.hold(machine, task_id) {
                return Ok(());
            }
            breakers.paused(machine)
        };
        let Some(paused) = paused else { return Ok(()) };
        let reason = format!(
            "recovering: automatic recovery is paused on {} after {} agents died there; resumes after {}",
            machine.as_str(),
            paused.opened_by.len(),
            clock_time(paused.until_ms)
        );
        self.queue(&stored, "recover", &reason)?;
        Ok(())
    }

    /// The breaker on `machine` opened: every dead agent there waiting to resume now waits on it, and the leads of
    /// those agents and of the ones that opened it are told, once each.
    pub(super) fn recovery_paused(
        self: &Arc<Self>,
        machine: &MachineId,
        opened: &Opened,
    ) -> Result<(), StoreError> {
        for stored in self.db(TaskRecords::queued)? {
            if &stored.task.project_ref.machine_id == machine {
                self.hold_if_paused(&stored.task.task_id, machine)?;
            }
        }
        let held = self
            .breakers
            .lock()
            .unwrap()
            .paused(machine)
            .map(|p| p.held)
            .unwrap_or_default();
        let mut leads: BTreeMap<String, (ProjectRef, Vec<TaskId>)> = BTreeMap::new();
        for task_id in opened.task_ids.iter().chain(&held) {
            let Some(stored) = self.db(|c| TaskRecords::get(c, task_id))? else {
                continue;
            };
            let r = stored.task.project_ref;
            let entry = leads
                .entry(format!(
                    "{}/{}",
                    r.machine_id.as_str(),
                    r.project_id.as_str()
                ))
                .or_insert_with(|| (r, Vec::new()));
            if held.contains(task_id) && !entry.1.contains(task_id) {
                entry.1.push(task_id.clone());
            }
        }
        let summary = format!(
            "automatic recovery paused on {}: {} agents died there within {} min ({})",
            machine.as_str(),
            opened.task_ids.len(),
            super::breaker::WINDOW_MS / 60_000,
            list(&opened.task_ids)
        );
        tracing::warn!(
            machine = machine.as_str(),
            summary,
            "tasks: machine breaker open"
        );
        self.breaker_event(
            machine,
            &summary,
            RecoveryPausedData {
                paused: true,
                task_ids: Some(opened.task_ids.clone()),
                until: Some(Timestamp(iso_ms(opened.until_ms))),
            },
        )?;
        for (r, waiting) in leads.into_values() {
            let text = paused_lines(
                machine.as_str(),
                &opened.task_ids,
                opened.until_ms,
                &waiting,
            );
            self.d.ports.wake(&r, WakeKind::RecoveryPaused, text);
        }
        self.retry_at(opened.until_ms);
        Ok(())
    }

    /// Closes the machine's breaker, if open: `completed`, an agent there that got its work done, or its quiet
    /// spell is over. The agents it held resume with the next run of the queue.
    pub(super) fn close_breaker(
        &self,
        machine: &MachineId,
        completed: Option<&Task>,
    ) -> Result<(), StoreError> {
        let Some(held) = self.breakers.lock().unwrap().close(machine) else {
            return Ok(());
        };
        let why = match completed {
            Some(t) => format!("{} completed there", t.task_id.as_str()),
            None => format!(
                "no agent died there for {} min",
                super::breaker::QUIET_MS / 60_000
            ),
        };
        let summary = format!(
            "automatic recovery resumes on {}: {why}{}",
            machine.as_str(),
            match held.as_slice() {
                [] => String::new(),
                ids => format!(
                    "; {} resume{}",
                    list(ids),
                    if ids.len() == 1 { "s" } else { "" }
                ),
            }
        );
        tracing::info!(
            machine = machine.as_str(),
            summary,
            "tasks: machine breaker closed"
        );
        self.breaker_event(
            machine,
            &summary,
            RecoveryPausedData {
                paused: false,
                task_ids: None,
                until: None,
            },
        )
    }

    /// Closes every breaker whose quiet spell is over. The caller runs the queue.
    pub(super) fn close_quiet_breakers(&self, now: i64) {
        let quiet = self.breakers.lock().unwrap().quiet(now);
        for machine in quiet {
            if let Err(error) = self.close_breaker(&machine, None) {
                tracing::warn!(%error, "tasks: breaker close not recorded");
            }
        }
    }

    fn breaker_event(
        &self,
        machine: &MachineId,
        summary: &str,
        data: RecoveryPausedData,
    ) -> Result<(), StoreError> {
        let paused = data.paused;
        self.d.events.append(NewEvent {
            at: Timestamp(self.now_iso()),
            r#type: HubEventType::MachineRecoveryPaused,
            machine_id: Some(machine.clone()),
            project_id: None,
            thread_id: None,
            summary: render_summary(summary),
            data: Some(serde_json::to_value(data)?),
            attention: paused.then_some(Attention::Loud),
        })?;
        Ok(())
    }

    /// Runs the queue at `at_ms`.
    fn retry_at(self: &Arc<Self>, at_ms: i64) {
        let wait = (at_ms - now_ms(self.d.clock.as_ref())).max(0) as u64;
        let (tasks, sleep) = (
            Arc::downgrade(self),
            self.d.clock.sleep(std::time::Duration::from_millis(wait)),
        );
        tokio::spawn(async move {
            sleep.await;
            if let Some(tasks) = tasks.upgrade() {
                tasks.retry_later();
            }
        });
    }

    /// At hub start: each machine's breaker as its last `machine.recovery_paused` left it, holding the dead agents
    /// there that wait to resume.
    pub(super) fn restore_breakers(self: &Arc<Self>) {
        let latest: Result<Vec<(i64, String)>, StoreError> = self.db(|c| {
            c.prepare_cached(
                "SELECT created_ms, data FROM events WHERE seq IN
                   (SELECT MAX(seq) FROM events WHERE type = 'machine.recovery_paused' GROUP BY machine_id)",
            )?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect()
        });
        let now = now_ms(self.d.clock.as_ref());
        for (at, data) in latest.unwrap_or_default() {
            let Ok(event) = stored_event(0, &data) else {
                continue;
            };
            let Some(machine) = event.machine_id else {
                continue;
            };
            let Some(Ok(paused)) = event.data.map(serde_json::from_value::<RecoveryPausedData>)
            else {
                continue;
            };
            let until = paused.until.as_ref().and_then(|u| parse_ms(u.as_str()));
            let (true, Some(until)) = (paused.paused, until) else {
                continue;
            };
            let opened = Opened {
                task_ids: paused.task_ids.unwrap_or_default(),
                until_ms: until,
            };
            self.breakers.lock().unwrap().restore(&machine, opened, at);
            for stored in self.db(TaskRecords::queued).unwrap_or_default() {
                if stored.task.project_ref.machine_id == machine {
                    let _ = self.hold_if_paused(&stored.task.task_id, &machine);
                }
            }
            self.retry_at(until.max(now));
        }
    }
}

/// An event as the log stores it, which leaves its seq to the row.
fn stored_event(seq: i64, data: &str) -> Result<HubEvent, StoreError> {
    let mut value: Value = serde_json::from_str(data)?;
    value["seq"] = json!(seq.max(1));
    Ok(serde_json::from_value(value)?)
}

fn render_summary(text: &str) -> String {
    super::render::one_line(text, 200)
}

/// A thread end as the hub's row of the thread says it went, for a run whose end the hub never logged.
fn synthetic_end(
    task: &Task,
    thread: &ThreadRef,
    row: &crate::hub::store::StoredThread,
    now: i64,
) -> HubEvent {
    let t = &row.thread;
    let r#type = match (row.last_run_status.as_deref(), t.status) {
        (Some("usage_limited"), _) => HubEventType::ThreadUsageLimited,
        (_, ThreadStatus::Completed) => HubEventType::ThreadCompleted,
        (_, ThreadStatus::Failed) => HubEventType::ThreadFailed,
        _ => HubEventType::ThreadInterrupted,
    };
    let mut data = serde_json::Map::new();
    data.insert("status".into(), json!(t.status));
    if let Some(run) = &row.last_run_id {
        data.insert("runId".into(), json!(run));
    }
    if let Some(e) = &t.last_error {
        data.insert(
            "error".into(),
            json!({ "class": e.class, "message": e.message }),
        );
    }
    if let Some(end) = t.end_cause {
        data.insert("endCause".into(), json!(end));
    }
    if let Some(at) = &t.usage_limit_reset_at {
        data.insert("usageLimitResetAt".into(), json!(at));
    }
    data.insert("reconciled".into(), json!(true));
    HubEvent {
        seq: EventSeq(Count::unchecked(0)),
        at: Timestamp(iso_ms(now)),
        r#type,
        machine_id: Some(thread.machine_id.clone()),
        project_id: Some(task.project_ref.project_id.clone()),
        thread_id: Some(thread.thread_id.clone()),
        summary: Text::unchecked(String::new()),
        data: Some(Value::Object(data)),
        attention: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The lead reads the breaker once: which agents opened it, which of its own wait, and what it can do.
    #[test]
    fn the_paused_line_names_the_deaths_the_waiting_agents_and_the_way_on() {
        let ids = |s: &[&str]| s.iter().map(|t| TaskId::unchecked(*t)).collect::<Vec<_>>();
        let until = parse_ms("2026-10-25T10:42:00.000Z").unwrap();
        assert_eq!(
            paused_lines(
                "lab-a",
                &ids(&["T1", "T2", "T3"]),
                until,
                &ids(&["T1", "T2"])
            ),
            "- Automatic recovery is paused on lab-a: 3 agents died there within 10 min (T1, T2, T3), claude exiting \
             or stalling each time.\n  > T1, T2 wait to resume; dead agents there resume again at 10:42 UTC if no \
             other dies, or once one there completes. To go on sooner, continue one with message_agent; stop_agent \
             ends it."
        );
        assert!(
            paused_lines("lab-a", &ids(&["T1", "T2", "T3"]), until, &ids(&["T3"]))
                .contains("> T3 waits to resume;")
        );
    }

    #[test]
    fn a_reconciled_end_reads_as_the_row_says() {
        let row: crate::hub::store::StoredThread = serde_json::from_value(json!({
            "machineId": "lab-a", "threadId": "t1", "projectId": "p1", "title": "t1", "status": "failed",
            "headline": "", "latestMessageTail": "", "lastError": { "class": "process_exited",
            "message": "claude was killed by signal 9" }, "endCause": "exited", "lastProgressAt": "2026-10-25T10:00:00.000Z",
            "stale": false, "asOf": "2026-10-25T10:00:00.000Z", "lastRunId": "r1",
        }))
        .unwrap();
        let task: Task = serde_json::from_value(json!({
            "taskId": "T1", "projectRef": { "machineId": "lab-a", "projectId": "p1" }, "workstreamId": "W1",
            "title": "slice", "kind": "read", "prompt": "do it", "state": "running", "attempt": 1,
            "createdAt": "2026-10-25T10:00:00.000Z",
        }))
        .unwrap();
        let thread = ThreadRef {
            machine_id: MachineId::unchecked("lab-a"),
            thread_id: fleetd_contracts::ids::ThreadId::unchecked("t1"),
        };
        let event = synthetic_end(&task, &thread, &row, 0);
        assert_eq!(event.r#type, HubEventType::ThreadFailed);
        let death = super::super::recovery::death(event.r#type, event.data.as_ref(), "lab-a", None);
        assert_eq!(death.kind, Kind::Exited);
        assert_eq!(event.data.unwrap()["runId"], "r1");
    }
}
