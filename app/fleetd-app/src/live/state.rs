//! What the app knows about live work: board snapshots per project (`orders_board`), order details
//! (`order_get`), and the ephemeral live feed (`LiveFrame`) merged on top. Pure: no gpui, no I/O. The shell feeds
//! it and renders from it.
//!
//! Snapshots are refetched on durable events; live frames arrive at 1 Hz (board) or 4 Hz (focused order) and
//! carry only lanes that changed. A lane's live values win over its snapshot, except that a snapshot saying the
//! lane ended is final: the hub stops sending a lane once it leaves the live scope, so a stale "working" would
//! otherwise stick.
//!
//! A board card lists only active lanes, so a lane that finishes simply leaves its card. The board feed keeps a
//! finished lane for a few seconds with its final status; a lane that left its card and that the feed says
//! settled stays in the order's lanes, so the board can show how it ended before letting it go.

use std::collections::HashMap;

use fleetd_contracts::ledger::WorkstreamId;
use fleetd_contracts::live::{AgentLane, LaneStatus, LiveFrame, LiveLane, MachineLive, OrderCard, TrainLive};
use fleetd_contracts::mcp::{OrderGetOutput, OrdersBoardOutput};
use fleetd_contracts::tasks::SlotState;

use crate::state::ProjectKey;

/// Streamed text kept per lane: the tail of the message being written.
const TEXT_TAIL: usize = 2000;

#[derive(Default)]
pub struct LiveState {
    boards: HashMap<ProjectKey, OrdersBoardOutput>,
    orders: HashMap<WorkstreamId, OrderGetOutput>,
    trains: Vec<TrainLive>,
    lanes: HashMap<String, LiveLane>,
    text: HashMap<String, (String, String)>,
    machines: Vec<MachineLive>,
    slots: Option<SlotState>,
    /// hub clock - local clock, in ms, as the largest `at - received` seen since the last full frame: every
    /// frame is late by its trip, so the largest is the closest to the true offset, and elapsed never runs back.
    skew_ms: Option<i64>,
    stale: bool,
    /// Lanes that left their board card, per order: the lane, the hub time it left, and its place on the card.
    left: HashMap<WorkstreamId, Vec<(AgentLane, i64, usize)>>,
    /// When the feed first said each lane settled (the frame's hub time).
    ended: HashMap<String, fleetd_contracts::ids::Timestamp>,
}

/// How long a lane that left its card is remembered: past the board's hold and the feed's grace.
const LEFT_KEEP_MS: i64 = 60_000;

impl LiveState {
    pub fn apply(&mut self, frame: LiveFrame, local_now_ms: i64) {
        if let Some(at) = parse_ms(frame.at.as_str()) {
            let seen = at - local_now_ms;
            self.skew_ms = Some(match self.skew_ms {
                Some(s) if !frame.full => s.max(seen),
                _ => seen,
            });
        }
        if frame.full {
            self.lanes.clear();
            self.text.clear();
        }
        self.stale = false;
        for mut lane in frame.lanes.into_inner() {
            let key = lane.lane_id.to_string();
            if is_final(lane.status) {
                self.ended.entry(key.clone()).or_insert_with(|| frame.at.clone());
            }
            if lane.spark.is_none() {
                lane.spark = self.lanes.get(&key).and_then(|old| old.spark.clone());
            }
            self.lanes.insert(key, lane);
        }
        for t in frame.text.into_inner() {
            let entry = self.text.entry(t.lane_id.to_string()).or_default();
            if entry.0 != t.message_id.as_str() {
                *entry = (t.message_id.to_string(), String::new());
            }
            entry.1.push_str(&t.append);
            keep_tail(&mut entry.1, TEXT_TAIL);
        }
        if let Some(machines) = frame.machines {
            self.machines = machines.into_inner();
        }
        if let Some(slots) = frame.slots {
            self.slots = Some(slots);
        }
    }

