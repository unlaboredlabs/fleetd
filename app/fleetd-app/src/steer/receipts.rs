//! A steer's receipt as one line under your message: queued → delivered → acknowledged, or honestly not; and the
//! line above the composer while a queued steer waits for the agent's next step.

use fleetd_contracts::live::{Activity, AgentLane, LaneStatus};

use super::{DeliveredHow, Sending, Steer, SteerBy, SteerStage};
use crate::live::state::parse_ms;
use crate::shell::{clip, clock};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone {
    Quiet,
    Good,
    Warn,
    Bad,
}

/// What the receipt line offers to click.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Act {
    /// While it is queued: drop it before the agent takes it in.
    Withdraw(String),
    /// It was not acknowledged: send the same words again with ⌘Enter's mode.
    Redirect(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Receipt {
    pub line: String,
    pub tone: Tone,
    pub act: Option<Act>,
}

/// Queued, then delivered, then one of the final stages. A refetch that answers with an older stage than an event
/// already told us (the two race) never moves a receipt back.
fn rank(stage: SteerStage) -> u8 {
    match stage {
        SteerStage::Queued => 0,
        SteerStage::Delivered => 1,
        _ => 2,
    }
}

/// Folds `incoming` into `rows` (kept in steer-number order).
pub fn merge(rows: &mut Vec<Steer>, incoming: Steer) {
    match rows.iter_mut().find(|s| s.id == incoming.id) {
        Some(row) if rank(incoming.stage) >= rank(row.stage) => *row = incoming,
        Some(_) => {}
        None => {
            rows.push(incoming);
            rows.sort_by_key(|s| s.id.n().unwrap_or(i64::MAX));
        }
    }
}

/// Only a queued steer can be withdrawn, and only by the person who sent it; once delivered it can't be unsaid.
pub fn can_withdraw(s: &Steer) -> bool {
    s.stage == SteerStage::Queued && matches!(s.by, SteerBy::Human { .. })
}

pub fn receipt(s: &Steer) -> Receipt {
    let id = s.id.as_str();
    let at = |t: &Option<fleetd_contracts::ids::Timestamp>| t.as_ref().map(|t| clock(t.as_str())).map(|c| format!(" {c}")).unwrap_or_default();
    let detail = s.detail.as_deref().filter(|d| !d.is_empty()).map(|d| format!(" · {d}")).unwrap_or_default();
    let plan = s.plan_change.as_deref().map(|p| format!(" · {p}")).unwrap_or_default();
    let (line, tone) = match s.stage {
        SteerStage::Queued => (format!("{id} · queued {}{detail}", clock(s.queued_at.as_str())), Tone::Quiet),
        SteerStage::Delivered => {
            let how = match s.how {
                Some(DeliveredHow::Turn) => " · started a turn".to_string(),
                Some(DeliveredHow::Boundary) => " · at its next step".to_string(),
                Some(DeliveredHow::Stopped) => match s.stopped_tool.as_deref() {
                    Some(tool) => format!(" · stopped {}", clip(tool, 60)),
                    None => " · stopped its current step".to_string(),
                },
                Some(DeliveredHow::Joined) => " · joined its running turn".to_string(),
                None => String::new(),
            };
            (format!("{id} · delivered{}{how}{detail}", at(&s.delivered_at)), Tone::Quiet)
        }
        SteerStage::Acknowledged => {
            let said = s.ack_excerpt.as_deref().map(|e| format!(" · \"{}\"", clip(e, 90))).unwrap_or_default();
            (format!("{id} · acknowledged{}{said}{plan}", at(&s.acked_at)), Tone::Good)
        }
        SteerStage::Unacknowledged => {
            let reply = s.ack_excerpt.as_deref().map(|e| format!(" · its reply: \"{}\"", clip(e, 80))).unwrap_or_default();
            (format!("{id} · not acknowledged{reply}"), Tone::Warn)
        }
        SteerStage::Withdrawn => (format!("{id} · withdrawn"), Tone::Quiet),
        SteerStage::Failed => (format!("{id} · failed{}", detail.replacen(" · ", ": ", 1)), Tone::Bad),
        SteerStage::Expired => (format!("{id} · expired before it was delivered{detail}"), Tone::Bad),
    };
    let act = if can_withdraw(s) {
        Some(Act::Withdraw(id.to_string()))
    } else if s.stage == SteerStage::Unacknowledged {
        Some(Act::Redirect(id.to_string()))
    } else {
        None
    };
    Receipt { line, tone, act }
}

/// The line for a steer the hub has not answered yet, or refused.
pub fn sending(s: &Sending) -> Receipt {
    match &s.error {
        None => Receipt { line: "sending…".into(), tone: Tone::Quiet, act: None },
        Some(e) => Receipt { line: format!("not sent: {e}"), tone: Tone::Bad, act: None },
    }
}

/// "S12 waits for the lead's next step (`cargo test` running 1m12s)": the oldest queued steer to this agent while
/// it is mid-step. None when nothing waits or the agent isn't working (a steer to an idle agent starts its turn).
pub fn waiting_line<'a>(steers: impl IntoIterator<Item = &'a Steer>, lane: &AgentLane, possessive: &str, now_ms: i64) -> Option<String> {
    let s = steers.into_iter().find(|s| s.stage == SteerStage::Queued)?;
    if !matches!(lane.status, LaneStatus::Working | LaneStatus::Starting) {
        return None;
    }
    let now = lane.live.as_ref().and_then(|l| l.activity.as_ref());
    let took = now.and_then(|a| parse_ms(a.since.as_str())).map(|since| short_elapsed(now_ms - since));
    let doing = match (now.map(|a| &a.activity), took) {
        (Some(Activity::Command { text }), Some(t)) => format!(" (`{}` running {t})", clip(text, 48)),
        (Some(_), Some(t)) => {
            let line = crate::live::activity::describe(lane);
            let what = line.machine.map_or(line.words.clone(), |m| format!("{} {}", line.words, clip(&m, 48)));
            format!(" ({what}, {t})")
        }
        _ => String::new(),
    };
    Some(format!("{} waits for {possessive} next step{doing}", s.id))
}

