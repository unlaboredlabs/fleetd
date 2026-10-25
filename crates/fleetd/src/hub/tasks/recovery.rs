//! Automatic recovery: a task whose run died (its node stopped, claude was killed, a stall) is resumed in its own
//! thread and worktree with a note to continue, after a delay; one that keeps dying for a real reason is not, and
//! fails with a line for its lead to decide on. Pure: `mod.rs` reads the facts and carries the action out.
//!
//! A full context is compacted in its thread, then the note follows; full again, or a thread that can't resume (its
//! conversation is gone, or its claude config dir changed), and the task restarts fresh: a new thread on its branch and
//! worktree, with its brief and a handoff from the last one.
//!
//! Waiting is not death: a run waiting on a person (`thread.waiting`), a usage limit (`thread.usage_limited`) or the
//! node's own retry never ends here, and a write task that pushed and ended its turn for CI or the train completed.
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::Timestamp;
use fleetd_contracts::prim::{Count, Int, Text};
use fleetd_contracts::sessions::RunEnd;
use fleetd_contracts::tasks::{RecoveryMode, TaskRecovery};
use serde_json::Value;

use crate::hub::store::{iso_ms, parse_ms};

use super::render::one_line;

/// Automatic recoveries per task; the death after the last one fails it. `FLEETD_RECOVERY_MAX` sets it for the lab.
pub const RECOVERY_MAX: i64 = 3;
/// Resumes after the node went away, which never count toward `RECOVERY_MAX`: a planned stop or an upgrade is
/// "resume when it's back". This ceiling only stops a node that dies over and over from looping a task forever.
pub const NODE_LOST_MAX: i64 = 20;
/// A node back from a stop or a crash gets this long to settle (its other runs report in) before a task resumes.
const NODE_SETTLE_MS: i64 = 30_000;
const NODE_JITTER_MS: i64 = 10_000;
const MINUTE_MS: i64 = 60_000;
/// A running task's machine offline this long: its lead is told, once per offline spell.
pub const UNREACHABLE_MS: i64 = 30 * MINUTE_MS;
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
    /// The conversation no longer fits: compacted, then restarted fresh.
    ContextFull,
    /// The node would not resume its thread: claude's conversation is gone, or the claude config dir changed.
    Refused,
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
    // A stall's message counts its idle minutes, which differ from one stall to the next: the same stall twice is
    // the same tool stuck, wherever it is.
    let same = if stalled {
        let inside = data.and_then(|d| d.get("inTool")).and_then(Value::as_bool) == Some(true);
        if inside {
            "inside a tool"
        } else {
            "outside a tool"
        }
        .to_owned()
    } else {
        text.clone()
    };
    Death {
        kind,
        reported: if stalled {
            Some(RunEnd::Stalled)
        } else {
            reported
        },
        cause,
        signature: one_line(&format!("{kind:?}: {same}{tool}"), 400),
        text,
    }
}