    pub fn set_board(&mut self, project: &ProjectKey, out: OrdersBoardOutput) {
        let at = parse_ms(out.at.as_str()).unwrap_or(0);
        if let Some(old) = self.boards.get(project) {
            for card in old.orders.iter() {
                let now = out.orders.iter().find(|c| c.workstream_id == card.workstream_id);
                let gone = card
                    .lanes
                    .iter()
                    .enumerate()
                    .filter(|(_, l)| !is_final(l.status) && !now.is_some_and(|c| c.lanes.iter().any(|n| n.lane_id == l.lane_id)));
                let left = self.left.entry(card.workstream_id.clone()).or_default();
                left.extend(gone.map(|(ix, l)| (l.clone(), at, ix)));
            }
        }
        for left in self.left.values_mut() {
            left.retain(|(_, when, _)| at - when < LEFT_KEEP_MS);
        }
        self.left.retain(|_, v| !v.is_empty());
        let live: std::collections::HashSet<&String> = self.lanes.keys().collect();
        self.ended.retain(|id, _| live.contains(id));
        self.boards.insert(project.clone(), out);
        self.rebuild_trains();
    }

    pub fn set_order(&mut self, out: OrderGetOutput) {
        self.orders.insert(out.order.workstream_id.clone(), out);
    }

    pub fn orders(&self, project: &ProjectKey) -> &[OrderCard] {
        self.boards.get(project).map_or(&[], |b| &b.orders)
    }

    /// The order's lanes with live values merged in: from its detail when loaded (active, then done), else
    /// from its board card.
    pub fn lanes(&self, w: &WorkstreamId) -> Vec<AgentLane> {
        let snapshot: Vec<&AgentLane> = match self.orders.get(w) {
            Some(o) => o.order.lanes.iter().chain(o.done_lanes.iter().filter(|d| !o.order.lanes.iter().any(|l| l.lane_id == d.lane_id))).collect(),
            None => {
                let mut lanes: Vec<&AgentLane> = self
                    .boards
                    .values()
                    .flat_map(|b| b.orders.iter())
                    .find(|o| &o.workstream_id == w)
                    .map(|o| o.lanes.iter().collect())
                    .unwrap_or_default();
                // Lanes that left the card and that the feed says settled, back at their place, so nothing jumps.
                for (l, _, ix) in self.left.get(w).into_iter().flatten() {
                    if !lanes.iter().any(|c| c.lane_id == l.lane_id) && self.lanes.get(l.lane_id.as_str()).is_some_and(|v| is_final(v.status)) {
                        lanes.insert((*ix).min(lanes.len()), l);
                    }
                }
                lanes
            }
        };
        snapshot.into_iter().map(|l| merge(l, self.lanes.get(l.lane_id.as_str()), self.ended.get(l.lane_id.as_str()))).collect()
    }

    /// The order's project lead with live values, once the order's detail is loaded.
    pub fn lead(&self, w: &WorkstreamId) -> Option<AgentLane> {
        let lead = self.orders.get(w)?.lead.as_ref()?;
        Some(merge(lead, self.lanes.get(lead.lane_id.as_str()), None))
    }

    /// A lane's latest live values as the feed sent them, e.g. a project lead's (`lead_lane_id`), which the board
    /// feed carries though no order card lists it.
    pub fn live_lane(&self, lane_id: &str) -> Option<&LiveLane> {
        self.lanes.get(lane_id)
    }

    pub fn machines(&self) -> &[MachineLive] {
        &self.machines
    }

    pub fn slots(&self) -> Option<&SlotState> {
        self.slots.as_ref()
    }

    pub fn trains(&self) -> &[TrainLive] {
        &self.trains
    }

    /// The streamed tail of the message a lane is writing (the lead's newest message in the order view).
    pub fn text(&self, lane_id: &str) -> Option<(&str, &str)> {
        self.text.get(lane_id).map(|(id, text)| (id.as_str(), text.as_str()))
    }

