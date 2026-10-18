//! Steer receipts on the node. A send the hub tagged as a steer is tracked from dispatch to its end, and each stage is
//! decided from claude's own frames: delivered on `command_lifecycle started` (how it was taken in), acknowledged when
//! an assistant text after that names its `S<n>`, unacknowledged when its run ends without one, withdrawn on a
//! successful `cancel_async_message`, failed when it ended before claude took it in. Only tagged sends are tracked,
//! so an older hub, which tags nothing, never receives a `MachineEvent::Steer` it cannot decode.
use std::time::Duration;

use fleetd_contracts::ids::{ThreadId, Timestamp};
use fleetd_contracts::prim::{NonEmpty, Text};
use fleetd_contracts::sessions::{RunStatus, SendNow, SessionOutput};
use fleetd_contracts::steer::{DeliveredHow, SteerId, SteerReceipt, SteerStage, names_steer};
use tokio::sync::oneshot;

use super::{Reply, SessionService, now};
use crate::node::runner::{ExitInfo, RunOutcome, SessionCommand};
use crate::node::util::head_utf16;

/// How long a mode-`now` send waits for claude's answer to its stop before replying without it (measured: 4 ms).
pub(super) const SEND_NOW_WAIT: Duration = Duration::from_secs(2);
const WITHDRAW_WAIT: Duration = Duration::from_secs(3);
const EXCERPT: usize = 200;

pub(super) struct SteerTrack {
    session_id: String,
    steer_id: SteerId,
    /// Another run was active when it was sent: delivered at a boundary rather than as a fresh turn.
    behind: bool,
    /// claude stopped the running step for it (`send_now: stopped`), and the step's title.
    stopped: Option<Option<String>>,
    delivered: bool,
    seen_at: Option<Timestamp>,
    /// The first assistant text after delivery, for an unacknowledged receipt.
    first: Option<(String, String)>,
}

impl SessionService {
    /// Starts tracking a tagged send before it is dispatched, so its first frame finds it.
    pub(super) fn track_steer(&self, id: &str, run_id: &str, steer_id: SteerId, behind: bool) {
        self.st().steers.insert(
            run_id.to_owned(),
            SteerTrack {
                session_id: id.to_owned(),
                steer_id,
                behind,
                stopped: None,
                delivered: false,
                seen_at: None,
                first: None,
            },
        );
    }

    pub(super) fn steer_delivered(&self, run_id: &str, joined: bool) {
        let receipt = {
            let mut st = self.st();
            let Some(t) = st.steers.get_mut(run_id).filter(|t| !t.delivered) else {
                return;
            };
            t.delivered = true;
            let how = delivered_how(joined, t.stopped.is_some(), t.behind);
            let mut r = receipt(t, run_id, SteerStage::Delivered);
            r.how = Some(how);
            r.stopped_tool = t.stopped.clone().flatten().map(|s| clip(&s));
            r
        };
        self.emit_steer(receipt);
    }

    pub(super) fn steer_seen(&self, run_ids: &[String]) {
        let mut st = self.st();
        for run_id in run_ids {
            if let Some(t) = st.steers.get_mut(run_id).filter(|t| t.delivered) {
                t.seen_at.get_or_insert_with(now);
            }
        }
    }

    pub(super) fn steer_send_now(
        &self,
        run_id: &str,
        outcome: SendNow,
        stopped_tool: Option<String>,
    ) {
        let mut st = self.st();
        if let Some(waiter) = st.send_now_waiters.remove(run_id) {
            let _ = waiter.send(outcome);
        }
        if let (SendNow::Stopped, Some(t)) = (outcome, st.steers.get_mut(run_id)) {
            t.stopped = Some(stopped_tool);
        }
    }

    pub(super) fn steer_withdrawn(&self, run_id: &str, cancelled: bool, by_stop: bool) {
        let track = {
            let mut st = self.st();
            if let Some(waiter) = st.withdraw_waiters.remove(run_id) {
                let _ = waiter.send(cancelled);
            }
            if cancelled {
                st.steers.remove(run_id)
            } else {
                None
            }
        };
        if let Some(t) = track {
            let mut r = receipt(&t, run_id, SteerStage::Withdrawn);
            if by_stop {
                r.reason = Some(Text::unchecked(
                    "the turn it waited on was stopped before it took this in",
                ));
            }
            self.emit_steer(r);
        }
    }

    /// The session's claude exited: every steer still open on it gets its final receipt, and is no longer tracked.
    pub(super) fn steers_exited(&self, id: &str, exit: &ExitInfo) {
        let open: Vec<(String, SteerTrack)> = {
            let mut st = self.st();
            let runs: Vec<String> = st
                .steers
                .iter()
                .filter(|(_, t)| t.session_id == id)
                .map(|(r, _)| r.clone())
                .collect();
            runs.into_iter()
                .filter_map(|r| st.steers.remove(&r).map(|t| (r, t)))
                .collect()
        };
        for (run_id, t) in open {
            let r = if t.delivered {
                let mut r = receipt(&t, &run_id, SteerStage::Unacknowledged);
                if let Some((message_id, text)) = &t.first {
                    r.message_id = NonEmpty::new(message_id.as_str()).ok();
                    r.excerpt = Some(clip(text));
                }
                r
            } else {
                let mut r = receipt(&t, &run_id, SteerStage::Failed);
                let code = exit
                    .code
                    .map_or_else(|| "a signal".to_owned(), |c| format!("code {c}"));
                r.reason = Text::new(format!("claude exited ({code}) before taking it in")).ok();
                r
            };
            self.emit_steer(r);
        }
    }