/// A resume the node refused (`message` is its words): the thread can't go on, so a new one takes over.
pub fn refused(message: &str) -> Death {
    Death {
        kind: Kind::Refused,
        reported: None,
        cause: RunEnd::Failed,
        text: one_line(
            &format!("its thread could not resume: {}", message.trim()),
            200,
        ),
        // However the node words it, and whichever thread it was: a fresh thread refused too is the same death.
        signature: "Refused".to_owned(),
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    /// Queue it with the note; it goes on at `recovery.next_at`, as `recovery.mode` says.
    Resume(TaskRecovery),
    /// Fail it, with why it was not resumed, for its lead to decide.
    Escalate(String),
    /// Fail it plainly: not a death, or nothing is left to recover for.
    Finish,
}

/// `prior` is the task's recovery so far. `stopped`: it must not go on (its workstream is closed or its PR merged).
/// `jitter` is in [0, 1).
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
    // A full context is compacted first; full again since (no fresh thread in between), it starts over in a new one.
    let compacted =
        prior.is_some_and(|p| p.last_cause == RunEnd::ContextFull && p.mode != RecoveryMode::Fresh);
    let mode = match death.kind {
        Kind::ContextFull if !compacted => RecoveryMode::Compact,
        Kind::ContextFull | Kind::Refused => RecoveryMode::Fresh,
        _ => RecoveryMode::Resume,
    };
    let delay = match death.kind {
        Kind::NodeLost => Ok(NODE_SETTLE_MS + (jitter * NODE_JITTER_MS as f64) as i64),
        Kind::ContextFull => Ok(0),
        Kind::Refused if streak == 1 => Ok(0),
        Kind::Refused => Err(format!("{}, again in a fresh thread", death.text)),
        Kind::Exited | Kind::Stalled if streak == 1 => Ok(MINUTE_MS),
        Kind::Exited | Kind::Stalled => Err(format!("it died the same way twice: {}", death.text)),
        Kind::Unreachable if streak == 1 => Ok(15 * MINUTE_MS),
        Kind::Unreachable if streak == 2 => Ok(60 * MINUTE_MS),
        Kind::Unreachable => Err(format!("{} ({streak} times in a row)", death.text)),
        Kind::Fatal | Kind::NotDead => Err(format!("{}, which resuming won't fix", death.text)),
    };
    let delay = match delay {
        Ok(delay) => delay,
        Err(why) => return Action::Escalate(why),
    };
    let used = prior.map_or(0, |p| p.count.get());
    let node_lost = prior.map_or(0, |p| p.node_lost.get());
    // A node going away is never the task's doing: it uses none of the budget, however often or soon it happens.
    if death.kind == Kind::NodeLost {
        if node_lost >= NODE_LOST_MAX {
            return Action::Escalate(format!(
                "{}, and its node has gone away {} times under it",
                death.text,
                node_lost + 1
            ));
        }
        return Action::Resume(TaskRecovery {
            node_lost: Count::unchecked(node_lost + 1),
            ..recovery(death, prior, streak, used, max, now_ms + delay, mode)
        });
    }
    // A full context or a refused resume says nothing about whether the run got anywhere.
    let unproductive = matches!(death.kind, Kind::Exited | Kind::Stalled | Kind::Unreachable)
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
    let delay = (delay as f64 * (0.9 + jitter * 0.2)) as i64;
    Action::Resume(recovery(
        death,
        prior,
        streak,
        count,
        max,
        now_ms + delay,
        mode,
    ))
}

fn recovery(
    death: &Death,
    prior: Option<&TaskRecovery>,
    streak: i64,
    count: i64,
    max: i64,
    at_ms: i64,
    mode: RecoveryMode,
) -> TaskRecovery {
    TaskRecovery {
        count: Count::unchecked(count),
        max: Count::unchecked(max),
        node_lost: prior.map_or_else(Count::default, |p| p.node_lost),
        last_cause: death.cause,
        last_cause_text: Text::unchecked(one_line(&death.text, 200)),
        signature: Some(Text::unchecked(death.signature.clone())),
        streak: Int::unchecked(streak),
        next_at: Some(Timestamp(iso_ms(at_ms))),
        resumed_at: prior.and_then(|p| p.resumed_at.clone()),
        mode,
    }
}

/// The queued reason while it waits to go on: "recovering: claude was killed by signal 9; resumes at 10:12:40 UTC
/// (1 of 3 recoveries used)".
pub fn queued_reason(recovery: &TaskRecovery) -> String {
    let at = recovery
        .next_at
        .as_ref()
        .and_then(|t| t.as_str().get(11..19))
        .map_or_else(String::new, |t| {
            let how = match recovery.mode {
                RecoveryMode::Resume => "resumes",
                RecoveryMode::Compact => "compacts and resumes",
                RecoveryMode::Fresh => "restarts in a fresh thread",
            };
            format!("; {how} at {t} UTC")
        });
    format!(
        "recovering: {}{at} ({})",
        recovery.last_cause_text.as_str(),
        used(recovery)
    )
}

/// "1 of 3 recoveries used": what the budget has left. Resumes after the node went away use none of it.
pub fn used(recovery: &TaskRecovery) -> String {
    format!(
        "{} of {} recoveries used",
        recovery.count.get(),
        recovery.max.get()
    )
}