    pub fn hub_now_ms(&self, local_now_ms: i64) -> i64 {
        local_now_ms + self.skew_ms.unwrap_or(0)
    }

    /// The live feed is lost: values stay, the UI greys them. Cleared by the next frame.
    pub fn mark_stale(&mut self) {
        self.stale = true;
    }

    pub fn stale(&self) -> bool {
        self.stale
    }

    pub fn clear(&mut self) {
        *self = Self::default();
    }

    /// One train per repo: projects sharing a repo report the same train, the most recent snapshot wins.
    fn rebuild_trains(&mut self) {
        let mut boards: Vec<&OrdersBoardOutput> = self.boards.values().collect();
        boards.sort_by(|a, b| a.at.cmp(&b.at));
        let mut by_repo: Vec<TrainLive> = Vec::new();
        for train in boards.into_iter().flat_map(|b| b.trains.iter()) {
            match by_repo.iter_mut().find(|t| t.repo == train.repo) {
                Some(t) => *t = train.clone(),
                None => by_repo.push(train.clone()),
            }
        }
        by_repo.sort_by(|a, b| a.repo.as_str().cmp(b.repo.as_str()));
        self.trains = by_repo;
    }
}

/// `ended`: when the feed first said the lane settled; it stops the lane's clock until the snapshot says when.
fn merge(snapshot: &AgentLane, live: Option<&LiveLane>, ended: Option<&fleetd_contracts::ids::Timestamp>) -> AgentLane {
    let mut lane = snapshot.clone();
    let Some(live) = live else { return lane };
    if is_final(snapshot.status) {
        return lane;
    }
    let spark = live.spark.clone().or_else(|| snapshot.live.as_ref().and_then(|l| l.spark.clone()));
    lane.status = live.status;
    if is_final(live.status) && lane.ended_at.is_none() {
        lane.ended_at = ended.cloned();
    }
    lane.live = Some(LiveLane { spark, ..live.clone() });
    lane
}

pub fn is_final(status: LaneStatus) -> bool {
    matches!(status, LaneStatus::Done | LaneStatus::Failed | LaneStatus::Cancelled)
}

/// Statuses with a clock running.
pub fn is_running(status: LaneStatus) -> bool {
    matches!(status, LaneStatus::Starting | LaneStatus::Working | LaneStatus::Waiting | LaneStatus::Stalled | LaneStatus::Parked | LaneStatus::Idle)
}

fn keep_tail(s: &mut String, max_chars: usize) {
    let n = s.chars().count();
    if n > max_chars {
        let cut = s.char_indices().nth(n - max_chars).map_or(0, |(i, _)| i);
        s.drain(..cut);
    }
}

/// "3 working · 1 queued · 3 done", most urgent first; "all 3 done" when nothing else is left.
pub fn fleet_summary(lanes: &[AgentLane]) -> String {
    use LaneStatus::*;
    let n = |set: &[LaneStatus]| lanes.iter().filter(|l| set.contains(&l.status)).count();
    let parts = [
        (n(&[Waiting]), "needs you"),
        (n(&[Failed]), "failed"),
        (n(&[Stalled]), "stalled"),
        (n(&[Starting, Working]), "working"),
        (n(&[Parked]), "parked"),
        (n(&[Queued]), "queued"),
        (n(&[Idle]), "idle"),
        (n(&[Done]), "done"),
        (n(&[Cancelled]), "cancelled"),
    ];
    let done = parts[7].0;
    if done > 0 && done == lanes.len() {
        return if done == 1 { "done".into() } else { format!("all {done} done") };
    }
    parts.iter().filter(|(c, _)| *c > 0).map(|(c, w)| format!("{c} {w}")).collect::<Vec<_>>().join(" · ")
}

