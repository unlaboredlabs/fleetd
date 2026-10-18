//! The one writer: node batches and hub spans, each committed in one transaction with labels, roll-ups and the
//! node's cursor; a node batch is acked only after its commit. Node spans move onto the hub clock and are joined to
//! their task, order or lead here.
use std::collections::HashMap;

use fleetd_contracts::time::{SpanExtra, SpanKind, SpanStatus, SpanWire};
use rusqlite::{Connection, OptionalExtension, params};
use tokio::sync::mpsc;

use super::store::{self, Ids, NewSpan, Share};
use super::{HubMsg, NodeBatch, Time};
use crate::hub::api::Shutdown;
use crate::hub::store::StoreError;

/// Hub spans committed per transaction.
const HUB_BATCH: usize = 500;
/// A wake explains a lead run that started at most this long after it (the send, then claude picking it up).
const WAKE_SLACK_MS: i64 = 120_000;

pub async fn write_loop(
    time: std::sync::Arc<Time>,
    mut hub_rx: mpsc::Receiver<HubMsg>,
    mut node_rx: mpsc::Receiver<NodeBatch>,
    shutdown: Shutdown,
) {
    loop {
        tokio::select! {
            () = shutdown.wait() => return,
            Some(batch) = node_rx.recv() => {
                let machine = batch.machine_id.clone();
                let offset = time.offset(&machine);
                match time.db.transaction(|c| ingest_frame(c, &machine, offset, &batch.frame)) {
                    Ok(ack) => (batch.ack)(ack),
                    Err(e) => {
                        tracing::error!(machine_id = %machine, error = %e, "time: node spans not stored");
                        (batch.ack)(super::Ack { upto: time.node_cursor(&machine), rewind: true });
                    }
                }
            }
            Some(first) = hub_rx.recv() => {
                let mut spans = vec![first];
                while spans.len() < HUB_BATCH {
                    match hub_rx.try_recv() {
                        Ok(s) => spans.push(s),
                        Err(_) => break,
                    }
                }
                let dropped = time.take_dropped();
                let now = time.now_ms();
                let written = time.db.transaction(|c| {
                    for m in &spans {
                        match m {
                            HubMsg::Span(s) => write_hub(c, s)?,
                            HubMsg::Close { prefix, end_ms } => close_prefix(c, prefix, *end_ms)?,
                        }
                    }
                    if dropped > 0 {
                        store::write(c, &gap(now, dropped), &[])?;
                    }
                    Ok(())
                });
                if let Err(e) = written {
                    tracing::error!(error = %e, "time: hub spans not stored");
                }
            }
        }
    }
}

fn gap(now: i64, count: u64) -> NewSpan {
    NewSpan {
        src: "h".into(),
        src_key: format!("gap/{now}"),
        kind: SpanKind::Gap,
        start_ms: now,
        end_ms: Some(now),
        lane: "fleet".into(),
        status: SpanStatus::Incomplete,
        extra: Some(SpanExtra {
            count: i64::try_from(count).ok().and_then(|n| n.try_into().ok()),
            reason: fleetd_contracts::prim::Text::new("the hub's span writer was full").ok(),
            ..SpanExtra::default()
        }),
        ..NewSpan::default()
    }
}

