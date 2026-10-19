//! Spans folded out of the event log: queue waits, usage parks, waits on a person's answer to a request, wake debounces, offline
//! writes, and each order's bounds and critical path. It walks the log in seq order from `time_cursors('events')`,
//! the way webhook delivery does, and wakes on the log's append notification; a replay is a no-op because every
//! span key is deterministic. Facts about a machine's lanes that only the hub learns (a sleep the node reports when
//! it re-links, `machine.slept`) belong here too, as spans on that machine's lanes.
use std::sync::Arc;

use fleetd_contracts::events::{HubEvent, HubEventType};
use fleetd_contracts::time::{DecidedBy, SpanExtra, SpanKind, SpanStatus};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use super::ingest::{thread_lane, who, write_hub};
use super::store::{self, Ids, NewSpan};
use super::{Time, parse_ms};
use crate::hub::api::Hub;
use crate::hub::store::StoreError;

const CURSOR: &str = "events";

pub async fn run(time: Arc<Time>, hub: Arc<Hub>) {
    let mut head = hub.events.subscribe();
    let mut cursor = time
        .db
        .with(|c| store::cursor(c, CURSOR))
        .ok()
        .flatten()
        .unwrap_or(0);
    loop {
        let page = match hub.events.page(cursor, None, None) {
            Ok(p) => p,
            Err(e) => {
                tracing::error!(error = %e, "time: event log not read");
                tokio::select! {
                    () = hub.shutdown.wait() => return,
                    () = time.clock.sleep(std::time::Duration::from_secs(5)) => {}
                }
                continue;
            }
        };
        if !page.events.is_empty() || page.cursor != cursor {
            let next = page.cursor;
            let done = time.db.transaction(|c| {
                for event in &page.events {
                    apply(c, event)?;
                }
                store::set_cursor(c, CURSOR, next)
            });
            match done {
                Ok(()) => cursor = next,
                Err(e) => tracing::error!(error = %e, "time: events not projected"),
            }
        }
        if page.more {
            continue;
        }
        tokio::select! {
            () = hub.shutdown.wait() => return,
            changed = head.changed() => if changed.is_err() { return },
        }
    }
}

fn at_ms(e: &HubEvent) -> i64 {
    parse_ms(e.at.as_str()).unwrap_or(0)
}

fn data_str<'a>(e: &'a HubEvent, key: &str) -> Option<&'a str> {
    e.data
        .as_ref()
        .and_then(|d| d.get(key))
        .and_then(Value::as_str)
}