/// What the fleet is doing, from its lanes: "3 writing · 2 reviewing · 1 verifying", each running agent counted
/// by what its role does, the ones that need you or failed first. Empty when no lane is at work. This is what an
/// order's phase line says while agents run, so it moves with their events instead of the lead's last note.
pub fn fleet_activity(lanes: &[AgentLane]) -> String {
    use fleetd_contracts::live::AgentRole::*;
    let running = |l: &&AgentLane| matches!(l.status, LaneStatus::Starting | LaneStatus::Working);
    let n = |pred: &dyn Fn(&AgentLane) -> bool| lanes.iter().filter(|l| pred(l)).count();
    let by_role = |roles: &[fleetd_contracts::live::AgentRole]| lanes.iter().filter(running).filter(|l| roles.contains(&l.role)).count();
    let parts = [
        (n(&|l| l.status == LaneStatus::Waiting), "need you"),
        (n(&|l| l.status == LaneStatus::Failed), "failed"),
        (by_role(&[Implementer]), "writing"),
        (by_role(&[Reader]), "reading"),
        (by_role(&[Reviewer]), "reviewing"),
        (by_role(&[Verifier, Qa]), "verifying"),
        (by_role(&[Lead]), "planning"),
        (n(&|l| l.status == LaneStatus::Stalled), "stalled"),
        (n(&|l| l.status == LaneStatus::Parked), "parked"),
        (n(&|l| l.status == LaneStatus::Queued), "queued"),
    ];
    let mut out: Vec<String> = parts.iter().filter(|(c, _)| *c > 0).map(|(c, w)| format!("{c} {w}")).collect();
    // One agent waiting on you reads "1 needs you".
    if let Some(first) = out.first_mut()
        && first == "1 need you"
    {
        *first = "1 needs you".into();
    }
    out.join(" · ")
}

/// `m:ss` under an hour, then `1h 05m`.
pub fn fmt_elapsed(ms: i64) -> String {
    let s = ms.max(0) / 1000;
    if s < 3600 { format!("{}:{:02}", s / 60, s % 60) } else { format!("{}h {:02}m", s / 3600, (s % 3600) / 60) }
}

/// `840`, `3.1k`, `48k`, `1.2M`, `12M`.
pub fn fmt_tokens(n: u64) -> String {
    fn scaled(n: u64, unit: u64, suffix: &str) -> String {
        let tenths = (n * 10 + unit / 2) / unit;
        if tenths < 100 { format!("{}.{}{suffix}", tenths / 10, tenths % 10) } else { format!("{}{suffix}", (n + unit / 2) / unit) }
    }
    match n {
        0..1000 => n.to_string(),
        1000..999_500 => scaled(n, 1000, "k"),
        _ => scaled(n, 1_000_000, "M"),
    }
}

/// Milliseconds since the Unix epoch of an RFC 3339 UTC timestamp ("2026-10-17T10:04:05.123Z"; fraction and
/// a numeric offset optional). `None` if it isn't one.
pub fn parse_ms(iso: &str) -> Option<i64> {
    let b = iso.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't' | b' ') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| iso.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, s) = (num(0..4)?, num(5..7)?, num(8..10)?, num(11..13)?, num(14..16)?, num(17..19)?);
    let mut rest = &iso[19..];
    let mut frac_ms = 0;
    if let Some(f) = rest.strip_prefix('.') {
        let digits = f.bytes().take_while(u8::is_ascii_digit).count();
        let ms_digits: String = f[..digits].chars().chain("000".chars()).take(3).collect();
        frac_ms = ms_digits.parse::<i64>().ok()?;
        rest = &f[digits..];
    }
    let offset_min = match rest {
        "Z" | "z" | "" => 0,
        _ => {
            let sign = match rest.as_bytes()[0] {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            let (oh, om) = (rest.get(1..3)?.parse::<i64>().ok()?, rest.get(4..6)?.parse::<i64>().ok()?);
            sign * (oh * 60 + om)
        }
    };
    let days = days_from_civil(y, mo, d);
    Some(((days * 86_400 + h * 3600 + mi * 60 + s) - offset_min * 60) * 1000 + frac_ms)
}

