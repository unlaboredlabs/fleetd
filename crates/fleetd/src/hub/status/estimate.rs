//! Feeds the progress model from one read of the hub: each unit's observations (plan items, and orders with no plan
//! items), each order's planning, the scope's estimate and slow items, and the scope's series.
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use fleetd_contracts::ids::Timestamp;
use fleetd_contracts::ledger::WorkstreamState;
use fleetd_contracts::plan::{ItemStage, PlanItemState, Size, Weight};
use fleetd_contracts::prim::{Int, Line, List};
use fleetd_contracts::status::{
    PlanningState, ProgressDrop, ProgressEstimate, ProgressPoint, StatusScope, WeightsBasis,
};
use fleetd_contracts::train::{Change, ChangeState};
use rusqlite::{Connection, params};
use serde_json::Value;

use super::model::{
    self, Calibration, Cause, Group, ItemProgress, Obs, Point, PointDrop, Unit, UnitKey, UnitKind,
    What,
};
use super::render::{DAY_MS, Order, Scope, World};
use crate::hub::plan::parse_ms;
use crate::hub::plan::store::ItemRow;
use crate::hub::store::iso_ms;

/// What the model reads beyond the status world, bounded by the orders in view.
#[derive(Default)]
pub struct ModelData {
    pub calibration: Arc<Calibration>,
    /// Orders still being drafted (the lead is planning), touched in the last day.
    pub drafts: Vec<Order>,
    /// Changes of the orders in view.
    pub changes: Vec<Change>,
    /// Order → when its brief froze (its first `workstream.running`).
    pub frozen: HashMap<String, i64>,
    /// Order → its first write task's start.
    pub first_write: HashMap<String, i64>,
    /// Task → its first push; order → its first push.
    pub task_push: HashMap<String, i64>,
    pub order_push: HashMap<String, i64>,
    /// Order → planning share fixed when its plan appeared, and when.
    pub planning: HashMap<String, (f64, i64)>,
    /// Live tasks (running, or idle until an answer or a usage reset) of the orders in view.
    pub live_tasks: HashMap<String, LiveTask>,
    /// The last day's pauses and restarts of the live tasks' threads, oldest first.
    pub thread_moves: Vec<ThreadMove>,
}

pub struct LiveTask {
    pub order: String,
    /// The Change it reviews, when it is a reviewer.
    pub reviews: Option<String>,
    /// Its record says running and not parked on a usage limit: what counts when its last day has no start, end or
    /// pause event to go by.
    pub running: bool,
}

/// A live task's thread waiting on an answer (`thread.waiting`), parked on a usage limit (`thread.usage_limited`) or
/// running again (`thread.started`), when the hub received it: the node's own times can be skewed, and the model
/// measures against the hub's.
pub struct ThreadMove {
    pub task: String,
    pub kind: String,
    pub at_ms: i64,
}

fn json_ids(ids: &[String]) -> String {
    serde_json::to_string(ids).unwrap_or_else(|_| "[]".into())
}