/// "40s", "1m12s", "1h05m".
pub fn short_elapsed(ms: i64) -> String {
    let s = ms.max(0) / 1000;
    match s {
        0..60 => format!("{s}s"),
        60..3600 => format!("{}m{:02}s", s / 60, s % 60),
        _ => format!("{}h{:02}m", s / 3600, (s % 3600) / 60),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::steer::{SteerMode, SteerTarget, mode_for};
    use fleetd_contracts::ids::Timestamp;
    use fleetd_contracts::prim::Text;
    use serde_json::json;

    fn ts(s: &str) -> Timestamp {
        Timestamp::from(s)
    }

    fn steer(id: &str, stage: SteerStage) -> Steer {
        serde_json::from_value(json!({ "id": id, "target": { "workstreamId": "W41" }, "workstreamId": "W41",
            "thread": { "machineId": "lab-a", "threadId": "t-lead" }, "runId": format!("run-{id}"),
            "by": { "kind": "human", "keyName": "laptop" }, "mode": "queue", "text": "skip the docs page",
            "stage": stage, "queuedAt": "2026-10-18T14:02:07.120Z" }))
        .unwrap()
    }

    #[test]
    fn enter_queues_and_cmd_enter_interrupts() {
        assert_eq!(mode_for(false), SteerMode::Queue);
        assert_eq!(mode_for(true), SteerMode::Now);
        assert_eq!(serde_json::to_value(SteerMode::Now).unwrap(), json!("now"));
        assert_eq!(
            serde_json::to_value(SteerTarget::Task { task_id: fleetd_contracts::tasks::TaskId::unchecked("T88") }).unwrap(),
            json!({ "taskId": "T88" })
        );
    }

    #[test]
    fn a_receipt_only_moves_forward() {
        let mut rows = vec![steer("S12", SteerStage::Queued)];
        merge(&mut rows, Steer { delivered_at: Some(ts("2026-10-18T14:02:31.000Z")), ..steer("S12", SteerStage::Delivered) });
        merge(&mut rows, Steer { ack_excerpt: Some(Text::unchecked("S12: dropping the docs page")), ..steer("S12", SteerStage::Acknowledged) });
        // A list fetched before the ack lands after it.
        merge(&mut rows, steer("S12", SteerStage::Delivered));
        merge(&mut rows, steer("S12", SteerStage::Queued));
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].stage, SteerStage::Acknowledged);
        merge(&mut rows, steer("S9", SteerStage::Queued));
        merge(&mut rows, steer("S10", SteerStage::Queued));
        assert_eq!(rows.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["S9", "S10", "S12"], "by number, not text");
    }

    #[test]
    fn only_a_queued_human_steer_can_be_withdrawn() {
        assert_eq!(receipt(&steer("S12", SteerStage::Queued)).act, Some(Act::Withdraw("S12".into())));
        assert_eq!(receipt(&steer("S12", SteerStage::Delivered)).act, None, "once delivered it can't be unsaid");
        assert!(!can_withdraw(&Steer { by: SteerBy::Lead, ..steer("S12", SteerStage::Queued) }), "a lead's steer is the lead's to take back");
        assert_eq!(receipt(&steer("S12", SteerStage::Withdrawn)), Receipt { line: "S12 · withdrawn".into(), tone: Tone::Quiet, act: None });
    }

    #[test]
    fn receipts_say_how_it_landed_and_admit_a_miss() {
        let stopped = Steer {
            delivered_at: Some(ts("2026-10-18T14:02:07.143Z")),
            how: Some(DeliveredHow::Stopped),
            stopped_tool: Some(Text::unchecked("cargo test --workspace")),
            ..steer("S12", SteerStage::Delivered)
        };
        assert_eq!(receipt(&stopped).line, "S12 · delivered 14:02:07 · stopped cargo test --workspace");
        let boundary = Steer { how: Some(DeliveredHow::Boundary), delivered_at: Some(ts("2026-10-18T14:02:31Z")), ..stopped.clone() };
        assert_eq!(receipt(&boundary).line, "S12 · delivered 14:02:31 · at its next step");
        let acked = Steer {
            acked_at: Some(ts("2026-10-18T14:02:08.910Z")),
            ack_excerpt: Some(Text::unchecked("S12: dropping the docs page, plan −1 item")),
            plan_change: Some(Text::unchecked("−1 item")),
            ..steer("S12", SteerStage::Acknowledged)
        };
        assert_eq!(
            receipt(&acked),
            Receipt {
                line: "S12 · acknowledged 14:02:08 · \"S12: dropping the docs page, plan −1 item\" · −1 item".into(),
                tone: Tone::Good,
                act: None
            }
        );
        let missed = Steer { ack_excerpt: Some(Text::unchecked("Continuing with the docs page.")), ..steer("S12", SteerStage::Unacknowledged) };
        assert_eq!(
            receipt(&missed),
            Receipt {
                line: "S12 · not acknowledged · its reply: \"Continuing with the docs page.\"".into(),
                tone: Tone::Warn,
                act: Some(Act::Redirect("S12".into()))
            }
        );
        let failed = Steer { detail: Some(Text::unchecked("lab-b refused the send")), ..steer("S12", SteerStage::Failed) };
        assert_eq!(receipt(&failed).line, "S12 · failed: lab-b refused the send");
        let offline = Steer { detail: Some(Text::unchecked("waiting for lab-b (until 14:30)")), ..steer("S12", SteerStage::Queued) };
        assert_eq!(receipt(&offline).line, "S12 · queued 14:02:07 · waiting for lab-b (until 14:30)");
    }

    #[test]
    fn the_waiting_line_names_the_running_step_and_its_age() {
        let lane: AgentLane = serde_json::from_value(json!({ "laneId": "lead", "role": "lead", "title": "lead", "status": "working",
            "live": { "laneId": "lead", "status": "working",
                      "activity": { "activity": { "kind": "command", "text": "cargo test" }, "since": "2026-10-18T14:00:00.000Z" } } }))
        .unwrap();
        let now = parse_ms("2026-10-18T14:01:12.000Z").unwrap();
        let rows = [steer("S11", SteerStage::Delivered), steer("S12", SteerStage::Queued)];
        assert_eq!(waiting_line(&rows, &lane, "the lead's", now).as_deref(), Some("S12 waits for the lead's next step (`cargo test` running 1m12s)"));
        let idle = AgentLane { status: LaneStatus::Idle, ..lane.clone() };
        assert_eq!(waiting_line(&rows, &idle, "the lead's", now), None, "an idle agent takes it in as a new turn");
        assert_eq!(waiting_line(&rows[..1], &lane, "the lead's", now), None);
        assert_eq!(short_elapsed(40_000), "40s");
        assert_eq!(short_elapsed(3_900_000), "1h05m");
    }
}
