//! Area leases: one writer per area within a project, from spawn until the task ends. A task takes all of its
//! areas at once or none of them, so no task ever holds some areas while waiting for others, and two tasks can
//! never deadlock on each other's areas. The hub never releases a lease on its own; one held past 4 h is flagged.
//! TS spec: apps/hub/src/leases/Leases.ts.
pub mod policy;

use std::sync::Arc;

use fleetd_contracts::{AreaName, HubEventType, Lease, MachineId, ProjectId, ProjectRef, TaskId, Timestamp};
use rusqlite::{Connection, Row, params};

use crate::clock::Clock;
use crate::hub::slots::Grant;
use crate::hub::store::{EventLog, HubDb, NewEvent, StoreError, iso_ms, now_ms};

pub use policy::{Policies, PolicySource, parse_policy};

pub const STALE_AFTER_MS: i64 = 4 * 60 * 60_000;

/// "lease: docs held by T1, hub held by T2", trimmed to fit `Task.queuedReason`.
fn conflict_reason(conflicts: &[(&str, String)]) -> String {
    let text = format!("lease: {}", conflicts.iter().map(|(area, by)| format!("{area} held by {by}")).collect::<Vec<_>>().join(", "));
    if text.encode_utf16().count() > 200 {
        let mut units = 0;
        let cut: String = text
            .chars()
            .take_while(|c| {
                units += c.len_utf16();
                units <= 199
            })
            .collect();
        format!("{cut}…")
    } else {
        text
    }
}

fn to_lease(row: &Row<'_>) -> rusqlite::Result<Lease> {
    Ok(Lease {
        project_ref: ProjectRef {
            machine_id: MachineId::unchecked(row.get::<_, String>("machine_id")?),
            project_id: ProjectId::unchecked(row.get::<_, String>("project_id")?),
        },
        area: AreaName::unchecked(row.get::<_, String>("area")?),
        task_id: TaskId::unchecked(row.get::<_, String>("task_id")?),
        since: Timestamp(row.get("since")?),
    })
}

