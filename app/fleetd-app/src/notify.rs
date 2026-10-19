//! "Needs you" notifications. The hub marks events with `attention` (its rules, not ours); this decides
//! when the OS may show one: at most one per the hub's coalescing window with the rest folded in as
//! "+N more", and inside the hub's quiet windows only urgent items. No clock and no I/O, so it is
//! unit-tested; the shell posts what [`Notifier::due`] returns.

use fleetd_contracts::events::{Attention, HubEvent, HubEventType};
use fleetd_contracts::mcp::AttentionPolicyOutput;

/// When the hub's attention_policy can't be read (an older hub): the hub's own defaults, minus quiet hours.
const FALLBACK_COALESCE_MS: i64 = 20 * 60_000;

#[derive(Clone, Debug, PartialEq)]
pub struct Notification {
    pub title: String,
    pub body: String,
    /// What clicking it opens.
    pub target: Target,
}

/// Where a clicked notification takes you: the ask itself when it is about one ask, else the screen that
/// explains it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    Ask(String),
    Inbox,
    Machines,
    /// The fleet's Status view (the digest).
    Status,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Policy {
    pub coalesce_ms: i64,
    /// (from, to) in Unix ms.
    pub quiet: Vec<(i64, i64)>,
}

impl Policy {
    pub fn from_output(out: &AttentionPolicyOutput) -> Self {
        let ms = |iso: &str| unix_secs(iso).map(|s| s * 1000);
        Policy {
            coalesce_ms: out.coalesce_sec.get() * 1000,
            quiet: out.quiet.iter().filter_map(|w| Some((ms(w.from.as_str())?, ms(w.to.as_str())?))).collect(),
        }
    }

    pub fn fallback() -> Self {
        Policy { coalesce_ms: FALLBACK_COALESCE_MS, quiet: Vec::new() }
    }

    pub fn quiet_at(&self, now: i64) -> bool {
        self.quiet.iter().any(|&(from, to)| now >= from && now < to)
    }

    /// The hub only sends the window under way and the next; past the last one, ask again.
    pub fn stale(&self, now: i64) -> bool {
        self.quiet.last().is_some_and(|&(_, to)| now >= to)
    }
}

struct Pending {
    line: String,
    urgent: bool,
    ask_id: Option<String>,
    /// About a machine or its setup (machine.*, doctor.*, usage.*), so Machines explains it.
    machine: bool,
    /// How many open-asks fetches had been sent when this arrived; only later ones can say it was answered.
    asks_sent: u64,
}

#[derive(Default)]
pub struct Notifier {
    pending: Vec<Pending>,
    last_sent: Option<i64>,
}

