//! Synchronous SQL over the ledger tables. Callers compose these inside one write transaction
//! and emit events after the commit; nothing here opens a transaction itself.
use fleetd_contracts::ids::{ProjectRef, Timestamp};
use fleetd_contracts::ledger::{Decision, DecisionId, DecisionKey, DecisionScope, DecisionState};
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

pub(super) fn decision_state_text(state: &DecisionState) -> &'static str {
    match state {
        DecisionState::Active => "active",
        DecisionState::Superseded => "superseded",
        DecisionState::Retired => "retired",
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