/// Unix ms -> "2026-10-17T10:04:05.123Z".
pub fn fmt_iso(ms: i64) -> String {
    let (days, rem) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    let (h, mi, s, milli) = (rem / 3_600_000, rem / 60_000 % 60, rem / 1000 % 60, rem % 1000);
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{milli:03}Z")
}

/// Howard Hinnant's days-from-civil.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;
    use fleetd_contracts::ids::Timestamp;
    use fleetd_contracts::live::{Activity, ActivityNow, AgentRole, LiveText, Spark, Tokens};
    use fleetd_contracts::prim::{List, Text};

    fn lane(id: &str, status: LaneStatus) -> AgentLane {
        AgentLane {
            lane_id: Text::unchecked(id),
            role: AgentRole::Implementer,
            task_id: None,
            thread_ref: None,
            title: Text::unchecked("t"),
            model: None,
            effort: None,
            status,
            status_reason: None,
            started_at: None,
            ended_at: None,
            branch: None,
            pr: None,
            receipts: None,
            live: None,
        }
    }

    fn live(id: &str, status: LaneStatus, spark: Option<Vec<u8>>) -> LiveLane {
        LiveLane {
            lane_id: Text::unchecked(id),
            status,
            activity: Some(ActivityNow { activity: Activity::Writing, since: Timestamp::from("2026-10-18T10:00:00Z") }),
            tokens: Some(Tokens { input: 10, output: 5, cache_read: 0, live: true }),
            spark: spark.map(|s| Spark { end_at: Timestamp::from("2026-10-18T10:00:00Z"), samples: List::unchecked(s) }),
        }
    }

    fn frame(at: &str, full: bool, lanes: Vec<LiveLane>) -> LiveFrame {
        LiveFrame { at: Timestamp::from(at), full, lanes: List::unchecked(lanes), text: List::default(), machines: None, slots: None }
    }

    fn board(w: &str, lanes: Vec<AgentLane>) -> OrdersBoardOutput {
        let card: OrderCard = serde_json::from_value(serde_json::json!({
            "workstreamId": w, "projectRef": {"machineId": "devbox", "projectId": "p1"}, "title": "x", "state": "running",
            "template": null, "phase": "working", "phaseDetail": null, "next": null, "needsYou": 0, "settled": 0, "total": 1,
            "lanes": [], "prs": [], "createdAt": "2026-10-18T10:00:00Z", "updatedAt": "2026-10-18T10:00:00Z"
        }))
        .unwrap();
        OrdersBoardOutput {
            orders: List::unchecked(vec![OrderCard { lanes: List::unchecked(lanes), ..card }]),
            trains: List::default(),
            at: Timestamp::from("2026-10-18T10:00:00Z"),
            next: None,
            truncated: None,
        }
    }

    fn key() -> ProjectKey {
        ("devbox".into(), "p1".into())
    }

    fn w(s: &str) -> WorkstreamId {
        WorkstreamId::unchecked(s)
    }

    #[test]
    fn live_values_merge_over_the_snapshot_and_sparks_persist_until_replaced() {
        let mut s = LiveState::default();
        s.set_board(&key(), board("W1", vec![lane("T1", LaneStatus::Starting), lane("T2", LaneStatus::Queued)]));
        s.apply(frame("2026-10-18T10:00:01Z", true, vec![live("T1", LaneStatus::Working, Some(vec![1, 2]))]), 0);
        // A frame without a spark keeps the last one.
        s.apply(frame("2026-10-18T10:00:02Z", false, vec![live("T1", LaneStatus::Working, None)]), 0);
        let lanes = s.lanes(&w("W1"));
        assert_eq!(lanes[0].status, LaneStatus::Working);
        assert_eq!(lanes[0].live.as_ref().unwrap().spark.as_ref().unwrap().samples.len(), 2);
        // T2 has no live entry: snapshot as is.
        assert_eq!(lanes[1].status, LaneStatus::Queued);
        assert!(lanes[1].live.is_none());
    }

    #[test]
    fn the_hubs_fixtures_merge_into_the_w14_lanes() {
        use crate::live::fixture::{board_fixture, frame_fixture};
        let mut s = LiveState::default();
        let board = board_fixture();
        let project = board.orders[0].project_ref.clone();
        s.set_board(&(project.machine_id.to_string(), project.project_id.to_string()), board);
        let at = parse_ms("2026-10-18T10:07:12.000Z").unwrap();
        s.apply(frame_fixture(crate::live::fixture::FULL), at);
        s.apply(frame_fixture(crate::live::fixture::DELTA), at + 250);
        let lanes = s.lanes(&w("W14"));
        let t31 = &lanes[0];
        assert_eq!(t31.lane_id.as_str(), "T31");
        let live = t31.live.as_ref().unwrap();
        // The delta moved T31 to a search and kept the full frame's sparkline.
        assert!(matches!(live.activity.as_ref().unwrap().activity, Activity::Read { .. }));
        assert_eq!(live.spark.as_ref().unwrap().samples.len(), 30);
        assert_eq!(lanes[2].status, LaneStatus::Queued);
        assert_eq!(s.machines().len(), 2);
        assert_eq!(s.slots().unwrap().cap.get(), 40);
        assert_eq!(s.trains()[0].chips.len(), 3);
        assert!(s.text(fleetd_contracts::live::lead_lane_id(&project).as_str()).unwrap().1.contains("T31"));
    }

    #[test]
    fn the_fleet_line_counts_running_agents_by_what_their_role_does() {
        use fleetd_contracts::live::AgentRole;
        let with = |role, status| AgentLane { role, ..lane("x", status) };
        let lanes = vec![
            with(AgentRole::Implementer, LaneStatus::Working),
            with(AgentRole::Implementer, LaneStatus::Starting),
            with(AgentRole::Implementer, LaneStatus::Done),
            with(AgentRole::Reviewer, LaneStatus::Working),
            with(AgentRole::Reviewer, LaneStatus::Working),
            with(AgentRole::Verifier, LaneStatus::Working),
            with(AgentRole::Verifier, LaneStatus::Queued),
        ];
        assert_eq!(fleet_activity(&lanes), "2 writing · 2 reviewing · 1 verifying · 1 queued");
        let waiting = vec![with(AgentRole::Reviewer, LaneStatus::Waiting), with(AgentRole::Implementer, LaneStatus::Working)];
        assert_eq!(fleet_activity(&waiting), "1 needs you · 1 writing");
        assert_eq!(fleet_activity(&[with(AgentRole::Implementer, LaneStatus::Done)]), "");
    }

    #[test]
    fn a_lane_that_leaves_its_card_stays_while_the_feed_says_how_it_ended() {
        let mut s = LiveState::default();
        let at = |t: &str| Timestamp::from(format!("2026-10-18T10:00:{t}Z"));
        s.set_board(
            &key(),
            OrdersBoardOutput { at: at("00"), ..board("W1", vec![lane("T1", LaneStatus::Working), lane("T2", LaneStatus::Working)]) },
        );
        s.apply(frame("2026-10-18T10:00:01Z", true, vec![live("T1", LaneStatus::Working, None), live("T2", LaneStatus::Working, None)]), 0);
        // T1 finishes: the feed says so first, then the board refetch drops it from the card.
        s.apply(frame("2026-10-18T10:00:05Z", false, vec![live("T1", LaneStatus::Done, None)]), 0);
        s.set_board(&key(), OrdersBoardOutput { at: at("06"), ..board("W1", vec![lane("T2", LaneStatus::Working)]) });
        let lanes = s.lanes(&w("W1"));
        assert_eq!(
            lanes.iter().map(|l| (l.lane_id.as_str(), l.status)).collect::<Vec<_>>(),
            [("T1", LaneStatus::Done), ("T2", LaneStatus::Working)],
            "where it was"
        );
        assert_eq!(lanes[0].ended_at.as_ref().map(|t| t.as_str()), Some("2026-10-18T10:00:05Z"), "its clock stops when it settled");
        // T2 leaves the card with no word from the feed (an older hub): it just goes.
        s.set_board(&key(), OrdersBoardOutput { at: at("07"), ..board("W1", vec![]) });
        assert_eq!(s.lanes(&w("W1")).iter().map(|l| l.lane_id.as_str()).collect::<Vec<_>>(), ["T1"]);
        // A minute on, it is forgotten.
        s.set_board(&key(), OrdersBoardOutput { at: Timestamp::from("2026-10-18T10:01:10Z"), ..board("W1", vec![]) });
        assert!(s.lanes(&w("W1")).is_empty());
    }

    #[test]
    fn a_snapshot_that_says_ended_beats_a_live_value_left_behind() {
        let mut s = LiveState::default();
        s.apply(frame("2026-10-18T10:00:01Z", true, vec![live("T1", LaneStatus::Working, None)]), 0);
        s.set_board(&key(), board("W1", vec![lane("T1", LaneStatus::Done)]));
        assert_eq!(s.lanes(&w("W1"))[0].status, LaneStatus::Done);
    }

    #[test]
    fn a_full_frame_replaces_every_lane() {
        let mut s = LiveState::default();
        s.set_board(&key(), board("W1", vec![lane("T1", LaneStatus::Starting)]));
        s.apply(frame("2026-10-18T10:00:01Z", true, vec![live("T1", LaneStatus::Working, Some(vec![9]))]), 0);
        s.apply(frame("2026-10-18T10:00:02Z", true, vec![]), 0);
        assert_eq!(s.lanes(&w("W1"))[0].status, LaneStatus::Starting);
    }

    #[test]
    fn order_detail_wins_over_the_board_card_and_adds_done_lanes() {
        let mut s = LiveState::default();
        s.set_board(&key(), board("W1", vec![lane("T1", LaneStatus::Working)]));
        let card = board("W1", vec![lane("T1", LaneStatus::Working), lane("T3", LaneStatus::Queued)]).orders.into_inner().remove(0);
        let done = List::unchecked(vec![lane("T0", LaneStatus::Done), lane("T1", LaneStatus::Done)]);
        s.set_order(OrderGetOutput { order: card, lead: None, done_lanes: done, asks: List::default(), claims: None, next: None, truncated: None });
        let ids: Vec<String> = s.lanes(&w("W1")).iter().map(|l| l.lane_id.to_string()).collect();
        assert_eq!(ids, ["T1", "T3", "T0"]);
        assert!(s.lanes(&w("W9")).is_empty());
    }

    #[test]
    fn skew_takes_the_least_delayed_frame_and_resets_on_full() {
        let mut s = LiveState::default();
        let at = parse_ms("2026-10-18T10:00:00Z").unwrap();
        // Hub is 5 s ahead; frames arrive 300 ms, then 50 ms, then 400 ms after they were stamped.
        s.apply(frame("2026-10-18T10:00:00Z", true, vec![]), at - 5000 + 300);
        s.apply(frame("2026-10-18T10:00:00Z", false, vec![]), at - 5000 + 50);
        s.apply(frame("2026-10-18T10:00:00Z", false, vec![]), at - 5000 + 400);
        assert_eq!(s.hub_now_ms(0), 4950);
        s.apply(frame("2026-10-18T10:00:00Z", true, vec![]), at);
        assert_eq!(s.hub_now_ms(0), 0);
    }

    #[test]
    fn streamed_text_appends_per_message_and_keeps_a_tail() {
        let mut s = LiveState::default();
        let t = |m: &str, a: &str| LiveText { lane_id: Text::unchecked("lead"), message_id: Text::unchecked(m), append: Text::unchecked(a) };
        let mut f = frame("2026-10-18T10:00:00Z", false, vec![]);
        f.text = List::unchecked(vec![t("m1", "Hello "), t("m1", "there")]);
        s.apply(f.clone(), 0);
        assert_eq!(s.text("lead"), Some(("m1", "Hello there")));
        f.text = List::unchecked(vec![t("m2", &"é".repeat(1500)), t("m2", &"x".repeat(1000))]);
        s.apply(f, 0);
        let (id, text) = s.text("lead").unwrap();
        assert_eq!(id, "m2");
        assert_eq!(text.chars().count(), 2000);
        assert!(text.starts_with('é') && text.ends_with('x'));
    }

    #[test]
    fn stale_until_the_next_frame() {
        let mut s = LiveState::default();
        s.mark_stale();
        assert!(s.stale());
        s.apply(frame("2026-10-18T10:00:00Z", true, vec![]), 0);
        assert!(!s.stale());
    }

    #[test]
    fn trains_are_one_per_repo_newest_snapshot_wins() {
        let train = |merged: i64| -> TrainLive {
            serde_json::from_value(
                serde_json::json!({"repo": "acme/storefront", "frozen": false, "frozenReason": null, "chips": [], "mergedToday": merged}),
            )
            .unwrap()
        };
        let mut s = LiveState::default();
        let mut a = board("W1", vec![]);
        a.trains = List::unchecked(vec![train(1)]);
        a.at = Timestamp::from("2026-10-18T10:00:00Z");
        let mut b = board("W2", vec![]);
        b.trains = List::unchecked(vec![train(2)]);
        b.at = Timestamp::from("2026-10-18T10:00:05Z");
        s.set_board(&("devbox".into(), "p2".into()), b);
        s.set_board(&key(), a);
        assert_eq!(s.trains().len(), 1);
        assert_eq!(s.trains()[0].merged_today.get(), 2);
    }

    #[test]
    fn summary_reads_most_urgent_first() {
        let l = |st| lane("x", st);
        use LaneStatus::*;
        assert_eq!(fleet_summary(&[l(Working), l(Starting), l(Queued), l(Done), l(Waiting)]), "1 needs you · 2 working · 1 queued · 1 done");
        assert_eq!(fleet_summary(&[l(Done), l(Done), l(Done)]), "all 3 done");
        assert_eq!(fleet_summary(&[l(Done)]), "done");
        assert_eq!(fleet_summary(&[]), "");
    }

    #[test]
    fn elapsed_and_tokens_read_like_the_spec() {
        assert_eq!(fmt_elapsed(72_400), "1:12");
        assert_eq!(fmt_elapsed(0), "0:00");
        assert_eq!(fmt_elapsed(-5), "0:00");
        assert_eq!(fmt_elapsed(3_599_999), "59:59");
        assert_eq!(fmt_elapsed(3_900_000), "1h 05m");
        assert_eq!(fmt_tokens(840), "840");
        assert_eq!(fmt_tokens(3_100), "3.1k");
        assert_eq!(fmt_tokens(9_960), "10k");
        assert_eq!(fmt_tokens(48_200), "48k");
        assert_eq!(fmt_tokens(999_499), "999k");
        assert_eq!(fmt_tokens(999_500), "1.0M");
        assert_eq!(fmt_tokens(1_230_000), "1.2M");
        assert_eq!(fmt_tokens(12_400_000), "12M");
    }

    #[test]
    fn timestamps_parse_to_unix_ms() {
        assert_eq!(parse_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_ms("2026-10-17T10:04:05.123Z"), Some(1_792_231_445_123));
        assert_eq!(parse_ms("2026-10-17T12:04:05.1+02:00"), Some(1_792_231_445_100));
        assert_eq!(parse_ms("2000-02-29T00:00:00Z"), Some(951_782_400_000));
        assert_eq!(parse_ms("not a time"), None);
        for ms in [0, 951_782_400_000, 1_792_231_445_123, -86_400_001] {
            assert_eq!(parse_ms(&fmt_iso(ms)), Some(ms));
        }
        assert_eq!(parse_ms("2026-10-17T10:04:05Q"), None);
    }
}