/// Closes the open hub spans under `prefix`.
pub fn close_prefix(c: &Connection, prefix: &str, end: i64) -> Result<(), StoreError> {
    let mut stmt = c.prepare_cached(
        "SELECT src_key, kind, start_ms FROM time_spans WHERE src = 'h' AND end_ms IS NULL
           AND substr(src_key, 1, length(?1)) = ?1",
    )?;
    let open: Vec<(String, i64, i64)> = stmt
        .query_map([prefix], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<Result<_, _>>()?;
    for (key, kind, start) in open {
        store::write(
            c,
            &NewSpan {
                src: "h".into(),
                src_key: key,
                kind: SpanKind::from_code(kind).unwrap_or_default(),
                start_ms: start,
                end_ms: Some(end.max(start)),
                ..NewSpan::default()
            },
            &[],
        )?;
    }
    Ok(())
}

/// A hub span, joined to its task's order and project when it names only the task.
pub fn write_hub(c: &Connection, s: &NewSpan) -> Result<(), StoreError> {
    let mut s = s.clone();
    if let Some(t) = s.ids.task_id.clone()
        && (s.ids.workstream_id.is_none() || s.ids.project_id.is_none())
        && let Some(n) = t.strip_prefix('T').and_then(|n| n.parse::<i64>().ok())
    {
        let row: Option<(String, String, String)> = c
            .query_row(
                "SELECT machine_id, project_id, workstream_id FROM tasks WHERE n = ?1",
                [n],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        if let Some((m, p, w)) = row {
            s.ids.machine_id.get_or_insert(m);
            s.ids.project_id.get_or_insert(p);
            s.ids.workstream_id.get_or_insert(w);
        }
    }
    store::write(c, &s, &[])?;
    Ok(())
}

/// Who a node session is: a task's thread, a lead, or unknown yet.
#[derive(Clone, Debug, Default)]
pub struct Who {
    pub ids: Ids,
    pub lead: bool,
}

pub fn who(c: &Connection, machine: &str, thread: &str) -> Result<Who, StoreError> {
    let task: Option<(i64, String, String, String)> = c
        .query_row(
            "SELECT n, project_id, workstream_id, data FROM tasks WHERE machine_id = ?1 AND thread_id = ?2
             ORDER BY n DESC LIMIT 1",
            [machine, thread],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    if let Some((n, project, workstream, data)) = task {
        let task_id = format!("T{n}");
        let review: Option<String> = c
            .query_row(
                "SELECT role FROM review_tasks WHERE task_id = ?1",
                [&task_id],
                |r| r.get(0),
            )
            .optional()?;
        let data: serde_json::Value = serde_json::from_str(&data).unwrap_or_default();
        let role = match (
            data["kind"].as_str(),
            review.as_deref(),
            data["qa"].as_bool(),
        ) {
            (Some("write"), _, _) => "implementer",
            (Some("read"), _, _) => "reader",
            (Some("review"), Some("verifier"), _) => "verifier",
            (Some("review"), _, Some(true)) => "qa",
            (Some("review"), _, _) => "reviewer",
            _ => "implementer",
        };
        return Ok(Who {
            ids: Ids {
                machine_id: Some(machine.to_owned()),
                project_id: Some(project),
                workstream_id: Some(workstream),
                task_id: Some(task_id),
                thread_id: Some(thread.to_owned()),
                run_id: None,
                role: Some(role.into()),
            },
            lead: false,
        });
    }
    let lead: Option<String> = c
        .query_row(
            "SELECT project_id FROM leads WHERE machine_id = ?1 AND thread_id = ?2",
            [machine, thread],
            |r| r.get(0),
        )
        .optional()?;
    let project = match &lead {
        Some(p) => Some(p.clone()),
        None => c
            .query_row(
                "SELECT project_id FROM threads WHERE machine_id = ?1 AND thread_id = ?2",
                [machine, thread],
                |r| r.get(0),
            )
            .optional()?,
    };
    Ok(Who {
        ids: Ids {
            machine_id: Some(machine.to_owned()),
            project_id: project,
            thread_id: Some(thread.to_owned()),
            role: lead.is_some().then(|| "lead".into()),
            ..Ids::default()
        },
        lead: lead.is_some(),
    })
}

pub fn thread_lane(machine: &str, thread: &str) -> String {
    format!("thread:{machine}/{thread}")
}

/// The orders a lead run served: the newest wake of that lead at or before the run's start.
fn lead_run_orders(
    c: &Connection,
    machine: &str,
    thread: &str,
    run: &str,
    start_ms: i64,
) -> Result<Vec<String>, StoreError> {
    let mut stmt = c.prepare_cached(
        "SELECT workstream_id FROM time_lead_runs WHERE machine_id = ?1 AND thread_id = ?2 AND run_id = ?3",
    )?;
    let known: Vec<String> = stmt
        .query_map([machine, thread, run], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    if !known.is_empty() {
        return Ok(known.into_iter().filter(|w| !w.is_empty()).collect());
    }
    let wake: Option<String> = c
        .query_row(
            "SELECT workstreams FROM time_wakes WHERE machine_id = ?1 AND thread_id = ?2 AND at_ms <= ?3
               AND at_ms >= ?4 ORDER BY at_ms DESC LIMIT 1",
            params![machine, thread, start_ms + 2_000, start_ms - WAKE_SLACK_MS],
            |r| r.get(0),
        )
        .optional()?;
    let ws: Vec<String> = wake
        .and_then(|w| serde_json::from_str(&w).ok())
        .unwrap_or_default();
    let n = ws.len() as i64;
    let mut insert = c.prepare_cached(
        "INSERT OR IGNORE INTO time_lead_runs (machine_id, thread_id, run_id, workstream_id, n, at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )?;
    if ws.is_empty() {
        insert.execute(params![machine, thread, run, "", 0, start_ms])?;
    }
    for w in &ws {
        insert.execute(params![machine, thread, run, w, n, start_ms])?;
    }
    Ok(ws)
}

/// Stores a frame only when it continues the node's stored cursor, so the cursor (and the node's delete on ack)
/// never passes rows the hub has not stored. A frame after a gap is refused with a rewind to the cursor.
pub fn ingest_frame(
    c: &Connection,
    machine: &str,
    offset: i64,
    frame: &fleetd_contracts::node_link::SpansFrame,
) -> Result<super::Ack, StoreError> {
    let source = format!("node:{machine}");
    let mut cursor = store::cursor(c, &source)?.unwrap_or(0).max(0) as u64;
    // A frame from row 1 below the cursor is an outbox that started over (its database was reset): follow it, or
    // the cursor would ack rows the node never sent and hide its gaps.
    if frame.from_rid == 1 && frame.to_rid < cursor {
        c.execute(
            "UPDATE time_cursors SET value = 0 WHERE source = ?1",
            [&source],
        )?;
        cursor = 0;
    }
    if frame.from_rid > cursor + 1 {
        return Ok(super::Ack {
            upto: cursor,
            rewind: true,
        });
    }
    ingest_node(c, machine, offset, &frame.spans)?;
    let upto = cursor.max(frame.to_rid);
    store::set_cursor(c, &source, upto as i64)?;
    Ok(super::Ack {
        upto,
        rewind: false,
    })
}

fn ingest_node(
    c: &Connection,
    machine: &str,
    offset: i64,
    spans: &[SpanWire],
) -> Result<(), StoreError> {
    let mut whos: HashMap<String, Who> = HashMap::new();
    let mut parents: Vec<(String, String)> = Vec::new();
    let src = format!("n:{machine}");
    // Envelopes first, so children find their parent in the same pass.
    let mut order: Vec<&SpanWire> = spans.iter().collect();
    order.sort_by_key(|s| (s.parent.is_some(), s.start_ms.get()));
    for w in order {
        let session = w.session_id.as_str();
        if !whos.contains_key(session) {
            whos.insert(session.to_owned(), who(c, machine, session)?);
        }
        let who = whos[session].clone();
        let mut ids = who.ids.clone();
        ids.run_id = w.run_id.as_ref().map(|r| r.to_string());
        let start = w.start_ms.get() + offset;
        let end = w.end_ms.get() + offset;
        let mut extra = w.extra.clone();
        if offset.abs() > 100 {
            extra.get_or_insert_with(SpanExtra::default).node_start_ms = Some(w.start_ms);
        }
        let mut shares = Vec::new();
        if who.lead
            && let Some(run) = &ids.run_id
        {
            let orders = lead_run_orders(c, machine, session, run, start)?;
            let n = orders.len() as i64;
            shares = orders
                .into_iter()
                .map(|w| Share {
                    scope: "order",
                    id: w,
                    of: n,
                })
                .collect();
        }
        let span = NewSpan {
            src: src.clone(),
            src_key: w.key.to_string(),
            kind: w.kind,
            start_ms: start,
            end_ms: Some(end.max(start)),
            excl_ms: w.excl_ms.map(|e| e.get()),
            ids,
            lane: thread_lane(machine, session),
            parent_key: None,
            label: w.label.as_ref().map(|l| l.to_string()),
            exit_code: w.exit_code.map(i64::from),
            out_bytes: w.out_bytes.map(|b| b.get()),
            status: w.status,
            extra,
        };
        store::write(c, &span, &shares)?;
        if let Some(p) = &w.parent {
            parents.push((w.key.to_string(), p.to_string()));
        }
    }
    store::link_parents(c, &src, &parents)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::store::HubDb;
    use fleetd_contracts::prim::{Count, Text};

    fn wire(key: &str, kind: SpanKind, run: &str, start: i64, end: i64, excl: i64) -> SpanWire {
        SpanWire {
            key: Text::unchecked(key),
            kind,
            session_id: fleetd_contracts::ids::ThreadId::unchecked("lead-1"),
            run_id: Some(Text::unchecked(run)),
            parent: None,
            start_ms: Count::try_from(start).unwrap(),
            end_ms: Count::try_from(end).unwrap(),
            excl_ms: Some(Count::try_from(excl).unwrap()),
            label: None,
            exit_code: None,
            out_bytes: None,
            status: SpanStatus::Ok,
            extra: None,
        }
    }

    fn rollup(c: &Connection, scope: &str, id: &str) -> (i64, i64) {
        c.query_row(
            "SELECT COALESCE(SUM(ms), 0), COALESCE(SUM(n), 0) FROM time_rollups WHERE scope = ?1 AND scope_id = ?2",
            [scope, id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
    }

    #[test]
    fn a_lead_turn_splits_over_the_orders_its_wake_served_and_a_resend_counts_nothing() {
        let db = HubDb::open_memory().unwrap();
        let day = 20_000 * 86_400_000_i64;
        db.transaction(|c| {
            c.execute(
                "INSERT INTO leads (machine_id, project_id, thread_id, started_at, session_generation)
                 VALUES ('devbox', 'storefront', 'lead-1', 't', 1)",
                [],
            )?;
            c.execute(
                "INSERT INTO time_wakes (machine_id, thread_id, at_ms, workstreams) VALUES ('devbox', 'lead-1', ?1, '[\"W1\",\"W2\"]')",
                [day + 1_000],
            )?;
            Ok(())
        })
        .unwrap();
        let spans = vec![
            wire(
                "lead-1/r1/run",
                SpanKind::Run,
                "r1",
                day + 1_500,
                day + 11_500,
                0,
            ),
            wire(
                "lead-1/msg/m1/output",
                SpanKind::ModelOutput,
                "r1",
                day + 1_500,
                day + 7_500,
                6_000,
            ),
            wire(
                "lead-1/t1",
                SpanKind::ToolBash,
                "r1",
                day + 7_500,
                day + 11_500,
                4_000,
            ),
        ];
        for _ in 0..2 {
            db.transaction(|c| ingest_node(c, "devbox", 0, &spans))
                .unwrap();
        }
        db.with(|c| {
            assert_eq!(rollup(c, "lead", "devbox/storefront"), (10_000, 3));
            assert_eq!(rollup(c, "order", "W1"), (5_000, 3));
            assert_eq!(rollup(c, "order", "W2"), (5_000, 3));
            assert_eq!(rollup(c, "fleet", ""), (10_000, 3));
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn a_hub_span_counts_once_when_it_closes_and_node_stamps_move_onto_the_hub_clock() {
        let db = HubDb::open_memory().unwrap();
        let open = NewSpan {
            src: "h".into(),
            src_key: "change/X1/reviewing/5".into(),
            kind: SpanKind::ChangeReview,
            start_ms: 5_000,
            lane: "change:acme/storefront#3".into(),
            ..NewSpan::default()
        };
        db.transaction(|c| {
            write_hub(c, &open)?;
            assert_eq!(rollup(c, "fleet", ""), (0, 0));
            close_prefix(c, "change/X1/", 65_000)?;
            close_prefix(c, "change/X1/", 99_000)?;
            assert_eq!(rollup(c, "fleet", ""), (60_000, 1));
            ingest_node(
                c,
                "buildbox",
                250,
                &[wire(
                    "lead-1/t9",
                    SpanKind::ToolRead,
                    "r9",
                    1_000,
                    2_000,
                    1_000,
                )],
            )?;
            let (start, extra): (i64, String) = c.query_row(
                "SELECT start_ms, extra FROM time_spans WHERE src_key = 'lead-1/t9'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            assert_eq!(start, 1_250);
            assert!(extra.contains("\"nodeStartMs\":1000"));
            Ok(())
        })
        .unwrap();
    }

    fn frame(from: u64, to: u64) -> fleetd_contracts::node_link::SpansFrame {
        fleetd_contracts::node_link::SpansFrame {
            from_rid: from,
            to_rid: to,
            spans: fleetd_contracts::prim::List::unchecked(vec![wire(
                &format!("lead-1/t{to}"),
                SpanKind::ToolRead,
                "r1",
                to as i64,
                to as i64 + 1,
                1,
            )]),
        }
    }

    /// A frame after a lost one is refused with a rewind, so the cursor (and the node's delete on ack) never
    /// passes rows the hub has not stored; a resend from the cursor is accepted.
    #[test]
    fn a_frame_after_a_lost_one_rewinds_instead_of_acking_past_the_hole() {
        let db = HubDb::open_memory().unwrap();
        let ack = |f| {
            db.transaction(|c| ingest_frame(c, "devbox", 0, &f))
                .unwrap()
        };
        assert_eq!(
            ack(frame(1, 4)),
            crate::hub::time::Ack {
                upto: 4,
                rewind: false
            }
        );
        // Rows 5..=8 were dropped by a full writer; 9..=12 arrive.
        assert_eq!(
            ack(frame(9, 12)),
            crate::hub::time::Ack {
                upto: 4,
                rewind: true
            }
        );
        let stored = |c: &Connection| -> i64 {
            c.query_row(
                "SELECT COUNT(*) FROM time_spans WHERE src_key = 'lead-1/t12'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(db.with(|c| Ok(stored(c))).unwrap(), 0);
        // The node sends again from 5; an overlapping resend is fine too.
        assert_eq!(
            ack(frame(3, 12)),
            crate::hub::time::Ack {
                upto: 12,
                rewind: false
            }
        );
        assert_eq!(db.with(|c| Ok(stored(c))).unwrap(), 1);
        // The node's database is reset: its outbox starts over at row 1, below the cursor.
        let ok = |upto| crate::hub::time::Ack {
            upto,
            rewind: false,
        };
        assert_eq!(ack(frame(1, 2)), ok(2));
        assert_eq!(
            ack(frame(5, 6)),
            crate::hub::time::Ack {
                upto: 2,
                rewind: true
            }
        );
    }
}
