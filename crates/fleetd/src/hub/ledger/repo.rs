//! Synchronous SQL over the ledger tables. Callers compose these inside one write transaction
//! and emit events after the commit; nothing here opens a transaction itself.
use fleetd_contracts::ids::{ProjectRef, Timestamp};
use fleetd_contracts::ledger::{
    Ask, AskId, AskState, Batch, BatchId, BatchItem, BatchState, Decision, DecisionId, DecisionKey,
    DecisionScope, DecisionState, WorkstreamId,
};
use fleetd_contracts::prim::Positive;
use rusqlite::{Connection, OptionalExtension, named_params, params};

use super::{Actor, Chain, Fail, LedgerError, iso_at, project_key};

fn serial(prefix: char, id: &str) -> Option<i64> {
    let digits = id.strip_prefix(prefix)?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n: i64 = digits.parse().ok()?;
    (n > 0 && n <= fleetd_contracts::prim::MAX_SAFE_INT).then_some(n)
}
pub fn decision_n(id: &str) -> Option<i64> {
    serial('D', id)
}
pub fn ask_n(id: &str) -> Option<i64> {
    serial('A', id)
}
pub fn batch_n(id: &str) -> Option<i64> {
    serial('B', id)
}

const STOPWORDS: &[&str] = &[
    "the", "and", "for", "should", "what", "which", "use", "with", "this", "that", "we", "do",
];

/// FTS5 query matching any of the words in `text`; `None` when there are none worth matching.
pub fn fts_query(text: &str) -> Option<String> {
    let lower = text.to_lowercase();
    let mut words: Vec<&str> = Vec::new();
    for word in lower
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
    {
        if !words.contains(&word) {
            words.push(word);
        }
    }
    let words: Vec<String> = words
        .into_iter()
        .filter(|w| w.encode_utf16().count() >= 2 && !STOPWORDS.contains(w))
        .take(24)
        .map(|w| format!("\"{w}\""))
        .collect();
    (!words.is_empty()).then(|| words.join(" OR "))
}

fn scope_columns(scope: &DecisionScope) -> (&'static str, String) {
    match scope {
        DecisionScope::Global => ("global", String::new()),
        DecisionScope::Project { project_ref } => ("project", project_key(project_ref)),
        DecisionScope::Workstream { workstream_id } => ("workstream", workstream_id.to_string()),
    }
}

/// An ask's project column: "" for an unrouted ask, which has no project yet.
pub fn ask_project_key(project_ref: Option<&ProjectRef>) -> String {
    project_ref.map(project_key).unwrap_or_default()
}

pub(super) fn decision_state_text(state: &DecisionState) -> &'static str {
    match state {
        DecisionState::Active => "active",
        DecisionState::Superseded => "superseded",
        DecisionState::Retired => "retired",
    }
}

pub(super) fn ask_state_text(state: &AskState) -> &'static str {
    match state {
        AskState::Open => "open",
        AskState::Auto => "auto",
        AskState::Answered => "answered",
        AskState::Defaulted => "defaulted",
        AskState::Withdrawn => "withdrawn",
    }
}

fn decode<T: serde::de::DeserializeOwned>(data: String) -> Result<T, Fail> {
    serde_json::from_str(&data)
        .map_err(|e| Fail::Internal(format!("ledger row does not decode: {e}")))
}

fn encode<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_string(value).expect("ledger records always encode")
}

#[derive(Clone, Debug)]
pub struct RecordInput {
    pub key: DecisionKey,
    pub scope: DecisionScope,
    pub value: String,
    pub why: Option<String>,
    pub ask_id: Option<AskId>,
    /// The project a workstream-scoped decision belongs to, so project-wide lookups find it.
    pub project_ref: Option<ProjectRef>,
}