impl ModelData {
    pub fn read(
        c: &Connection,
        orders: &[Order],
        since_iso: &str,
        calibration: Arc<Calibration>,
    ) -> rusqlite::Result<Self> {
        let mut drafts = Vec::new();
        for row in c
            .prepare_cached(
                "SELECT machine_id, project_id, data FROM workstreams
                 WHERE state = 'draft' AND json_extract(data, '$.updatedAt') >= ?",
            )?
            .query_map([since_iso], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })?
        {
            let (m, p, data) = row?;
            if let Ok(w) = serde_json::from_str(&data) {
                drafts.push(Order {
                    w,
                    pkey: format!("{m}/{p}"),
                });
            }
        }
        let ids: Vec<String> = orders
            .iter()
            .chain(&drafts)
            .map(|o| o.w.workstream_id.to_string())
            .collect();
        let ids = json_ids(&ids);
        let changes = c
            .prepare_cached(
                "SELECT data FROM changes
                 WHERE (CASE WHEN json_valid(data) THEN json_extract(data, '$.workstreamId') END)
                   IN (SELECT value FROM json_each(?))",
            )?
            .query_map([&ids], |r| r.get::<_, String>(0))?
            .filter_map(|d| serde_json::from_str::<Change>(&d.ok()?).ok())
            .collect();
        let frozen = c
            .prepare_cached(
                "SELECT json_extract(data, '$.data.workstreamId') AS ws, MIN(created_ms) FROM events
                 WHERE type = 'workstream.running' AND ws IN (SELECT value FROM json_each(?))
                 GROUP BY ws",
            )?
            .query_map([&ids], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let first_write = c
            .prepare_cached(
                "SELECT workstream_id, MIN(json_extract(data, '$.startedAt')) FROM tasks
                 WHERE workstream_id IN (SELECT value FROM json_each(?))
                   AND json_extract(data, '$.kind') = 'write' AND json_extract(data, '$.startedAt') IS NOT NULL
                 GROUP BY workstream_id",
            )?
            .query_map([&ids], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .filter_map(|r| {
                let (ws, at) = r.ok()?;
                Some((ws, parse_ms(&at)?))
            })
            .collect();
        let mut task_push: HashMap<String, i64> = HashMap::new();
        let mut order_push: HashMap<String, i64> = HashMap::new();
        for row in c
            .prepare_cached(
                "SELECT s.workstream_id, s.task_id, s.start_ms, l.text FROM time_spans s
                 JOIN time_labels l ON l.id = s.label_id
                 WHERE s.workstream_id IN (SELECT value FROM json_each(?)) AND s.kind = ?
                   AND (l.text LIKE '%git push%' OR l.text LIKE 'gh pr create%')",
            )?
            .query_map(
                params![ids, fleetd_contracts::time::SpanKind::Git.code()],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Option<String>>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, String>(3)?,
                    ))
                },
            )?
        {
            let (ws, task, at, label) = row?;
            if !model::is_push(&label) {
                continue;
            }
            let min = |m: &mut HashMap<String, i64>, k: String| {
                let e = m.entry(k).or_insert(at);
                *e = (*e).min(at);
            };
            min(&mut order_push, ws);
            if let Some(t) = task {
                min(&mut task_push, t);
            }
        }
        let planning = c
            .prepare_cached(
                "SELECT workstream_id, share, ended_ms FROM status_planning
                 WHERE workstream_id IN (SELECT value FROM json_each(?))",
            )?
            .query_map([&ids], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    (r.get::<_, f64>(1)?, r.get::<_, i64>(2)?),
                ))
            })?
            .collect::<rusqlite::Result<_>>()?;
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
                .query_map([parse_ms(since_iso).unwrap_or(0)], |r| {
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
            calibration,
            drafts,
            changes,
            frozen,
            first_write,
            task_push,
            order_push,
            planning,
            live_tasks,
            thread_moves,
        })
    }
}

/// Each Change's moves in the last day, from `change.state` events.
fn moves(recent: &[(String, Value)]) -> HashMap<String, Vec<(i64, ChangeState)>> {
    let mut out: HashMap<String, Vec<(i64, ChangeState)>> = HashMap::new();
    for (_, e) in recent.iter().filter(|(t, _)| t == "change.state") {
        let (Some(id), Some(at), Some(to)) = (
            e.pointer("/data/changeId").and_then(Value::as_str),
            e.get("at").and_then(Value::as_str).and_then(parse_ms),
            e.pointer("/data/to")
                .and_then(|v| serde_json::from_value::<ChangeState>(v.clone()).ok()),
        ) else {
            continue;
        };
        out.entry(id.to_owned()).or_default().push((at, to));
    }
    out
}

