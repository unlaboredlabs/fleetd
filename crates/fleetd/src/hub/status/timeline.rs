//! Each unit's observations (a plan item, or an order with no plan items), read back from the hub's own rows: events,
//! plan items, tasks, Changes and the time inspector's git spans. The nightly calibration, the forecast log and the
//! offline replay (`bin/progress_replay.rs`) read history through this and fold it with `model::observe`, the same
//! fold the status view uses, so they agree on what was observed.
use std::collections::HashMap;

use fleetd_contracts::plan::{ItemStage, Size};
use fleetd_contracts::time::SpanKind;
use fleetd_contracts::train::ChangeState;
use rusqlite::{Connection, params};
use serde_json::Value;

use super::model::{
    Cause, ItemFacts, Obs, STAGES, UnitKey, UnitKind, What, cause_of, change_stage, is_push,
    observe,
};

/// One unit's observed history.
#[derive(Clone, Debug, PartialEq)]
pub struct Timeline {
    pub key: UnitKey,
    /// `W1` for an order with no plan items, `W1/P2` for a plan item.
    pub label: String,
    pub workstream: String,
    /// `machine/project`.
    pub pkey: String,
    pub kind: UnitKind,
    pub size: Size,
    /// When the order was created, and when its planning ended (its first plan item, or its first task).
    pub order_ms: i64,
    pub plan_ms: Option<i64>,
    /// When the unit was planned.
    pub start_ms: i64,
    pub obs: Vec<Obs>,
    /// Its order's drop causes (failed reviews and CI, added scope, reopened items).
    pub causes: Vec<Cause>,
    pub dropped: bool,
}

impl Timeline {
    pub fn facts_at(&self, t: i64) -> ItemFacts {
        observe(&self.obs, t).remove(&self.key).unwrap_or_default()
    }

    pub fn done_ms(&self) -> Option<i64> {
        self.facts_at(i64::MAX)
            .reached
            .iter()
            .find(|(s, _)| *s == ItemStage::Verified)
            .map(|(_, at)| *at)
    }

    /// When each stage was first reached. A stage passed without being seen takes the time of the next one seen, so
    /// its time counts toward the stage before it.
    pub fn first_reached(&self) -> [Option<i64>; STAGES] {
        let mut first: [Option<i64>; STAGES] = [None; STAGES];
        for o in &self.obs {
            let stage = match &o.what {
                What::Created => Some(ItemStage::Planned),
                What::BriefFrozen => Some(ItemStage::BriefFrozen),
                What::TaskStarted => Some(ItemStage::TaskStarted),
                What::Pushed => Some(ItemStage::FirstPush),
                What::ChangeState { state, .. } => change_stage(*state),
                What::Verified => Some(ItemStage::Verified),
                What::Reopened => None,
            };
            let Some(stage) = stage else { continue };
            for f in first.iter_mut().take(stage.index() + 1) {
                if f.is_none_or(|t| o.at_ms < t) {
                    *f = Some(o.at_ms);
                }
            }
        }
        first[0] = Some(self.start_ms);
        first
    }
}

fn size_of(points: i64) -> Size {
    match points {
        1 => Size::S,
        8 => Size::L,
        _ => Size::M,
    }
}

fn s<'a>(v: &'a Value, path: &[&str]) -> Option<&'a str> {
    path.iter().try_fold(v, |v, k| v.get(k))?.as_str()
}

const TYPES: &[&str] = &[
    "workstream.running",
    "workstream.done",
    "task.started",
    "change.queued",
    "change.state",
    "change.ci_failed",
    "pr.merged",
    "review.verdict",
    "plan.changed",
    "plan.verified",
];

struct Order {
    ws: String,
    order_ms: i64,
    /// (at, type, the event's `data`).
    events: Vec<(i64, String, Value)>,
}

/// Every unit of the orders created at or after `since_ms`, or only `only`'s whenever it was created.
pub fn load(c: &Connection, since_ms: i64, only: Option<&str>) -> rusqlite::Result<Vec<Timeline>> {
    let mut stmt = c.prepare(
        "SELECT json_extract(data, '$.workstreamId'), json_extract(data, '$.createdAt') FROM workstreams
         WHERE ?1 IS NULL OR json_extract(data, '$.workstreamId') = ?1 ORDER BY n",
    )?;
    let mut orders: Vec<Order> = stmt
        .query_map([only], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .filter_map(|r| r.ok())
        .filter_map(|(ws, created)| {
            let order_ms = chrono::DateTime::parse_from_rfc3339(&created)
                .ok()?
                .timestamp_millis();
            (only.is_some() || order_ms >= since_ms).then_some(Order {
                ws,
                order_ms,
                events: Vec::new(),
            })
        })
        .collect();
    if orders.is_empty() {
        return Ok(Vec::new());
    }
    let index: HashMap<String, usize> = orders
        .iter()
        .enumerate()
        .map(|(i, o)| (o.ws.clone(), i))
        .collect();
    let from = orders.iter().map(|o| o.order_ms).min().unwrap_or(0);
    let list = serde_json::to_string(TYPES).unwrap_or_default();
    let mut stmt = c.prepare(
        "SELECT created_ms, type, json_extract(data, '$.data') FROM events
         WHERE type IN (SELECT value FROM json_each(?1)) AND created_ms >= ?2 ORDER BY seq",
    )?;
    let rows = stmt.query_map(params![list, from], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?,
        ))
    })?;
    for row in rows {
        let (at, ty, data) = row?;
        let Some(data) = data.and_then(|d| serde_json::from_str::<Value>(&d).ok()) else {
            continue;
        };
        if let Some(&i) = s(&data, &["workstreamId"]).and_then(|ws| index.get(ws)) {
            orders[i].events.push((at, ty, data));
        }
    }
    let mut out = Vec::new();
    for o in &orders {
        out.extend(order_units(c, o)?);
    }
    Ok(out)
}

