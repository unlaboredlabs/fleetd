//! A project's bar. Each unit (a plan item, or an order with no plan items) earns a fixed share of its size at each
//! stage fleetd observed: its PR opened, review passed, CI green, merged, verified. Inside a stage it also earns
//! in-stage credit for the time work on it was in flight, never past 90% of the step to the next stage. The figure
//! falls only with an observed cause, and that point says why. Nothing here is a time estimate: a stage's usual time
//! only paces in-stage credit and is never shown.
use std::collections::{HashMap, HashSet};

use fleetd_contracts::ids::Timestamp;
use fleetd_contracts::ledger::Workstream;
use fleetd_contracts::plan::{PlanItemState, Size, Weight};
use fleetd_contracts::prim::{Int, Line};
use fleetd_contracts::status::{DropReason, ProgressDrop, ProgressEstimate, ProgressPoint};
use fleetd_contracts::train::{Change, ChangeState};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::hub::plan;
use crate::hub::plan::store::ItemRow;
use crate::hub::store::{iso_ms, parse_ms};

const MIN: i64 = 60_000;
pub const DAY_MS: i64 = 24 * 60 * MIN;
/// Done plan items are read this far back.
const WINDOW_MS: i64 = 7 * DAY_MS;
/// Inside a stage a unit earns at most this share of the step to the next stage.
pub const IN_STAGE_CAP: f64 = 0.9;
/// Points kept per project.
pub const SERIES_CAP: usize = 96;
/// Points status_get sends, the newest.
pub const SERIES_SENT: usize = 48;

/// The stages that earn credit, in order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Stage {
    Planned,
    PrOpen,
    ReviewPassed,
    CiGreen,
    Merged,
    Verified,
}

impl Stage {
    /// The share of a unit's size reaching this stage earns.
    pub fn credit(self) -> f64 {
        match self {
            Self::Planned => 0.0,
            Self::PrOpen => 0.5,
            Self::ReviewPassed => 0.7,
            Self::CiGreen => 0.8,
            Self::Merged => 0.9,
            Self::Verified => 1.0,
        }
    }

    fn next(self) -> Self {
        match self {
            Self::Planned => Self::PrOpen,
            Self::PrOpen => Self::ReviewPassed,
            Self::ReviewPassed => Self::CiGreen,
            Self::CiGreen => Self::Merged,
            Self::Merged | Self::Verified => Self::Verified,
        }
    }

    /// How long the step to the next stage usually runs for a unit of `size`: its share of the unit's built-in length,
    /// at least a minute.
    pub fn usual_ms(self, size: Size) -> i64 {
        let length = match size {
            Size::S => 10 * MIN,
            Size::M => 20 * MIN,
            Size::L => 60 * MIN,
        };
        ((length as f64 * (self.next().credit() - self.credit())) as i64).max(MIN)
    }
}

/// Where a Change puts its unit. A failed review, a red CI or a rebase conflict send it back to "PR open"; a refused
/// or abandoned Change no longer counts.
pub fn change_stage(state: ChangeState) -> Option<Stage> {
    use ChangeState::*;
    Some(match state {
        Queued | Reviewing | NeedsRebase | CiFailed => Stage::PrOpen,
        Ready | Rebasing | Ci => Stage::ReviewPassed,
        Merging => Stage::CiGreen,
        Merged => Stage::Merged,
        Refused | Abandoned => return None,
    })
}

/// A unit the bar credits: a plan item.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum UnitKey {
    Item(i64),
}

/// Something fleetd observed about a unit.
#[derive(Clone, Debug, PartialEq)]
pub enum What {
    Created,
    /// A linked Change was created (state `queued`) or moved to `state`.
    ChangeState {
        change: String,
        state: ChangeState,
    },
    /// fleetd verified it (`plan.verified`).
    Verified,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Obs {
    pub at_ms: i64,
    pub unit: UnitKey,
    pub what: What,
}

/// The stages fleetd observed for one unit, with when each was reached. A unit that fell back (its Change went back
/// to review or red CI) is where its Changes are now, so the furthest stage listed is where it is.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Facts {
    pub reached: Vec<(Stage, i64)>,
}

impl Facts {
    /// The furthest stage and when it was entered.
    pub fn current(&self) -> (Stage, i64) {
        self.reached
            .iter()
            .max_by_key(|(s, at)| (*s, std::cmp::Reverse(*at)))
            .copied()
            .unwrap_or((Stage::Planned, 0))
    }
}