fn change_obs(
    unit: &UnitKey,
    ch: &Change,
    moves: &HashMap<String, Vec<(i64, ChangeState)>>,
    out: &mut Vec<Obs>,
) {
    let id = ch.change_id.to_string();
    let created = parse_ms(ch.created_at.as_str()).unwrap_or(0);
    let mut push = |at: i64, state: ChangeState| {
        out.push(Obs {
            at_ms: at,
            unit: unit.clone(),
            what: What::ChangeState {
                change: id.clone(),
                state,
            },
        });
    };
    push(created, ChangeState::Queued);
    let seen = moves.get(&id).map(Vec::as_slice).unwrap_or_default();
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

/// The scope's figure under the progress model.
pub struct ModelOut {
    pub groups: Vec<Group>,
    pub units: HashMap<UnitKey, ItemProgress>,
    pub estimate: model::Estimate,
    pub basis: WeightsBasis,
    /// The order's planning (order scopes only).
    pub planning: Option<PlanningState>,
    /// (label, stage, time in it so far), the slowest against its usual first.
    pub slower: Vec<(String, ItemStage, i64)>,
    /// The unit on the scope's critical path.
    pub critical: Option<UnitKey>,
    /// Each unit's open PR number, for its steps.
    pub prs: HashMap<UnitKey, i64>,
    /// Plans that appeared since the last read: (order, share, when), to store once.
    pub fix_planning: Vec<(String, f64, i64)>,
    /// When the figure next moves with time alone (in-stage credit, a unit turning slow, planning's bar).
    pub wake_at: Option<i64>,
    /// Why the figure holds, while paused work is all it has in flight.
    pub paused: Option<String>,
}

fn label_of(w: &World, key: &UnitKey) -> String {
    match key {
        UnitKey::Item(n) => w
            .items
            .iter()
            .find(|i| i.n == *n)
            .map_or_else(|| format!("P{n}"), |i| format!("P{n} {}", i.data.title)),
        UnitKey::Order(ws) => w
            .orders
            .iter()
            .find(|o| o.w.workstream_id.as_str() == ws)
            .map_or_else(
                || ws.clone(),
                |o| format!("{ws} {}", crate::hub::orders::short_title(&o.w)),
            ),
    }
}

/// The critical path: the open unit with the most unfinished work through it (its own remaining share of its size,
/// plus that of every open item waiting on it), by weights only. Ties go to the earlier unit.
fn critical(
    items: &[&ItemRow],
    units: &HashMap<UnitKey, ItemProgress>,
    points: &HashMap<UnitKey, f64>,
) -> Option<UnitKey> {
    let left = |k: &UnitKey| {
        units.get(k).filter(|u| !u.verified).map_or(0.0, |u| {
            points.get(k).copied().unwrap_or(0.0) * (1.0 - u.credit)
        })
    };
    let waiting: HashMap<i64, Vec<i64>> = items.iter().fold(HashMap::new(), |mut m, i| {
        for a in &i.data.after {
            m.entry(*a).or_default().push(i.n);
        }
        m
    });
    fn through(
        n: i64,
        waiting: &HashMap<i64, Vec<i64>>,
        left: &dyn Fn(&UnitKey) -> f64,
        memo: &mut HashMap<i64, f64>,
        depth: usize,
    ) -> f64 {
        if let Some(v) = memo.get(&n) {
            return *v;
        }
        let after = if depth < 64 {
            waiting
                .get(&n)
                .into_iter()
                .flatten()
                .map(|x| through(*x, waiting, left, memo, depth + 1))
                .fold(0.0, f64::max)
        } else {
            0.0
        };
        let v = left(&UnitKey::Item(n)) + after;
        memo.insert(n, v);
        v
    }
    let mut memo = HashMap::new();
    let mut keys: Vec<&UnitKey> = units.keys().filter(|k| !units[*k].verified).collect();
    keys.sort();
    let mut best: Option<(&UnitKey, f64)> = None;
    for k in keys {
        let v = match k {
            UnitKey::Item(n) => through(*n, &waiting, &left, &mut memo, 0),
            UnitKey::Order(_) => left(k),
        };
        if best.is_none_or(|(_, b)| v > b + 1e-9) {
            best = Some((k, v));
        }
    }
    best.map(|(k, _)| k.clone())
}

/// What a unit still waits on, in order: open items it is `after`, then its remaining stages.
pub fn steps(stage: ItemStage, pr: Option<i64>, after: &[String]) -> Vec<String> {
    let on = |what: &str| pr.map_or_else(|| what.to_owned(), |n| format!("{what} of #{n}"));
    let ci = pr.map_or_else(|| "CI".to_owned(), |n| format!("CI on #{n}"));
    let mut out: Vec<String> = after.to_vec();
    let rest: [String; 8] = [
        "the brief".into(),
        "a writer".into(),
        "the writer's push".into(),
        "a PR".into(),
        on("review"),
        ci,
        "merge".into(),
        "marked done".into(),
    ];
    let k = stage.index().min(rest.len());
    if stage != ItemStage::Verified {
        out.extend(rest.iter().skip(k).cloned());
    }
    out.truncate(8);
    out
}

pub fn compute(w: &World, scope: &StatusScope, s: &Scope<'_>) -> ModelOut {
    let md = &w.model;
    let cal = &md.calibration;
    let now = w.now;
    let moves = moves(&w.recent);
    let drafts: Vec<&Order> = md
        .drafts
        .iter()
        .filter(|o| match scope {
            StatusScope::Fleet => true,
            StatusScope::Project { .. } => s.pkeys.contains(&o.pkey),
            StatusScope::Order { workstream_id } => o.w.workstream_id == *workstream_id,
        })
        .collect();
    let live: Vec<&ItemRow> = s
        .items
        .iter()
        .copied()
        .filter(|i| i.state != PlanItemState::Dropped)
        .collect();
    let has_must = live.iter().any(|i| i.weight == Weight::Must)
        || s.orders
            .iter()
            .any(|o| w.placeholders.contains_key(o.w.workstream_id.as_str()))
        || !drafts.is_empty();
    let counted: Vec<&ItemRow> = live
        .iter()
        .copied()
        .filter(|i| (i.weight == Weight::Must) == has_must)
        .collect();
    let frozen = |ws: &str| md.frozen.get(ws).copied();
    let first_item_ms = |m: i64| {
        w.milestones
            .iter()
            .find(|x| x.n == m)
            .and_then(|x| x.first_item_ms)
    };
    let created_of = |i: &ItemRow| {
        i.data
            .created_ms
            .or_else(|| first_item_ms(i.milestone))
            .or(i.started_ms)
            .unwrap_or(now)
    };

    // Observations of every unit.
    let mut obs: Vec<Obs> = Vec::new();
    let mut add = |unit: &UnitKey, at: Option<i64>, what: What| {
        if let Some(at) = at {
            obs.push(Obs {
                at_ms: at,
                unit: unit.clone(),
                what,
            });
        }
    };
    for i in &counted {
        let key = UnitKey::Item(i.n);
        let created = created_of(i);
        add(&key, Some(created), What::Created);
        let ws = i.workstream_id.as_deref();
        add(
            &key,
            ws.and_then(frozen).map(|f| f.max(created)),
            What::BriefFrozen,
        );
        add(&key, i.started_ms, What::TaskStarted);
        let tasks: HashSet<&str> = i.data.links.tasks.iter().map(|t| t.as_str()).collect();
        add(
            &key,
            tasks
                .iter()
                .filter_map(|t| md.task_push.get(*t))
                .min()
                .copied(),
            What::Pushed,
        );
        if i.state == PlanItemState::Done {
            add(&key, Some(i.done_ms.unwrap_or(now)), What::Verified);
        }
    }
    let mut change_units: Vec<(UnitKey, &Change)> = Vec::new();
    for i in &counted {
        let tasks: HashSet<&str> = i.data.links.tasks.iter().map(|t| t.as_str()).collect();
        for ch in &md.changes {
            if ch
                .task_id
                .as_ref()
                .is_some_and(|t| tasks.contains(t.as_str()))
                || i.data.links.prs.contains(&ch.pr_url)
            {
                change_units.push((UnitKey::Item(i.n), ch));
            }
        }
    }
    let virtual_orders: Vec<&Order> = s
        .orders
        .iter()
        .copied()
        .filter(|o| w.placeholders.contains_key(o.w.workstream_id.as_str()))
        .filter(|o| {
            !counted
                .iter()
                .any(|i| i.workstream_id.as_deref() == Some(o.w.workstream_id.as_str()))
        })
        .collect();
    for o in &virtual_orders {
        let ws = o.w.workstream_id.as_str();
        let key = UnitKey::Order(ws.to_owned());
        add(&key, parse_ms(o.w.created_at.as_str()), What::Created);
        add(&key, frozen(ws), What::BriefFrozen);
        add(&key, md.first_write.get(ws).copied(), What::TaskStarted);
        add(&key, md.order_push.get(ws).copied(), What::Pushed);
        if w.placeholders.get(ws).is_some_and(|p| p.done) {
            add(&key, parse_ms(o.w.updated_at.as_str()), What::Verified);
        }
        for ch in md.changes.iter().filter(|c| c.workstream_id.as_str() == ws) {
            change_units.push((key.clone(), ch));
        }
    }
    for (key, ch) in &change_units {
        change_obs(key, ch, &moves, &mut obs);
    }
    let pr_of = change_units;
    let facts = model::observe(&obs, now);

    // What each unit has had in flight, as spans of time: its tasks while they ran, and a Change of its while it moves
    // on the train (one the train holds, or one in review with no reviewer running, is not). Only time those spans
    // cover earns in-stage credit, so time nobody worked never counts, and a pause keeps what was earned. A task's
    // moves in the last day give its spans: a start opens one (a continued task keeps what it earned), and an end
    // keeps nothing (an ended task's credit is taken back with a marker); a pause (its thread waiting on an answer, or
    // parked on a usage limit) closes one, and its thread running again after a stop opens one (while it runs, that
    // is only a new turn). A day's first move says what came before: only a thread running again follows a stop. With no move in
    // the day its record decides, and it has run all day. The events go first because the task area updates the
    // record after them, and a render in between must already see the pause. A Change has been moving since its last
    // update: a state move or a hold lifted. A start read later than the real one only under-counts, which the drop
    // rule shows as a hold, never as a fall or a jump.
    #[derive(Clone, Copy, PartialEq)]
    enum Move {
        Start,
        End,
        Park(&'static str),
        ThreadRuns,
    }
    let mut moves: Vec<(i64, &str, Move)> = Vec::new();
    for (t, e) in &w.recent {
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
    for m in &md.thread_moves {
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
    for (key, ch) in &pr_of {
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
            for (t, _) in md
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
    for o in &virtual_orders {
        let ws = o.w.workstream_id.as_str();
        for (t, _) in md.live_tasks.iter().filter(|(_, l)| l.order == ws) {
            unit_tasks.push((UnitKey::Order(ws.to_owned()), t));
        }
    }
    // The scope's latest pause, shown while nothing else in it runs.
    let mut paused: Option<(i64, &str)> = None;
    for (key, t) in unit_tasks {
        let Some(live) = md.live_tasks.get(t) else {
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

    // Each unit's progress against its calibration.
    let mut units: HashMap<UnitKey, ItemProgress> = HashMap::new();
    let mut bases: Vec<WeightsBasis> = Vec::new();
    let mut slower = Vec::new();
    let wake: std::cell::Cell<Option<i64>> = std::cell::Cell::new(None);
    let wake_at = |t: i64| {
        if t > now {
            wake.set(Some(wake.get().map_or(t, |x| x.min(t))));
        }
    };
    let mut progress_of = |key: UnitKey, pkey: &str, kind: UnitKind, size: Size| {
        let r = cal.resolve(pkey, kind, size);
        bases.push(r.basis);
        let f = facts.get(&key).cloned().unwrap_or_default();
        let (stage, entered) = f.current();
        let sp = spans.get(&key).map_or(&[][..], Vec::as_slice);
        let p = model::item_progress(&f, now, &r, sp);
        if !p.verified {
            let k = stage.index();
            let cap_ms = (r.usual_ms(k) as f64 * model::IN_STAGE_CAP) as i64;
            if sp.iter().any(|&(_, end)| end == now) && model::covered(sp, entered, now) < cap_ms {
                wake_at(now + TICK_MS);
            }
            if let Some(slow) = r.slow_at(k) {
                wake_at(entered + slow + 1);
            }
        }
        if p.slower {
            let usual = r.usual_ms(stage.index());
            slower.push((
                label_of(w, &key),
                stage,
                now - entered,
                (now - entered) * 100 / usual,
            ));
        }
        units.insert(key, p.clone());
        p
    };

    let mut groups = Vec::new();
    let mut fix_planning = Vec::new();
    let mut planning_state = None;
    let mut points: HashMap<UnitKey, f64> = HashMap::new();
    let mut grouped: HashSet<i64> = HashSet::new();
    for o in s.orders.iter().copied().chain(drafts.iter().copied()) {
        let ws = o.w.workstream_id.as_str();
        let mine: Vec<&ItemRow> = counted
            .iter()
            .copied()
            .filter(|i| i.workstream_id.as_deref() == Some(ws))
            .collect();
        let placeholder = w.placeholders.get(ws);
        let draft = o.w.state == WorkstreamState::Draft;
        let mut group_units = Vec::new();
        let points = if !mine.is_empty() {
            for i in &mine {
                grouped.insert(i.n);
                let p = progress_of(UnitKey::Item(i.n), &i.pkey, UnitKind::Item, i.size);
                group_units.push(Unit {
                    points: i.size.points() as f64,
                    progress: p,
                });
            }
            group_units.iter().map(|u| u.points).sum()
        } else if let Some(ph) = placeholder {
            let size = match ph.size {
                1 => Size::S,
                8 => Size::L,
                _ => Size::M,
            };
            let p = progress_of(
                UnitKey::Order(ws.to_owned()),
                &o.pkey,
                UnitKind::Order,
                size,
            );
            group_units.push(Unit {
                points: ph.size as f64,
                progress: p,
            });
            ph.size as f64
        } else if draft {
            Size::S.points() as f64
        } else {
            continue;
        };
        let created = parse_ms(o.w.created_at.as_str()).unwrap_or(now);
        let first_item = w
            .items
            .iter()
            .filter(|i| i.workstream_id.as_deref() == Some(ws))
            .map(created_of)
            .min();
        let (share, usual) = cal.planning(&o.pkey);
        let planning = match md.planning.get(ws) {
            Some((fixed, ended)) => model::planning(created, Some(*ended), now, *fixed, usual),
            None => {
                let ended = [first_item, md.first_write.get(ws).copied()]
                    .into_iter()
                    .flatten()
                    .min()
                    .filter(|_| !draft);
                if let Some(e) = ended {
                    fix_planning.push((ws.to_owned(), share, e));
                }
                model::planning(created, ended, now, share, usual)
            }
        };
        if planning.active && planning.credit < model::IN_STAGE_CAP {
            wake_at(now + TICK_MS);
        }
        if matches!(scope, StatusScope::Order { .. }) {
            planning_state = Some(PlanningState {
                active: planning.active,
                pct: Int::unchecked((planning.credit * 100.0).floor() as i64),
                share_pct: Int::unchecked((planning.share * 100.0).round() as i64),
                since: Timestamp(iso_ms(planning.since_ms)),
            });
        }
        let done = !group_units.is_empty() && group_units.iter().all(|u| u.progress.verified);
        groups.push(Group {
            points,
            planning: Some(planning),
            units: group_units,
            done,
        });
    }
    for i in counted.iter().filter(|i| !grouped.contains(&i.n)) {
        let p = progress_of(UnitKey::Item(i.n), &i.pkey, UnitKind::Item, i.size);
        groups.push(Group {
            points: i.size.points() as f64,
            planning: None,
            done: p.verified,
            units: vec![Unit {
                points: i.size.points() as f64,
                progress: p,
            }],
        });
    }
    let estimate = model::estimate(&groups);
    let basis = if bases.contains(&WeightsBasis::Default) || bases.is_empty() {
        WeightsBasis::Default
    } else if bases.contains(&WeightsBasis::Fleet) {
        WeightsBasis::Fleet
    } else {
        WeightsBasis::Project
    };

    for i in &counted {
        points.insert(UnitKey::Item(i.n), i.size.points() as f64);
    }
    for o in &virtual_orders {
        if let Some(ph) = w.placeholders.get(o.w.workstream_id.as_str()) {
            points.insert(
                UnitKey::Order(o.w.workstream_id.to_string()),
                ph.size as f64,
            );
        }
    }
    let critical = critical(&counted, &units, &points);
    let mut prs: HashMap<UnitKey, i64> = HashMap::new();
    for (key, ch) in &pr_of {
        let open = !matches!(
            ch.state,
            ChangeState::Merged | ChangeState::Abandoned | ChangeState::Refused
        );
        if open || !prs.contains_key(key) {
            prs.insert(key.clone(), ch.pr_number.get());
        }
    }
    slower.sort_by_key(|(_, _, _, ratio)| std::cmp::Reverse(*ratio));
    let slower = slower.into_iter().map(|(l, s, e, _)| (l, s, e)).collect();
    ModelOut {
        groups,
        units,
        estimate,
        basis,
        planning: planning_state,
        slower,
        critical,
        prs,
        fix_planning,
        wake_at: wake.get(),
        paused,
    }
}

/// Points a doc carries (the store keeps [`model::SERIES_CAP`]); `fit` trims further, oldest first, to fit a frame.
pub const DOC_SERIES: usize = 48;

/// How often a figure with work in flight is re-rendered for its in-stage credit.
pub const TICK_MS: i64 = 60_000;

/// The drop causes in the last day's events that touch the scope's orders.
pub fn causes(w: &World, scope: &StatusScope, s: &Scope<'_>) -> Vec<Cause> {
    let ws_of_change: HashMap<String, String> = w
        .model
        .changes
        .iter()
        .map(|c| (c.change_id.to_string(), c.workstream_id.to_string()))
        .collect();
    w.recent
        .iter()
        .filter_map(|(t, e)| {
            let data = e.get("data")?;
            let pk = format!(
                "{}/{}",
                e.get("machineId")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                e.get("projectId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
            );
            let ws = data
                .get("workstreamId")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| {
                    data.get("changeId")
                        .and_then(Value::as_str)
                        .and_then(|c| ws_of_change.get(c).cloned())
                });
            let in_scope = match scope {
                StatusScope::Fleet => true,
                StatusScope::Project { .. } => s.pkeys.contains(&pk),
                StatusScope::Order { workstream_id } => {
                    ws.as_deref() == Some(workstream_id.as_str())
                }
            };
            if !in_scope {
                return None;
            }
            let at = e.get("at").and_then(Value::as_str).and_then(parse_ms)?;
            model::cause_of(t, data, at)
        })
        .collect()
}

fn drop_text(d: &PointDrop) -> String {
    serde_json::to_string(d).unwrap_or_default()
}

/// Applies the drop rule to the scope's stored series and returns it, oldest first, with the new point appended
/// when it changes anything. `paused` marks the new point while the figure holds on paused work.
pub fn series(
    c: &Connection,
    key: &str,
    raw: model::Estimate,
    paused: Option<String>,
    causes: &[Cause],
    now: i64,
) -> rusqlite::Result<Vec<Point>> {
    let mut points: Vec<Point> = c
        .prepare_cached(
            "SELECT at_ms, pct, verified, drop_reason, paused FROM status_series WHERE scope = ?
             ORDER BY at_ms DESC LIMIT ?",
        )?
        .query_map(params![key, model::SERIES_CAP as i64], |r| {
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
    let next = Point {
        paused,
        ..model::next_point(points.last(), raw.pct, raw.verified_pct, causes, now)
    };
    if model::changes(points.last(), &next) && points.last().is_none_or(|l| l.at_ms < now) {
        c.prepare_cached(
            "INSERT OR REPLACE INTO status_series (scope, at_ms, pct, verified, drop_reason, paused)
             VALUES (?, ?, ?, ?, ?, ?)",
        )?
        .execute(params![
            key,
            next.at_ms,
            next.pct,
            next.verified,
            next.drop.as_ref().map(drop_text),
            next.paused
        ])?;
        c.prepare_cached(
            "DELETE FROM status_series WHERE scope = ? AND at_ms NOT IN
               (SELECT at_ms FROM status_series WHERE scope = ? ORDER BY at_ms DESC LIMIT ?)",
        )?
        .execute(params![key, key, model::SERIES_CAP as i64])?;
        points.push(next);
        if points.len() > model::SERIES_CAP {
            points.remove(0);
        }
    }
    Ok(points)
}

pub fn store_planning(c: &Connection, fix: &[(String, f64, i64)]) -> rusqlite::Result<()> {
    for (ws, share, ended) in fix {
        c.prepare_cached(
            "INSERT OR IGNORE INTO status_planning (workstream_id, share, ended_ms) VALUES (?, ?, ?)",
        )?
        .execute(params![ws, share, ended])?;
    }
    Ok(())
}

fn pct(n: i64) -> Int<0, 100> {
    Int::unchecked(n.clamp(0, 100))
}

/// The contract shape. With a series, the figure is the series' last point (the drop rule applied).
pub fn estimate_of(out: &ModelOut, series: Option<&[Point]>) -> ProgressEstimate {
    let (p, v) = match series.and_then(|s| s.last()) {
        Some(last) => (last.pct, last.verified),
        None => (out.estimate.pct, out.estimate.verified_pct),
    };
    ProgressEstimate {
        pct: pct(p),
        verified_pct: pct(v),
        in_flight_pct: pct(p - v),
        planning: out.planning.clone(),
        weights: out.basis,
        series: series.map(|pts| {
            List::unchecked(
                pts[pts.len().saturating_sub(DOC_SERIES)..]
                    .iter()
                    .map(|x| ProgressPoint {
                        at: Timestamp(iso_ms(x.at_ms)),
                        pct: pct(x.pct),
                        verified_pct: pct(x.verified),
                        drop: x.drop.as_ref().map(|d| ProgressDrop {
                            reason: d.reason,
                            from_pct: pct(d.from_pct),
                            text: Line::unchecked(crate::hub::plan::clip(
                                if d.text.is_empty() { "—" } else { &d.text },
                                200,
                            )),
                        }),
                        paused: x
                            .paused
                            .as_deref()
                            .map(|t| Line::unchecked(crate::hub::plan::clip(t, 200))),
                    })
                    .collect(),
            )
        }),
    }
}

/// "in review", for "P12 cart page is slower than usual in review (2h10m so far)".
pub fn stage_phrase(stage: ItemStage) -> &'static str {
    match stage {
        ItemStage::Planned => "waiting for its brief",
        ItemStage::BriefFrozen => "waiting to start",
        ItemStage::TaskStarted => "being written",
        ItemStage::FirstPush => "before its PR",
        ItemStage::PrOpen => "in review",
        ItemStage::ReviewPassed => "in CI and the train",
        ItemStage::CiGreen => "merging",
        ItemStage::Merged => "being marked done",
        ItemStage::Verified | ItemStage::Unknown => "",
    }
}
