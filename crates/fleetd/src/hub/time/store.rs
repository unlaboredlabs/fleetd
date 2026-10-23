//! The time tables: span writes (idempotent on `(src, src_key)`), labels, per-day roll-ups, retention and reads.
//! Every write runs inside the caller's transaction, so a batch's spans, labels, roll-ups and cursor commit together.
use fleetd_contracts::time::{Category, SpanExtra, SpanKind, SpanStatus};
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};

use super::model::{Row, is_detail};
use crate::hub::store::StoreError;

pub const DEFAULT_RETENTION_DAYS: i64 = 30;
/// Roll-ups and critical paths outlive spans: a few KB per day.
pub const ROLLUP_DAYS: i64 = 400;
pub const PRUNE_BATCH: i64 = 5_000;
const LABEL_MAX: usize = 500;
const DAY_MS: i64 = 86_400_000;

/// Who a span belongs to.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Ids {
    pub machine_id: Option<String>,
    pub project_id: Option<String>,
    pub workstream_id: Option<String>,
    pub task_id: Option<String>,
    pub thread_id: Option<String>,
    pub run_id: Option<String>,
    /// `AgentRole` as stored: lead, implementer, reviewer, ...
    pub role: Option<String>,
}

/// A span on its way into the store. `end_ms` absent opens it; a later write with the same key and an end closes it.
#[derive(Clone, Debug, Default)]
pub struct NewSpan {
    pub src: String,
    pub src_key: String,
    pub kind: SpanKind,
    pub start_ms: i64,
    pub end_ms: Option<i64>,
    /// Absent: the whole interval (a hub span alone on its lane), 0 for detail spans.
    pub excl_ms: Option<i64>,
    pub ids: Ids,
    pub lane: String,
    pub parent_key: Option<String>,
    /// Raw; normalized and deduped here.
    pub label: Option<String>,
    pub exit_code: Option<i64>,
    pub out_bytes: Option<i64>,
    pub status: SpanStatus,
    pub extra: Option<SpanExtra>,
}

/// One roll-up target besides the span's own ids, with a weight: a lead turn split over the orders its wake served.
#[derive(Clone, Debug, PartialEq)]
pub struct Share {
    pub scope: &'static str,
    pub id: String,
    /// Numerator over `of`.
    pub of: i64,
}

/// What a write did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Wrote {
    /// New, or closed an open one: counted in roll-ups.
    Counted(i64),
    Opened(i64),
    /// A resend or a replay.
    Unchanged,
}