fn json_rows(c: &Connection, sql: &str, ws: &str) -> rusqlite::Result<Vec<Value>> {
    let mut stmt = c.prepare(sql)?;
    let rows = stmt.query_map([ws], |r| r.get::<_, String>(0))?;
    Ok(rows
        .filter_map(|r| r.ok())
        .filter_map(|d| serde_json::from_str(&d).ok())
        .collect())
}

struct Draft {
    key: UnitKey,
    label: String,
    size: Size,
    start_ms: i64,
    dropped: bool,
    tasks: Vec<String>,
    prs: Vec<String>,
}

fn order_units(c: &Connection, o: &Order) -> rusqlite::Result<Vec<Timeline>> {
    let ws = o.ws.as_str();
    let (pkey, state): (String, String) = c
        .query_row(
            "SELECT machine_id || '/' || project_id, state FROM workstreams
             WHERE json_extract(data, '$.workstreamId') = ?1",
            [ws],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap_or_default();
    let mut stmt = c.prepare(
        "SELECT i.n, i.state, i.size, i.data, m.first_item_ms FROM plan_items i
         LEFT JOIN plan_milestones m ON m.n = i.milestone WHERE i.workstream_id = ?1 ORDER BY i.position, i.n",
    )?;
    let items: Vec<(i64, String, i64, Value, Option<i64>)> = stmt
        .query_map([ws], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get::<_, String>(3)?,
                r.get(4)?,
            ))
        })?
        .filter_map(|r| r.ok())
        .map(|(n, st, size, d, first)| {
            (
                n,
                st,
                size,
                serde_json::from_str(&d).unwrap_or(Value::Null),
                first,
            )
        })
        .collect();
    let tasks = json_rows(
        c,
        "SELECT data FROM tasks WHERE workstream_id = ?1 ORDER BY n",
        ws,
    )?;
    let changes = json_rows(
        c,
        "SELECT data FROM changes WHERE json_extract(data, '$.workstreamId') = ?1",
        ws,
    )?;
    // Pushes are the time inspector's: a hub without its tables has none.
    let pushes: Vec<(i64, String)> = c
        .prepare(
            "SELECT s.start_ms, s.task_id, l.text FROM time_spans s JOIN time_labels l ON l.id = s.label_id
             WHERE s.workstream_id = ?1 AND s.kind = ?2 AND s.task_id IS NOT NULL ORDER BY s.start_ms",
        )
        .and_then(|mut st| {
            st.query_map(params![ws, SpanKind::Git.code()], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap_or_default()
        .into_iter()
        .filter(|(_, _, label)| is_push(label))
        .map(|(at, task, _)| (at, task))
        .collect();
    let at_of = |ty: &str| {
        o.events
            .iter()
            .find(|(_, t, _)| t == ty)
            .map(|(at, _, _)| *at)
    };
    let running = at_of("workstream.running");
    let write_tasks: Vec<String> = tasks
        .iter()
        .filter(|t| s(t, &["kind"]) == Some("write"))
        .filter_map(|t| s(t, &["taskId"]).map(str::to_owned))
        .collect();
    let first_write = o
        .events
        .iter()
        .find(|(_, ty, d)| {
            ty == "task.started"
                && s(d, &["taskId"]).is_some_and(|t| write_tasks.iter().any(|w| w == t))
        })
        .map(|(at, _, _)| *at);

    let mut drafts: Vec<Draft> = Vec::new();
    let item_created = |d: &Value, first: Option<i64>| {
        d.get("createdMs")
            .or_else(|| d.get("created_ms"))
            .and_then(Value::as_i64)
            .or(first)
    };
    if items.is_empty() {
        let tier: Option<String> = c
            .query_row(
                "SELECT tier FROM estimates WHERE workstream_id = ?1",
                [ws],
                |r| r.get(0),
            )
            .ok();
        drafts.push(Draft {
            key: UnitKey::Order(ws.to_owned()),
            label: ws.to_owned(),
            size: match tier.as_deref() {
                Some("S") => Size::S,
                Some("L") => Size::L,
                _ => Size::M,
            },
            start_ms: o.order_ms,
            dropped: state == "stopped",
            tasks: write_tasks.clone(),
            prs: Vec::new(),
        });
    } else {
        for (n, st, size, d, first) in &items {
            let id = format!("P{n}");
            let strings = |ptr: &str| -> Vec<String> {
                d.pointer(ptr)
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(|x| x.as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default()
            };
            let mut linked = strings("/links/tasks");
            for t in &tasks {
                if s(t, &["itemId"]) == Some(id.as_str())
                    && let Some(tid) = s(t, &["taskId"])
                    && !linked.iter().any(|l| l == tid)
                {
                    linked.push(tid.to_owned());
                }
            }
            drafts.push(Draft {
                key: UnitKey::Item(*n),
                label: format!("{ws}/{id}"),
                size: size_of(*size),
                start_ms: item_created(d, *first)
                    .unwrap_or(o.order_ms)
                    .max(o.order_ms),
                dropped: st == "dropped",
                tasks: linked,
                prs: strings("/links/prs"),
            });
        }
    }
    let plan_ms = drafts
        .iter()
        .filter(|d| matches!(d.key, UnitKey::Item(_)))
        .map(|d| d.start_ms)
        .chain(first_write)
        .min();

    let unit_of_change: HashMap<String, usize> = changes
        .iter()
        .filter_map(|ch| {
            let id = s(ch, &["changeId"])?.to_owned();
            let task = s(ch, &["taskId"]);
            let url = s(ch, &["prUrl"]);
            // An order with no plan items takes every Change of the order.
            let u = drafts.iter().position(|d| {
                matches!(d.key, UnitKey::Order(_))
                    || task.is_some_and(|t| d.tasks.iter().any(|x| x == t))
                    || url.is_some_and(|p| d.prs.iter().any(|x| x == p))
            })?;
            Some((id, u))
        })
        .collect();
    let unit_of_task = |task: &str| {
        drafts
            .iter()
            .position(|d| d.tasks.iter().any(|t| t == task))
    };

    let mut obs: Vec<Vec<Obs>> = vec![Vec::new(); drafts.len()];
    let mut add = |i: usize, at_ms: i64, what: What| {
        obs[i].push(Obs {
            at_ms: at_ms.max(drafts[i].start_ms),
            unit: drafts[i].key.clone(),
            what,
        });
    };
    for (i, d) in drafts.iter().enumerate() {
        add(i, d.start_ms, What::Created);
        if let Some(r) = running {
            add(i, r, What::BriefFrozen);
        }
    }
    for (at, task) in &pushes {
        if let Some(i) = unit_of_task(task) {
            add(i, *at, What::Pushed);
        }
    }
    let mut causes = Vec::new();
    for (at, ty, data) in &o.events {
        if let Some(cause) = cause_of(ty, data, *at) {
            causes.push(cause);
        }
        let change = s(data, &["changeId"]);
        match ty.as_str() {
            "task.started" => {
                if let Some(i) = s(data, &["taskId"]).and_then(unit_of_task) {
                    add(i, *at, What::TaskStarted);
                }
            }
            "change.queued" | "change.state" | "pr.merged" => {
                let Some(&i) = change.and_then(|c| unit_of_change.get(c)) else {
                    continue;
                };
                let state = match ty.as_str() {
                    "change.queued" => Some(ChangeState::Queued),
                    "pr.merged" => Some(ChangeState::Merged),
                    _ => data
                        .get("to")
                        .and_then(|t| serde_json::from_value(t.clone()).ok()),
                };
                if let Some(state) = state {
                    let change = change.unwrap_or_default().to_owned();
                    add(i, *at, What::ChangeState { change, state });
                }
            }
            "plan.verified" => {
                let item = s(data, &["itemId"]);
                if let Some(i) = drafts
                    .iter()
                    .position(|d| item.is_some_and(|it| d.label.ends_with(&format!("/{it}"))))
                {
                    add(i, *at, What::Verified);
                }
            }
            "workstream.done" => {
                for (i, d) in drafts.iter().enumerate() {
                    if matches!(d.key, UnitKey::Order(_)) {
                        add(i, *at, What::Verified);
                    }
                }
            }
            // "P3 reopened: check 1 failed in a later claim"
            "plan.changed" if s(data, &["kind"]) == Some("reopened") => {
                let n = s(data, &["note"])
                    .and_then(|t| t.strip_prefix('P'))
                    .and_then(|t| t.split(' ').next())
                    .and_then(|t| t.parse::<i64>().ok());
                if let Some(i) = drafts
                    .iter()
                    .position(|d| n.is_some_and(|n| d.key == UnitKey::Item(n)))
                {
                    add(i, *at, What::Reopened);
                }
            }
            _ => {}
        }
    }
    let kind_of = |k: &UnitKey| match k {
        UnitKey::Item(_) => UnitKind::Item,
        UnitKey::Order(_) => UnitKind::Order,
    };
    Ok(drafts
        .into_iter()
        .zip(obs)
        .map(|(d, obs)| Timeline {
            kind: kind_of(&d.key),
            key: d.key,
            label: d.label,
            workstream: ws.to_owned(),
            pkey: pkey.clone(),
            size: d.size,
            order_ms: o.order_ms,
            plan_ms,
            start_ms: d.start_ms,
            obs,
            causes: causes.clone(),
            dropped: d.dropped,
        })
        .collect())
}
