//! Landed changes folded out of the event log, shaped like the time projector: it walks the log in seq order from
//! `time_cursors('metrics:events')` and wakes on the log's append notification; a replay writes the same rows.
//!
//! - `pr.merged`: a `train` row, timed from its order's request.
//! - `pr.merged_outside`: `fleetd_by_hand` when fleetd wrote it (a Change, or a `fleetd/` head), else `outside`; a
//!   bot's PR is kept as skipped.
//! - `change.state`: the first move to `ready` is when its review passed.
//! - `workstream.created`: the order's request time, for rows that landed before it was known.
//! - the person's acts on fleetd's surfaces, and their merges by hand, as touches (`touches.rs`).
//!
//! What a fold needs from the other areas' tables (the Change, the order, the train) is read before the transaction,
//! as `leads::requested` reads on its own connection.
use std::sync::Arc;

use fleetd_contracts::events::{HubEvent, HubEventType, TrainEventData};
use fleetd_contracts::ledger::Workstream;
use fleetd_contracts::metrics::{ActorKind, MergeRoute, SkipWhy};
use fleetd_contracts::status::ChangeStateData;
use fleetd_contracts::train::{Change, ChangeState};
use rusqlite::{Connection, OptionalExtension, params};

use super::store::{self, MergeRow};
use super::touches;
use crate::hub::api::Hub;
use crate::hub::leads::requested;
use crate::hub::store::{HubDb, StoreError, parse_ms};

const CURSOR: &str = "metrics:events";
const TYPES: [HubEventType; 8] = [
    HubEventType::PrMerged,
    HubEventType::PrMergedOutside,
    HubEventType::ChangeState,
    HubEventType::WorkstreamCreated,
    HubEventType::ChatMessage,
    HubEventType::RequestUpdated,
    HubEventType::SteerQueued,
    HubEventType::DecisionRecorded,
];
/// The branches fleetd's write tasks push: `fleetd/T<n>-…`.
const FLEETD_BRANCH: &str = "fleetd/";

pub async fn run(hub: Arc<Hub>) {
    let mut head = hub.events.subscribe();
    let mut cursor = hub
        .db
        .with(|c| crate::hub::time::store::cursor(c, CURSOR))
        .ok()
        .flatten()
        .unwrap_or(0);
    loop {
        head.borrow_and_update();
        match step(&hub.db, &hub.events, cursor) {
            Ok((next, more)) => {
                cursor = next;
                if more {
                    continue;
                }
            }
            Err(e) => {
                tracing::error!(error = %e, "metrics: events not projected");
                tokio::select! {
                    () = hub.shutdown.wait() => return,
                    () = hub.clock.sleep(std::time::Duration::from_secs(5)) => {}
                }
                continue;
            }
        }
        tokio::select! {
            () = hub.shutdown.wait() => return,
            changed = head.changed() => if changed.is_err() { return },
        }
    }
}

/// Projects one page after `cursor`: (the cursor to resume from, whether more pages are ready).
pub fn step(
    db: &HubDb,
    events: &crate::hub::store::EventLog,
    cursor: i64,
) -> Result<(i64, bool), StoreError> {
    let page = events.page(cursor, Some(&TYPES), None)?;
    if page.events.is_empty() && page.cursor == cursor {
        return Ok((cursor, page.more));
    }
    let mut folds = Vec::new();
    for e in &page.events {
        let fold = resolve(db, e)?;
        if let Some(Fold::Merge(m)) = &fold {
            folds.extend(touches::merged_by_hand(m).map(|t| Fold::Touch(Box::new(t))));
        }
        folds.extend(fold);
        folds.extend(touches::of_event(db, e)?.map(|t| Fold::Touch(Box::new(t))));
    }
    let first_ms = page.events.first().and_then(|e| parse_ms(e.at.as_str()));
    db.transaction(|c| {
        if cursor == 0 {
            known_since(c, first_ms)?;
        }
        for fold in &folds {
            write(c, fold)?;
        }
        // A catch-up beside the loop may have saved a later cursor: never move it back.
        let saved = crate::hub::time::store::cursor(c, CURSOR)?.unwrap_or(0);
        crate::hub::time::store::set_cursor(c, CURSOR, page.cursor.max(saved))
    })?;
    Ok((page.cursor, page.more))
}

/// Folds one page past the stored cursor now, for a reader that must not lag the event that woke it: Status reads
/// its row right after `pr.merged`, maybe before [`run`] has folded it. Safe beside [`run`], as a replay writes the
/// same rows; a longer backlog is left to [`run`].
pub fn catch_up(db: &HubDb, events: &crate::hub::store::EventLog) -> Result<(), StoreError> {
    let cursor = db.with(|c| crate::hub::time::store::cursor(c, CURSOR))?;
    step(db, events, cursor.unwrap_or(0)).map(drop)
}