/// When a task its node's going away cut off resumes, given that the node has been back since `live_since_ms`: the
/// settle counts from its return, not from the death, which a node that stops cleanly reports before it goes. `None`
/// when its time already allows for that, or it died some other way.
pub fn settled(recovery: &TaskRecovery, live_since_ms: i64, task_id: &str) -> Option<Timestamp> {
    if !matches!(
        recovery.last_cause,
        RunEnd::NodeStopping | RunEnd::NodeRestarted
    ) {
        return None;
    }
    let at = parse_ms(recovery.next_at.as_ref()?.as_str())?;
    // Each task its own share of the jitter, the same every time it is asked.
    let share = task_id
        .bytes()
        .fold(0u32, |h, b| h.wrapping_mul(31).wrapping_add(b.into()))
        % 1000;
    let due = live_since_ms + NODE_SETTLE_MS + NODE_JITTER_MS * i64::from(share) / 1000;
    (due > at).then(|| Timestamp(iso_ms(due)))
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
        death(HubEventType::ThreadInterrupted, Some(&data), "devbox", None)
    }

    fn failed(data: Value, tool: Option<&str>) -> Death {
        death(HubEventType::ThreadFailed, Some(&data), "devbox", tool)
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
                "the node on devbox stopped",
            ),
            (
                json!({ "endCause": "node_restarted" }),
                RunEnd::NodeRestarted,
                "the node on devbox restarted mid-run (a crash, a kill or a power loss)",
            ),
            (
                json!({ "late": true }),
                RunEnd::NodeStopping,
                "the node on devbox went away",
            ),
            (
                json!({ "error": { "class": "process_exited", "message": "the node stopped" } }),
                RunEnd::NodeStopping,
                "the node on devbox stopped",
            ),
            (
                json!({ "error": { "class": "process_exited", "message": "node restarted mid-run" } }),
                RunEnd::NodeRestarted,
                "the node on devbox restarted mid-run (a crash, a kill or a power loss)",
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
                let second = resume(decide(&d, Some(&first), false, NOW, 0.0, 3));
                assert_eq!((second.count.get(), second.node_lost.get()), (0, 2));
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

    /// Back from a stop: it resumes after the settle, 30 to 40 s, every time the node goes away. A planned stop or an
    /// upgrade is "resume when it's back", so none of it uses the budget; only a node that keeps dying, 20 times, is
    /// escalated.
    #[test]
    fn a_node_lost_task_resumes_30_s_after_the_node_is_back_using_none_of_its_budget() {
        let d = interrupted(json!({ "endCause": "node_stopping" }));
        let first = resume(decide(&d, None, false, NOW, 0.0, 3));
        assert_eq!(
            (first.count.get(), first.node_lost.get(), due_in(&first)),
            (0, 1, 30_000)
        );
        assert_eq!(
            queued_reason(&first),
            "recovering: the node on devbox stopped; resumes at 17:47:10 UTC (0 of 3 recoveries used)"
        );
        // Same signature, and soon after its resume: still the node's doing, so no escalation and no count.
        let resumed = TaskRecovery {
            next_at: None,
            resumed_at: Some(Timestamp(iso_ms(NOW))),
            ..first
        };
        let second = resume(decide(&d, Some(&resumed), false, NOW + 1_000, 0.99, 3));
        assert_eq!((second.count.get(), second.node_lost.get()), (0, 2));
        assert!((39_000..40_000).contains(&(due_in(&second) - 1_000)));
        // A budget spent on crashes doesn't stop it either.
        let spent = TaskRecovery {
            count: Count::unchecked(3),
            ..second.clone()
        };
        assert_eq!(
            resume(decide(&d, Some(&spent), false, NOW, 0.0, 3))
                .count
                .get(),
            3
        );
        let looping = TaskRecovery {
            node_lost: Count::unchecked(NODE_LOST_MAX),
            ..second
        };
        assert_eq!(
            escalated(decide(&d, Some(&looping), false, NOW, 0.0, 3)),
            "the node on devbox stopped, and its node has gone away 21 times under it"
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

    /// The watchdog's message counts the idle minutes; two stalls in the same tool are still the same death, and the
    /// second is escalated.
    #[test]
    fn the_same_stall_twice_escalates_whatever_its_minutes() {
        let stall = |minutes: u32, in_tool: bool| {
            failed(
                json!({ "reason": "stalled", "inTool": in_tool, "error": { "class": "stalled",
                    "message": format!("no progress for {minutes} min inside a tool, so fleetd interrupted it") } }),
                Some("Ran cargo test --workspace"),
            )
        };
        let first = resume(decide(&stall(20, true), None, false, NOW, 0.5, 3));
        assert_eq!(
            escalated(decide(&stall(23, true), Some(&first), false, NOW, 0.5, 3)),
            "it died the same way twice: no output for too long: no progress for 23 min inside a tool, so fleetd \
             interrupted it"
        );
        // Stuck outside a tool is another death.
        assert!(matches!(
            decide(&stall(23, false), Some(&first), false, NOW, 0.5, 3),
            Action::Resume(_)
        ));
    }

    /// A node that stops cleanly reports its runs' ends before it goes: their tasks resume 30-40 s after it is back,
    /// not after the death. Other deaths keep their time.
    #[test]
    fn a_node_lost_task_settles_from_the_nodes_return() {
        let lost = resume(decide(
            &interrupted(json!({ "endCause": "node_stopping" })),
            None,
            false,
            NOW,
            0.0,
            3,
        ));
        let back = NOW + 600_000;
        let at = parse_ms(settled(&lost, back, "T1").unwrap().as_str()).unwrap();
        assert!((back + 30_000..back + 40_000).contains(&at), "{at}");
        assert_eq!(settled(&lost, back, "T1"), settled(&lost, back, "T1"));
        // Back before the death was reported: its own 30 s from the death already allow for it.
        assert_eq!(settled(&lost, NOW - 60_000, "T1"), None);
        let killed = resume(decide(
            &failed(
                json!({ "endCause": "exited", "error": { "class": "process_exited", "message": "claude was killed by signal 9" } }),
                None,
            ),
            None,
            false,
            NOW,
            0.0,
            3,
        ));
        assert_eq!(settled(&killed, back, "T1"), None);
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
            resumed_at: Some(Timestamp(iso_ms(NOW - 60_000))),
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
            resumed_at: Some(Timestamp(iso_ms(NOW - PRODUCTIVE_MS))),
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

    /// A full context is compacted in its thread at once; full again since, the task restarts fresh at once, and a
    /// fresh thread whose context fills up is compacted first again. Each uses one recovery, however soon it comes.
    #[test]
    fn a_full_context_compacts_then_restarts_fresh() {
        let full = failed(
            json!({ "endCause": "context_full", "error": { "class": "invalid_request", "message": "Prompt is too long" } }),
            Some("Read a large file"),
        );
        assert_eq!(full.kind, Kind::ContextFull);
        let compact = resume(decide(&full, None, false, NOW, 0.5, 3));
        assert_eq!(
            (compact.mode, compact.count.get(), due_in(&compact)),
            (RecoveryMode::Compact, 1, 0)
        );
        assert_eq!(
            queued_reason(&compact),
            "recovering: its context is full; compacts and resumes at 17:46:40 UTC (1 of 3 recoveries used)"
        );
        // Compacted, the note went out (`mode` is back to resume), and a minute later it is full again.
        let compacted = TaskRecovery {
            mode: RecoveryMode::Resume,
            next_at: None,
            resumed_at: Some(fleetd_contracts::ids::Timestamp(iso_ms(NOW - 60_000))),
            ..compact
        };
        let fresh = resume(decide(&full, Some(&compacted), false, NOW, 0.5, 3));
        assert_eq!(
            (fresh.mode, fresh.count.get(), due_in(&fresh)),
            (RecoveryMode::Fresh, 2, 0)
        );
        let again = resume(decide(&full, Some(&fresh), false, NOW, 0.5, 3));
        assert_eq!(again.mode, RecoveryMode::Compact);
        // Another death in between doesn't make a full context look compacted.
        let crashed = TaskRecovery {
            last_cause: RunEnd::Exited,
            ..compacted
        };
        assert_eq!(
            resume(decide(&full, Some(&crashed), false, NOW, 0.5, 3)).mode,
            RecoveryMode::Compact
        );
    }

    /// A resume the node refused restarts fresh at once; refused again, it is escalated.
    #[test]
    fn a_refused_resume_restarts_fresh_once() {
        let d = refused("the session can't resume: claude's conversation /c/t1.jsonl is gone");
        assert_eq!(
            d.text,
            "its thread could not resume: the session can't resume: claude's conversation /c/t1.jsonl is gone"
        );
        let fresh = resume(decide(&d, None, false, NOW, 0.5, 3));
        assert_eq!(
            (fresh.mode, fresh.count.get(), due_in(&fresh)),
            (RecoveryMode::Fresh, 1, 0)
        );
        let other_thread =
            refused("the session can't resume: claude's conversation /c/t2.jsonl is gone");
        assert!(
            escalated(decide(&other_thread, Some(&fresh), false, NOW, 0.5, 3))
                .ends_with(", again in a fresh thread")
        );
    }

    /// Auth, a bad request: escalated at once. A stopped task isn't recovered at all.
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
        let lost = interrupted(json!({ "endCause": "node_stopping" }));
        assert_eq!(decide(&lost, None, true, NOW, 0.0, 3), Action::Finish);
        let killed = failed(
            json!({ "endCause": "exited", "error": { "class": "process_exited", "message": "claude was killed by signal 9" } }),
            None,
        );
        assert!(matches!(
            decide(&killed, None, false, NOW, 0.0, 0),
            Action::Escalate(_)
        ));
    }
}
