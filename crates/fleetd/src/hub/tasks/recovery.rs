//! Automatic recovery: a task whose run died (its node stopped, claude was killed, a stall) is resumed in its own
//! thread and worktree with a note to continue, after a delay; one that keeps dying for a real reason is not, and
//! fails with a line for its lead to decide on. Pure: `mod.rs` reads the facts and carries the action out.
//!
//! Waiting is not death: a run waiting on a person (`thread.waiting`), a usage limit (`thread.usage_limited`) or the
//! node's own retry never ends here, and a write task that pushed and ended its turn for CI or the train completed.
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::prim::{Count, Int, Text};
use fleetd_contracts::sessions::RunEnd;
use fleetd_contracts::tasks::TaskRecovery;
use serde_json::Value;

use crate::hub::store::{iso_ms, parse_ms};

use super::render::one_line;

/// Automatic recoveries per task; the death after the last one fails it. `FLEETD_RECOVERY_MAX` sets it for the lab.
pub const RECOVERY_MAX: i64 = 3;
/// A node back from a stop or a crash gets this long to settle (its other runs report in) before a task resumes.
const NODE_SETTLE_MS: i64 = 30_000;
const NODE_JITTER_MS: i64 = 10_000;
const MINUTE_MS: i64 = 60_000;
/// A resumed run that dies sooner did nothing, and its death counts twice.
const PRODUCTIVE_MS: i64 = 5 * MINUTE_MS;

pub fn max() -> i64 {
    std::env::var("FLEETD_RECOVERY_MAX")
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .filter(|n| *n >= 0)
        .unwrap_or(RECOVERY_MAX)
}

/// What kind of death a run's end is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// The node went away under it: stopped, crashed, killed or powered off. Never the task's fault.
    NodeLost,
    /// claude exited or was killed with nobody asking.
    Exited,
    /// The watchdog saw no output for too long.
    Stalled,
    /// The machine slept, or the API connection kept failing after the node's own retries.
    Unreachable,
    /// The conversation no longer fits; a resume would only fail again.
    ContextFull,
    /// A failure a resume doesn't fix: the login, a bad request, anything else.
    Fatal,
    /// Not a death: someone stopped it, or nothing says otherwise.
    NotDead,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Death {
    pub kind: Kind,
    /// What the task's result records: the event's own cause, or `stalled`.
    pub reported: Option<RunEnd>,
    /// The cause the recovery records, for an event from a node that sends none too.
    pub cause: RunEnd,
    /// In plain words, for the agent's note and the lead.
    pub text: String,
    pub signature: String,
}

