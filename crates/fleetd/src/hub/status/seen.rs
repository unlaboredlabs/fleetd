//! Since you last looked: per human key and scope, the event seq they last saw, and what happened in that scope
//! since. One indexed range scan per type (`events_by_type`).
use fleetd_contracts::ids::{EventSeq, Timestamp};
use fleetd_contracts::prim::{Count, Int};
use fleetd_contracts::status::{Since, StatusScope};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use crate::hub::store::iso_ms;

pub fn mark(c: &Connection, key_id: &str, scope: &str, seq: i64, now: i64) -> rusqlite::Result<()> {
    c.prepare_cached(
        "INSERT INTO status_seen (key_id, scope, seq, at_ms) VALUES (?, ?, ?, ?)
         ON CONFLICT (key_id, scope) DO UPDATE SET seq = max(seq, excluded.seq), at_ms = excluded.at_ms",
    )?
    .execute(params![key_id, scope, seq, now])?;
    Ok(())
}

pub fn get(c: &Connection, key_id: &str, scope: &str) -> rusqlite::Result<Option<(i64, i64)>> {
    c.prepare_cached("SELECT seq, at_ms FROM status_seen WHERE key_id = ? AND scope = ?")?
        .query_row(params![key_id, scope], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
}

/// Whether an event (as stored: the `NewEvent` JSON) belongs to the scope.
pub fn in_scope(scope: &StatusScope, event: &Value) -> bool {
    match scope {
        StatusScope::Fleet => true,
        StatusScope::Project { project_ref } => {
            event.get("machineId").and_then(Value::as_str) == Some(project_ref.machine_id.as_str())
                && event.get("projectId").and_then(Value::as_str)
                    == Some(project_ref.project_id.as_str())
        }
        StatusScope::Order { workstream_id } => {
            event.pointer("/data/workstreamId").and_then(Value::as_str)
                == Some(workstream_id.as_str())
        }
    }
}

const COUNTED: [&str; 8] = [
    "pr.merged",
    "plan.verified",
    "workstream.running",
    "task.failed",
    "claim.failed",
    "change.ci_failed",
    "batch.ready",
    "plan.changed",
];

/// Counts since `after` (the key's mark) in the scope. `asked` counts batch items whose ask is in the scope.
pub fn since(
    c: &Connection,
    scope: &StatusScope,
    mark: Option<(i64, i64)>,
) -> rusqlite::Result<Since> {
    Ok(since_from(c, scope, mark, None)?.0)
}

/// [`since`], continuing from counts already made up to a seq (`base`), so a viewer that keeps asking scans only the
/// events since its last answer. Returns the counts and the seq they run to.
pub fn since_from(
    c: &Connection,
    scope: &StatusScope,
    mark: Option<(i64, i64)>,
    base: Option<(i64, &Since)>,
) -> rusqlite::Result<(Since, i64)> {
    let head: i64 = c.query_row("SELECT COALESCE(MAX(seq), 0) FROM events", [], |r| r.get(0))?;
    let Some((after, at_ms)) = mark else {
        return Ok((Since::default(), head));
    };
    let oldest: Option<i64> = c.query_row("SELECT MIN(seq) FROM events", [], |r| r.get(0))?;
    let mut out = Since {
        seen_at: Some(Timestamp(iso_ms(at_ms))),
        seen_seq: Some(EventSeq(Count::unchecked(after))),
        pruned: oldest.is_some_and(|o| o > after + 1).then_some(true),
        ..Default::default()
    };
    let from = match base {
        Some((to, counted)) if to >= after => {
            out.merged = counted.merged;
            out.verified = counted.verified;
            out.started = counted.started;
            out.failed = counted.failed;
            out.asked = counted.asked;
            out.scope_items = counted.scope_items;
            to
        }
        _ => after,
    };
    let (mut merged, mut verified, mut started, mut failed, mut asked, mut scope_items) = (
        out.merged.get(),
        out.verified.get(),
        out.started.get(),
        out.failed.get(),
        out.asked.get(),
        out.scope_items.get(),
    );
    let mut stmt = c.prepare_cached(
        "SELECT data FROM events WHERE type = ? AND seq > ? AND seq <= ? ORDER BY seq",
    )?;
    for t in COUNTED {
        for row in stmt.query_map(params![t, from, head], |r| r.get::<_, String>(0))? {
            let Ok(event) = serde_json::from_str::<Value>(&row?) else {
                continue;
            };
            if t == "batch.ready" {
                let items = event
                    .pointer("/data/items")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                for item in items {
                    let Some(ask) = item.get("askId").and_then(Value::as_str) else {
                        continue;
                    };
                    if ask_in_scope(c, scope, ask)? {
                        asked += 1;
                    }
                }
                continue;
            }
            if !in_scope(scope, &event) {
                continue;
            }
            match t {
                "pr.merged" => merged += 1,
                "plan.verified" => verified += 1,
                "workstream.running" => started += 1,
                "plan.changed" => {
                    let kind = event.pointer("/data/kind").and_then(Value::as_str);
                    if matches!(kind, Some("scope" | "closed")) {
                        scope_items += event
                            .pointer("/data/deltaItems")
                            .and_then(Value::as_i64)
                            .unwrap_or(0);
                    }
                }
                _ => failed += 1,
            }
        }
    }
    out.merged = Count::unchecked(merged);
    out.verified = Count::unchecked(verified);
    out.started = Count::unchecked(started);
    out.failed = Count::unchecked(failed);
    out.asked = Count::unchecked(asked);
    out.scope_items = Int::unchecked(scope_items);
    Ok((out, head))
}

fn ask_in_scope(c: &Connection, scope: &StatusScope, ask: &str) -> rusqlite::Result<bool> {
    if *scope == StatusScope::Fleet {
        return Ok(true);
    }
    let n: i64 = ask.get(1..).and_then(|n| n.parse().ok()).unwrap_or(0);
    let row: Option<(String, Option<String>)> = c
        .prepare_cached("SELECT project_key, workstream_id FROM asks WHERE n = ?")?
        .query_row([n], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    Ok(match (scope, row) {
        (StatusScope::Project { project_ref }, Some((key, _))) => {
            key == format!("{}/{}", project_ref.machine_id, project_ref.project_id)
        }
        (StatusScope::Order { workstream_id }, Some((_, Some(ws)))) => ws == workstream_id.as_str(),
        _ => false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
    use fleetd_contracts::ledger::WorkstreamId;

    fn db() -> std::sync::Arc<crate::hub::store::HubDb> {
        crate::hub::store::HubDb::open_memory().unwrap()
    }

    fn add(c: &Connection, t: &str, event: Value) {
        c.execute(
            "INSERT INTO events (created_ms, type, machine_id, data) VALUES (0, ?, NULL, ?)",
            params![t, event.to_string()],
        )
        .unwrap();
    }

    #[test]
    fn counts_events_after_the_mark_in_scope() {
        let db = db();
        db.with(|c| {
            let ev = |t: &str, ws: &str| serde_json::json!({ "type": t, "machineId": "devbox", "projectId": "p1", "data": { "workstreamId": ws } });
            add(c, "pr.merged", ev("pr.merged", "W1"));
            mark(c, "K1", "fleet", 1, 10).unwrap();
            add(c, "pr.merged", ev("pr.merged", "W1"));
            add(c, "pr.merged", ev("pr.merged", "W2"));
            add(c, "task.failed", ev("task.failed", "W1"));
            add(c, "plan.changed", serde_json::json!({ "type": "plan.changed", "machineId": "devbox", "projectId": "p1", "data": { "workstreamId": "W1", "kind": "scope", "deltaItems": 3 } }));
            let fleet = since(c, &StatusScope::Fleet, get(c, "K1", "fleet").unwrap()).unwrap();
            assert_eq!((fleet.merged.get(), fleet.failed.get(), fleet.scope_items.get()), (2, 1, 3));
            let order = StatusScope::Order { workstream_id: WorkstreamId::unchecked("W2") };
            assert_eq!(since(c, &order, Some((1, 10))).unwrap().merged.get(), 1);
            let other = StatusScope::Project {
                project_ref: ProjectRef { machine_id: MachineId::unchecked("buildbox"), project_id: ProjectId::unchecked("p1") },
            };
            assert_eq!(since(c, &other, Some((1, 10))).unwrap().merged.get(), 0);
            assert_eq!(since(c, &StatusScope::Fleet, None).unwrap(), Since::default(), "never looked");
            let (base, to) = since_from(c, &StatusScope::Fleet, Some((1, 10)), None).unwrap();
            add(c, "pr.merged", ev("pr.merged", "W3"));
            let (more, _) = since_from(c, &StatusScope::Fleet, Some((1, 10)), Some((to, &base))).unwrap();
            assert_eq!(more.merged.get(), 3, "continues from the counted seq");
            mark(c, "K1", "fleet", 0, 20).unwrap();
            assert_eq!(get(c, "K1", "fleet").unwrap(), Some((1, 20)), "a mark never moves back");
            Ok(())
        })
        .unwrap();
    }
}