/// Merges are known from the oldest event the projector's first pass found (the log keeps 30 days).
fn known_since(c: &Connection, first_ms: Option<i64>) -> Result<(), StoreError> {
    let oldest: Option<i64> =
        c.query_row("SELECT MIN(created_ms) FROM events", [], |r| r.get(0))?;
    if let Some(ms) = oldest.or(first_ms) {
        c.execute(
            "INSERT OR IGNORE INTO time_cursors (source, value) VALUES (?1, ?2)",
            params![store::KNOWN_SINCE, ms],
        )?;
    }
    Ok(())
}

/// One event's effect on the tables.
#[derive(Debug, PartialEq)]
enum Fold {
    Merge(Box<MergeRow>),
    Review {
        change_id: String,
        at_ms: i64,
    },
    Requested {
        workstream_id: String,
        at_ms: i64,
        basis: &'static str,
    },
    Touch(Box<store::TouchRow>),
}

pub(super) fn data<T: serde::de::DeserializeOwned>(e: &HubEvent) -> Option<T> {
    let decoded = e.data.clone().map(serde_json::from_value).transpose();
    decoded.unwrap_or_else(|error| {
        tracing::warn!(seq = e.seq.get(), %error, "metrics: event data not read");
        None
    })
}

fn resolve(db: &HubDb, e: &HubEvent) -> Result<Option<Fold>, StoreError> {
    let at = parse_ms(e.at.as_str()).unwrap_or(0);
    Ok(match e.r#type {
        HubEventType::PrMerged | HubEventType::PrMergedOutside => {
            let Some(d) = data::<TrainEventData>(e) else {
                return Ok(None);
            };
            merge(db, e, &d, at)?.map(|m| Fold::Merge(Box::new(m)))
        }
        HubEventType::ChangeState => data::<ChangeStateData>(e)
            .filter(|d| d.to == ChangeState::Ready)
            .map(|d| Fold::Review {
                change_id: d.change_id.to_string(),
                at_ms: at,
            }),
        HubEventType::WorkstreamCreated => {
            let Some(w) = e
                .data
                .as_ref()
                .and_then(|d| d.get("workstreamId"))
                .and_then(|v| v.as_str())
            else {
                return Ok(None);
            };
            workstream(db, w)?
                .map(|w| requested::get(db, &w).map(|r| (w, r)))
                .transpose()?
                .map(|(w, r)| Fold::Requested {
                    workstream_id: w.workstream_id.to_string(),
                    at_ms: r.at_ms,
                    basis: r.basis.as_str(),
                })
        }
        _ => None,
    })
}

fn actor(kind: Option<ActorKind>) -> Option<String> {
    kind.map(|k| actor_str(k).to_owned())
}

pub fn actor_str(k: ActorKind) -> &'static str {
    match k {
        ActorKind::Human => "human",
        ActorKind::Bot => "bot",
        ActorKind::Train => "train",
        ActorKind::Unknown => "unknown",
    }
}

