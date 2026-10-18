//! The activity line: what a lane is doing now, in literal present tense ("running cargo test -p fleetd",
//! "editing hub/leads/digest.rs"). Text is replaced in place when it changes, never crossfaded: a fading line
//! reads as flicker. When there is nothing specific to say, it says no more than the status (rule 9).

use fleetd_contracts::live::{Activity, AgentLane, LaneStatus};
use gpui::{Div, FontWeight, Hsla, SharedString, div, prelude::*, px};

use super::state::{fmt_elapsed, parse_ms};
use crate::theme::{REGULAR, STRONG, Theme, size};

/// Commands are cut to this many characters, in the middle, so both the program and its target show.
const COMMAND_MAX: usize = 80;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone {
    Quiet,
    /// Waiting on you: full weight, primary text.
    Loud,
    Danger,
}

/// One activity line as text: words in the UI voice, then machine text (a command, path or pattern) in mono.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Line {
    pub words: String,
    pub machine: Option<String>,
    pub tone: Tone,
}

impl Line {
    fn say(words: impl Into<String>) -> Self {
        Self { words: words.into(), machine: None, tone: Tone::Quiet }
    }

    fn with(words: impl Into<String>, machine: impl Into<String>) -> Self {
        Self { words: words.into(), machine: Some(machine.into()), tone: Tone::Quiet }
    }
}

pub fn describe(lane: &AgentLane) -> Line {
    let reason = lane.status_reason.as_deref().filter(|r| !r.is_empty());
    match lane.status {
        LaneStatus::Queued => Line::say(reason.map_or("queued".into(), |r| format!("queued · {r}"))),
        LaneStatus::Waiting => Line { tone: Tone::Loud, ..Line::say(reason.map_or("waiting on you".into(), |r| format!("waiting on you: {r}"))) },
        LaneStatus::Parked => Line::say(reason.unwrap_or("usage limit")),
        LaneStatus::Stalled => Line::say(reason.map_or("stalled".into(), |r| format!("stalled: {r}"))),
        LaneStatus::Cancelled => Line::say("cancelled"),
        LaneStatus::Failed => Line { tone: Tone::Danger, ..Line::say(reason.map_or("failed".into(), |r| format!("failed: {r}"))) },
        LaneStatus::Done => {
            let took = match (lane.started_at.as_ref().and_then(|t| parse_ms(t.as_str())), lane.ended_at.as_ref().and_then(|t| parse_ms(t.as_str())))
            {
                (Some(a), Some(b)) => format!("done in {}", fmt_elapsed(b - a)),
                _ => "done".into(),
            };
            Line::say(match &lane.pr {
                Some(pr) => format!("{took} · #{}", pr.number),
                None => took,
            })
        }
        LaneStatus::Idle => Line::say("idle"),
        LaneStatus::Starting | LaneStatus::Working => match lane.live.as_ref().and_then(|l| l.activity.as_ref()).map(|a| &a.activity) {
            Some(Activity::Command { text }) => Line::with("running", middle_ellipsis(text, COMMAND_MAX)),
            Some(Activity::Edit { path }) => Line::with("editing", path.as_str()),
            Some(Activity::Read { pattern: Some(p), .. }) => Line::with("searching", p.as_str()),
            Some(Activity::Read { path: Some(p), .. }) => Line::with("reading", p.as_str()),
            Some(Activity::Read { .. }) => Line::say("reading"),
            Some(Activity::Tool { name, detail: Some(d) }) => Line::with(name.as_str(), d.as_str()),
            Some(Activity::Tool { name, detail: None }) => Line::say(name.as_str()),
            Some(Activity::Writing) => Line::say("writing"),
            Some(Activity::Compacting) => Line::say("compacting context"),
            Some(Activity::Retrying { attempt, of, reason }) => Line::say(format!("retrying ({attempt} of {of}): {reason}")),
            Some(Activity::Thinking) => Line::say("waiting on the model"),
            None if lane.status == LaneStatus::Starting => Line::say("starting"),
            None => Line::say("waiting on the model"),
        },
    }
}

/// The activity line as an element: one line, cut with an ellipsis when the column is short.
pub fn activity_line(t: &Theme, lane: &AgentLane) -> Div {
    render(t, &describe(lane), false)
}

/// `stale`: the live feed is reconnecting; the last line stays, in italics (still readable: `quiet`, AA).
pub fn render(t: &Theme, line: &Line, stale: bool) -> Div {
    let (color, weight): (Hsla, FontWeight) = match (stale, line.tone) {
        (true, _) => (t.quiet, REGULAR),
        (false, Tone::Quiet) => (t.quiet, REGULAR),
        (false, Tone::Loud) => (t.text, STRONG),
        (false, Tone::Danger) => (t.danger, REGULAR),
    };
    div()
        .flex()
        .items_baseline()
        .gap_1()
        .min_w_0()
        .overflow_hidden()
        .whitespace_nowrap()
        .text_size(px(size::XS))
        .text_color(color)
        .font_weight(weight)
        .when(stale, |d| d.italic())
        .child(div().flex_none().child(SharedString::from(line.words.clone())))
        .when_some(line.machine.clone(), |d, m| {
            d.child(div().min_w_0().overflow_hidden().text_ellipsis().font_family(t.mono_font.clone()).text_size(px(size::SM)).child(m))
        })
}