    /// An assistant text in session `id`: it acknowledges every delivered steer it names.
    pub(super) fn steer_text(&self, id: &str, message_id: &str, text: &str) {
        let acked: Vec<SteerReceipt> = {
            let mut st = self.st();
            let mut acked = Vec::new();
            st.steers.retain(|run_id, t| {
                if t.session_id != id || !t.delivered {
                    return true;
                }
                if names_steer(text, &t.steer_id) {
                    let mut r = receipt(t, run_id, SteerStage::Acknowledged);
                    r.message_id = NonEmpty::new(message_id).ok();
                    r.excerpt = Some(clip(text));
                    acked.push(r);
                    return false;
                }
                t.first
                    .get_or_insert_with(|| (message_id.to_owned(), text.to_owned()));
                true
            });
            acked
        };
        for r in acked {
            self.emit_steer(r);
        }
    }

    /// The steer's run ended (and the node is not retrying it).
    pub(super) fn steer_ended(&self, run_id: &str, outcome: &RunOutcome) {
        let Some(t) = self.st().steers.remove(run_id) else {
            return;
        };
        let r = if t.delivered {
            let mut r = receipt(&t, run_id, SteerStage::Unacknowledged);
            if let Some((message_id, text)) = &t.first {
                r.message_id = NonEmpty::new(message_id.as_str()).ok();
                r.excerpt = Some(clip(text));
            }
            r
        } else {
            let mut r = receipt(&t, run_id, SteerStage::Failed);
            let why = match outcome {
                RunOutcome::Failed(f) => f.message.to_string(),
                _ => "claude dropped it before taking it in".into(),
            };
            r.reason = Text::new(head_utf16(&why, 400)).ok();
            r
        };
        self.emit_steer(r);
    }

    /// A tagged send that never reached claude.
    pub(super) fn steer_failed(&self, run_id: &str, why: &str) {
        let Some(t) = self.st().steers.remove(run_id) else {
            return;
        };
        let mut r = receipt(&t, run_id, SteerStage::Failed);
        r.reason = Text::new(head_utf16(why, 400)).ok();
        self.emit_steer(r);
    }

    fn emit_steer(&self, receipt: SteerReceipt) {
        let st = self.st();
        match self.store().steer_receipt(&receipt) {
            Ok(frame) => st.machine(frame),
            Err(e) => tracing::warn!(error = %e, "cannot log a steer receipt"),
        }
    }

    /// `cancel_async_message` for a send claude still holds; `cancelled: false` once it has started.
    pub(super) async fn withdraw(&self, id: &str, run_id: &str) -> Reply {
        self.session(id)?;
        let queued = self
            .store()
            .runs(id)?
            .iter()
            .any(|r| r.id == run_id && r.status == RunStatus::Queued);
        let commands = self.st().live.get(id).map(|l| l.commands.clone());
        let (Some(commands), true) = (commands, queued) else {
            return Ok(SessionOutput::Withdrawn { cancelled: false });
        };
        let (tx, rx) = oneshot::channel();
        self.st().withdraw_waiters.insert(run_id.to_owned(), tx);
        let command = SessionCommand::Withdraw {
            run_id: run_id.to_owned(),
        };
        let cancelled = if commands.send(command).await.is_ok() {
            tokio::time::timeout(WITHDRAW_WAIT, rx)
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or(false)
        } else {
            false
        };
        self.st().withdraw_waiters.remove(run_id);
        Ok(SessionOutput::Withdrawn { cancelled })
    }
}

fn delivered_how(joined: bool, stopped: bool, behind: bool) -> DeliveredHow {
    match (joined, stopped, behind) {
        (true, _, _) => DeliveredHow::Joined,
        (_, true, _) => DeliveredHow::Stopped,
        (_, _, true) => DeliveredHow::Boundary,
        _ => DeliveredHow::Turn,
    }
}

fn receipt(t: &SteerTrack, run_id: &str, stage: SteerStage) -> SteerReceipt {
    SteerReceipt {
        session_id: ThreadId::unchecked(t.session_id.as_str()),
        run_id: NonEmpty::unchecked(run_id),
        steer_id: t.steer_id.clone(),
        stage,
        at: now(),
        how: None,
        stopped_tool: None,
        seen_at: t.seen_at.clone(),
        message_id: None,
        excerpt: None,
        reason: None,
    }
}

fn clip(text: &str) -> Text<0, 200> {
    Text::new(head_utf16(text.trim(), EXCERPT)).unwrap_or_else(|_| Text::unchecked(""))
}