/// Each unit's observed stages as of `until_ms`, from observations in any order.
pub fn observe(obs: &[Obs], until_ms: i64) -> HashMap<UnitKey, Facts> {
    #[derive(Default)]
    struct Fold {
        created: Option<i64>,
        /// change → (first seen, its stage, entered that stage).
        changes: HashMap<String, (i64, Option<Stage>, i64)>,
        verified: Option<i64>,
    }
    let mut sorted: Vec<&Obs> = obs.iter().filter(|o| o.at_ms <= until_ms).collect();
    sorted.sort_by_key(|o| o.at_ms);
    let mut folds: HashMap<UnitKey, Fold> = HashMap::new();
    for o in sorted {
        let f = folds.entry(o.unit.clone()).or_default();
        match &o.what {
            What::Created => {
                f.created.get_or_insert(o.at_ms);
            }
            What::ChangeState { change, state } => {
                let stage = change_stage(*state);
                let e = f
                    .changes
                    .entry(change.clone())
                    .or_insert((o.at_ms, stage, o.at_ms));
                if e.1 != stage {
                    e.1 = stage;
                    e.2 = o.at_ms;
                }
            }
            What::Verified => {
                f.verified.get_or_insert(o.at_ms);
            }
        }
    }
    folds
        .into_iter()
        .map(|(k, f)| {
            let mut reached = Vec::new();
            if let Some(at) = f.created {
                reached.push((Stage::Planned, at));
            }
            let live: Vec<&(i64, Option<Stage>, i64)> =
                f.changes.values().filter(|c| c.1.is_some()).collect();
            // Every live Change counts: the unit is at its least advanced one.
            if let Some(opened) = live.iter().map(|c| c.0).min() {
                let (stage, since) = live
                    .iter()
                    .filter_map(|c| Some((c.1?, c.2)))
                    .min_by_key(|(s, at)| (*s, std::cmp::Reverse(*at)))
                    .unwrap_or((Stage::PrOpen, opened));
                reached.push((
                    Stage::PrOpen,
                    if stage == Stage::PrOpen {
                        since
                    } else {
                        opened
                    },
                ));
                if stage > Stage::PrOpen {
                    reached.push((stage, since));
                }
            }
            if let Some(at) = f.verified {
                reached.push((Stage::Verified, at));
            }
            (k, Facts { reached })
        })
        .collect()
}

/// A unit's share of its size credited (0 to 1), and whether it is verified: its stage's credit plus
/// `step × min(worked / usual, 0.9)`. `worked` is only the stage's time covered by `spans`, the unit's spans of work
/// in flight (an open one ends at `now`), so paused, it holds what it earned, and time nobody worked never counts.
pub fn unit_credit(f: &Facts, now: i64, size: Size, spans: &[(i64, i64)]) -> (f64, bool) {
    let (stage, entered) = f.current();
    if stage == Stage::Verified {
        return (1.0, true);
    }
    let frac =
        (covered(spans, entered, now) as f64 / stage.usual_ms(size) as f64).min(IN_STAGE_CAP);
    (
        stage.credit() + (stage.next().credit() - stage.credit()) * frac,
        false,
    )
}

/// The time in `[from, to]` that `spans` cover; they may overlap.
pub fn covered(spans: &[(i64, i64)], from: i64, to: i64) -> i64 {
    let mut clipped: Vec<(i64, i64)> = spans
        .iter()
        .map(|&(a, b)| (a.max(from), b.min(to)))
        .filter(|(a, b)| a < b)
        .collect();
    clipped.sort_unstable();
    let (mut total, mut end) = (0, i64::MIN);
    for (a, b) in clipped {
        let a = a.max(end);
        if b > a {
            total += b - a;
            end = b;
        }
    }
    total
}

/// A project's figure before the drop rule: (pct, verified pct), Σ credit over Σ points, floored. 100 only when every
/// unit is verified, and never below what is verified. `units` are (points, credit, verified).
pub fn figure(units: &[(f64, f64, bool)]) -> (i64, i64) {
    let total: f64 = units.iter().map(|u| u.0).sum();
    if total <= 0.0 {
        return (0, 0);
    }
    let all_done = units.iter().all(|u| u.2);
    // The epsilon keeps a share like 0.7 × 3 / 3 from flooring to 69.
    let pct_of = |x: f64| {
        let p = (100.0 * x / total + 1e-9).floor() as i64;
        if all_done { p.min(100) } else { p.min(99) }
    };
    let verified = pct_of(units.iter().filter(|u| u.2).map(|u| u.0).sum());
    let credit = pct_of(units.iter().map(|u| u.0 * u.1).sum());
    (credit.max(verified), verified)
}

/// An order the bars read: open, or done in the last day.
pub struct Order {
    pub w: Workstream,
    pub pkey: String,
}

impl Order {
    fn id(&self) -> &str {
        self.w.workstream_id.as_str()
    }
}

/// A live task (running, or idle until an answer or a usage reset) of an order the bars read.
pub struct LiveTask {
    pub order: String,
    /// The Change it reviews, when it is a reviewer.
    pub reviews: Option<String>,
    /// Its record says running and not parked on a usage limit: what counts when its last day has no start, end or
    /// pause event to go by.
    pub running: bool,
}

/// A live task's thread waiting on an answer (`thread.waiting`), parked on a usage limit (`thread.usage_limited`) or
/// running again (`thread.started`), when the hub received it: the node's own times can be skewed.
pub struct ThreadMove {
    pub task: String,
    pub kind: String,
    pub at_ms: i64,
}

/// One read of what every project's bar needs, bounded by open work and the last day, so a read costs the same after
/// months of history.
pub struct Data {
    pub now: i64,
    pub items: Vec<ItemRow>,
    pub open_milestones: HashSet<i64>,
    /// Milestone → when its first item came.
    pub first_item_ms: HashMap<i64, i64>,
    pub orders: Vec<Order>,
    /// Changes of `orders`.
    pub changes: Vec<Change>,
    /// The last day's events the bars read, oldest first: (type, stored JSON).
    pub recent: Vec<(String, Value)>,
    pub live_tasks: HashMap<String, LiveTask>,
    /// The last day's pauses and restarts of the live tasks' threads, oldest first.
    pub thread_moves: Vec<ThreadMove>,
}