pub fn retention_days(conn: &Connection) -> Result<i64, StoreError> {
    let v: Option<i64> = conn
        .query_row(
            "SELECT value FROM time_settings WHERE key = 'retention_days'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    Ok(v.unwrap_or(DEFAULT_RETENTION_DAYS))
}

pub fn set_retention_days(conn: &Connection, days: i64) -> Result<(), StoreError> {
    conn.execute(
        "INSERT INTO time_settings (key, value) VALUES ('retention_days', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [days],
    )?;
    Ok(())
}

pub fn cursor(conn: &Connection, source: &str) -> Result<Option<i64>, StoreError> {
    Ok(conn
        .query_row(
            "SELECT value FROM time_cursors WHERE source = ?1",
            [source],
            |r| r.get(0),
        )
        .optional()?)
}

pub fn set_cursor(conn: &Connection, source: &str, value: i64) -> Result<(), StoreError> {
    conn.execute(
        "INSERT INTO time_cursors (source, value) VALUES (?1, ?2)
         ON CONFLICT(source) DO UPDATE SET value = MAX(value, excluded.value)",
        params![source, value],
    )?;
    Ok(())
}

/// The program family of a label, after `cd x &&` and `VAR=value` prefixes: "cargo test", "git push", "pytest".
/// Tools that are not a shell command are their own family ("Read", "mcp__x__y").
pub fn family(kind: SpanKind, tool: Option<&str>, label: &str) -> String {
    if !matches!(
        kind,
        SpanKind::ToolBash | SpanKind::Git | SpanKind::CheckClaim
    ) {
        return tool.unwrap_or(kind.as_str()).to_owned();
    }
    let Some(program) = crate::node::runner::claude::spans::program(label) else {
        return String::new();
    };
    let prog = program.rsplit('/').next().unwrap_or(program);
    const WITH_SUB: &[&str] = &[
        "cargo", "git", "gh", "npm", "pnpm", "yarn", "go", "vp", "docker", "npx", "bun", "uv",
        "poetry",
    ];
    if WITH_SUB.contains(&prog) {
        let after = label[label.find(program).map_or(0, |i| i + program.len())..].trim_start();
        let mut tokens = after.split_whitespace();
        let mut sub = None;
        while let Some(t) = tokens.next() {
            if t == "-C" || t == "-c" {
                tokens.next();
            } else if !t.starts_with('-') {
                sub = Some(t);
                break;
            }
        }
        if let Some(sub) = sub {
            let sub: String = sub.chars().take(40).collect();
            return format!("{prog} {sub}");
        }
    }
    prog.chars().take(80).collect()
}

/// Worktree paths become `<wt>`, so the same command in two worktrees is one label.
pub fn normalize(label: &str) -> String {
    static WT: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = WT.get_or_init(|| {
        regex::Regex::new(r"(?:/[^\s/'\x22]+)*/worktrees/[^\s/'\x22]+/[^\s/'\x22]+").unwrap()
    });
    let out = re.replace_all(label, "<wt>");
    crate::node::util::head_utf16(&out, LABEL_MAX).to_owned()
}

fn label_id(conn: &Connection, family: &str, text: &str) -> Result<i64, StoreError> {
    let mut h = Sha256::new();
    h.update(family.as_bytes());
    h.update([0]);
    h.update(text.as_bytes());
    let hash = &h.finalize()[..16];
    if let Some(id) = conn
        .query_row("SELECT id FROM time_labels WHERE hash = ?1", [hash], |r| {
            r.get(0)
        })
        .optional()?
    {
        return Ok(id);
    }
    conn.execute(
        "INSERT INTO time_labels (hash, family, text) VALUES (?1, ?2, ?3)",
        params![hash, family, text],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Writes one span; counts it in the roll-ups when it is new and closed, or when this write closes it.
pub fn write(conn: &Connection, span: &NewSpan, shares: &[Share]) -> Result<Wrote, StoreError> {
    let existing: Option<(i64, Option<i64>)> = conn
        .query_row(
            "SELECT id, end_ms FROM time_spans WHERE src = ?1 AND src_key = ?2",
            params![span.src, span.src_key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let label = match &span.label {
        Some(raw) => {
            let text = normalize(raw);
            let tool = span
                .extra
                .as_ref()
                .and_then(|e| e.tool.as_ref())
                .map(|t| t.as_str().to_owned());
            let fam = family(span.kind, tool.as_deref(), &text);
            Some(label_id(conn, &fam, &text)?)
        }
        None => None,
    };
    let excl = span.end_ms.map(|end| {
        if is_detail(span.kind) {
            0
        } else {
            span.excl_ms
                .unwrap_or(end - span.start_ms)
                .clamp(0, (end - span.start_ms).max(0))
        }
    });
    let extra = span.extra.as_ref().map(serde_json::to_string).transpose()?;
    let parent: Option<i64> = match &span.parent_key {
        Some(k) => conn
            .query_row(
                "SELECT id FROM time_spans WHERE src = ?1 AND src_key = ?2",
                params![span.src, k],
                |r| r.get(0),
            )
            .optional()?,
        None => None,
    };
    let id = match existing {
        Some((_, Some(_))) => return Ok(Wrote::Unchanged),
        Some((id, None)) => {
            if span.end_ms.is_none() {
                return Ok(Wrote::Unchanged);
            }
            conn.execute(
                "UPDATE time_spans SET end_ms = ?2, excl_ms = ?3, status = ?4,
                   extra = COALESCE(?5, extra), label_id = COALESCE(?6, label_id),
                   exit_code = COALESCE(?7, exit_code), workstream_id = COALESCE(workstream_id, ?8),
                   task_id = COALESCE(task_id, ?9)
                 WHERE id = ?1",
                params![
                    id,
                    span.end_ms,
                    excl,
                    span.status.code(),
                    extra,
                    label,
                    span.exit_code,
                    span.ids.workstream_id,
                    span.ids.task_id
                ],
            )?;
            id
        }
        None => {
            let i = &span.ids;
            conn.execute(
                "INSERT INTO time_spans (src, src_key, kind, cat, start_ms, end_ms, excl_ms, machine_id, project_id,
                   workstream_id, task_id, thread_id, run_id, role, lane, parent_id, label_id, exit_code, out_bytes,
                   status, extra)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)",
                params![
                    span.src,
                    span.src_key,
                    span.kind.code(),
                    span.kind.category().code(),
                    span.start_ms,
                    span.end_ms,
                    excl,
                    i.machine_id,
                    i.project_id,
                    i.workstream_id,
                    i.task_id,
                    i.thread_id,
                    i.run_id,
                    i.role,
                    span.lane,
                    parent,
                    label,
                    span.exit_code,
                    span.out_bytes,
                    span.status.code(),
                    extra
                ],
            )?;
            let id = conn.last_insert_rowid();
            if span.end_ms.is_none() {
                return Ok(Wrote::Opened(id));
            }
            id
        }
    };
    type Owners = (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let (machine, project, workstream, task, role): Owners = conn.query_row(
        "SELECT machine_id, project_id, workstream_id, task_id, role FROM time_spans WHERE id = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    )?;
    let ms = excl.unwrap_or(0);
    let day = span.start_ms.div_euclid(DAY_MS);
    let mut targets: Vec<(&str, String, i64)> = vec![("fleet", String::new(), 1)];
    if let Some(m) = &machine {
        targets.push(("machine", m.clone(), 1));
        if let Some(p) = &project {
            targets.push(("project", format!("{m}/{p}"), 1));
            if role.as_deref() == Some("lead") {
                targets.push(("lead", format!("{m}/{p}"), 1));
            }
        }
    }
    if let Some(w) = &workstream {
        targets.push(("order", w.clone(), 1));
    }
    if let Some(t) = &task {
        targets.push(("task", t.clone(), 1));
    }
    for s in shares {
        targets.push((s.scope, s.id.clone(), s.of.max(1)));
    }
    let mut stmt = conn.prepare_cached(
        "INSERT INTO time_rollups (day, scope, scope_id, cat, kind, ms, n) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)
         ON CONFLICT(day, scope, scope_id, cat, kind) DO UPDATE SET ms = ms + excluded.ms, n = n + 1",
    )?;
    for (scope, scope_id, of) in targets {
        stmt.execute(params![
            day,
            scope,
            scope_id,
            span.kind.category().code(),
            span.kind.code(),
            ms / of
        ])?;
    }
    Ok(Wrote::Counted(id))
}

/// Resolves parents written later in the same batch.
pub fn link_parents(
    conn: &Connection,
    src: &str,
    pairs: &[(String, String)],
) -> Result<(), StoreError> {
    let mut stmt = conn.prepare_cached(
        "UPDATE time_spans SET parent_id = (SELECT id FROM time_spans WHERE src = ?1 AND src_key = ?3)
         WHERE src = ?1 AND src_key = ?2 AND parent_id IS NULL",
    )?;
    for (child, parent) in pairs {
        stmt.execute(params![src, child, parent])?;
    }
    Ok(())
}

/// Deletes spans past retention and roll-ups past [`ROLLUP_DAYS`], one batch per call; true while more remain.
pub fn prune(conn: &Connection, now_ms: i64) -> Result<bool, StoreError> {
    let days = retention_days(conn)?;
    let cutoff = now_ms - days * DAY_MS;
    let n = conn.execute(
        "DELETE FROM time_spans WHERE id IN (SELECT id FROM time_spans WHERE start_ms < ?1 ORDER BY start_ms LIMIT ?2)",
        params![cutoff, PRUNE_BATCH],
    )? as i64;
    conn.execute(
        "DELETE FROM time_labels WHERE id IN (SELECT l.id FROM time_labels l
           WHERE NOT EXISTS (SELECT 1 FROM time_spans s WHERE s.label_id = l.id) LIMIT ?1)",
        [PRUNE_BATCH],
    )?;
    let old_day = (now_ms - ROLLUP_DAYS * DAY_MS).div_euclid(DAY_MS);
    conn.execute("DELETE FROM time_rollups WHERE day < ?1", [old_day])?;
    conn.execute(
        "DELETE FROM time_paths WHERE computed_ms < ?1",
        [now_ms - ROLLUP_DAYS * DAY_MS],
    )?;
    conn.execute("DELETE FROM time_wakes WHERE at_ms < ?1", [cutoff])?;
    conn.execute("DELETE FROM time_lead_runs WHERE at_ms < ?1", [cutoff])?;
    // An order's bounds give its wall time, read with its roll-ups, so they last as long.
    conn.execute(
        "DELETE FROM time_orders WHERE COALESCE(end_ms, start_ms) < ?1",
        [now_ms - ROLLUP_DAYS * DAY_MS],
    )?;
    Ok(n == PRUNE_BATCH)
}

/// The bytes the time tables take on disk (SQLite's `dbstat`).
pub fn stored_bytes(conn: &Connection) -> Result<i64, StoreError> {
    let bytes: Option<i64> = conn
        .query_row(
            "SELECT SUM(pgsize) FROM dbstat WHERE name LIKE 'time\\_%' ESCAPE '\\'
               OR name LIKE 'sqlite_autoindex_time\\_%' ESCAPE '\\'",
            [],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    Ok(bytes.unwrap_or(0))
}

/// Which spans a read covers.
#[derive(Clone, Debug, Default)]
pub struct Filter {
    pub since_ms: i64,
    pub until_ms: i64,
    pub machine_id: Option<String>,
    pub project: Option<(String, String)>,
    /// Lead lanes of a project.
    pub lead: Option<(String, String)>,
    pub workstream_id: Option<String>,
    pub task_ids: Option<Vec<String>>,
    pub thread: Option<(String, String)>,
    pub role: Option<String>,
    pub kinds: Option<Vec<SpanKind>>,
    pub after_id: Option<i64>,
    /// Only spans that start here or later: keeps a period's read on the start index.
    pub start_from: Option<i64>,
    /// At the limit, keep the newest spans instead of the oldest.
    pub newest: bool,
}

/// What a reader needs beside the row: the source key (a node span's item id is in it), the role, the run and
/// whether the span is still open.
#[derive(Clone, Debug, Default)]
pub struct Meta {
    pub src_key: String,
    pub role: Option<String>,
    pub run_id: Option<String>,
    pub open: bool,
}

pub fn read(conn: &Connection, f: &Filter, limit: usize) -> Result<Vec<Row>, StoreError> {
    Ok(read_meta(conn, f, limit)?
        .into_iter()
        .map(|(r, _)| r)
        .collect())
}

/// Spans overlapping `[since, until)` that match, by id after `after_id`, at most `limit`. Open spans are cut at
/// `until`.
pub fn read_meta(
    conn: &Connection,
    f: &Filter,
    limit: usize,
) -> Result<Vec<(Row, Meta)>, StoreError> {
    let mut args: Vec<rusqlite::types::Value> = vec![f.until_ms.into(), f.since_ms.into()];
    // An order's own spans and its share of lead turns (runs whose wake served it), as two indexed branches.
    let from = match &f.workstream_id {
        Some(w) => {
            args.push(w.clone().into());
            "(SELECT * FROM time_spans WHERE workstream_id = ?3
              UNION ALL
              SELECT t.* FROM time_lead_runs lr JOIN time_spans t ON t.run_id = lr.run_id
                AND t.machine_id = lr.machine_id AND t.thread_id = lr.thread_id
              WHERE lr.workstream_id = ?3 AND t.role = 'lead' AND t.workstream_id IS NOT ?3)"
        }
        None => "time_spans",
    };
    let mut sql = format!(
        "SELECT s.id, s.kind, s.start_ms, s.end_ms, s.excl_ms, s.lane, s.parent_id, s.label_id, l.text, l.family,
           s.exit_code, s.out_bytes, s.status, s.machine_id, s.project_id, s.workstream_id, s.task_id, s.thread_id,
           s.extra, s.src_key, s.role, s.run_id
         FROM {from} s LEFT JOIN time_labels l ON l.id = s.label_id
         WHERE s.start_ms < ?1 AND COALESCE(s.end_ms, ?1) >= ?2"
    );
    let mut add = |clause: &str, values: Vec<rusqlite::types::Value>, sql: &mut String| {
        // Number each `?` in the clause after the parameters bound so far.
        let mut parts = clause.split('?');
        let mut c = parts.next().unwrap_or_default().to_owned();
        let mut values = values.into_iter();
        for part in parts {
            args.push(values.next().expect("a value per placeholder"));
            c.push_str(&format!("?{}", args.len()));
            c.push_str(part);
        }
        sql.push_str(" AND ");
        sql.push_str(&c);
    };
    if let Some(m) = &f.machine_id {
        add("s.machine_id = ?", vec![m.clone().into()], &mut sql);
    }
    if let Some((m, p)) = &f.project {
        add(
            "s.machine_id = ? AND s.project_id = ?",
            vec![m.clone().into(), p.clone().into()],
            &mut sql,
        );
    }
    if let Some((m, p)) = &f.lead {
        add(
            "s.machine_id = ? AND s.project_id = ? AND s.role = 'lead'",
            vec![m.clone().into(), p.clone().into()],
            &mut sql,
        );
    }
    if let Some(from) = f.start_from {
        add("s.start_ms >= ?", vec![from.into()], &mut sql);
    }
    if let Some(ts) = &f.task_ids {
        let list = serde_json::to_string(ts)?;
        add(
            "s.task_id IN (SELECT value FROM json_each(?))",
            vec![list.into()],
            &mut sql,
        );
    }
    if let Some((m, t)) = &f.thread {
        add(
            "s.machine_id = ? AND s.thread_id = ?",
            vec![m.clone().into(), t.clone().into()],
            &mut sql,
        );
    }
    if let Some(r) = &f.role {
        add("s.role = ?", vec![r.clone().into()], &mut sql);
    }
    if let Some(kinds) = &f.kinds {
        let list = serde_json::to_string(&kinds.iter().map(|k| k.code()).collect::<Vec<_>>())?;
        add(
            "s.kind IN (SELECT value FROM json_each(?))",
            vec![list.into()],
            &mut sql,
        );
    }
    if let Some(a) = f.after_id {
        add("s.id > ?", vec![a.into()], &mut sql);
    }
    let order = if f.newest { "DESC" } else { "" };
    sql.push_str(&format!(" ORDER BY s.id {order} LIMIT {limit}"));
    let mut stmt = conn.prepare(&sql)?;
    let until = f.until_ms;
    let rows = stmt.query_map(rusqlite::params_from_iter(args.iter()), |r| {
        let kind: i64 = r.get(1)?;
        let start: i64 = r.get(2)?;
        let end: Option<i64> = r.get(3)?;
        let extra: Option<String> = r.get(18)?;
        let src_key: String = r.get(19)?;
        let role: Option<String> = r.get(20)?;
        let run_id: Option<String> = r.get(21)?;
        Ok((
            Row {
                id: r.get(0)?,
                kind: SpanKind::from_code(kind).unwrap_or_default(),
                start_ms: start,
                end_ms: end.unwrap_or(until.max(start)),
                excl_ms: r.get::<_, Option<i64>>(4)?.unwrap_or_else(|| {
                    if is_detail(SpanKind::from_code(kind).unwrap_or_default()) {
                        0
                    } else {
                        until.max(start) - start
                    }
                }),
                lane: r.get(5)?,
                parent_id: r.get(6)?,
                label_id: r.get(7)?,
                label: r.get(8)?,
                family: r.get(9)?,
                exit_code: r.get(10)?,
                out_bytes: r.get(11)?,
                status: SpanStatus::from_code(r.get(12)?),
                machine_id: r.get(13)?,
                project_id: r.get(14)?,
                workstream_id: r.get(15)?,
                task_id: r.get(16)?,
                thread_id: r.get(17)?,
                role: role.clone(),
                extra: extra
                    .and_then(|e| serde_json::from_str(&e).ok())
                    .unwrap_or_default(),
            },
            Meta {
                src_key,
                role,
                run_id,
                open: end.is_none(),
            },
        ))
    })?;
    let mut out = rows.collect::<Result<Vec<_>, _>>()?;
    if f.newest {
        out.reverse();
    }
    Ok(out)
}

/// Per category and kind, exclusive ms and count, from the roll-ups for whole UTC days in `[from_day, to_day)`.
pub fn rollup_totals(
    conn: &Connection,
    scope: &str,
    scope_id: &str,
    from_day: i64,
    to_day: i64,
) -> Result<Vec<(Category, SpanKind, i64, i64)>, StoreError> {
    let mut stmt = conn.prepare_cached(
        "SELECT cat, kind, SUM(ms), SUM(n) FROM time_rollups
         WHERE scope = ?1 AND scope_id = ?2 AND day >= ?3 AND day < ?4 GROUP BY cat, kind",
    )?;
    let rows = stmt.query_map(params![scope, scope_id, from_day, to_day], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, i64>(3)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (cat, kind, ms, n) = row?;
        if let (Some(cat), Some(kind)) = (Category::from_code(cat), SpanKind::from_code(kind)) {
            out.push((cat, kind, ms, n));
        }
    }
    Ok(out)
}

pub const DAY: i64 = DAY_MS;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_read_binds_every_filter_and_includes_an_order_s_share_of_lead_turns() {
        let db = crate::hub::store::HubDb::open_memory().unwrap();
        db.transaction(|c| {
            for (key, ws, role, run) in [
                ("a", Some("W1"), None, None),
                ("b", None, Some("lead"), Some("r1")),
                ("c", None, Some("lead"), Some("r2")),
            ] {
                let span = NewSpan {
                    src: "h".into(),
                    src_key: key.into(),
                    kind: SpanKind::ToolBash,
                    start_ms: 10,
                    end_ms: Some(20),
                    ids: Ids {
                        machine_id: Some("devbox".into()),
                        thread_id: Some("t".into()),
                        workstream_id: ws.map(str::to_owned),
                        role: role.map(str::to_owned),
                        run_id: run.map(str::to_owned),
                        ..Ids::default()
                    },
                    lane: "thread:devbox/t".into(),
                    ..NewSpan::default()
                };
                write(c, &span, &[])?;
            }
            c.execute(
                "INSERT INTO time_lead_runs VALUES ('devbox', 't', 'r1', 'W1', 2, 10), ('devbox', 't', 'r1', 'W2', 2, 10)",
                [],
            )?;
            let f = Filter {
                since_ms: 0,
                until_ms: 100,
                machine_id: Some("devbox".into()),
                workstream_id: Some("W1".into()),
                kinds: Some(vec![SpanKind::ToolBash]),
                ..Filter::default()
            };
            let ids: Vec<i64> = read(c, &f, 10)?.iter().map(|r| r.id).collect();
            assert_eq!(ids, vec![1, 2]);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn families_and_worktree_paths() {
        assert_eq!(
            family(
                SpanKind::ToolBash,
                Some("Bash"),
                "cd x && cargo test --workspace"
            ),
            "cargo test"
        );
        assert_eq!(
            family(SpanKind::Git, Some("Bash"), "git -C /a push origin"),
            "git push"
        );
        assert_eq!(
            family(SpanKind::ToolBash, Some("Bash"), "pytest -q"),
            "pytest"
        );
        assert_eq!(family(SpanKind::ToolRead, Some("Read"), "/x/y"), "Read");
        assert_eq!(
            normalize("cd /home/u/.fleetd/worktrees/p1/T4-abc && cargo test"),
            "cd <wt> && cargo test"
        );
    }

    /// A hub from before the slots' saturation spans went: its stored `slots.full` spans and their roll-ups go, so
    /// none reads back as another kind.
    #[test]
    fn stored_slots_full_spans_go_on_an_older_hub() {
        use crate::hub::store::migrations::MIGRATIONS;
        let conn = Connection::open_in_memory().unwrap();
        // Found by content, not as the last migration, so later migrations don't break this test.
        let at = MIGRATIONS
            .iter()
            .position(|m| m.contains("DELETE FROM time_spans WHERE kind = 37"))
            .unwrap();
        for m in &MIGRATIONS[..at] {
            conn.execute_batch(m).unwrap();
        }
        conn.execute_batch(
            "INSERT INTO time_spans (src, src_key, kind, cat, start_ms, lane, status)
               VALUES ('h', 'slots/1', 37, 3, 1, 'fleet', 0), ('h', 'bash', 10, 1, 1, 'x', 0);
             INSERT INTO time_rollups VALUES (1, 'fleet', '', 3, 37, 5, 1), (1, 'fleet', '', 1, 10, 5, 1);",
        )
        .unwrap();
        conn.execute_batch(MIGRATIONS[at]).unwrap();
        let kinds = |table: &str| -> Vec<i64> {
            conn.prepare(&format!("SELECT kind FROM {table}"))
                .unwrap()
                .query_map([], |r| r.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        };
        assert_eq!(kinds("time_spans"), [10]);
        assert_eq!(kinds("time_rollups"), [10]);
    }
}