/// The all-or-none rule over the project's lease rows, inside the caller's transaction.
fn acquire_in(db: &Connection, project_ref: &ProjectRef, task_id: &TaskId, areas: &[AreaName], since: &str) -> rusqlite::Result<Grant> {
    let (m, p) = (project_ref.machine_id.as_str(), project_ref.project_id.as_str());
    let held: Vec<(String, String)> = db
        .prepare_cached("SELECT area, task_id FROM leases WHERE machine_id = ? AND project_id = ?")?
        .query_map(params![m, p], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let holder = |area: &str| held.iter().find(|(a, _)| a == area).map(|(_, t)| t.clone());
    let conflicts: Vec<(&str, String)> = areas
        .iter()
        .filter_map(|a| holder(a.as_str()).filter(|t| t != task_id.as_str()).map(|t| (a.as_str(), t)))
        .collect();
    if !conflicts.is_empty() {
        return Ok(Grant::Queued(conflict_reason(&conflicts)));
    }
    for area in areas {
        if holder(area.as_str()).is_none() {
            db.prepare_cached("INSERT INTO leases (machine_id, project_id, area, task_id, since) VALUES (?, ?, ?, ?, ?)")?
                .execute(params![m, p, area.as_str(), task_id.as_str(), since])?;
        }
    }
    Ok(Grant::Granted)
}

#[derive(Clone, Debug, Default)]
pub struct LeaseFilter {
    pub project_ref: Option<ProjectRef>,
    pub task_id: Option<TaskId>,
}

pub struct Leases {
    db: Arc<HubDb>,
    events: Arc<EventLog>,
    clock: Arc<dyn Clock>,
}

impl Leases {
    pub fn new(db: Arc<HubDb>, events: Arc<EventLog>, clock: Arc<dyn Clock>) -> Arc<Self> {
        Arc::new(Self { db, events, clock })
    }

    /// Takes every area in `areas` for the task, or none: if another task holds any of them, the reason names every
    /// conflict. Areas the task already holds count as granted.
    pub fn acquire(&self, project_ref: &ProjectRef, task_id: &TaskId, areas: &[AreaName]) -> Result<Grant, StoreError> {
        let since = iso_ms(now_ms(self.clock.as_ref()));
        self.db.transaction(|db| Ok(acquire_in(db, project_ref, task_id, areas, &since)?))
    }

    /// Drops every lease the task holds and returns them.
    pub fn release(&self, task_id: &TaskId) -> Result<Vec<Lease>, StoreError> {
        self.db.transaction(|db| {
            let leases = db.prepare_cached("SELECT * FROM leases WHERE task_id = ?")?.query_map([task_id.as_str()], to_lease)?.collect::<rusqlite::Result<Vec<_>>>()?;
            db.prepare_cached("DELETE FROM leases WHERE task_id = ?")?.execute([task_id.as_str()])?;
            Ok(leases)
        })
    }

    /// Oldest first, for the digest.
    pub fn list(&self, filter: &LeaseFilter) -> Result<Vec<Lease>, StoreError> {
        self.db.with(|db| {
            Ok(db
                .prepare_cached(
                    "SELECT * FROM leases WHERE (?1 IS NULL OR (machine_id = ?1 AND project_id = ?2))
                       AND (?3 IS NULL OR task_id = ?3) ORDER BY since, area",
                )?
                .query_map(
                    params![
                        filter.project_ref.as_ref().map(|r| r.machine_id.as_str()),
                        filter.project_ref.as_ref().map(|r| r.project_id.as_str()),
                        filter.task_id.as_ref().map(|t| t.as_str()),
                    ],
                    to_lease,
                )?
                .collect::<rusqlite::Result<_>>()?)
        })
    }

    /// Emits `lease.stale` once for each lease held over 4 h. Returns how many it flagged.
    pub fn flag_stale(&self) -> Result<usize, StoreError> {
        let now = now_ms(self.clock.as_ref());
        let stale: Vec<Lease> = self.db.with(|db| {
            Ok(db
                .prepare_cached("SELECT * FROM leases WHERE stale_flagged = 0 AND since < ? ORDER BY since")?
                .query_map([iso_ms(now - STALE_AFTER_MS)], to_lease)?
                .collect::<rusqlite::Result<_>>()?)
        })?;
        for lease in &stale {
            let since_ms = parse_iso_ms(lease.since.as_str()).unwrap_or(now);
            let hours = (now - since_ms).div_euclid(3_600_000);
            self.events.append(NewEvent {
                at: Timestamp(iso_ms(now)),
                r#type: HubEventType::LeaseStale,
                machine_id: Some(lease.project_ref.machine_id.clone()),
                project_id: Some(lease.project_ref.project_id.clone()),
                thread_id: None,
                summary: format!(
                    "Lease on {} in {} held by {} for {hours} h; still held",
                    lease.area.as_str(),
                    lease.project_ref.project_id.as_str(),
                    lease.task_id.as_str()
                ),
                data: Some(serde_json::json!({ "taskId": lease.task_id, "area": lease.area, "since": lease.since })),
            })?;
            self.db.with(|db| {
                db.prepare_cached("UPDATE leases SET stale_flagged = 1 WHERE machine_id = ? AND project_id = ? AND area = ?")?.execute(params![
                    lease.project_ref.machine_id.as_str(),
                    lease.project_ref.project_id.as_str(),
                    lease.area.as_str()
                ])?;
                Ok(())
            })?;
        }
        Ok(stale.len())
    }
}

/// Epoch ms of an ISO timestamp as the hub writes them (`YYYY-MM-DDTHH:MM:SS.mmmZ`), like `Date.parse`.
pub(crate) fn parse_iso_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' {
        return None;
    }
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, sec) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    let ms = if b.get(19) == Some(&b'.') { s.get(20..23).and_then(|f| f.parse::<i64>().ok()).unwrap_or(0) } else { 0 };
    // Howard Hinnant's days_from_civil.
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400_000 + h * 3_600_000 + mi * 60_000 + sec * 1000 + ms)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::hub::store::test_clock::ManualClock;

    /// 2026-10-17T10:00:00.000Z
    const NOW_MS: u64 = 1_792_231_200_000;

    fn project(p: &str) -> ProjectRef {
        ProjectRef { machine_id: MachineId::unchecked("lab-a"), project_id: ProjectId::unchecked(p) }
    }
    fn t(n: u32) -> TaskId {
        TaskId::unchecked(format!("T{n}"))
    }
    fn areas(names: &[&str]) -> Vec<AreaName> {
        names.iter().map(|n| AreaName::unchecked(*n)).collect()
    }

    struct Kit {
        leases: Arc<Leases>,
        events: Arc<EventLog>,
        clock: Arc<ManualClock>,
    }

    fn kit() -> Kit {
        let db = HubDb::open_memory().unwrap();
        let clock = ManualClock::at(NOW_MS);
        let events = Arc::new(EventLog::new(db.clone(), clock.clone()).unwrap());
        Kit { leases: Leases::new(db, events.clone(), clock.clone()), events, clock }
    }

    impl Kit {
        fn take(&self, p: &str, n: u32, names: &[&str]) -> Grant {
            self.leases.acquire(&project(p), &t(n), &areas(names)).unwrap()
        }
        fn held(&self, n: u32) -> Vec<String> {
            let filter = LeaseFilter { task_id: Some(t(n)), ..Default::default() };
            self.leases.list(&filter).unwrap().into_iter().map(|l| l.area.as_str().to_owned()).collect()
        }
    }

    fn queued(reason: &str) -> Grant {
        Grant::Queued(reason.to_owned())
    }

    #[test]
    fn takes_all_areas_or_none_so_crossing_requests_cannot_deadlock() {
        let k = kit();
        assert_eq!(k.take("pa", 1, &["docs", "hub"]), Grant::Granted);
        assert_eq!(k.held(1), ["docs", "hub"]);
        // T2 wants the same areas in the other order, plus a free one: it gets nothing, not even "web".
        assert_eq!(k.take("pa", 2, &["hub", "web", "docs"]), queued("lease: hub held by T1, docs held by T1"));
        assert!(k.held(2).is_empty());
        // So a third task can still take the free area.
        assert_eq!(k.take("pa", 3, &["web"]), Grant::Granted);
        assert_eq!(k.take("pa", 2, &["hub", "web", "docs"]), queued("lease: hub held by T1, web held by T3, docs held by T1"));
        let released: Vec<String> = k.leases.release(&t(1)).unwrap().into_iter().map(|l| l.area.as_str().to_owned()).collect();
        assert_eq!(released, ["docs", "hub"]);
        assert_eq!(k.take("pa", 2, &["hub", "web", "docs"]), queued("lease: web held by T3"));
        k.leases.release(&t(3)).unwrap();
        assert_eq!(k.take("pa", 2, &["hub", "web", "docs"]), Grant::Granted);
        assert_eq!(k.held(2), ["docs", "hub", "web"]);
    }

    #[test]
    fn exclusive_per_project_idempotent_for_the_holder_and_oldest_first() {
        let k = kit();
        k.take("pa", 1, &["docs"]);
        k.clock.advance(Duration::from_secs(60));
        assert_eq!(k.take("pb", 2, &["docs"]), Grant::Granted);
        // Asking again, or for a superset, keeps what T1 has.
        assert_eq!(k.take("pa", 1, &["docs"]), Grant::Granted);
        assert_eq!(k.take("pa", 1, &["docs", "hub"]), Grant::Granted);
        let all: Vec<String> = k
            .leases
            .list(&LeaseFilter::default())
            .unwrap()
            .iter()
            .map(|l| format!("{}:{}:{}:{}", l.project_ref.project_id.as_str(), l.area.as_str(), l.task_id.as_str(), l.since.as_str()))
            .collect();
        assert_eq!(all, ["pa:docs:T1:2026-10-17T10:00:00.000Z", "pb:docs:T2:2026-10-17T10:01:00.000Z", "pa:hub:T1:2026-10-17T10:01:00.000Z"]);
        let in_b = LeaseFilter { project_ref: Some(project("pb")), ..Default::default() };
        assert_eq!(k.leases.list(&in_b).unwrap().iter().map(|l| l.task_id.as_str().to_owned()).collect::<Vec<_>>(), ["T2"]);
        assert!(k.leases.release(&t(9)).unwrap().is_empty());
    }

    #[test]
    fn flags_a_lease_held_over_4_h_once_and_keeps_it() {
        let k = kit();
        k.take("pa", 1, &["docs"]);
        k.clock.advance(Duration::from_secs(4 * 3600));
        assert_eq!(k.leases.flag_stale().unwrap(), 0);
        k.clock.advance(Duration::from_secs(60));
        assert_eq!(k.leases.flag_stale().unwrap(), 1);
        assert_eq!(k.leases.flag_stale().unwrap(), 0);
        let stale = k.events.page(0, Some(&[HubEventType::LeaseStale]), None).unwrap().events;
        assert_eq!(stale.len(), 1);
        assert_eq!(stale[0].summary.as_str(), "Lease on docs in pa held by T1 for 4 h; still held");
        assert_eq!(stale[0].project_id.as_ref().map(|p| p.as_str()), Some("pa"));
        assert_eq!(stale[0].data, Some(serde_json::json!({ "taskId": "T1", "area": "docs", "since": "2026-10-17T10:00:00.000Z" })));
        assert_eq!(k.leases.list(&LeaseFilter::default()).unwrap().len(), 1);
    }

    #[test]
    fn parses_hub_timestamps_like_date_parse() {
        assert_eq!(parse_iso_ms("2026-10-17T10:00:00.000Z"), Some(NOW_MS as i64));
        assert_eq!(iso_ms(parse_iso_ms("2024-02-29T23:59:59.999Z").unwrap()), "2024-02-29T23:59:59.999Z");
    }
}
