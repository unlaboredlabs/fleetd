//! Incidents: what went wrong, recorded by the hub from what it observed (a false claim, an estimate miss, a polish
//! loop, ...), never by an agent. Each one is stored and announced as `incident.recorded`.
//! TS spec: apps/hub/src/incidents/Incidents.ts.
use crate::clock::Clock;
use crate::hub::store::{EventLog, HubDb, NewEvent, StoreError, iso_ms, now_ms};
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::ids::Timestamp;
use fleetd_contracts::ledger::WorkstreamId;
use fleetd_contracts::prim::{List, Text};
use fleetd_contracts::tasks::TaskId;
use fleetd_contracts::verification::{Incident, IncidentClass, IncidentId};
use rusqlite::{OptionalExtension, named_params};
use std::sync::Arc;

pub mod detectors;

/// An `Incident` before the hub numbers and dates it.
#[derive(Debug, Clone, PartialEq)]
pub struct IncidentInput {
    pub class: IncidentClass,
    pub project_ref: ProjectRef,
    pub workstream_id: Option<WorkstreamId>,
    pub task_id: Option<TaskId>,
    /// Plain-language lines; cut to 20 lines of at most 2000 characters each.
    pub evidence: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct IncidentFilter {
    pub project_ref: Option<ProjectRef>,
    pub workstream_id: Option<WorkstreamId>,
    pub class: Option<IncidentClass>,
    /// Recorded at or after this instant (ms), and before `until_ms`.
    pub since_ms: Option<i64>,
    pub until_ms: Option<i64>,
}

// `at` is always the fixed-width UTC ISO form, so text order is time order.
const WHERE: &str = "($machine IS NULL OR (machine_id = $machine AND project_id = $project))
  AND ($workstream IS NULL OR workstream_id = $workstream) AND ($class IS NULL OR class = $class)
  AND ($since IS NULL OR json_extract(data, '$.at') >= $since) AND ($until IS NULL OR json_extract(data, '$.at') < $until)";

/// An evidence line as the contract takes it: non-empty, at most 2000 UTF-16 units.
fn line(text: &str) -> String {
    let flat = if text.trim().is_empty() {
        "(empty)"
    } else {
        text
    };
    if flat.encode_utf16().count() <= 2000 {
        return flat.to_owned();
    }
    let mut units = 0;
    let cut: String = flat
        .chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= 1999
        })
        .collect();
    cut + "…"
}

pub(crate) fn class_name(class: IncidentClass) -> String {
    match serde_json::to_value(class) {
        Ok(serde_json::Value::String(s)) => s,
        _ => String::new(),
    }
}

pub struct Incidents {
    db: Arc<HubDb>,
    events: Arc<EventLog>,
    clock: Arc<dyn Clock>,
}

impl Incidents {
    pub fn new(db: Arc<HubDb>, events: Arc<EventLog>, clock: Arc<dyn Clock>) -> Self {
        Self { db, events, clock }
    }

    /// Numbers (`I<n>`), stores and emits `incident.recorded`.
    pub fn record(&self, input: IncidentInput) -> Result<Incident, StoreError> {
        let at = iso_ms(now_ms(self.clock.as_ref()));
        let incident = self.db.transaction(|conn| {
            let r = &input.project_ref;
            let n: i64 = conn
                .prepare_cached(
                    "INSERT INTO incidents (class, machine_id, project_id, workstream_id, data) VALUES (?, ?, ?, ?, '') RETURNING n",
                )?
                .query_row(
                    rusqlite::params![class_name(input.class), r.machine_id.as_str(), r.project_id.as_str(), input.workstream_id.as_ref().map(|w| w.as_str())],
                    |row| row.get(0),
                )?;
            let incident = Incident {
                incident_id: IncidentId::unchecked(format!("I{n}")),
                class: input.class,
                project_ref: input.project_ref.clone(),
                workstream_id: input.workstream_id.clone(),
                task_id: input.task_id.clone(),
                evidence: List::unchecked(input.evidence.iter().take(20).map(|l| Text::unchecked(line(l))).collect()),
                at: Timestamp(at.clone()),
            };
            conn.prepare_cached("UPDATE incidents SET data = ? WHERE n = ?")?.execute(rusqlite::params![serde_json::to_string(&incident)?, n])?;
            Ok(incident)
        })?;
        let mut data =
            serde_json::json!({ "incidentId": incident.incident_id, "class": incident.class });
        if let Some(w) = &incident.workstream_id {
            data["workstreamId"] = serde_json::json!(w);
        }
        if let Some(t) = &incident.task_id {
            data["taskId"] = serde_json::json!(t);
        }
        let on = incident
            .workstream_id
            .as_ref()
            .map(|w| format!(" on {w}"))
            .unwrap_or_default();
        self.events.append(NewEvent {
            at: Timestamp(at),
            r#type: HubEventType::IncidentRecorded,
            machine_id: Some(incident.project_ref.machine_id.clone()),
            project_id: Some(incident.project_ref.project_id.clone()),
            thread_id: None,
            summary: format!(
                "{} {}{on}: {}",
                incident.incident_id,
                class_name(incident.class),
                incident.evidence.first().map(|l| l.as_str()).unwrap_or("")
            ),
            data: Some(data),
            attention: None,
        })?;
        Ok(incident)
    }