/// The row a train merge or an outside merge makes.
fn merge(
    db: &HubDb,
    e: &HubEvent,
    d: &TrainEventData,
    at: i64,
) -> Result<Option<MergeRow>, StoreError> {
    let (Some(repo), Some(pr)) = (&d.repo, d.pr_number) else {
        return Ok(None);
    };
    let train = e.r#type == HubEventType::PrMerged;
    let change = match &d.change_id {
        Some(id) => change(db, id.as_str())?,
        None => None,
    };
    // A fleetd branch names its task: `fleetd/T12-…`.
    let head_task = d
        .head
        .as_deref()
        .and_then(|h| h.strip_prefix(FLEETD_BRANCH))
        .and_then(|rest| {
            let n: String = rest
                .strip_prefix('T')?
                .chars()
                .take_while(char::is_ascii_digit)
                .collect();
            (!n.is_empty()).then(|| format!("T{n}"))
        });
    let fleetd = change.is_some()
        || d.change_id.is_some()
        || d.head
            .as_deref()
            .is_some_and(|h| h.starts_with(FLEETD_BRANCH));
    let task_id = d
        .task_id
        .as_ref()
        .map(|t| t.to_string())
        .or_else(|| {
            change
                .as_ref()
                .and_then(|c| c.task_id.as_ref())
                .map(|t| t.to_string())
        })
        .or(head_task);
    let workstream_id = d
        .workstream_id
        .as_ref()
        .map(|w| w.to_string())
        .or_else(|| change.as_ref().map(|c| c.workstream_id.to_string()));
    let workstream_id = match (workstream_id, &task_id) {
        (Some(w), _) => Some(w),
        (None, Some(t)) if fleetd => task_workstream(db, t)?,
        _ => None,
    };
    let (route, skip_why) = if train {
        (MergeRoute::Train.as_str(), None)
    } else if d.author_kind == Some(ActorKind::Bot) {
        (store::SKIPPED, Some(skip_str(SkipWhy::Bot)))
    } else if fleetd {
        (MergeRoute::FleetdByHand.as_str(), None)
    } else {
        (MergeRoute::Outside.as_str(), None)
    };
    let requested = match workstream_id.as_deref() {
        Some(w) if fleetd || train => workstream(db, w)?
            .map(|w| requested::get(db, &w))
            .transpose()?,
        _ => None,
    };
    let remote = store::github_remote(repo.as_str());
    // The project that owns it: the train's owner, else its Change's, else the event's.
    let owner = train_owner(db, repo.as_str())?
        .or_else(|| {
            change.as_ref().map(|c| {
                (
                    c.project_ref.machine_id.to_string(),
                    c.project_ref.project_id.to_string(),
                )
            })
        })
        .or_else(|| {
            e.machine_id
                .as_ref()
                .zip(e.project_id.as_ref())
                .map(|(m, p)| (m.to_string(), p.to_string()))
        });
    let (machine_id, project_id) = owner.unzip();
    Ok(Some(MergeRow {
        unit_key: format!("pr:{}", pr.get()),
        machine_id,
        project_id,
        pr_number: Some(pr.get()),
        merged_ms: d
            .merged_at
            .as_ref()
            .and_then(|t| parse_ms(t.as_str()))
            .unwrap_or(at),
        merged_sha: d.merged_sha.as_deref().map(str::to_lowercase).or_else(|| {
            change
                .as_ref()
                .and_then(|c| c.merged_sha.as_ref())
                .map(|s| s.to_string())
        }),
        route: route.to_owned(),
        skip_why: skip_why.map(str::to_owned),
        workstream_id: workstream_id.filter(|_| fleetd || train),
        task_id: task_id.filter(|_| fleetd || train),
        change_id: d.change_id.as_ref().map(|c| c.to_string()),
        batch_pr: d.batch_pr.map(|n| n.get()),
        requested_ms: requested.map(|r| r.at_ms),
        requested_basis: requested.map(|r| r.basis.as_str().to_owned()),
        pr_created_ms: d.pr_created_at.as_ref().and_then(|t| parse_ms(t.as_str())),
        // A Change is made when its PR is enqueued, right after the task opens it.
        first_pr_ms: change
            .as_ref()
            .and_then(|c| parse_ms(c.created_at.as_str())),
        author_kind: actor(d.author_kind),
        merged_by_kind: if train {
            Some(actor_str(ActorKind::Train).to_owned())
        } else {
            actor(d.merged_by_kind)
        },
        url: d
            .pr_url
            .clone()
            .or_else(|| change.as_ref().map(|c| c.pr_url.to_string()))
            .or_else(|| Some(format!("https://{remote}/pull/{}", pr.get()))),
        repo: remote,
        src: "event".into(),
        ..MergeRow::default()
    }))
}

pub fn skip_str(why: SkipWhy) -> &'static str {
    match why {
        SkipWhy::Bot => "bot",
        SkipWhy::OtherBase => "other_base",
        SkipWhy::MergeBack => "merge_back",
        SkipWhy::Unknown => "unknown",
    }
}

fn write(c: &Connection, fold: &Fold) -> Result<(), StoreError> {
    match fold {
        Fold::Merge(m) => {
            let mut m = (**m).clone();
            if let Some(id) = &m.change_id {
                m.review_passed_ms = store::review_passed(c, id)?;
            }
            store::see_repo(c, &m.repo, "github")?;
            store::upsert_merge(c, &m)
        }
        Fold::Review { change_id, at_ms } => store::stamp_review(c, change_id, *at_ms),
        Fold::Requested {
            workstream_id,
            at_ms,
            basis,
        } => store::set_requested(c, workstream_id, *at_ms, basis),
        Fold::Touch(t) => store::upsert_touch(c, t),
    }
}

fn number(id: &str) -> i64 {
    id.get(1..).and_then(|n| n.parse().ok()).unwrap_or(-1)
}

fn change(db: &HubDb, id: &str) -> Result<Option<Change>, StoreError> {
    let data: Option<String> = db.with(|c| {
        Ok(
            c.query_row("SELECT data FROM changes WHERE n = ?1", [number(id)], |r| {
                r.get(0)
            })
            .optional()?,
        )
    })?;
    Ok(data.and_then(|d| serde_json::from_str(&d).ok()))
}

fn workstream(db: &HubDb, id: &str) -> Result<Option<Workstream>, StoreError> {
    let data: Option<String> = db.with(|c| {
        Ok(c.query_row(
            "SELECT data FROM workstreams WHERE n = ?1",
            [number(id)],
            |r| r.get(0),
        )
        .optional()?)
    })?;
    Ok(data.and_then(|d| serde_json::from_str(&d).ok()))
}

fn task_workstream(db: &HubDb, task: &str) -> Result<Option<String>, StoreError> {
    db.with(|c| {
        Ok(c.query_row(
            "SELECT workstream_id FROM tasks WHERE n = ?1",
            [number(task)],
            |r| r.get(0),
        )
        .optional()?)
    })
}

fn train_owner(db: &HubDb, repo: &str) -> Result<Option<(String, String)>, StoreError> {
    db.with(|c| {
        Ok(c.query_row(
            "SELECT machine_id, project_id FROM trains WHERE repo = ?1",
            [repo.to_lowercase()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?)
    })
}