const RECENT_TYPES: [&str; 8] = [
    // Stage moves and the causes that may lower a figure.
    "change.state",
    "change.ci_failed",
    "plan.changed",
    "review.verdict",
    // A live task's runs: in-stage credit counts while one is open.
    "task.started",
    "task.completed",
    "task.failed",
    "task.cancelled",
];

impl Data {
    pub fn read(c: &Connection, now: i64) -> rusqlite::Result<Self> {
        let since_ms = now - DAY_MS;
        let since_iso = iso_ms(since_ms);
        let mut orders = Vec::new();
        for row in c
            .prepare_cached(
                "SELECT machine_id, project_id, data FROM workstreams
                 WHERE state = 'open'
                    OR (state = 'done' AND json_extract(data, '$.updatedAt') >= ?)",
            )?
            .query_map([&since_iso], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })?
        {
            let (m, p, data) = row?;
            if let Ok(w) = serde_json::from_str::<Workstream>(&data) {
                orders.push(Order {
                    w,
                    pkey: format!("{m}/{p}"),
                });
            }
        }
        let milestones = plan::store::milestones_all(c)?;
        let ids = serde_json::to_string(&orders.iter().map(Order::id).collect::<Vec<_>>())
            .unwrap_or_else(|_| "[]".into());
        let changes = c
            .prepare_cached(
                "SELECT data FROM changes
                 WHERE (CASE WHEN json_valid(data) THEN json_extract(data, '$.workstreamId') END)
                   IN (SELECT value FROM json_each(?))",
            )?
            .query_map([&ids], |r| r.get::<_, String>(0))?
            .filter_map(|d| serde_json::from_str::<Change>(&d.ok()?).ok())
            .collect();
        let mut recent = Vec::new();
        let types = serde_json::to_string(&RECENT_TYPES).unwrap_or_default();
        for row in c
            .prepare_cached(
                "SELECT type, data FROM events
                 WHERE type IN (SELECT value FROM json_each(?)) AND created_ms >= ? ORDER BY seq",
            )?
            .query_map(params![types, since_ms], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
        {
            let (t, data) = row?;
            if let Ok(v) = serde_json::from_str(&data) {
                recent.push((t, v));
            }
        }
        let mut task_of_thread: HashMap<(String, String), String> = HashMap::new();
        let mut live_tasks = HashMap::new();
        for row in c
            .prepare_cached(
                "SELECT json_extract(t.data, '$.taskId'), t.workstream_id, r.change_id,
                        t.state = 'running' AND json_extract(t.data, '$.parked') IS NULL,
                        t.machine_id, t.thread_id
                 FROM tasks t LEFT JOIN review_tasks r ON r.task_id = json_extract(t.data, '$.taskId')
                 WHERE t.state IN ('running', 'idle') AND t.workstream_id IN (SELECT value FROM json_each(?))",
            )?
            .query_map([&ids], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    LiveTask {
                        order: r.get(1)?,
                        reviews: r.get(2)?,
                        running: r.get(3)?,
                    },
                    r.get::<_, String>(4)?,
                    r.get::<_, Option<String>>(5)?,
                ))
            })?
        {
            let (task, live, machine, thread) = row?;
            if let Some(thread) = thread {
                task_of_thread.insert((machine, thread), task.clone());
            }
            live_tasks.insert(task, live);
        }
        // One pass over the day's thread events, matched here: a join per task would rescan them for each.
        // Reminders of a prompt still open are not moves.
        let mut thread_moves = Vec::new();
        if !task_of_thread.is_empty() {
            for row in c
                .prepare_cached(
                    "SELECT machine_id, json_extract(data, '$.threadId'), type, created_ms FROM events
                     WHERE type IN ('thread.started', 'thread.waiting', 'thread.usage_limited') AND created_ms >= ?
                       AND COALESCE(json_extract(data, '$.data.reminder'), 0) = 0
                     ORDER BY seq",
                )?
                .query_map([since_ms], |r| {
                    Ok((
                        r.get::<_, Option<String>>(0)?,
                        r.get::<_, Option<String>>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, i64>(3)?,
                    ))
                })?
            {
                let (Some(machine), Some(thread), kind, at_ms) = row? else {
                    continue;
                };
                if let Some(task) = task_of_thread.get(&(machine, thread)) {
                    thread_moves.push(ThreadMove {
                        task: task.clone(),
                        kind,
                        at_ms,
                    });
                }
            }
        }
        Ok(Self {
            now,
            items: plan::store::items_live(c, now - WINDOW_MS)?,
            open_milestones: milestones
                .iter()
                .filter(|m| m.done_ms.is_none())
                .map(|m| m.n)
                .collect(),
            first_item_ms: milestones
                .iter()
                .filter_map(|m| Some((m.n, m.first_item_ms?)))
                .collect(),
            orders,
            changes,
            recent,
            live_tasks,
            thread_moves,
        })
    }
}

/// A project's figure before the drop rule.
#[derive(Clone, Debug, PartialEq)]
pub struct Bar {
    pub pct: i64,
    pub verified: i64,
    /// Why the figure holds, while paused work is all it has in flight.
    pub paused: Option<String>,
    /// The last day's observed causes that may lower it.
    pub causes: Vec<Cause>,
}