impl RecordInput {
    pub fn new(key: DecisionKey, scope: DecisionScope, value: impl Into<String>) -> Self {
        Self {
            key,
            scope,
            value: value.into(),
            why: None,
            ask_id: None,
            project_ref: None,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct DecisionFilter {
    /// Global decisions plus everything recorded in this project.
    pub chain: Option<Chain>,
    /// Exactly this scope.
    pub scope: Option<DecisionScope>,
    pub source: Option<fleetd_contracts::ledger::DecisionSource>,
    /// Recorded at or after this time (ms).
    pub since_ms: Option<i64>,
    pub limit: Option<i64>,
}

#[derive(Clone, Debug, Default)]
pub struct AskFilter {
    pub state: Option<AskState>,
    pub project_ref: Option<ProjectRef>,
    pub workstream_id: Option<WorkstreamId>,
    pub batch_id: Option<BatchId>,
    pub limit: Option<i64>,
}

#[derive(Clone, Debug)]
pub struct StoredBatch {
    pub batch: Batch,
    pub n: i64,
    pub last_add_ms: Option<i64>,
    pub published_ms: Option<i64>,
}

pub struct AskRow {
    pub ask: Ask,
    pub filed_by: String,
}

pub fn get_decision(db: &Connection, id: &str) -> Result<Option<Decision>, Fail> {
    let Some(n) = decision_n(id) else {
        return Ok(None);
    };
    let data: Option<String> = db
        .query_row("SELECT data FROM decisions WHERE n = ?", [n], |r| r.get(0))
        .optional()?;
    data.map(decode).transpose()
}

fn put_decision(db: &Connection, n: i64, decision: &Decision) -> Result<(), Fail> {
    db.execute(
        "UPDATE decisions SET data = ?, state = ? WHERE n = ?",
        params![encode(decision), decision_state_text(&decision.state), n],
    )?;
    Ok(())
}

/// Inserts an active decision, superseding the active one on the same key and scope.
pub fn record_decision(
    db: &Connection,
    input: &RecordInput,
    actor: &Actor,
    now_ms: i64,
) -> Result<Decision, Fail> {
    let (kind, id) = scope_columns(&input.scope);
    let previous: Option<(i64, String)> = db
        .query_row(
            "SELECT n, data FROM decisions WHERE key = ? AND scope_kind = ? AND scope_id = ? AND state = 'active'",
            params![input.key.as_str(), kind, id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let project_ref = match &input.scope {
        DecisionScope::Project { project_ref } => Some(project_ref),
        DecisionScope::Workstream { .. } => input.project_ref.as_ref(),
        DecisionScope::Global => None,
    };
    let n: i64 = db.query_row(
        "INSERT INTO decisions (key, scope_kind, scope_id, project_key, state, source, at_ms, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, '') RETURNING n",
        params![
            input.key.as_str(),
            kind,
            id,
            project_ref.map(project_key),
            "active",
            super::source_text(&actor.source),
            now_ms
        ],
        |r| r.get(0),
    )?;
    let mut supersedes = None;
    if let Some((old_n, data)) = previous {
        let mut old: Decision = decode(data)?;
        old.state = DecisionState::Superseded;
        put_decision(db, old_n, &old)?;
        supersedes = Some(old.decision_id);
    }
    let decision = Decision {
        decision_id: DecisionId::unchecked(format!("D{n}")),
        key: input.key.clone(),
        scope: input.scope.clone(),
        value: super::text(&input.value),
        why: input.why.as_deref().map(super::text),
        source: actor.source,
        by: Some(actor.by.clone()),
        ask_id: input.ask_id.clone(),
        supersedes,
        state: DecisionState::Active,
        at: Timestamp(iso_at(now_ms)),
    };
    put_decision(db, n, &decision)?;
    db.execute(
        "INSERT INTO decisions_fts (rowid, key, value, why) VALUES (?, ?, ?, ?)",
        params![
            n,
            input.key.as_str(),
            input.value,
            input.why.as_deref().unwrap_or("")
        ],
    )?;
    Ok(decision)
}

pub fn retire_decision(db: &Connection, id: &str) -> Result<Decision, Fail> {
    let Some(mut decision) = get_decision(db, id)? else {
        return Err(LedgerError::not_found(format!("No decision {id}.")).into());
    };
    if decision.state != DecisionState::Active {
        return Err(LedgerError::invalid_fix(
            format!("{id} is already {}.", decision_state_text(&decision.state)),
            "Forget the decision that replaced it instead.",
        )
        .into());
    }
    decision.state = DecisionState::Retired;
    put_decision(db, decision_n(id).expect("found by id"), &decision)?;
    Ok(decision)
}

pub fn resolve(db: &Connection, key: &str, chain: &Chain) -> Result<Option<Decision>, Fail> {
    let data: Option<String> = db
        .query_row(
            "SELECT data FROM decisions
             WHERE key = :key AND state = 'active' AND (
               (scope_kind = 'workstream' AND scope_id = :ws) OR (scope_kind = 'project' AND scope_id = :project)
               OR scope_kind = 'global')
             ORDER BY CASE scope_kind WHEN 'workstream' THEN 0 WHEN 'project' THEN 1 ELSE 2 END LIMIT 1",
            named_params! {
                ":key": key,
                ":ws": chain.workstream_id.as_ref().map(|w| w.as_str()),
                ":project": project_key(&chain.project_ref),
            },
            |r| r.get(0),
        )
        .optional()?;
    data.map(decode).transpose()
}

/// Active decisions on `key` recorded in the project, at project or workstream scope, oldest first.
pub fn active_on_key(
    db: &Connection,
    key: &str,
    project_ref: &ProjectRef,
) -> Result<Vec<Decision>, Fail> {
    let mut stmt =
        db.prepare_cached("SELECT data FROM decisions WHERE key = ? AND project_key = ? AND state = 'active' ORDER BY n")?;
    let rows = stmt.query_map(params![key, project_key(project_ref)], |r| {
        r.get::<_, String>(0)
    })?;
    rows.map(|row| decode(row?)).collect()
}

type FilterParams = (Option<String>, Option<&'static str>, Option<String>);

fn filter_params(chain: Option<&Chain>, scope: Option<&DecisionScope>) -> FilterParams {
    let scope = scope.map(scope_columns);
    (
        chain.map(|c| project_key(&c.project_ref)),
        scope.as_ref().map(|s| s.0),
        scope.map(|s| s.1),
    )
}

pub fn search_decisions(
    db: &Connection,
    query: &str,
    filter: &DecisionFilter,
) -> Result<Vec<Decision>, Fail> {
    let Some(q) = fts_query(query) else {
        return Ok(Vec::new());
    };
    let (project, kind, id) = filter_params(filter.chain.as_ref(), filter.scope.as_ref());
    let mut stmt = db.prepare_cached(
        "SELECT d.data FROM decisions_fts f JOIN decisions d ON d.n = f.rowid
         WHERE decisions_fts MATCH :q AND d.state = 'active'
           AND (:project IS NULL OR d.scope_kind = 'global' OR d.project_key = :project)
           AND (:kind IS NULL OR (d.scope_kind = :kind AND d.scope_id = :id))
         ORDER BY bm25(decisions_fts), d.n DESC LIMIT :limit",
    )?;
    let rows = stmt.query_map(
        named_params! { ":q": q, ":project": project, ":kind": kind, ":id": id, ":limit": filter.limit.unwrap_or(10) },
        |r| r.get::<_, String>(0),
    )?;
    rows.map(|row| decode(row?)).collect()
}

pub fn list_decisions(db: &Connection, filter: &DecisionFilter) -> Result<Vec<Decision>, Fail> {
    let (project, kind, id) = filter_params(filter.chain.as_ref(), filter.scope.as_ref());
    let source = filter.source.as_ref().map(super::source_text);
    let mut stmt = db.prepare_cached(
        "SELECT data FROM decisions
         WHERE state = 'active'
           AND (:project IS NULL OR scope_kind = 'global' OR project_key = :project)
           AND (:kind IS NULL OR (scope_kind = :kind AND scope_id = :id))
           AND (:source IS NULL OR source = :source) AND at_ms >= :since
         ORDER BY n DESC LIMIT :limit",
    )?;
    let rows = stmt.query_map(
        named_params! {
            ":project": project, ":kind": kind, ":id": id, ":source": source,
            ":since": filter.since_ms.unwrap_or(0), ":limit": filter.limit.unwrap_or(50),
        },
        |r| r.get::<_, String>(0),
    )?;
    rows.map(|row| decode(row?)).collect()
}

pub fn get_ask_row(db: &Connection, id: &str) -> Result<Option<AskRow>, Fail> {
    let Some(n) = ask_n(id) else { return Ok(None) };
    let row: Option<(String, String)> = db
        .query_row("SELECT data, filed_by FROM asks WHERE n = ?", [n], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()?;
    row.map(|(data, filed_by)| {
        Ok(AskRow {
            ask: decode(data)?,
            filed_by,
        })
    })
    .transpose()
}

pub fn get_ask(db: &Connection, id: &str) -> Result<Option<Ask>, Fail> {
    Ok(get_ask_row(db, id)?.map(|row| row.ask))
}

pub fn put_ask(db: &Connection, ask: &Ask) -> Result<(), Fail> {
    db.execute(
        "UPDATE asks SET data = ?, state = ?, batch_n = ? WHERE n = ?",
        params![
            encode(ask),
            ask_state_text(&ask.state),
            ask.batch_id.as_deref().and_then(batch_n),
            ask_n(&ask.ask_id).expect("minted ask id"),
        ],
    )?;
    Ok(())
}

/// Inserts an ask; `build` receives the new id and returns the record to store. The key column follows the built
/// ask's key, for asks whose key names their own id (`gated.a7`).
pub fn insert_ask(
    db: &Connection,
    project_ref: Option<&ProjectRef>,
    key: &str,
    workstream_id: Option<&WorkstreamId>,
    filed_by: &str,
    now_ms: i64,
    build: impl FnOnce(AskId) -> Ask,
) -> Result<Ask, Fail> {
    let n: i64 = db.query_row(
        "INSERT INTO asks (project_key, workstream_id, key, state, filed_by, batch_n, created_ms, data)
         VALUES (?, ?, ?, ?, ?, NULL, ?, '') RETURNING n",
        params![ask_project_key(project_ref), workstream_id.map(|w| w.as_str()), key, "open", filed_by, now_ms],
        |r| r.get(0),
    )?;
    let ask = build(AskId::unchecked(format!("A{n}")));
    if ask.key.as_str() != key {
        db.execute(
            "UPDATE asks SET key = ? WHERE n = ?",
            params![ask.key.as_str(), n],
        )?;
    }
    put_ask(db, &ask)?;
    Ok(ask)
}

pub fn open_ask_with_key(
    db: &Connection,
    project_ref: Option<&ProjectRef>,
    key: &str,
) -> Result<Option<Ask>, Fail> {
    let data: Option<String> = db
        .query_row(
            "SELECT data FROM asks WHERE project_key = ? AND key = ? AND state = 'open' LIMIT 1",
            params![ask_project_key(project_ref), key],
            |r| r.get(0),
        )
        .optional()?;
    data.map(decode).transpose()
}

pub fn list_asks(db: &Connection, filter: &AskFilter) -> Result<Vec<Ask>, Fail> {
    let mut stmt = db.prepare_cached(
        "SELECT data FROM asks
         WHERE (:state IS NULL OR state = :state) AND (:project IS NULL OR project_key = :project)
           AND (:ws IS NULL OR workstream_id = :ws) AND (:batch IS NULL OR batch_n = :batch)
         ORDER BY batch_n IS NULL, batch_n, json_extract(data, '$.number'), n LIMIT :limit",
    )?;
    let rows = stmt.query_map(
        named_params! {
            ":state": filter.state.as_ref().map(ask_state_text),
            ":project": filter.project_ref.as_ref().map(project_key),
            ":ws": filter.workstream_id.as_ref().map(|w| w.as_str()),
            ":batch": filter.batch_id.as_ref().map(|b| batch_n(b).unwrap_or(-1)),
            ":limit": filter.limit.unwrap_or(100),
        },
        |r| r.get::<_, String>(0),
    )?;
    rows.map(|row| decode(row?)).collect()
}

pub fn get_batch(db: &Connection, n: i64) -> Result<Option<StoredBatch>, Fail> {
    let row: Option<(String, i64, Option<i64>, Option<i64>)> = db
        .query_row(
            "SELECT state, created_ms, last_add_ms, published_ms FROM batches WHERE n = ?",
            [n],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((state, created_ms, last_add_ms, published_ms)) = row else {
        return Ok(None);
    };
    let mut stmt = db.prepare_cached(
        "SELECT number, ask_n FROM batch_items WHERE batch_n = ? ORDER BY number",
    )?;
    let items = stmt
        .query_map([n], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))?
        .map(|row| {
            let (number, ask) = row?;
            Ok(BatchItem {
                number: Positive::unchecked(number),
                ask_id: AskId::unchecked(format!("A{ask}")),
            })
        })
        .collect::<Result<Vec<_>, Fail>>()?;
    Ok(Some(StoredBatch {
        n,
        batch: Batch {
            batch_id: BatchId::unchecked(format!("B{n}")),
            created_at: Timestamp(iso_at(created_ms)),
            items,
            state: if state == "closed" {
                BatchState::Closed
            } else {
                BatchState::Open
            },
        },
        last_add_ms,
        published_ms,
    }))
}

fn batch_by(db: &Connection, sql: &str) -> Result<Option<StoredBatch>, Fail> {
    let n: Option<i64> = db.query_row(sql, [], |r| r.get(0)).optional()?;
    match n {
        Some(n) => get_batch(db, n),
        None => Ok(None),
    }
}

/// The batch new asks join: open and not yet published.
pub fn collecting_batch(db: &Connection) -> Result<Option<StoredBatch>, Fail> {
    batch_by(
        db,
        "SELECT n FROM batches WHERE state = 'open' AND published_ms IS NULL ORDER BY n DESC LIMIT 1",
    )
}

/// Gives `ask` the next number in batch `n`; `quiet` (a new ask) restarts the batch's quiet window.
fn place_in(
    db: &Connection,
    n: i64,
    ask: &Ask,
    now_ms: i64,
    quiet: bool,
) -> Result<(Ask, StoredBatch), Fail> {
    let number: i64 = db.query_row(
        "SELECT COALESCE(MAX(number), 0) + 1 FROM batch_items WHERE batch_n = ?",
        [n],
        |r| r.get(0),
    )?;
    db.execute(
        "INSERT INTO batch_items (batch_n, number, ask_n) VALUES (?, ?, ?)",
        params![n, number, ask_n(&ask.ask_id).expect("minted ask id")],
    )?;
    if quiet {
        db.execute(
            "UPDATE batches SET last_add_ms = ? WHERE n = ?",
            params![now_ms, n],
        )?;
    }
    let mut placed = ask.clone();
    placed.batch_id = Some(BatchId::unchecked(format!("B{n}")));
    placed.number = Some(Positive::unchecked(number));
    put_ask(db, &placed)?;
    let batch = get_batch(db, n)?.expect("just placed into it");
    Ok((placed, batch))
}

fn new_batch(db: &Connection, now_ms: i64) -> Result<i64, Fail> {
    Ok(db.query_row(
        "INSERT INTO batches (state, created_ms, last_add_ms, published_ms) VALUES ('open', ?, NULL, NULL) RETURNING n",
        [now_ms],
        |r| r.get(0),
    )?)
}

/// A new ask joins the collecting batch, creating it if needed.
pub fn add_to_collecting(
    db: &Connection,
    ask: &Ask,
    now_ms: i64,
) -> Result<(Ask, StoredBatch), Fail> {
    let n = match collecting_batch(db)? {
        Some(stored) => stored.n,
        None => new_batch(db, now_ms)?,
    };
    place_in(db, n, ask, now_ms, true)
}

/// "later": the ask leaves `from_batch` (whose item list keeps it, numbers never change) for the collecting batch.
/// It does not start the quiet window, so it is shown again with the next new ask rather than 30 s from now.
pub fn move_to_later_batch(
    db: &Connection,
    ask: &Ask,
    from_batch: i64,
    now_ms: i64,
) -> Result<Ask, Fail> {
    let n = match collecting_batch(db)? {
        Some(stored) if stored.n != from_batch => stored.n,
        _ => new_batch(db, now_ms)?,
    };
    Ok(place_in(db, n, ask, now_ms, false)?.0)
}

/// True when it was still unpublished.
pub fn publish_batch(db: &Connection, n: i64, now_ms: i64) -> Result<bool, Fail> {
    Ok(db.execute(
        "UPDATE batches SET published_ms = ? WHERE n = ? AND published_ms IS NULL",
        params![now_ms, n],
    )? > 0)
}

/// Closes the batch once no item is still open in it (answered, withdrawn, or moved to a later batch).
pub fn close_if_done(db: &Connection, n: i64) -> Result<bool, Fail> {
    let Some(stored) = get_batch(db, n)? else {
        return Ok(false);
    };
    if stored.batch.state == BatchState::Closed {
        return Ok(false);
    }
    for item in &stored.batch.items {
        if let Some(ask) = get_ask(db, &item.ask_id)?
            && ask.state == AskState::Open
            && ask.batch_id.as_ref() == Some(&stored.batch.batch_id)
        {
            return Ok(false);
        }
    }
    db.execute("UPDATE batches SET state = 'closed' WHERE n = ?", [n])?;
    Ok(true)
}

/// Latest open batch the human has been shown; the collecting one only when none was published.
pub fn latest_open_batch(db: &Connection) -> Result<Option<StoredBatch>, Fail> {
    batch_by(
        db,
        "SELECT n FROM batches WHERE state = 'open' ORDER BY published_ms IS NULL, n DESC LIMIT 1",
    )
}

pub fn list_batches(
    db: &Connection,
    state: Option<BatchState>,
    limit: Option<i64>,
) -> Result<Vec<StoredBatch>, Fail> {
    let mut stmt =
        db.prepare_cached("SELECT n FROM batches WHERE (:state IS NULL OR state = :state) ORDER BY n DESC LIMIT :limit")?;
    let ns = stmt
        .query_map(
            named_params! {
                ":state": state.map(|s| if s == BatchState::Closed { "closed" } else { "open" }),
                ":limit": limit.unwrap_or(20),
            },
            |r| r.get::<_, i64>(0),
        )?
        .collect::<Result<Vec<_>, _>>()?;
    ns.into_iter()
        .map(|n| Ok(get_batch(db, n)?.expect("listed")))
        .collect()
}
