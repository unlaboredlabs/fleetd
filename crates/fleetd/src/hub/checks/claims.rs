//! `claim done`: the lead only claims; the hub moves the workstream to verifying, runs its frozen done-when checks in
//! index order, and only all of them passing makes it done. A failure wakes the lead with each failing check's
//! evidence; the third failed claim on a workstream is a false-claim incident.
use super::now_ts;
use super::ports::{ClaimWake, Ports, Refusal, invalid, not_found};
use super::records::{ClaimFilter, ClaimRecords};
use super::render::failed_claim_evidence;
use super::runner::{CheckContext, CheckRunner, ran_by_of};
use crate::clock::Clock;
use crate::hub::estimates::Estimates;
use crate::hub::incidents::{IncidentInput, Incidents};
use crate::hub::orders::open_work::{CLOSED_ON_PURPOSE, Item, OpenWork, ids, listed};
use crate::hub::store::{EventLog, NewEvent, StoreError};
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::ids::Timestamp;
use fleetd_contracts::ledger::{CheckSpec, Workstream, WorkstreamId, WorkstreamState};
use fleetd_contracts::prim::{Count, List, Text};
use fleetd_contracts::verification::{
    CheckOutcome, CheckResult, Claim, ClaimId, ClaimOutcome, IncidentClass,
};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::task::{AbortHandle, JoinHandle};

/// Under the node's 30 s answer timeout for lead calls; slower claims report through a wake.
pub const INLINE_WAIT: Duration = Duration::from_secs(20);
pub const FALSE_CLAIM_AT: usize = 3;
/// Same text as `playbooks::finish_all_rules::FINISH_ALL_IDLE`.
const FINISH_ALL_IDLE: &str = "finish-all: nothing left with a value source";

/// `claim_done`'s answer; the lead-call result is this with `op: "claim_done"`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimDoneOutcome {
    pub claim_id: ClaimId,
    pub workstream_id: WorkstreamId,
    pub state: WorkstreamState,
    /// Present when every check finished within the call.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claim: Option<Claim>,
    pub next: String,
}

fn same_project(a: &ProjectRef, b: &ProjectRef) -> bool {
    a.machine_id == b.machine_id && a.project_id == b.project_id
}

fn store_refusal(e: StoreError) -> Refusal {
    super::ports::internal(e)
}