/// The project's bar, or None when it has nothing to count. The units are the live items of its open milestones
/// (must items, or polish when it has none).
pub fn bar(d: &Data, pkey: &str) -> Option<Bar> {
    let now = d.now;
    let live: Vec<&ItemRow> = d
        .items
        .iter()
        .filter(|i| {
            i.pkey == pkey
                && i.state != PlanItemState::Dropped
                && d.open_milestones.contains(&i.milestone)
        })
        .collect();
    let has_must = live.iter().any(|i| i.weight == Weight::Must);
    let counted: Vec<&ItemRow> = live
        .into_iter()
        .filter(|i| (i.weight == Weight::Must) == has_must)
        .collect();
    if counted.is_empty() {
        return None;
    }

    let mut obs: Vec<Obs> = Vec::new();
    let mut change_units: Vec<(UnitKey, &Change)> = Vec::new();
    for i in &counted {
        let key = UnitKey::Item(i.n);
        let created = i
            .data
            .created_ms
            .or_else(|| d.first_item_ms.get(&i.milestone).copied())
            .or(i.started_ms)
            .unwrap_or(now);
        obs.push(Obs {
            at_ms: created,
            unit: key.clone(),
            what: What::Created,
        });
        if i.state == PlanItemState::Done {
            obs.push(Obs {
                at_ms: i.done_ms.unwrap_or(now),
                unit: key.clone(),
                what: What::Verified,
            });
        }
        let tasks: HashSet<&str> = i.data.links.tasks.iter().map(|t| t.as_str()).collect();
        for ch in &d.changes {
            if ch
                .task_id
                .as_ref()
                .is_some_and(|t| tasks.contains(t.as_str()))
                || i.data.links.prs.contains(&ch.pr_url)
            {
                change_units.push((key.clone(), ch));
            }
        }
    }
    // Each Change's moves in the last day, from `change.state` events.
    let mut change_moves: HashMap<&str, Vec<(i64, ChangeState)>> = HashMap::new();
    for (_, e) in d.recent.iter().filter(|(t, _)| t == "change.state") {
        let (Some(id), Some(at), Some(to)) = (
            e.pointer("/data/changeId").and_then(Value::as_str),
            e.get("at").and_then(Value::as_str).and_then(parse_ms),
            e.pointer("/data/to")
                .and_then(|v| serde_json::from_value::<ChangeState>(v.clone()).ok()),
        ) else {
            continue;
        };
        change_moves.entry(id).or_default().push((at, to));
    }
    for (key, ch) in &change_units {
        let id = ch.change_id.to_string();
        let created = parse_ms(ch.created_at.as_str()).unwrap_or(0);
        let mut push = |at_ms: i64, state: ChangeState| {
            obs.push(Obs {
                at_ms,
                unit: key.clone(),
                what: What::ChangeState {
                    change: id.clone(),
                    state,
                },
            });
        };
        push(created, ChangeState::Queued);
        let seen = change_moves
            .get(id.as_str())
            .map(Vec::as_slice)
            .unwrap_or_default();
        for (at, state) in seen {
            push(*at, *state);
        }
        if seen.last().is_none_or(|(_, s)| *s != ch.state) {
            push(
                parse_ms(ch.updated_at.as_str()).unwrap_or(created),
                ch.state,
            );
        }
    }
    let facts = observe(&obs, now);

    // What each unit has had in flight, as spans of time: its tasks while they ran, and a Change of its while it moves
    // on the train (one the train holds, or one in review with no reviewer running, is not). Only time those spans
    // cover earns in-stage credit, so time nobody worked never counts, and a pause keeps what was earned. A task's
    // moves in the last day give its spans: a start opens one (a continued task keeps what it earned), and an end
    // keeps nothing (an ended task's credit is taken back with a marker); a pause (its thread waiting on an answer, or
    // parked on a usage limit) closes one, and its thread running again after a stop opens one (while it runs, that
    // is only a new turn). A day's first move says what came before: only a thread running again follows a stop.
    // With no move in the day its record decides, and it has run all day. The events go first because the task area
    // updates the record after them, and a read in between must already see the pause. A Change has been moving
    // since its last update: a state move or a hold lifted. A start read later than the real one only under-counts,
    // which the drop rule shows as a hold, never as a fall or a jump.
    #[derive(Clone, Copy, PartialEq)]
    enum Move {
        Start,
        End,
        Park(&'static str),
        ThreadRuns,
    }
    let mut moves: Vec<(i64, &str, Move)> = Vec::new();
    for (t, e) in &d.recent {
        let m = match t.as_str() {
            "task.started" => Move::Start,
            "task.completed" | "task.failed" | "task.cancelled" => Move::End,
            _ => continue,
        };
        if let (Some(task), Some(at)) = (
            e.pointer("/data/taskId").and_then(Value::as_str),
            e.get("at").and_then(Value::as_str).and_then(parse_ms),
        ) {
            moves.push((at, task, m));
        }
    }
    for m in &d.thread_moves {
        let kind = match m.kind.as_str() {
            "thread.started" => Move::ThreadRuns,
            "thread.waiting" => Move::Park("an agent is waiting for an answer"),
            _ => Move::Park("an agent hit a usage limit"),
        };
        moves.push((m.at_ms, m.task.as_str(), kind));
    }
    moves.sort_by_key(|(at, _, _)| *at);
    #[derive(Default)]
    struct Run {
        spans: Vec<(i64, i64)>,
        open: Option<i64>,
        /// While paused: when, and why.
        parked: Option<(i64, &'static str)>,
    }
    let mut runs: HashMap<&str, Run> = HashMap::new();
    for (at, task, m) in moves {
        let run = runs.entry(task).or_insert_with(|| Run {
            open: (m != Move::ThreadRuns).then_some(now - DAY_MS),
            ..Run::default()
        });
        match m {
            Move::Start => {
                run.open = Some(at);
                run.parked = None;
            }
            Move::End => *run = Run::default(),
            Move::Park(why) => {
                if let Some(start) = run.open.take() {
                    run.spans.push((start, at));
                }
                run.parked = Some((at, why));
            }
            Move::ThreadRuns if run.open.is_none() => {
                run.open = Some(at);
                run.parked = None;
            }
            Move::ThreadRuns => {}
        }
    }
    let mut spans: HashMap<UnitKey, Vec<(i64, i64)>> = HashMap::new();
    let mut unit_tasks: Vec<(UnitKey, &str)> = Vec::new();
    for (key, ch) in &change_units {
        let moving = match ch.state {
            ChangeState::Queued | ChangeState::Ready => {
                ch.last_error.as_ref().is_none_or(|e| e.is_empty())
            }
            ChangeState::Rebasing | ChangeState::Ci | ChangeState::Merging => true,
            _ => false,
        };
        if moving {
            let updated = parse_ms(ch.updated_at.as_str()).unwrap_or(now);
            spans.entry(key.clone()).or_default().push((updated, now));
        }
        if ch.state == ChangeState::Reviewing {
            for (t, _) in d
                .live_tasks
                .iter()
                .filter(|(_, l)| l.reviews.as_deref() == Some(ch.change_id.as_str()))
            {
                unit_tasks.push((key.clone(), t));
            }
        }
        if let Some(t) = &ch.task_id {
            unit_tasks.push((key.clone(), t.as_str()));
        }
    }
    for i in &counted {
        for t in &i.data.links.tasks {
            unit_tasks.push((UnitKey::Item(i.n), t.as_str()));
        }
    }
    // The project's latest pause, shown while nothing else in it runs.
    let mut paused: Option<(i64, &str)> = None;
    for (key, t) in unit_tasks {
        let Some(live) = d.live_tasks.get(t) else {
            continue;
        };
        let unit = spans.entry(key).or_default();
        match runs.get(t) {
            Some(run) => {
                unit.extend(run.spans.iter().copied().chain(run.open.map(|s| (s, now))));
                paused = paused.max(run.parked);
            }
            None if live.running => unit.push((now - DAY_MS, now)),
            None => {}
        }
    }
    let running = spans.values().flatten().any(|&(_, end)| end == now);
    let paused = paused
        .filter(|_| !running)
        .map(|(_, why)| format!("paused: {why}"));

    let units: Vec<(UnitKey, i64)> = counted
        .iter()
        .map(|i| (UnitKey::Item(i.n), i.size.points()))
        .collect();
    let credited: Vec<(f64, f64, bool)> = units
        .into_iter()
        .map(|(key, points)| {
            let f = facts.get(&key).cloned().unwrap_or_default();
            let sp = spans.get(&key).map_or(&[][..], Vec::as_slice);
            let UnitKey::Item(n) = &key;
            let size = counted
                .iter()
                .find(|i| i.n == *n)
                .map_or(Size::M, |i| i.size);
            let (credit, verified) = unit_credit(&f, now, size, sp);
            (points as f64, credit, verified)
        })
        .collect();
    let (pct, verified) = figure(&credited);
    let causes = d
        .recent
        .iter()
        .filter_map(|(t, e)| {
            let of = |k: &str| e.get(k).and_then(Value::as_str).unwrap_or_default();
            if format!("{}/{}", of("machineId"), of("projectId")) != pkey {
                return None;
            }
            let at = e.get("at").and_then(Value::as_str).and_then(parse_ms)?;
            cause_of(t, e.get("data")?, at)
        })
        .collect();
    Some(Bar {
        pct,
        verified,
        paused,
        causes,
    })
}

/// One point of a project's series.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub at_ms: i64,
    pub pct: i64,
    pub verified: i64,
    pub drop: Option<PointDrop>,
    /// Set while the figure holds because work paused: what paused. A marker, not a drop.
    #[serde(default)]
    pub paused: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PointDrop {
    pub reason: DropReason,
    pub from_pct: i64,
    pub text: String,
}

/// Something observed that may lower a figure: added scope, a failed review or CI (a unit falls back a stage), work
/// that stopped, or a reopened item.
#[derive(Clone, Debug, PartialEq)]
pub struct Cause {
    pub at_ms: i64,
    pub reason: DropReason,
    pub text: String,
}

/// The drop cause an event is, if any: `data` is the event's `data` object.
pub fn cause_of(event_type: &str, data: &Value, at_ms: i64) -> Option<Cause> {
    let str_of = |k: &str| data.get(k).and_then(Value::as_str);
    let pr = || {
        data.get("prNumber").and_then(Value::as_i64).map_or_else(
            || str_of("changeId").unwrap_or("a PR").to_owned(),
            |n| format!("#{n}"),
        )
    };
    let (reason, text) = match event_type {
        // Every plan marker changes a figure's denominator, so any of them explains a drop: added or removed scope,
        // a finished milestone leaving the figure, items closed with their order, a reopened item.
        "plan.changed" => match str_of("kind")? {
            "reopened" => (DropReason::Reopened, str_of("note")?.to_owned()),
            _ => (DropReason::ScopeChange, str_of("note")?.to_owned()),
        },
        "change.ci_failed" => (DropReason::CiFailed, format!("CI failed on {}", pr())),
        // An agent's run ended, so its unit may have nothing in flight any more and lose its in-stage credit.
        "task.completed" => (
            DropReason::WorkStopped,
            "work stopped: an agent finished".into(),
        ),
        "task.failed" => (
            DropReason::WorkStopped,
            "work stopped: an agent failed".into(),
        ),
        "task.cancelled" => (
            DropReason::WorkStopped,
            "work stopped: an agent was cancelled".into(),
        ),
        "review.verdict" if data.get("blocking").and_then(Value::as_i64).unwrap_or(0) > 0 => {
            let n = data.get("blocking").and_then(Value::as_i64).unwrap_or(0);
            let on = str_of("pr")
                .and_then(|u| u.rsplit('/').next())
                .map_or_else(String::new, |n| format!(" on #{n}"));
            (
                DropReason::ReviewFailed,
                format!(
                    "review found {n} blocking issue{}{on}",
                    if n == 1 { "" } else { "s" }
                ),
            )
        }
        "change.state" => {
            let from = serde_json::from_value::<ChangeState>(data.get("from")?.clone()).ok()?;
            let to = serde_json::from_value::<ChangeState>(data.get("to")?.clone()).ok()?;
            if change_stage(to)? >= change_stage(from)? {
                return None;
            }
            match to {
                ChangeState::CiFailed => (DropReason::CiFailed, format!("CI failed on {}", pr())),
                ChangeState::NeedsRebase => {
                    (DropReason::CiFailed, format!("{} needs a rebase", pr()))
                }
                _ => (
                    DropReason::ReviewFailed,
                    format!("{} went back to review", pr()),
                ),
            }
        }
        _ => return None,
    };
    Some(Cause {
        at_ms,
        reason,
        text: plan::clip(&text, 200),
    })
}

/// The next point. The figure may fall only when a cause was observed since the previous point (same millisecond
/// included: an event can land in the ms a point was taken), and that point says why; otherwise it holds. Verified
/// likewise falls only on added scope or a reopened item.
pub fn next_point(
    prev: Option<&Point>,
    raw_pct: i64,
    raw_verified: i64,
    causes: &[Cause],
    now: i64,
) -> Point {
    let Some(p) = prev else {
        return Point {
            at_ms: now,
            pct: raw_pct.max(raw_verified),
            verified: raw_verified,
            drop: None,
            paused: None,
        };
    };
    let since: Vec<&Cause> = causes
        .iter()
        .filter(|c| c.at_ms >= p.at_ms && c.at_ms <= now)
        .collect();
    let verified = if raw_verified < p.verified
        && !since
            .iter()
            .any(|c| matches!(c.reason, DropReason::ScopeChange | DropReason::Reopened))
    {
        p.verified
    } else {
        raw_verified
    };
    let (pct, drop) = if raw_pct >= p.pct {
        (raw_pct, None)
    } else if let Some(c) = since.iter().max_by_key(|c| c.at_ms) {
        (
            raw_pct,
            Some(PointDrop {
                reason: c.reason,
                from_pct: p.pct,
                text: c.text.clone(),
            }),
        )
    } else {
        (p.pct, None)
    };
    Point {
        at_ms: now,
        pct: pct.max(verified),
        verified,
        drop,
        paused: None,
    }
}

/// Whether `next` adds anything to a series ending in `last`.
pub fn changes(last: Option<&Point>, next: &Point) -> bool {
    last.is_none_or(|l| {
        l.pct != next.pct
            || l.verified != next.verified
            || next.drop.is_some()
            || l.paused != next.paused
    })
}

/// A project's stored series, oldest first.
pub fn stored(c: &Connection, key: &str) -> rusqlite::Result<Vec<Point>> {
    let mut points: Vec<Point> = c
        .prepare_cached(
            "SELECT at_ms, pct, verified, drop_reason, paused FROM status_series WHERE scope = ?
             ORDER BY at_ms DESC LIMIT ?",
        )?
        .query_map(params![key, SERIES_CAP as i64], |r| {
            Ok(Point {
                at_ms: r.get(0)?,
                pct: r.get(1)?,
                verified: r.get(2)?,
                drop: r
                    .get::<_, Option<String>>(3)?
                    .and_then(|d| serde_json::from_str(&d).ok()),
                paused: r.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    points.reverse();
    Ok(points)
}

/// Applies the drop rule to the project's stored series and returns its last point, storing it when it changes
/// anything. `bar.paused` marks the new point while the figure holds on paused work.
pub fn advance(c: &Connection, key: &str, bar: &Bar, now: i64) -> rusqlite::Result<Point> {
    let last = stored(c, key)?.pop();
    let next = Point {
        paused: bar.paused.clone(),
        ..next_point(last.as_ref(), bar.pct, bar.verified, &bar.causes, now)
    };
    if !changes(last.as_ref(), &next) || last.as_ref().is_some_and(|l| l.at_ms >= now) {
        return Ok(last.unwrap_or(next));
    }
    c.prepare_cached(
        "INSERT OR REPLACE INTO status_series (scope, at_ms, pct, verified, drop_reason, paused)
         VALUES (?, ?, ?, ?, ?, ?)",
    )?
    .execute(params![
        key,
        next.at_ms,
        next.pct,
        next.verified,
        next.drop
            .as_ref()
            .map(|d| serde_json::to_string(d).unwrap_or_default()),
        next.paused
    ])?;
    c.prepare_cached(
        "DELETE FROM status_series WHERE scope = ? AND at_ms NOT IN
           (SELECT at_ms FROM status_series WHERE scope = ? ORDER BY at_ms DESC LIMIT ?)",
    )?
    .execute(params![key, key, SERIES_CAP as i64])?;
    Ok(next)
}

fn pct(n: i64) -> Int<0, 100> {
    Int::unchecked(n.clamp(0, 100))
}

/// The row's bar from its series' last point.
pub fn estimate_of(p: &Point) -> ProgressEstimate {
    ProgressEstimate {
        pct: pct(p.pct),
        verified_pct: pct(p.verified),
        in_flight_pct: pct(p.pct - p.verified),
    }
}

/// The newest [`SERIES_SENT`] points in the contract shape, oldest first.
pub fn points_out(points: &[Point]) -> Vec<ProgressPoint> {
    let line = |t: &str| Line::unchecked(plan::clip(if t.is_empty() { "—" } else { t }, 200));
    points[points.len().saturating_sub(SERIES_SENT)..]
        .iter()
        .map(|x| ProgressPoint {
            at: Timestamp(iso_ms(x.at_ms)),
            pct: pct(x.pct),
            verified_pct: pct(x.verified),
            drop: x.drop.as_ref().map(|d| ProgressDrop {
                reason: d.reason,
                from_pct: pct(d.from_pct),
                text: line(&d.text),
            }),
            paused: x.paused.as_deref().map(line),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// In flight all along.
    const ALL: &[(i64, i64)] = &[(0, i64::MAX)];
    const M: i64 = MIN;

    fn at(stage: Stage, t: i64) -> Facts {
        Facts {
            reached: vec![(Stage::Planned, 0), (stage, t)],
        }
    }

    #[test]
    fn reaching_a_stage_credits_its_fixed_share() {
        for (stage, share) in [
            (Stage::PrOpen, 0.5),
            (Stage::ReviewPassed, 0.7),
            (Stage::CiGreen, 0.8),
            (Stage::Merged, 0.9),
        ] {
            let (credit, verified) = unit_credit(&at(stage, 10 * M), 10 * M, Size::M, ALL);
            assert!(
                (credit - share).abs() < 1e-9 && !verified,
                "{stage:?}: no time in it yet"
            );
        }
        assert_eq!(
            unit_credit(&at(Stage::Verified, 5 * M), 6 * M, Size::M, ALL),
            (1.0, true)
        );
    }

    #[test]
    fn inside_a_stage_credit_moves_but_never_claims_the_next_stage() {
        let f = at(Stage::PrOpen, 0);
        let usual = Stage::PrOpen.usual_ms(Size::M);
        let half = unit_credit(&f, usual / 2, Size::M, ALL).0;
        assert!(
            (half - 0.6).abs() < 1e-6,
            "half of the step to review: {half}"
        );
        let mut last = 0.0;
        for t in [0, usual / 4, usual / 2, usual, 3 * usual, 100 * usual] {
            let c = unit_credit(&f, t, Size::M, ALL).0;
            assert!(c >= last, "never falls with time");
            assert!(
                c < Stage::ReviewPassed.credit(),
                "never reaches review unobserved"
            );
            last = c;
        }
        assert!(
            (last - (0.5 + 0.2 * IN_STAGE_CAP)).abs() < 1e-9,
            "the 0.9 cap"
        );
        assert_eq!(
            unit_credit(&f, 100 * usual, Size::M, &[]).0,
            0.5,
            "with nothing in flight, time in the stage earns nothing"
        );
        // A quarter, a pause of 100 usual times, then another quarter: half, as with no pause.
        let (q, back) = (usual / 4, 100 * usual);
        let resumed = unit_credit(&f, back + q, Size::M, &[(0, q), (back, i64::MAX)]).0;
        assert!(
            (resumed - half).abs() < 1e-6,
            "paused time never counts and earned time stays: {resumed} vs {half}"
        );
    }

    #[test]
    fn observations_fold_into_stages_and_a_failed_ci_falls_back() {
        let item = UnitKey::Item(1);
        let obs = |at: i64, what: What| Obs {
            at_ms: at,
            unit: item.clone(),
            what,
        };
        let cs = |at: i64, change: &str, state: ChangeState| {
            obs(
                at,
                What::ChangeState {
                    change: change.into(),
                    state,
                },
            )
        };
        let all = vec![
            obs(0, What::Created),
            cs(5, "X1", ChangeState::Queued),
            cs(6, "X1", ChangeState::Reviewing),
            cs(8, "X1", ChangeState::Ready),
            cs(9, "X1", ChangeState::Ci),
            cs(10, "X1", ChangeState::CiFailed),
            cs(12, "X1", ChangeState::Reviewing),
        ];
        let at = |t: i64| observe(&all, t)[&item].current();
        assert_eq!(at(2), (Stage::Planned, 0));
        assert_eq!(
            at(6),
            (Stage::PrOpen, 5),
            "reviewing keeps the PR-open time"
        );
        assert_eq!(
            at(9),
            (Stage::ReviewPassed, 8),
            "ready → ci stays in one stage"
        );
        assert_eq!(
            at(10),
            (Stage::PrOpen, 10),
            "red CI: back to PR open, from now"
        );
        assert_eq!(at(12), (Stage::PrOpen, 10));
        let mut two = all.clone();
        two.push(cs(13, "X1", ChangeState::Merged));
        two.push(cs(14, "X2", ChangeState::Queued));
        assert_eq!(
            observe(&two, 14)[&item].current(),
            (Stage::PrOpen, 14),
            "every live Change counts"
        );
        two.push(cs(15, "X2", ChangeState::Abandoned));
        assert_eq!(
            observe(&two, 15)[&item].current(),
            (Stage::Merged, 13),
            "an abandoned one doesn't"
        );
        two.push(obs(16, What::Verified));
        assert_eq!(observe(&two, 16)[&item].current().0, Stage::Verified);
    }

    #[test]
    fn the_figure_is_never_100_until_verified() {
        assert_eq!(figure(&[]), (0, 0));
        assert_eq!(
            figure(&[(1.0, 1.0, true), (3.0, 0.9, false)]),
            (92, 25),
            "floored, in flight on top of verified"
        );
        assert_eq!(
            figure(&[(1.0, 1.0, true), (199.0, 1.0, false)]).0,
            99,
            "100 only when every unit is verified"
        );
        assert_eq!(figure(&[(1.0, 1.0, true), (3.0, 1.0, true)]), (100, 100));
    }

    #[test]
    fn the_figure_drops_only_with_a_marker() {
        let p0 = next_point(None, 40, 20, &[], 1_000);
        assert_eq!((p0.pct, p0.verified), (40, 20));
        let held = next_point(Some(&p0), 35, 20, &[], 60_000);
        assert_eq!((held.pct, held.drop.clone()), (40, None), "no cause: hold");
        let old = Cause {
            at_ms: 0,
            reason: DropReason::CiFailed,
            text: "CI failed on #1".into(),
        };
        assert_eq!(
            next_point(Some(&p0), 35, 20, &[old], 60_000).pct,
            40,
            "a cause before the last point is spent"
        );
        let ci = Cause {
            at_ms: 30_000,
            reason: DropReason::CiFailed,
            text: "CI failed on #212".into(),
        };
        let fell = next_point(Some(&p0), 35, 20, std::slice::from_ref(&ci), 60_000);
        let d = fell.drop.unwrap();
        assert_eq!(
            (fell.pct, d.reason, d.from_pct, d.text.as_str()),
            (35, DropReason::CiFailed, 40, "CI failed on #212")
        );
        assert_eq!(
            next_point(Some(&p0), 35, 10, &[ci], 60_000).verified,
            20,
            "CI never un-verifies"
        );
        let scope = Cause {
            at_ms: 30_000,
            reason: DropReason::ScopeChange,
            text: "+2 items: lab run".into(),
        };
        let p = next_point(Some(&p0), 30, 15, &[scope], 60_000);
        assert_eq!((p.pct, p.verified), (30, 15));
        assert!(!changes(Some(&p0), &next_point(Some(&p0), 40, 20, &[], 1)));
    }

    #[test]
    fn causes_come_from_observed_events_only() {
        use serde_json::json;
        let c = cause_of(
            "change.state",
            &json!({ "from": "ci", "to": "ci_failed", "prNumber": 212 }),
            5,
        )
        .unwrap();
        assert_eq!(
            (c.reason, c.text.as_str()),
            (DropReason::CiFailed, "CI failed on #212")
        );
        let c = cause_of(
            "change.state",
            &json!({ "from": "ready", "to": "reviewing", "prNumber": 3 }),
            5,
        );
        assert_eq!(c.unwrap().reason, DropReason::ReviewFailed);
        assert!(cause_of("change.state", &json!({ "from": "ready", "to": "ci" }), 5).is_none());
        let c = cause_of(
            "plan.changed",
            &json!({ "kind": "milestone_done", "note": "M1 checkout done (1 item)" }),
            5,
        );
        assert_eq!(
            c.unwrap().text,
            "M1 checkout done (1 item)",
            "a finished milestone leaves the figure with its marker"
        );
        let c = cause_of(
            "review.verdict",
            &json!({ "blocking": 2, "pr": "https://github.com/a/b/pull/9" }),
            5,
        );
        assert_eq!(c.unwrap().text, "review found 2 blocking issues on #9");
        assert!(cause_of("review.verdict", &json!({ "blocking": 0 }), 5).is_none());
        assert!(
            cause_of("thread.usage_limited", &json!({}), 5).is_none(),
            "a pause holds the figure, it never explains a fall"
        );
        let c = cause_of("task.failed", &json!({ "taskId": "T12" }), 5);
        assert_eq!(
            c.map(|c| (c.reason, c.text)),
            Some((
                DropReason::WorkStopped,
                "work stopped: an agent failed".into()
            )),
            "plain words, no task id"
        );
    }
}