    pub fn get(&self, incident_id: &IncidentId) -> Result<Option<Incident>, StoreError> {
        let Some(n) = incident_id
            .as_str()
            .strip_prefix('I')
            .and_then(|n| n.parse::<i64>().ok())
        else {
            return Ok(None);
        };
        self.db.with(|conn| {
            let data: Option<String> = conn
                .prepare_cached("SELECT data FROM incidents WHERE n = ?")?
                .query_row([n], |row| row.get(0))
                .optional()?;
            Ok(data.map(|d| serde_json::from_str(&d)).transpose()?)
        })
    }

    /// Newest first.
    pub fn list(&self, filter: &IncidentFilter, limit: usize) -> Result<Vec<Incident>, StoreError> {
        self.db.with(|conn| {
            let p = Params::of(filter);
            let mut stmt = conn.prepare_cached(&format!("SELECT data FROM incidents WHERE {WHERE} ORDER BY n DESC LIMIT $limit"))?;
            let rows = stmt.query_map(
                named_params! {
                    "$machine": p.machine, "$project": p.project, "$workstream": p.workstream, "$class": p.class,
                    "$since": p.since, "$until": p.until, "$limit": limit as i64,
                },
                |row| row.get::<_, String>(0),
            )?;
            let mut out = Vec::new();
            for data in rows {
                out.push(serde_json::from_str(&data?)?);
            }
            Ok(out)
        })
    }

    /// How many match per class (no limit), most first; classes with none are left out.
    pub fn counts(&self, filter: &IncidentFilter) -> Result<Vec<(IncidentClass, u64)>, StoreError> {
        self.db.with(|conn| {
            let p = Params::of(filter);
            let mut stmt = conn.prepare_cached(&format!(
                "SELECT class, COUNT(*) AS count FROM incidents WHERE {WHERE} GROUP BY class ORDER BY count DESC, class"
            ))?;
            let rows = stmt.query_map(
                named_params! {
                    "$machine": p.machine, "$project": p.project, "$workstream": p.workstream, "$class": p.class,
                    "$since": p.since, "$until": p.until,
                },
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )?;
            let mut out = Vec::new();
            for row in rows {
                let (class, count) = row?;
                out.push((serde_json::from_value(serde_json::Value::String(class))?, count as u64));
            }
            Ok(out)
        })
    }
}

struct Params {
    machine: Option<String>,
    project: Option<String>,
    workstream: Option<String>,
    class: Option<String>,
    since: Option<String>,
    until: Option<String>,
}

impl Params {
    fn of(f: &IncidentFilter) -> Self {
        Self {
            machine: f
                .project_ref
                .as_ref()
                .map(|r| r.machine_id.as_str().to_owned()),
            project: f
                .project_ref
                .as_ref()
                .map(|r| r.project_id.as_str().to_owned()),
            workstream: f.workstream_id.as_ref().map(|w| w.as_str().to_owned()),
            class: f.class.map(class_name),
            since: f.since_ms.map(iso_ms),
            until: f.until_ms.map(iso_ms),
        }
    }
}

/// `incidents_list`'s answer, before the tool layer adds `truncated`. `allows` is the caller's read grant per
/// machine. Mirrors FleetApi.ts: scoped to a project the store's limit is exact; otherwise read wide and keep what the
/// key may see. Counts cover the last `window_days`, from the incidents this key may read.
pub struct IncidentsListed {
    pub incidents: Vec<Incident>,
    pub truncated: bool,
    pub counts: Vec<(IncidentClass, u64)>,
    pub counts_since: String,
}

impl Incidents {
    pub fn list_for_tool(
        &self,
        filter: IncidentFilter,
        limit: usize,
        window_days: u32,
        allows: &dyn Fn(&ProjectRef) -> bool,
    ) -> Result<IncidentsListed, StoreError> {
        let scoped = filter.project_ref.is_some();
        let mut all: Vec<Incident> = self
            .list(&filter, if scoped { limit + 1 } else { 1000 })?
            .into_iter()
            .filter(|i| allows(&i.project_ref))
            .collect();
        let truncated = all.len() > limit;
        all.truncate(limit);
        let since_ms = now_ms(self.clock.as_ref()) - i64::from(window_days) * 86_400_000;
        let window = IncidentFilter {
            since_ms: Some(since_ms),
            until_ms: None,
            ..filter
        };
        let mut tally: Vec<(IncidentClass, u64)> = Vec::new();
        for i in self.list(&window, 10_000)? {
            if !allows(&i.project_ref) {
                continue;
            }
            match tally.iter_mut().find(|(c, _)| *c == i.class) {
                Some((_, n)) => *n += 1,
                None => tally.push((i.class, 1)),
            }
        }
        // TS sorts by count, then class name (localeCompare; the names are lowercase ASCII).
        tally.sort_by(|a, b| {
            b.1.cmp(&a.1)
                .then_with(|| class_name(a.0).cmp(&class_name(b.0)))
        });
        Ok(IncidentsListed {
            incidents: all,
            truncated,
            counts: tally,
            counts_since: iso_ms(since_ms),
        })
    }
}