fn state_name(s: WorkstreamState) -> String {
    serde_json::to_value(s)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

/// A claim that closes over unlanded work on purpose: why, and the work the lead was shown when it claimed.
struct CloseOver {
    why: String,
    seen: Vec<Item>,
}

pub struct Claims {
    records: Arc<ClaimRecords>,
    runner: Arc<CheckRunner>,
    ports: Arc<dyn Ports>,
    events: Arc<EventLog>,
    estimates: Arc<Estimates>,
    incidents: Arc<Incidents>,
    clock: Arc<dyn Clock>,
    inline_wait: Duration,
    /// The claim running per workstream; a new claim aborts it.
    running: Mutex<HashMap<WorkstreamId, AbortHandle>>,
    // Workstream state changes go through this, so a claim's start and another's end never interleave.
    lock: tokio::sync::Mutex<()>,
}

impl Claims {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        records: Arc<ClaimRecords>,
        runner: Arc<CheckRunner>,
        ports: Arc<dyn Ports>,
        events: Arc<EventLog>,
        estimates: Arc<Estimates>,
        incidents: Arc<Incidents>,
        clock: Arc<dyn Clock>,
        inline_wait: Duration,
    ) -> Self {
        Self {
            records,
            runner,
            ports,
            events,
            estimates,
            incidents,
            clock,
            inline_wait,
            running: Mutex::default(),
            lock: Default::default(),
        }
    }

    pub fn ports(&self) -> &Arc<dyn Ports> {
        &self.ports
    }

    pub fn records(&self) -> &Arc<ClaimRecords> {
        &self.records
    }

    pub fn get(&self, claim_id: &ClaimId) -> Result<Option<Claim>, StoreError> {
        self.records.get(claim_id)
    }

    /// Finished claims, newest first.
    pub fn list(&self, filter: &ClaimFilter) -> Result<Vec<Claim>, StoreError> {
        self.records.list(filter)
    }

    fn emit(
        &self,
        w: &Workstream,
        r#type: HubEventType,
        summary: String,
        data: serde_json::Value,
    ) -> Result<(), StoreError> {
        self.events.append(NewEvent {
            at: now_ts(self.clock.as_ref()),
            r#type,
            machine_id: Some(w.project_ref.machine_id.clone()),
            project_id: Some(w.project_ref.project_id.clone()),
            thread_id: None,
            summary,
            data: Some(data),
            attention: None,
        })?;
        Ok(())
    }

    async fn run_checks(&self, w: &Workstream, claim_id: &ClaimId) -> Vec<CheckResult> {
        let mut results: Vec<CheckResult> = Vec::new();
        let done_when = w
            .brief
            .as_ref()
            .map(|b| b.done_when.clone())
            .unwrap_or_default();
        for (index, spec) in done_when.iter().enumerate() {
            let index = index as u32;
            // Only these are worth a judge's or the human's time once an earlier check failed.
            let asks_someone = matches!(spec, CheckSpec::Judge { .. } | CheckSpec::Human { .. });
            if asks_someone && results.iter().any(|r| r.result != CheckOutcome::Pass) {
                results.push(CheckResult {
                    check_index: Count::unchecked(i64::from(index)),
                    spec: spec.clone(),
                    result: CheckOutcome::Error,
                    evidence: Text::unchecked("not run: a judge or the human is asked only once every earlier check passes"),
                    exit_code: None,
                    ran_by: ran_by_of(spec),
                    at: now_ts(self.clock.as_ref()),
                });
                continue;
            }
            results.push(
                self.runner
                    .run(
                        &CheckContext {
                            workstream: w,
                            claim_id,
                        },
                        index,
                        spec,
                    )
                    .await,
            );
        }
        results
    }

    /// Stores the claim and acts on it. The workstream is re-read: it may have been stopped while checks ran. Runs with
    /// the lock held and nothing awaited, so a superseding claim cannot cut it off halfway.
    fn conclude(&self, claim: &Claim, close_over: Option<&CloseOver>) -> Result<(), StoreError> {
        self.records.finish(claim)?;
        let Some(w) = self.ports.workstream(&claim.workstream_id) else {
            return Ok(());
        };
        // A research judge's numbers already made it done, with its verdict.
        if w.state == WorkstreamState::Done {
            return Ok(());
        }
        let label = format!("{} on {}", claim.claim_id, w.workstream_id);
        if claim.outcome == ClaimOutcome::Pass {
            if w.state != WorkstreamState::Verifying {
                return Ok(());
            }
            // Write work spawned while it verified (a review's fixes) would be dropped once it is done: it stays open.
            // Closing over work on purpose covers only the work the lead was shown when it claimed.
            let work = self.ports.open_work(&w);
            let unseen: Vec<OpenWork> = match close_over {
                Some(c) => work
                    .iter()
                    .filter(|o| !c.seen.contains(&o.item))
                    .cloned()
                    .collect(),
                None => work.clone(),
            };
            if !unseen.is_empty() {
                return self.hold(&w, claim, unseen);
            }
            let done = Workstream {
                state: WorkstreamState::Done,
                updated_at: now_ts(self.clock.as_ref()),
                ..w.clone()
            };
            self.ports.put_workstream(&done);
            self.emit(
                &w,
                HubEventType::ClaimPassed,
                format!("{label} passed: all {} checks", claim.results.len()),
                serde_json::json!({ "claimId": claim.claim_id, "workstreamId": w.workstream_id }),
            )?;
            let mut data =
                serde_json::json!({ "workstreamId": w.workstream_id, "claimId": claim.claim_id });
            let mut summary = format!("{} is done: {}", w.workstream_id, w.title);
            if let Some(why) = close_over
                .map(|c| c.why.as_str())
                .filter(|_| !work.is_empty())
            {
                let reason = format!("{CLOSED_ON_PURPOSE}{why} (dropping {})", listed(&work));
                summary = format!("{} is done, {reason}", w.workstream_id);
                data["reason"] = serde_json::json!(reason);
            }
            self.emit(&w, HubEventType::WorkstreamDone, summary, data)?;
            return self.estimates.record_done(&w.workstream_id);
        }
        let failures: Vec<CheckResult> = claim
            .results
            .iter()
            .filter(|r| r.result != CheckOutcome::Pass)
            .cloned()
            .collect();
        self.emit(
            &w,
            HubEventType::ClaimFailed,
            format!(
                "{label} failed: {} of {} checks did not pass",
                failures.len(),
                claim.results.len()
            ),
            serde_json::json!({
                "claimId": claim.claim_id,
                "workstreamId": w.workstream_id,
                "failing": failures.iter().map(|r| r.check_index.get()).collect::<Vec<_>>(),
            }),
        )?;
        self.ports.wake(
            &w.project_ref,
            ClaimWake::Failed {
                claim_id: claim.claim_id.clone(),
                workstream_id: w.workstream_id.clone(),
                failures,
            },
        );
        let failed = self.records.list(&ClaimFilter {
            workstream_id: Some(w.workstream_id.clone()),
            outcome: Some(ClaimOutcome::Fail),
            limit: 20,
            ..Default::default()
        })?;
        if failed.len() == FALSE_CLAIM_AT {
            self.incidents.record(IncidentInput {
                class: IncidentClass::FalseClaim,
                project_ref: w.project_ref.clone(),
                workstream_id: Some(w.workstream_id.clone()),
                task_id: None,
                evidence: failed
                    .iter()
                    .rev()
                    .map(|c| failed_claim_evidence(&c.claim_id, &c.results))
                    .collect(),
            })?;
        }
        Ok(())
    }

    /// Every check passed while write work has not landed: back to running, recorded with why, and the lead is told.
    fn hold(&self, w: &Workstream, claim: &Claim, work: Vec<OpenWork>) -> Result<(), StoreError> {
        self.ports.put_workstream(&Workstream {
            state: WorkstreamState::Running,
            updated_at: now_ts(self.clock.as_ref()),
            ..w.clone()
        });
        let reason = format!("work that hasn't landed is still open: {}", listed(&work));
        self.emit(
            w,
            HubEventType::WorkstreamState,
            format!(
                "{} stays open: {} passed, but {reason}",
                w.workstream_id, claim.claim_id
            ),
            serde_json::json!({
                "workstreamId": w.workstream_id,
                "state": "running",
                "claimId": claim.claim_id,
                "reason": reason,
            }),
        )?;
        self.ports.wake(
            &w.project_ref,
            ClaimWake::Held {
                claim_id: claim.claim_id.clone(),
                workstream_id: w.workstream_id.clone(),
                work,
            },
        );
        Ok(())
    }

    async fn run_claim(
        self: Arc<Self>,
        w: Workstream,
        claim_id: ClaimId,
        by: String,
        at: Timestamp,
        close_over: Option<CloseOver>,
    ) -> Claim {
        let results = self.run_checks(&w, &claim_id).await;
        let outcome = if results.iter().all(|r| r.result == CheckOutcome::Pass) {
            ClaimOutcome::Pass
        } else {
            ClaimOutcome::Fail
        };
        let claim = Claim {
            claim_id,
            workstream_id: w.workstream_id.clone(),
            by,
            at,
            results: List::unchecked(results),
            outcome,
        };
        // Waiting for the lock stays abortable, so a superseded claim gives way; once it holds it, it finishes.
        let _held = self.lock.lock().await;
        if let Err(error) = self.conclude(&claim, close_over.as_ref()) {
            tracing::warn!(claim_id = %claim.claim_id, %error, "claim not concluded");
        }
        claim
    }

    async fn start(
        self: &Arc<Self>,
        workstream_id: &WorkstreamId,
        by: &str,
        project_ref: Option<&ProjectRef>,
        close_over: Option<&str>,
    ) -> Result<(ClaimId, JoinHandle<Claim>, Vec<OpenWork>), Refusal> {
        let _held = self.lock.lock().await;
        let not_found = || {
            not_found(
                format!("There is no workstream {workstream_id}."),
                Some("Use a workstream id from your digest."),
            )
        };
        let Some(w) = self.ports.workstream(workstream_id) else {
            return Err(not_found());
        };
        if project_ref.is_some_and(|r| !same_project(&w.project_ref, r)) {
            return Err(not_found());
        }
        match w.state {
            WorkstreamState::Done => {
                return Err(invalid(
                    format!("{workstream_id} is already done."),
                    Some("Open a new intent if there is more to do."),
                ));
            }
            WorkstreamState::Idle
                if w.playbook
                    .as_ref()
                    .is_some_and(|p| p.as_str().starts_with("finish-all@")) =>
            {
                return Err(invalid(
                    format!(
                        "{workstream_id} is idle: {FINISH_ALL_IDLE}. A finish-all run ends idle, not done."
                    ),
                    Some("Nothing to claim. Call `inventory` again when new work comes in."),
                ));
            }
            WorkstreamState::Stopped | WorkstreamState::Failed => {
                return Err(invalid(
                    format!(
                        "{workstream_id} is {}; there is nothing to claim.",
                        state_name(w.state)
                    ),
                    None,
                ));
            }
            _ => {}
        }
        let work = self.ports.open_work(&w);
        if close_over.is_none() && !work.is_empty() {
            return Err(invalid(
                format!(
                    "{workstream_id} has write work that hasn't landed: {} (ids, for tools only: {}). It is done only once that lands.",
                    listed(&work),
                    ids(&work)
                ),
                Some(
                    "Say so in chat in one line, in plain words, no ids. Let it land, then claim again. If some of it is truly not needed or failed for good, claim with closeOver set to why, and say why in chat.",
                ),
            ));
        }
        if w.brief.is_none() {
            return Err(invalid(
                format!(
                    "{workstream_id} has no frozen brief, so it has no done-when checks to run."
                ),
                Some(&format!(
                    "Register its brief with `brief` for {workstream_id} first."
                )),
            ));
        }
        let at = now_ts(self.clock.as_ref());
        let claim_id = self
            .records
            .start(workstream_id, &w.project_ref)
            .map_err(store_refusal)?;
        let verifying = Workstream {
            state: WorkstreamState::Verifying,
            updated_at: at.clone(),
            ..w.clone()
        };
        if w.state != WorkstreamState::Verifying {
            self.ports.put_workstream(&verifying);
            self.emit(
                &w,
                HubEventType::WorkstreamState,
                format!("{workstream_id} is verifying ({claim_id})"),
                serde_json::json!({ "workstreamId": workstream_id, "state": "verifying", "claimId": claim_id }),
            )
            .map_err(store_refusal)?;
        }
        let handle = tokio::spawn(self.clone().run_claim(
            verifying,
            claim_id.clone(),
            by.to_owned(),
            at,
            close_over.map(|why| CloseOver {
                why: why.to_owned(),
                seen: work.iter().map(|o| o.item.clone()).collect(),
            }),
        ));
        // This claim supersedes one still running on the same workstream.
        if let Some(previous) = self
            .running
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(workstream_id.clone(), handle.abort_handle())
        {
            previous.abort();
        }
        // What a closeOver claim may drop: the work the lead was shown.
        let shown = if close_over.is_some() {
            work
        } else {
            Vec::new()
        };
        Ok((claim_id, handle, shown))
    }

    /// Starts a claim on the workstream and waits up to the inline wait for its checks. With `project_ref`, refuses
    /// another project's workstream. A new claim supersedes one still running on the same workstream.
    /// With `close_over`, the workstream may close over its unlanded write work, which is then dropped with that why.
    pub async fn claim_done(
        self: &Arc<Self>,
        workstream_id: &WorkstreamId,
        by: &str,
        project_ref: Option<&ProjectRef>,
        close_over: Option<&str>,
    ) -> Result<ClaimDoneOutcome, Refusal> {
        let (claim_id, mut handle, closing_over) = self
            .start(workstream_id, by, project_ref, close_over)
            .await?;
        let inline = tokio::select! {
            joined = &mut handle => Some(joined),
            () = self.clock.sleep(self.inline_wait) => None,
        };
        match inline {
            Some(Ok(claim)) => {
                self.forget_running(workstream_id, &handle);
                // As stored: a workstream stopped while its checks ran stays stopped.
                let state = self
                    .ports
                    .workstream(workstream_id)
                    .map_or(WorkstreamState::Verifying, |w| w.state);
                let next = if claim.outcome == ClaimOutcome::Pass
                    && state == WorkstreamState::Running
                {
                    format!(
                        "Every check passed, but {workstream_id} stays open: write work of it hasn't landed (see the wake). Say so in chat in plain words; claim again once it lands."
                    )
                } else if claim.outcome == ClaimOutcome::Pass
                    && state == WorkstreamState::Done
                    && !closing_over.is_empty()
                {
                    format!(
                        "{workstream_id} is done: every check passed, and it closed on purpose over {}, which is dropped. Say in chat, in plain words, what was dropped and why. Spawn nothing more for it.",
                        listed(&closing_over)
                    )
                } else if claim.outcome == ClaimOutcome::Pass {
                    format!(
                        "{workstream_id} is {}: every check passed. Spawn nothing more for it.",
                        state_name(state)
                    )
                } else {
                    let failing: Vec<String> = claim
                        .results
                        .iter()
                        .filter(|r| r.result != CheckOutcome::Pass)
                        .map(|r| format!("done:{}", r.check_index.get()))
                        .collect();
                    format!(
                        "{} did not pass; the evidence is in each result. Fix what failed, then claim again.",
                        failing.join(", ")
                    )
                };
                Ok(ClaimDoneOutcome {
                    claim_id,
                    workstream_id: workstream_id.clone(),
                    state,
                    claim: Some(claim),
                    next,
                })
            }
            // Superseded by a newer claim before it finished.
            Some(Err(_)) => Ok(ClaimDoneOutcome {
                next: format!("{claim_id} was superseded by a newer claim on {workstream_id}."),
                claim_id,
                workstream_id: workstream_id.clone(),
                state: WorkstreamState::Verifying,
                claim: None,
            }),
            None => {
                // Still running: a failure wakes the lead anyway; a pass needs telling, since this call has returned.
                let this = self.clone();
                let (id, ws) = (claim_id.clone(), workstream_id.clone());
                tokio::spawn(async move {
                    let joined = (&mut handle).await;
                    this.forget_running(&ws, &handle);
                    if let Ok(claim) = joined
                        && claim.outcome == ClaimOutcome::Pass
                        && let Some(w) = this.ports.workstream(&ws)
                        && w.state == WorkstreamState::Done
                    {
                        this.ports.wake(
                            &w.project_ref,
                            ClaimWake::Passed {
                                claim_id: id,
                                workstream_id: ws,
                            },
                        );
                    }
                });
                Ok(ClaimDoneOutcome {
                    next: format!(
                        "{claim_id} is still running its checks (a judge, the human, or a slow command); its outcome arrives in a wake. Carry on with other work."
                    ),
                    claim_id,
                    workstream_id: workstream_id.clone(),
                    state: WorkstreamState::Verifying,
                    claim: None,
                })
            }
        }
    }

    fn forget_running(&self, workstream_id: &WorkstreamId, handle: &JoinHandle<Claim>) {
        let mut running = self.running.lock().unwrap_or_else(|p| p.into_inner());
        if running
            .get(workstream_id)
            .is_some_and(|h| h.id() == handle.id())
        {
            running.remove(workstream_id);
        }
    }
}