/// Closes every open span of `kinds` matching `clause` at `end`.
fn close_open(
    c: &Connection,
    kinds: &[SpanKind],
    clause: &str,
    args: &[&str],
    end: i64,
) -> Result<(), StoreError> {
    let codes = serde_json::to_string(&kinds.iter().map(|k| k.code()).collect::<Vec<_>>())?;
    let mut stmt = c.prepare(&format!(
        "SELECT src_key, start_ms FROM time_spans WHERE src = 'h' AND end_ms IS NULL
           AND kind IN (SELECT value FROM json_each(?1)) AND {clause}"
    ))?;
    let mut values: Vec<rusqlite::types::Value> = vec![codes.into()];
    values.extend(
        args.iter()
            .map(|a| rusqlite::types::Value::from(a.to_string())),
    );
    let open: Vec<(String, i64)> = stmt
        .query_map(rusqlite::params_from_iter(values.iter()), |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?
        .collect::<Result<_, _>>()?;
    for (key, start) in open {
        close(c, &key, start, end, None)?;
    }
    Ok(())
}

fn close(
    c: &Connection,
    key: &str,
    start: i64,
    end: i64,
    extra: Option<SpanExtra>,
) -> Result<(), StoreError> {
    let kind: Option<(i64, Option<String>)> = c
        .query_row(
            "SELECT kind, extra FROM time_spans WHERE src = 'h' AND src_key = ?1",
            [key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((kind, old)) = kind else {
        return Ok(());
    };
    let merged = match (
        old.and_then(|o| serde_json::from_str::<SpanExtra>(&o).ok()),
        extra,
    ) {
        (Some(mut o), Some(n)) => {
            o.decided_by = n.decided_by.or(o.decided_by);
            o.answered_by = n.answered_by.or(o.answered_by);
            o.key = n.key.or(o.key);
            Some(o)
        }
        (o, n) => n.or(o),
    };
    store::write(
        c,
        &NewSpan {
            src: "h".into(),
            src_key: key.to_owned(),
            kind: SpanKind::from_code(kind).unwrap_or_default(),
            start_ms: start,
            end_ms: Some(end.max(start)),
            extra: merged,
            ..NewSpan::default()
        },
        &[],
    )?;
    Ok(())
}

fn open(
    c: &Connection,
    key: String,
    kind: SpanKind,
    start: i64,
    ids: Ids,
    lane: String,
    extra: SpanExtra,
) -> Result<(), StoreError> {
    write_hub(
        c,
        &NewSpan {
            src: "h".into(),
            src_key: key,
            kind,
            start_ms: start,
            end_ms: None,
            ids,
            lane,
            extra: (extra != SpanExtra::default()).then_some(extra),
            ..NewSpan::default()
        },
    )
}

fn task_ids(c: &Connection, task: &str) -> Result<Ids, StoreError> {
    let n = task
        .strip_prefix('T')
        .and_then(|n| n.parse::<i64>().ok())
        .unwrap_or(-1);
    let row: Option<(String, String, String, Option<String>)> = c
        .query_row(
            "SELECT machine_id, project_id, workstream_id, thread_id FROM tasks WHERE n = ?1",
            [n],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    Ok(match row {
        Some((m, p, w, t)) => Ids {
            machine_id: Some(m),
            project_id: Some(p),
            workstream_id: Some(w),
            task_id: Some(task.to_owned()),
            thread_id: t,
            ..Ids::default()
        },
        None => Ids {
            task_id: Some(task.to_owned()),
            ..Ids::default()
        },
    })
}

fn queue_kind(kind: Option<&str>, reason: Option<&str>) -> SpanKind {
    let k = kind.or(reason).unwrap_or_default();
    if k.starts_with("lease") {
        SpanKind::QueueLease
    } else if k.starts_with("offline") || k.contains("offline") {
        SpanKind::QueueOffline
    } else if k.starts_with("usage") || k.contains("usage") {
        SpanKind::QueueUsage
    } else {
        SpanKind::QueueSlot
    }
}

fn asks_lane(ids: &Ids) -> String {
    match (&ids.workstream_id, &ids.machine_id, &ids.project_id) {
        (Some(w), _, _) => format!("asks:{w}"),
        (None, Some(m), Some(p)) => format!("asks:{m}/{p}"),
        _ => "asks:fleet".into(),
    }
}

fn apply(c: &Connection, e: &HubEvent) -> Result<(), StoreError> {
    let at = at_ms(e);
    let seq = e.seq.get();
    let machine = e.machine_id.as_ref().map(|m| m.to_string());
    let thread = e.thread_id.as_ref().map(|t| t.to_string());
    match e.r#type {
        HubEventType::TaskQueued => {
            let Some(task) = data_str(e, "taskId") else {
                return Ok(());
            };
            let queue = [
                SpanKind::QueueSlot,
                SpanKind::QueueLease,
                SpanKind::QueueOffline,
                SpanKind::QueueUsage,
            ];
            close_open(c, &queue, "task_id = ?2", &[task], at)?;
            let kind = queue_kind(data_str(e, "queuedKind"), data_str(e, "queuedReason"));
            let extra = SpanExtra {
                reason: data_str(e, "queuedReason").and_then(|r| {
                    fleetd_contracts::prim::Text::new(crate::node::util::head_utf16(r, 200)).ok()
                }),
                ..SpanExtra::default()
            };
            let ids = task_ids(c, task)?;
            open(
                c,
                format!("task/{task}/q/{seq}"),
                kind,
                at,
                ids,
                format!("task:{task}"),
                extra,
            )?;
        }
        HubEventType::TaskStarted
        | HubEventType::TaskCompleted
        | HubEventType::TaskFailed
        | HubEventType::TaskCancelled => {
            let Some(task) = data_str(e, "taskId") else {
                return Ok(());
            };
            let queue = [
                SpanKind::QueueSlot,
                SpanKind::QueueLease,
                SpanKind::QueueOffline,
                SpanKind::QueueUsage,
            ];
            close_open(c, &queue, "task_id = ?2", &[task], at)?;
            if e.r#type == HubEventType::TaskStarted
                && let (Some(m), Some(t)) = (&machine, &thread)
            {
                // Node spans that arrived before the task knew its thread.
                let ids = task_ids(c, task)?;
                c.execute(
                    "UPDATE time_spans SET task_id = ?3, workstream_id = ?4, project_id = COALESCE(project_id, ?5)
                     WHERE machine_id = ?1 AND thread_id = ?2 AND task_id IS NULL AND role IS NULL",
                    params![m, t, task, ids.workstream_id, ids.project_id],
                )?;
            }
        }
        HubEventType::ThreadUsageLimited => {
            let (Some(m), Some(t)) = (&machine, &thread) else {
                return Ok(());
            };
            let mut ids = who(c, m, t)?.ids;
            ids.run_id = data_str(e, "runId").map(str::to_owned);
            open(
                c,
                format!("park/{m}/{t}/{seq}"),
                SpanKind::ParkUsage,
                at,
                ids,
                thread_lane(m, t),
                SpanExtra::default(),
            )?;
        }
        HubEventType::ThreadStarted => {
            let (Some(m), Some(t)) = (&machine, &thread) else {
                return Ok(());
            };
            close_open(
                c,
                &[SpanKind::ParkUsage],
                "machine_id = ?2 AND thread_id = ?3",
                &[m, t],
                at,
            )?;
        }
        HubEventType::RequestOpened | HubEventType::RequestUpdated => {
            let Some(id) = data_str(e, "requestId") else {
                return Ok(());
            };
            let key = format!("request/{id}");
            let state = data_str(e, "state").unwrap_or("");
            if state == "open" {
                let Some(r) = get_request(c, id) else {
                    return Ok(());
                };
                // A permission prompt's wait is the node's `wait.permission` span; its request adds no second one.
                if r.permission.is_some() {
                    return Ok(());
                }
                let ids = Ids {
                    machine_id: Some(r.project_ref.machine_id.to_string()),
                    project_id: Some(r.project_ref.project_id.to_string()),
                    workstream_id: r.workstream_id.as_ref().map(|w| w.to_string()),
                    ..Ids::default()
                };
                let extra = SpanExtra {
                    key: r
                        .secret
                        .as_ref()
                        .and_then(|s| fleetd_contracts::prim::Text::new(s.key.to_string()).ok()),
                    ..SpanExtra::default()
                };
                let lane = asks_lane(&ids);
                return open(c, key, SpanKind::WaitAsk, at, ids, lane, extra);
            }
            let start: Option<i64> = c
                .query_row("SELECT start_ms FROM time_spans WHERE src = 'h' AND src_key = ?1 AND end_ms IS NULL", [&key], |r| r.get(0))
                .optional()?;
            let Some(start) = start else { return Ok(()) };
            let extra = SpanExtra {
                decided_by: Some(DecidedBy::Human),
                answered_by: data_str(e, "by").and_then(|b| {
                    fleetd_contracts::prim::Text::new(crate::node::util::head_utf16(b, 80)).ok()
                }),
                ..SpanExtra::default()
            };
            close(c, &key, start, at, Some(extra))?;
        }
        HubEventType::LeadWoken => {
            let (Some(m), Some(t)) = (&machine, &thread) else {
                return Ok(());
            };
            let first = data_str(e, "firstTriggerAt")
                .and_then(parse_ms)
                .unwrap_or(at)
                .min(at);
            let ws: Vec<String> = e
                .data
                .as_ref()
                .and_then(|d| d.get("workstreamIds"))
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default();
            c.execute(
                "INSERT OR IGNORE INTO time_wakes (machine_id, thread_id, at_ms, workstreams) VALUES (?1, ?2, ?3, ?4)",
                params![m, t, at, serde_json::to_string(&ws)?],
            )?;
            let mut ids = who(c, m, t)?.ids;
            if let [one] = ws.as_slice() {
                ids.workstream_id = Some(one.clone());
            }
            let n = ws.len() as i64;
            let shares: Vec<store::Share> = ws
                .iter()
                .map(|w| store::Share {
                    scope: "order",
                    id: w.clone(),
                    of: n,
                })
                .collect();
            store::write(
                c,
                &NewSpan {
                    src: "h".into(),
                    src_key: format!("wake/{m}/{t}/{seq}"),
                    kind: SpanKind::WakeDebounce,
                    start_ms: first,
                    end_ms: Some(at),
                    // A wake that waited while the lead was mid-turn: that part is the run's, which the node's
                    // spans already tile, so it is not counted twice.
                    excl_ms: Some((at - first) - busy_ms(c, m, t, first, at)?),
                    ids,
                    lane: thread_lane(m, t),
                    ..NewSpan::default()
                },
                if ws.len() == 1 { &[] } else { &shares },
            )?;
        }
        HubEventType::WriteDelivered | HubEventType::WriteExpired => {
            let (Some(m), Some(t)) = (&machine, &thread) else {
                return Ok(());
            };
            let Some(queued) = data_str(e, "queuedAt").and_then(parse_ms) else {
                return Ok(());
            };
            let mut ids = who(c, m, t)?.ids;
            ids.run_id = data_str(e, "runId").map(str::to_owned);
            let status = if e.r#type == HubEventType::WriteExpired {
                SpanStatus::Cancelled
            } else {
                SpanStatus::Ok
            };
            write_hub(
                c,
                &NewSpan {
                    src: "h".into(),
                    src_key: format!("write/{m}/{t}/{seq}"),
                    kind: SpanKind::WaitOffline,
                    start_ms: queued,
                    end_ms: Some(at),
                    ids,
                    lane: thread_lane(m, t),
                    status,
                    ..NewSpan::default()
                },
            )?;
        }
        HubEventType::WorkstreamCreated => {
            let Some(w) = data_str(e, "workstreamId")
                .map(str::to_owned)
                .or_else(|| workstream_from_summary(e))
            else {
                return Ok(());
            };
            let (Some(m), Some(p)) = (&machine, e.project_id.as_ref().map(|p| p.to_string()))
            else {
                return Ok(());
            };
            c.execute(
                "INSERT OR IGNORE INTO time_orders (workstream_id, machine_id, project_id, start_ms) VALUES (?1, ?2, ?3, ?4)",
                params![w, m, p, at],
            )?;
        }
        HubEventType::WorkstreamDone => {
            let Some(w) = data_str(e, "workstreamId") else {
                return Ok(());
            };
            c.execute(
                "UPDATE time_orders SET end_ms = ?2 WHERE workstream_id = ?1 AND end_ms IS NULL",
                params![w, at],
            )?;
            if let Some(path) = super::tools::order_path(c, w, at)? {
                c.execute(
                    "INSERT INTO time_paths (workstream_id, computed_ms, data) VALUES (?1, ?2, ?3)
                     ON CONFLICT(workstream_id) DO UPDATE SET computed_ms = excluded.computed_ms, data = excluded.data",
                    params![w, at, serde_json::to_string(&path)?],
                )?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// How long thread `t` was running within `[from, to]`, from its `thread.*` events (a run starts with
/// `thread.started` and ends with completed, failed, interrupted or usage_limited). A run older than
/// [`BUSY_LOOKBACK_MS`] that is still going counts as not running.
pub fn busy_ms(c: &Connection, m: &str, t: &str, from: i64, to: i64) -> Result<i64, StoreError> {
    let mut stmt = c.prepare_cached(
        "SELECT created_ms, type FROM events
         WHERE created_ms >= ?3 AND created_ms <= ?4 AND machine_id = ?1 AND type IN
           ('thread.started', 'thread.completed', 'thread.failed', 'thread.interrupted', 'thread.usage_limited')
           AND json_extract(data, '$.threadId') = ?2
         ORDER BY seq",
    )?;
    let rows: Vec<(i64, String)> = stmt
        .query_map(params![m, t, from - BUSY_LOOKBACK_MS, to], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?
        .collect::<Result<_, _>>()?;
    let mut running_since: Option<i64> = None;
    let mut busy = 0;
    for (at, kind) in rows {
        match (kind.as_str(), running_since) {
            ("thread.started", None) => running_since = Some(at),
            ("thread.started", Some(_)) => {}
            (_, Some(s)) => {
                busy += (at.min(to) - s.max(from)).max(0);
                running_since = None;
            }
            (_, None) => {}
        }
    }
    if let Some(s) = running_since {
        busy += (to - s.max(from)).max(0);
    }
    Ok(busy.min(to - from).max(0))
}

const BUSY_LOOKBACK_MS: i64 = 6 * 3600 * 1000;

/// Read on the projector's own connection: another reader would wait for the lock this transaction holds.
fn get_request(c: &Connection, id: &str) -> Option<fleetd_contracts::ledger::HumanRequest> {
    let n: i64 = id.strip_prefix('Q')?.parse().ok()?;
    c.query_row("SELECT data FROM requests WHERE n = ?1", [n], |r| r.get::<_, String>(0))
        .optional()
        .ok()
        .flatten()
        .and_then(|data| serde_json::from_str(&data).ok())
}

fn workstream_from_summary(e: &HubEvent) -> Option<String> {
    let s = e.summary.as_str();
    let i = s.find(" W")? + 1;
    let id: String = s[i..]
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric())
        .collect();
    (id.len() > 1 && id[1..].chars().all(|c| c.is_ascii_digit())).then_some(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::store::HubDb;

    fn event(c: &Connection, at: i64, kind: &str, thread: &str) {
        let data = serde_json::json!({ "type": kind, "machineId": "devbox", "threadId": thread })
            .to_string();
        c.execute(
            "INSERT INTO events (created_ms, type, machine_id, data) VALUES (?1, ?2, 'devbox', ?3)",
            params![at, kind, data],
        )
        .unwrap();
    }

    /// A wake whose debounce overlaps the lead's running turn counts only the part after the turn: the lane's
    /// exclusive time stays its wall time.
    #[test]
    fn a_wake_counts_only_the_time_its_lead_was_not_running() {
        let db = HubDb::open_memory().unwrap();
        db.transaction(|c| {
            event(c, 1_000, "thread.started", "lead-1");
            event(c, 41_000, "thread.completed", "lead-1");
            event(c, 45_000, "thread.started", "other");
            assert_eq!(busy_ms(c, "devbox", "lead-1", 20_000, 60_000)?, 21_000);
            event(c, 70_000, "thread.started", "lead-1");
            assert_eq!(busy_ms(c, "devbox", "lead-1", 60_000, 80_000)?, 10_000);
            assert_eq!(busy_ms(c, "devbox", "lead-1", 42_000, 60_000)?, 0);
            Ok(())
        })
        .unwrap();
    }
}
