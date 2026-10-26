//! When the human asked for an order, for the time from order to merged. A submitted order was asked for when it was
//! submitted. One the lead opens was asked for at the earliest human chat message its run took in, stamped as it
//! opens; with none (the lead opened it on its own), it is when it opened, and says so.
use fleetd_contracts::ids::{ProjectRef, ThreadId};
use fleetd_contracts::ledger::{IntakeChannel, Workstream};
use rusqlite::{OptionalExtension, named_params, params};

use crate::hub::store::{HubDb, StoreError, parse_ms};

/// The event log keeps 30 days: a run that ended before then left no event, and no message it took in is newer.
const LOG_KEPT_MS: i64 = 30 * 24 * 60 * 60 * 1000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RequestedBasis {
    /// Submitted by the app or MCP: its `source.at`.
    Source,
    /// Opened by the lead: the earliest human chat message of the run that opened it.
    Chat,
    /// Opened by the lead with no human message to go by: when it opened, later than the ask by the lead's turn.
    Opened,
}

impl RequestedBasis {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Source => "source",
            Self::Chat => "chat",
            Self::Opened => "opened",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "source" => Self::Source,
            "chat" => Self::Chat,
            "opened" => Self::Opened,
            _ => return None,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Requested {
    pub at_ms: i64,
    pub basis: RequestedBasis,
}

fn number(w: &Workstream) -> i64 {
    w.workstream_id.as_str()[1..].parse().unwrap_or(0)
}

/// The `created_at` of the earliest human chat message the lead's running turn took in: one written since the
/// project's lead last ended a run, or the one sent with `now` that interrupted it. A message written during an
/// earlier run went to that run.
pub fn run_human_ms(
    db: &HubDb,
    r: &ProjectRef,
    thread: &ThreadId,
    now_ms: i64,
) -> Result<Option<i64>, StoreError> {
    db.with(|c| {
        let p = named_params! {
            "$machine": r.machine_id.as_str(),
            "$project": r.project_id.as_str(),
            "$thread": thread.as_str(),
            "$now": now_ms,
        };
        // The lead's earlier threads count too: a fresh lead's first run follows the old one's last.
        let ends: Vec<(i64, String)> = c
            .prepare_cached(
                "SELECT created_ms, type FROM events
                 WHERE type IN ('thread.completed', 'thread.failed', 'thread.interrupted', 'thread.usage_limited')
                   AND machine_id = $machine AND created_ms <= $now
                   AND json_extract(data, '$.threadId') IN (
                     SELECT $thread UNION SELECT json_extract(data, '$.threadId') FROM events
                     WHERE type = 'lead.started' AND machine_id = $machine
                       AND json_extract(data, '$.projectId') = $project)
                 ORDER BY seq DESC LIMIT 2",
            )?
            .query_map(p, |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let floor = ends.get(1).map_or(now_ms - LOG_KEPT_MS, |e| e.0);
        let (since, interrupted) = ends
            .first()
            .map_or((floor, false), |e| (e.0, e.1 == "thread.interrupted"));
        let messages: Vec<(i64, Option<String>)> = c
            .prepare_cached(
                "SELECT created_ms, json_extract(data, '$.delivery') FROM chat_messages
                 WHERE machine_id = ?1 AND project_id = ?2 AND created_ms > ?3 AND created_ms <= ?4 AND held = 0
                   AND json_extract(data, '$.author') = 'human' AND json_extract(data, '$.history') IS NULL
                   AND json_extract(data, '$.delivery') IS NOT NULL
                 ORDER BY seq",
            )?
            .query_map(
                params![r.machine_id.as_str(), r.project_id.as_str(), floor, now_ms],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?
            .collect::<rusqlite::Result<_>>()?;
        Ok(messages
            .into_iter()
            .find(|(at, delivery)| {
                *at > since || (interrupted && delivery.as_deref() == Some("now"))
            })
            .map(|(at, _)| at))
    })
}

/// Stamps a lead-opened order with when it was asked for.
pub fn set(db: &HubDb, w: &Workstream, requested: Requested) -> Result<(), StoreError> {
    db.with(|c| {
        c.execute(
            "UPDATE workstreams SET requested_ms = ?1, requested_basis = ?2 WHERE n = ?3",
            params![requested.at_ms, requested.basis.as_str(), number(w)],
        )?;
        Ok(())
    })
}

/// When the order was asked for: its stamp, else when it was submitted, else (a lead's from before the stamp) when it
/// opened.
pub fn get(db: &HubDb, w: &Workstream) -> Result<Requested, StoreError> {
    let stamp: Option<(Option<i64>, Option<String>)> = db.with(|c| {
        Ok(c.query_row(
            "SELECT requested_ms, requested_basis FROM workstreams WHERE n = ?",
            [number(w)],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?)
    })?;
    if let Some((Some(at_ms), Some(basis))) = stamp
        && let Some(basis) = RequestedBasis::parse(&basis)
    {
        return Ok(Requested { at_ms, basis });
    }
    let (at, basis) = match w.source.channel {
        IntakeChannel::Lead => (&w.created_at, RequestedBasis::Opened),
        IntakeChannel::App | IntakeChannel::Mcp | IntakeChannel::Automation => {
            (&w.source.at, RequestedBasis::Source)
        }
    };
    Ok(Requested {
        at_ms: parse_ms(at.as_str()).unwrap_or(0),
        basis,
    })
}