impl Notifier {
    /// Queues an event the hub marked for attention; others are ignored.
    pub fn push(&mut self, event: &HubEvent, asks_sent: u64) {
        let Some(attention) = event.attention else { return };
        let ask_id = (event.r#type == HubEventType::AskCreated).then(|| event.data.as_ref()?.get("askId")?.as_str().map(str::to_string)).flatten();
        let kind = event.r#type.as_str();
        let machine = ["machine.", "doctor.", "usage."].iter().any(|p| kind.starts_with(p));
        self.pending.push(Pending { line: one_line(&event.summary, 140), urgent: attention == Attention::Urgent, ask_id, machine, asks_sent });
    }

    /// What to show now, if anything. `still_open(ask_id, asks_sent)` drops asks answered or withdrawn
    /// meanwhile.
    pub fn due(&mut self, now: i64, policy: &Policy, still_open: impl Fn(&str, u64) -> bool) -> Option<Notification> {
        self.pending.retain(|p| p.ask_id.as_deref().is_none_or(|id| still_open(id, p.asks_sent)));
        let quiet = policy.quiet_at(now);
        if !self.pending.iter().any(|p| !quiet || p.urgent) {
            return None;
        }
        if self.last_sent.is_some_and(|at| now - at < policy.coalesce_ms) {
            return None;
        }
        let (send, held): (Vec<_>, Vec<_>) = self.pending.drain(..).partition(|p| !quiet || p.urgent);
        self.pending = held;
        self.last_sent = Some(now);
        let body = match send.len() {
            1 => send[0].line.clone(),
            n => format!("{} (+{} more)", send[0].line, n - 1),
        };
        let target = match send.as_slice() {
            [one] if one.ask_id.is_some() => Target::Ask(one.ask_id.clone().unwrap_or_default()),
            all if all.iter().all(|p| p.machine) => Target::Machines,
            _ => Target::Inbox,
        };
        Some(Notification { title: "fleetd needs you".into(), body, target })
    }
}

fn one_line(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max { flat } else { format!("{}…", flat.chars().take(max - 1).collect::<String>()) }
}

/// Seconds since the Unix epoch for "YYYY-MM-DDTHH:MM:SS[.fff]Z".
pub fn unix_secs(iso: &str) -> Option<i64> {
    let n = |r: std::ops::Range<usize>| iso.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, s) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    // Days from civil (H. Hinnant).
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (mo + if mo > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some((era * 146_097 + doe - 719_468) * 86_400 + h * 3600 + mi * 60 + s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const MIN: i64 = 60_000;
    const T0: i64 = 1_792_231_200_000; // 2026-10-17T10:00:00Z

    fn event(summary: &str, attention: Option<Attention>, ask: Option<&str>) -> HubEvent {
        serde_json::from_value(json!({ "seq": 1, "at": "2026-10-17T10:00:00.000Z",
            "type": if ask.is_some() { "ask.created" } else { "usage.breaker" }, "summary": summary,
            "data": ask.map(|id| json!({ "askId": id })), "attention": attention }))
        .unwrap()
    }

    fn open(_: &str, _: u64) -> bool {
        true
    }

    #[test]
    fn notifies_at_once_then_at_most_once_per_window_with_the_rest_folded_in() {
        let policy = Policy { coalesce_ms: 20 * MIN, quiet: vec![] };
        let mut n = Notifier::default();
        n.push(&event("A1 [money] pay: Buy the\ndomain?", Some(Attention::Urgent), Some("A1")), 0);
        n.push(&event("thread failed", None, None), 0);
        assert_eq!(
            n.due(T0, &policy, open),
            Some(Notification { title: "fleetd needs you".into(), body: "A1 [money] pay: Buy the domain?".into(), target: Target::Ask("A1".into()) })
        );
        assert_eq!(n.due(T0, &policy, open), None, "nothing left");
        n.push(&event("lab-a breaker open", Some(Attention::Loud), None), 0);
        n.push(&event("A2 [credential] token", Some(Attention::Loud), Some("A2")), 0);
        assert_eq!(n.due(T0 + 19 * MIN, &policy, open), None);
        let both = n.due(T0 + 20 * MIN, &policy, open).unwrap();
        assert_eq!((both.body.as_str(), both.target), ("lab-a breaker open (+1 more)", Target::Inbox));
        n.push(&event("devbox breaker open", Some(Attention::Loud), None), 0);
        assert_eq!(n.due(T0 + 40 * MIN, &policy, open).unwrap().target, Target::Machines, "a usage breaker is explained on Machines");
    }

    #[test]
    fn quiet_windows_hold_loud_items_and_let_urgent_ones_through() {
        let policy = Policy { coalesce_ms: 20 * MIN, quiet: vec![(T0 - 60 * MIN, T0 + 60 * MIN)] };
        let mut n = Notifier::default();
        n.push(&event("A1 [credential] token", Some(Attention::Loud), Some("A1")), 0);
        assert_eq!(n.due(T0, &policy, open), None);
        n.push(&event("A2 [irreversible] drop the db", Some(Attention::Urgent), Some("A2")), 0);
        assert_eq!(n.due(T0, &policy, open).unwrap().body, "A2 [irreversible] drop the db");
        assert_eq!(n.due(T0 + 59 * MIN, &policy, open), None, "still quiet");
        assert_eq!(n.due(T0 + 60 * MIN, &policy, open).unwrap().body, "A1 [credential] token");
    }

    #[test]
    fn asks_answered_meanwhile_are_dropped_but_only_on_a_fetch_sent_after_they_arrived() {
        let policy = Policy { coalesce_ms: 20 * MIN, quiet: vec![] };
        let mut n = Notifier::default();
        n.push(&event("first", Some(Attention::Loud), None), 0);
        assert!(n.due(T0, &policy, open).is_some());
        n.push(&event("A3 [money] pay", Some(Attention::Urgent), Some("A3")), 4);
        // A fetch sent before the ask existed (number 4) can't vouch for it; number 5 can.
        let landed = |last: u64| move |_: &str, sent: u64| last <= sent;
        assert!(n.due(T0 + 20 * MIN, &policy, landed(4)).is_some());
        n.push(&event("A4 [money] pay", Some(Attention::Urgent), Some("A4")), 4);
        assert_eq!(n.due(T0 + 40 * MIN, &policy, landed(5)), None);
    }

    #[test]
    fn policy_reads_the_hub_windows_and_goes_stale_after_the_last() {
        let out: AttentionPolicyOutput = serde_json::from_value(json!({ "coalesceSec": 1200,
            "quiet": [{ "from": "2026-10-17T09:00:00.000Z", "to": "2026-10-17T11:00:00.000Z" }] }))
        .unwrap();
        let policy = Policy::from_output(&out);
        assert_eq!(policy, Policy { coalesce_ms: 20 * MIN, quiet: vec![(T0 - 60 * MIN, T0 + 60 * MIN)] });
        assert!(policy.quiet_at(T0) && !policy.quiet_at(T0 + 60 * MIN));
        assert!(!policy.stale(T0) && policy.stale(T0 + 60 * MIN));
        assert!(!Policy::fallback().stale(T0));
    }

    #[test]
    fn unix_secs_parses_hub_timestamps() {
        assert_eq!(unix_secs("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(unix_secs("2026-10-17T10:00:00.000Z"), Some(1_792_231_200));
        assert_eq!(unix_secs("2024-02-29T23:59:59Z"), Some(1_709_251_199));
        assert_eq!(unix_secs("soon"), None);
    }
}