/// Cuts `s` to `max` characters by replacing its middle with "…".
pub fn middle_ellipsis(s: &str, max: usize) -> String {
    let n = s.chars().count();
    if n <= max || max < 3 {
        return s.to_string();
    }
    let keep = max - 1;
    let head = keep.div_ceil(2);
    let tail = keep - head;
    let start: String = s.chars().take(head).collect();
    let end: String = s.chars().skip(n - tail).collect();
    format!("{start}…{end}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use fleetd_contracts::ids::Timestamp;
    use fleetd_contracts::live::{ActivityNow, LiveLane};
    use fleetd_contracts::prim::Text;

    fn lane(status: LaneStatus, activity: Option<Activity>) -> AgentLane {
        serde_json::from_value::<AgentLane>(serde_json::json!({
            "laneId": "T31", "role": "implementer", "title": "x", "status": "working"
        }))
        .map(|mut l| {
            l.status = status;
            l.live = activity.map(|a| LiveLane {
                lane_id: Text::unchecked("T31"),
                status,
                activity: Some(ActivityNow { activity: a, since: Timestamp::from("2026-10-18T10:00:00Z") }),
                tokens: None,
                spark: None,
            });
            l
        })
        .unwrap()
    }

    fn words(l: &AgentLane) -> String {
        let d = describe(l);
        d.machine.map_or(d.words.clone(), |m| format!("{} {m}", d.words))
    }

    #[test]
    fn working_lanes_say_what_they_do_literally() {
        use Activity::*;
        let w = |a| words(&lane(LaneStatus::Working, Some(a)));
        assert_eq!(w(Command { text: Text::unchecked("cargo test -p fleetd") }), "running cargo test -p fleetd");
        assert_eq!(w(Edit { path: Text::unchecked("hub/leads/digest.rs") }), "editing hub/leads/digest.rs");
        assert_eq!(w(Read { path: Some(Text::unchecked("a.rs")), pattern: Some(Text::unchecked("fn stalled")) }), "searching fn stalled");
        assert_eq!(w(Read { path: Some(Text::unchecked("a.rs")), pattern: None }), "reading a.rs");
        assert_eq!(w(Tool { name: Text::unchecked("WebFetch"), detail: Some(Text::unchecked("docs.rs")) }), "WebFetch docs.rs");
        assert_eq!(w(Retrying { attempt: 2, of: 5, reason: Text::unchecked("overloaded") }), "retrying (2 of 5): overloaded");
        assert_eq!(w(Thinking), "waiting on the model");
        assert_eq!(w(Compacting), "compacting context");
        // Nothing open and no recent output: no more than the status says.
        assert_eq!(words(&lane(LaneStatus::Working, None)), "waiting on the model");
        assert_eq!(words(&lane(LaneStatus::Starting, None)), "starting");
    }

    #[test]
    fn other_statuses_carry_their_reason() {
        let mut q = lane(LaneStatus::Queued, None);
        assert_eq!(words(&q), "queued");
        q.status_reason = Some(Text::unchecked("slots: 40/40 in use"));
        assert_eq!(words(&q), "queued · slots: 40/40 in use");
        let mut w = lane(LaneStatus::Waiting, None);
        w.status_reason = Some(Text::unchecked("approve rm -rf build"));
        assert_eq!(describe(&w).tone, Tone::Loud);
        assert_eq!(words(&w), "waiting on you: approve rm -rf build");
        let mut f = lane(LaneStatus::Failed, None);
        f.status_reason = Some(Text::unchecked("tests failed (exit 101)"));
        assert_eq!(words(&f), "failed: tests failed (exit 101)");
        let mut d = lane(LaneStatus::Done, None);
        d.started_at = Some(Timestamp::from("2026-10-18T10:00:00Z"));
        d.ended_at = Some(Timestamp::from("2026-10-18T10:03:02Z"));
        assert_eq!(words(&d), "done in 3:02");
    }

    #[test]
    fn long_commands_lose_their_middle() {
        assert_eq!(middle_ellipsis("short", 80), "short");
        let cut = middle_ellipsis(&format!("cargo test {} --nocapture", "x".repeat(100)), 20);
        assert_eq!(cut.chars().count(), 20);
        assert!(cut.starts_with("cargo test") && cut.ends_with("nocapture"));
    }
}