/// Reads a `thread.failed` or `thread.interrupted` event. `last_tool` is the run's last action, for the signature.
pub fn death(
    r#type: HubEventType,
    data: Option<&Value>,
    machine: &str,
    last_tool: Option<&str>,
) -> Death {
    let field = |path: &[&str]| {
        path.iter()
            .try_fold(data?, |v, k| v.get(*k))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    let message = field(&["error", "message"]).unwrap_or_default();
    let class = field(&["error", "class"]).unwrap_or_default();
    let late = data.and_then(|d| d.get("late")).and_then(Value::as_bool) == Some(true);
    let reported = data
        .and_then(|d| d.get("endCause"))
        .and_then(|e| serde_json::from_value::<RunEnd>(e.clone()).ok());
    let stalled = field(&["reason"]).as_deref() == Some("stalled");
    let node = |how: &str| format!("the node on {machine} {how}");
    let by_class = || match class.as_str() {
        "process_exited" => (Kind::Exited, RunEnd::Exited),
        "network" | "overloaded" => (Kind::Unreachable, RunEnd::Failed),
        _ => (Kind::Fatal, RunEnd::Failed),
    };
    // The node's own words for its stop and its restart are the node going away whatever else the event says: an
    // OOM kill of the node, then its restart by systemd, failed 20 tasks with "[process_exited] the node stopped".
    let node_end = reported
        .filter(|e| matches!(e, RunEnd::NodeStopping | RunEnd::NodeRestarted))
        .or(match message.trim() {
            "the node stopped" => Some(RunEnd::NodeStopping),
            "node restarted mid-run" => Some(RunEnd::NodeRestarted),
            _ => None,
        });
    let ((kind, cause), text) = if stalled {
        (
            (Kind::Stalled, RunEnd::Stalled),
            format!("no output for too long: {message}"),
        )
    } else {
        match node_end.or(reported) {
            Some(RunEnd::NodeStopping) => ((Kind::NodeLost, RunEnd::NodeStopping), node("stopped")),
            Some(RunEnd::NodeRestarted) => (
                (Kind::NodeLost, RunEnd::NodeRestarted),
                node("restarted mid-run (a crash, a kill or a power loss)"),
            ),
            Some(RunEnd::MachineSlept) => (
                (Kind::Unreachable, RunEnd::MachineSlept),
                format!("{machine} slept and claude's stream did not come back"),
            ),
            Some(RunEnd::Exited) => ((Kind::Exited, RunEnd::Exited), message.clone()),
            Some(RunEnd::ContextFull) => (
                (Kind::ContextFull, RunEnd::ContextFull),
                "its context is full".to_owned(),
            ),
            Some(RunEnd::Failed) => (by_class(), message.clone()),
            Some(
                end @ (RunEnd::Requested
                | RunEnd::Superseded
                | RunEnd::Completed
                | RunEnd::Limited
                | RunEnd::Stalled),
            ) => ((Kind::NotDead, end), message.clone()),
            // A node that records no cause (like the one on Oct 22): an interrupt reported on the node's
            // return is the node going away.
            None | Some(RunEnd::Unknown) => match r#type {
                HubEventType::ThreadInterrupted if late => {
                    ((Kind::NodeLost, RunEnd::NodeStopping), node("went away"))
                }
                HubEventType::ThreadInterrupted => {
                    ((Kind::NotDead, RunEnd::Requested), message.clone())
                }
                _ => (by_class(), message.clone()),
            },
        }
    };
    let text = match text.trim() {
        "" if kind == Kind::Exited => "claude exited".to_owned(),
        "" => "it failed without saying why".to_owned(),
        t => one_line(t, 200),
    };
    let tool = last_tool
        .map(|t| format!(" while: {}", one_line(t, 120)))
        .unwrap_or_default();
    Death {
        kind,
        reported: if stalled {
            Some(RunEnd::Stalled)
        } else {
            reported
        },
        cause,
        signature: one_line(&format!("{kind:?}: {text}{tool}"), 400),
        text,
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    /// Queue it with the note; it resumes at `recovery.next_at`.
    Resume(TaskRecovery),
    /// Fail it, with why it was not resumed, for its lead to decide.
    Escalate(String),
    /// Fail it plainly: not a death, or nothing is left to recover for.
    Finish,
}

/// `prior` is the task's recovery so far. `stopped`: it must not go on (its workstream is closed, its PR merged or
/// its plan item done). `jitter` is in [0, 1).
pub fn decide(
    death: &Death,
    prior: Option<&TaskRecovery>,
    stopped: bool,
    now_ms: i64,
    jitter: f64,
    max: i64,
) -> Action {
    if death.kind == Kind::NotDead || stopped {
        return Action::Finish;
    }
    let streak = match prior {
        Some(p) if p.signature.as_ref().map(|s| s.as_str()) == Some(death.signature.as_str()) => {
            p.streak.get() + 1
        }
        _ => 1,
    };
    let delay = match death.kind {
        Kind::NodeLost => Ok(NODE_SETTLE_MS + (jitter * NODE_JITTER_MS as f64) as i64),
        Kind::Exited | Kind::Stalled if streak == 1 => Ok(MINUTE_MS),
        Kind::Exited | Kind::Stalled => Err(format!("it died the same way twice: {}", death.text)),
        Kind::Unreachable if streak == 1 => Ok(15 * MINUTE_MS),
        Kind::Unreachable if streak == 2 => Ok(60 * MINUTE_MS),
        Kind::Unreachable => Err(format!("{} ({streak} times in a row)", death.text)),
        Kind::ContextFull => Err(format!("{}; resuming it would fail again", death.text)),
        Kind::Fatal | Kind::NotDead => Err(format!("{}, which resuming won't fix", death.text)),
    };
    let delay = match delay {
        Ok(delay) => delay,
        Err(why) => return Action::Escalate(why),
    };
    let used = prior.map_or(0, |p| p.count.get());
    // A node going away is never the run's doing, however soon it happens.
    let unproductive = death.kind != Kind::NodeLost
        && prior
            .and_then(|p| p.resumed_at.as_ref())
            .and_then(|at| parse_ms(at.as_str()))
            .is_some_and(|at| now_ms - at < PRODUCTIVE_MS);
    let count = used + if unproductive { 2 } else { 1 };
    if count > max {
        return Action::Escalate(format!(
            "it died again ({}) after {used} automatic recover{} of at most {max}",
            death.text,
            if used == 1 { "y" } else { "ies" }
        ));
    }
    // The timed ones spread ±10%, so tasks a single outage cut off don't all resume at once.
    let delay = if death.kind == Kind::NodeLost {
        delay
    } else {
        (delay as f64 * (0.9 + jitter * 0.2)) as i64
    };
    Action::Resume(TaskRecovery {
        count: Count::unchecked(count),
        max: Count::unchecked(max),
        last_cause: death.cause,
        last_cause_text: Text::unchecked(one_line(&death.text, 200)),
        signature: Some(Text::unchecked(death.signature.clone())),
        streak: Int::unchecked(streak),
        next_at: Some(fleetd_contracts::ids::Timestamp(iso_ms(now_ms + delay))),
        resumed_at: prior.and_then(|p| p.resumed_at.clone()),
    })
}

/// The queued reason while it waits to resume: "recovering: the node on forge stopped; resumes at 10:12:40 UTC
/// (recovery 1 of 3)".
pub fn queued_reason(recovery: &TaskRecovery) -> String {
    let at = recovery
        .next_at
        .as_ref()
        .and_then(|t| t.as_str().get(11..19))
        .map_or_else(String::new, |t| format!("; resumes at {t} UTC"));
    format!(
        "recovering: {}{at} (recovery {} of {})",
        recovery.last_cause_text.as_str(),
        recovery.count.get(),
        recovery.max.get()
    )
}

/// Whether it is waiting out its delay at `now_ms`.
pub fn waiting(recovery: Option<&TaskRecovery>, now_ms: i64) -> bool {
    recovery
        .and_then(|r| r.next_at.as_ref())
        .and_then(|at| parse_ms(at.as_str()))
        .is_some_and(|at| at > now_ms)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const NOW: i64 = 1_792_000_000_000;

    fn interrupted(data: Value) -> Death {
        death(HubEventType::ThreadInterrupted, Some(&data), "forge", None)
    }

    fn failed(data: Value, tool: Option<&str>) -> Death {
        death(HubEventType::ThreadFailed, Some(&data), "forge", tool)
    }

    fn resume(action: Action) -> TaskRecovery {
        match action {
            Action::Resume(r) => r,
            other => panic!("not resumed: {other:?}"),
        }
    }

    fn escalated(action: Action) -> String {
        match action {
            Action::Escalate(why) => why,
            other => panic!("not escalated: {other:?}"),
        }
    }

    fn due_in(r: &TaskRecovery) -> i64 {
        parse_ms(r.next_at.as_ref().unwrap().as_str()).unwrap() - NOW
    }

    /// The node going away, however the event says so: by its cause, in the node's words, or only by coming late
    /// (the Oct 22 node, which recorded no cause).
    #[test]
    fn a_node_stop_or_crash_is_the_node_going_away() {
        for (data, cause, text) in [
            (
                json!({ "endCause": "node_stopping" }),
                RunEnd::NodeStopping,
                "the node on forge stopped",
            ),
            (
                json!({ "endCause": "node_restarted" }),
                RunEnd::NodeRestarted,
                "the node on forge restarted mid-run (a crash, a kill or a power loss)",
            ),
            (
                json!({ "late": true }),
                RunEnd::NodeStopping,
                "the node on forge went away",
            ),
            (
                json!({ "error": { "class": "process_exited", "message": "the node stopped" } }),
                RunEnd::NodeStopping,
                "the node on forge stopped",
            ),
            (
                json!({ "error": { "class": "process_exited", "message": "node restarted mid-run" } }),
                RunEnd::NodeRestarted,
                "the node on forge restarted mid-run (a crash, a kill or a power loss)",
            ),
        ] {
            let d = interrupted(data);
            assert_eq!(
                (d.kind, d.cause, d.text.as_str()),
                (Kind::NodeLost, cause, text)
            );
        }
    }

    /// The node OOM-killed, then restarted by systemd: its runs failed with "[process_exited] the node stopped" or
    /// "node restarted mid-run", whatever cause came with them. That is the node going away, never "died twice".
    #[test]
    fn an_oom_killed_and_restarted_node_is_the_node_going_away() {
        for (message, cause) in [
            ("the node stopped", RunEnd::NodeStopping),
            ("node restarted mid-run", RunEnd::NodeRestarted),
        ] {
            for end in [
                json!(null),
                json!("exited"),
                json!("failed"),
                json!("requested"),
            ] {
                let d = failed(
                    json!({ "endCause": end, "error": { "class": "process_exited", "message": message } }),
                    Some("Ran cargo build"),
                );
                assert_eq!(
                    (d.kind, d.cause),
                    (Kind::NodeLost, cause),
                    "{message} with {end}"
                );
                let first = resume(decide(&d, None, false, NOW, 0.0, 3));
                assert_eq!(due_in(&first), 30_000);
                assert_eq!(
                    resume(decide(&d, Some(&first), false, NOW, 0.0, 3))
                        .count
                        .get(),
                    2
                );
            }
        }
    }

    /// A person's interrupt, or one nothing explains, is not a death; neither is a late `requested` end.
    #[test]
    fn a_requested_end_is_not_a_death() {
        for data in [
            json!({ "endCause": "requested", "error": { "class": "process_exited", "message": "stopped" } }),
            json!({ "endCause": "requested", "late": true }),
            json!({}),
        ] {
            let d = interrupted(data);
            assert_eq!(d.kind, Kind::NotDead);
            assert_eq!(decide(&d, None, false, NOW, 0.0, 3), Action::Finish);
        }
    }

    /// Back from a stop: it resumes after the settle, 30 to 40 s, every time the node goes away, up to the cap.
    #[test]
    fn a_node_lost_task_resumes_30_s_after_the_node_is_back_up_to_the_cap() {
        let d = interrupted(json!({ "endCause": "node_stopping" }));
        let first = resume(decide(&d, None, false, NOW, 0.0, 3));
        assert_eq!((first.count.get(), due_in(&first)), (1, 30_000));
        assert_eq!(
            queued_reason(&first),
            "recovering: the node on forge stopped; resumes at 17:47:10 UTC (recovery 1 of 3)"
        );
        // Same signature, and soon after its resume: still the node's doing, so no escalation and no double count.
        let resumed = TaskRecovery {
            next_at: None,
            resumed_at: Some(fleetd_contracts::ids::Timestamp(iso_ms(NOW))),
            ..first
        };
        let second = resume(decide(&d, Some(&resumed), false, NOW + 1_000, 0.99, 3));
        assert_eq!(second.count.get(), 2);
        assert!((39_000..40_000).contains(&(due_in(&second) - 1_000)));
        let third = TaskRecovery {
            count: Count::unchecked(3),
            ..second
        };
        assert!(
            escalated(decide(&d, Some(&third), false, NOW, 0.0, 3))
                .contains("after 3 automatic recoveries of at most 3")
        );
    }

    /// Killed by a signal: resumed after a minute; killed the same way again, it is escalated.
    #[test]
    fn dying_the_same_way_twice_escalates() {
        let d = failed(
            json!({ "endCause": "exited", "error": { "class": "process_exited", "message": "claude was killed by signal 9" } }),
            Some("Ran cargo test --workspace"),
        );
        let first = resume(decide(&d, None, false, NOW, 0.5, 3));
        assert_eq!(due_in(&first), MINUTE_MS);
        assert_eq!(
            escalated(decide(&d, Some(&first), false, NOW, 0.5, 3)),
            "it died the same way twice: claude was killed by signal 9"
        );
        // Another way of dying starts over.
        let other = failed(
            json!({ "endCause": "exited", "error": { "class": "process_exited", "message": "claude was killed by signal 9" } }),
            Some("Ran npm test"),
        );
        assert_eq!(
            resume(decide(&other, Some(&first), false, NOW, 0.5, 3))
                .count
                .get(),
            2
        );
    }

    /// A resumed run that dies within 5 minutes counts twice toward the cap.
    #[test]
    fn a_resume_that_did_nothing_counts_twice() {
        let d = failed(
            json!({ "reason": "stalled", "error": { "message": "no output for 20 min" } }),
            None,
        );
        assert_eq!((d.kind, d.reported), (Kind::Stalled, Some(RunEnd::Stalled)));
        let prior = TaskRecovery {
            signature: None,
            resumed_at: Some(fleetd_contracts::ids::Timestamp(iso_ms(NOW - 60_000))),
            next_at: None,
            ..resume(decide(&d, None, false, NOW, 0.5, 3))
        };
        assert_eq!(
            resume(decide(&d, Some(&prior), false, NOW, 0.5, 3))
                .count
                .get(),
            3
        );
        let later = TaskRecovery {
            resumed_at: Some(fleetd_contracts::ids::Timestamp(iso_ms(
                NOW - PRODUCTIVE_MS,
            ))),
            ..prior
        };
        assert_eq!(
            resume(decide(&d, Some(&later), false, NOW, 0.5, 3))
                .count
                .get(),
            2
        );
    }

    /// A slept machine or a failing connection: 15 min, then 60 min, then escalated.
    #[test]
    fn an_unreachable_api_backs_off_then_escalates() {
        let d = failed(
            json!({ "endCause": "failed", "error": { "class": "network", "message": "fetch failed" } }),
            None,
        );
        let first = resume(decide(&d, None, false, NOW, 0.5, 3));
        assert_eq!(due_in(&first), 15 * MINUTE_MS);
        let second = resume(decide(&d, Some(&first), false, NOW, 0.5, 3));
        assert_eq!(due_in(&second), 60 * MINUTE_MS);
        assert_eq!(
            escalated(decide(&d, Some(&second), false, NOW, 0.5, 3)),
            "fetch failed (3 times in a row)"
        );
    }

    /// Auth, a bad request, a full context: escalated at once. A stopped task isn't recovered at all.
    #[test]
    fn what_a_resume_cant_fix_escalates_and_a_stopped_task_finishes() {
        let auth = failed(
            json!({ "endCause": "failed", "error": { "class": "auth", "message": "Not logged in" } }),
            None,
        );
        assert_eq!(
            escalated(decide(&auth, None, false, NOW, 0.0, 3)),
            "Not logged in, which resuming won't fix"
        );
        let full = failed(
            json!({ "endCause": "context_full", "error": { "message": "prompt is too long" } }),
            None,
        );
        assert_eq!(
            escalated(decide(&full, None, false, NOW, 0.0, 3)),
            "its context is full; resuming it would fail again"
        );
        let lost = interrupted(json!({ "endCause": "node_stopping" }));
        assert_eq!(decide(&lost, None, true, NOW, 0.0, 3), Action::Finish);
        assert!(matches!(
            decide(&lost, None, false, NOW, 0.0, 0),
            Action::Escalate(_)
        ));
    }
}
