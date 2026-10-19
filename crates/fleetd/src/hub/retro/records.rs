//! Retro runs and proposals in the hub database (`retro_runs`, `retro_proposals`, migration 0013).
//! No logic beyond storage.
use super::types::{RetroProposal, RetroRun};
use rusqlite::{Connection, OptionalExtension, Row, params};

/// The store's `HubDb::with`, as a trait the retro holds: runs `f` on the hub's one connection.
pub trait SqlRunner: Send + Sync {
    fn run(&self, f: &mut dyn FnMut(&Connection) -> rusqlite::Result<()>) -> Result<(), String>;
}

fn q<R>(db: &dyn SqlRunner, f: impl FnOnce(&Connection) -> rusqlite::Result<R>) -> R {
    let mut f = Some(f);
    let mut out = None;
    let result = db.run(&mut |c| {
        out = Some((f.take().expect("runs once"))(c)?);
        Ok(())
    });
    match (result, out) {
        (Ok(()), Some(v)) => v,
        (r, _) => panic!("retro records: {r:?}"),
    }
}

/// In a write transaction, so a concurrent writer waits instead of interleaving.
fn tx<R>(db: &dyn SqlRunner, f: impl FnOnce(&Connection) -> rusqlite::Result<R>) -> R {
    q(db, |c| {
        c.execute_batch("BEGIN IMMEDIATE")?;
        match f(c) {
            Ok(v) => {
                c.execute_batch("COMMIT")?;
                Ok(v)
            }
            Err(e) => {
                let _ = c.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    })
}

#[derive(Clone, Debug)]
pub struct StoredProposal {
    pub proposal: RetroProposal,
    /// Machines of the incidents it cites: a key sees the proposal only with read on all of them.
    pub machines: Vec<String>,
    /// The override file a wording change replaced: `Some(None)` when the bundled playbook was in use, `None` before
    /// it applies.
    pub previous_override: Option<Option<String>>,
}

/// States in which a proposal still holds its playbook: no other change to it may start.
pub const HOLDING: [&str; 2] = ["pending", "measuring"];

fn n_of(id: &str) -> i64 {
    id.get(1..).and_then(|n| n.parse().ok()).unwrap_or(0)
}

fn stored(row: &Row) -> rusqlite::Result<StoredProposal> {
    let data: String = row.get("data")?;
    let machines: String = row.get("machines")?;
    let had: Option<i64> = row.get("had_override")?;
    let previous: Option<String> = row.get("previous_override")?;
    Ok(StoredProposal {
        proposal: serde_json::from_str(&data)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?,
        machines: serde_json::from_str(&machines).unwrap_or_default(),
        previous_override: had.map(|h| {
            if h == 1 {
                Some(previous.unwrap_or_default())
            } else {
                None
            }
        }),
    })
}

fn json<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_string(v).expect("serialisable")
}

pub struct RetroRecords<'a>(pub &'a dyn SqlRunner);

impl RetroRecords<'_> {
    /// Numbers a run as it starts.
    pub fn begin_run(&self, at_ms: i64, trigger: &str, threshold_class: Option<&str>) -> u64 {
        q(self.0, |c| {
            c.query_row(
                "INSERT INTO retro_runs (at_ms, trigger, threshold_class, data) VALUES (?, ?, ?, '') RETURNING n",
                params![at_ms, trigger, threshold_class],
                |r| r.get::<_, i64>(0),
            )
        }) as u64
    }

    pub fn finish_run(&self, run: &RetroRun, turned: bool) {
        q(self.0, |c| {
            c.execute(
                "UPDATE retro_runs SET data = ?, turned = ? WHERE n = ?",
                params![json(run), turned as i64, run.run as i64],
            )
        });
    }

    pub fn latest_run(&self) -> Option<RetroRun> {
        let data: Option<String> = q(self.0, |c| {
            c.query_row(
                "SELECT data FROM retro_runs WHERE data != '' ORDER BY n DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional()
        });
        data.and_then(|d| serde_json::from_str(&d).ok())
    }

    /// Start times of runs that spent a claude turn after `since_ms`, oldest first.
    pub fn turned_since(&self, since_ms: i64) -> Vec<i64> {
        q(self.0, |c| {
            let mut s = c.prepare(
                "SELECT at_ms FROM retro_runs WHERE turned = 1 AND at_ms > ? ORDER BY at_ms",
            )?;
            s.query_map([since_ms], |r| r.get(0))?.collect()
        })
    }

    /// A threshold run for `class` started since `since_ms`.
    pub fn threshold_since(&self, class: &str, since_ms: i64) -> bool {
        q(self.0, |c| {
            c.query_row(
                "SELECT 1 FROM retro_runs WHERE trigger = 'threshold' AND threshold_class = ? AND at_ms >= ? LIMIT 1",
                params![class, since_ms],
                |_| Ok(()),
            )
            .optional()
        })
        .is_some()
    }

    /// Stores a new proposal; `proposal_id` is assigned (`R<n>`).
    pub fn insert(&self, mut proposal: RetroProposal, machines: &[String]) -> RetroProposal {
        tx(self.0, |c| {
            let n: i64 = c.query_row(
                "INSERT INTO retro_proposals (run_n, playbook, state, machines, data) VALUES (?, ?, ?, ?, '') RETURNING n",
                params![proposal.run as i64, proposal.playbook, proposal.state, json(&machines)],
                |r| r.get(0),
            )?;
            proposal.proposal_id = format!("R{n}");
            c.execute(
                "UPDATE retro_proposals SET state = ?, due_ms = ?, data = ? WHERE n = ?",
                params![proposal.state, Option::<i64>::None, json(&proposal), n],
            )?;
            Ok(proposal)
        })
    }

    /// `previous_override` is stored when given (`Some`), kept otherwise.
    pub fn put(&self, proposal: &RetroProposal, previous_override: Option<Option<&str>>) {
        tx(self.0, |c| {
            let n = n_of(&proposal.proposal_id);
            let due = (proposal.state == "measuring")
                .then(|| {
                    proposal
                        .due_at
                        .as_deref()
                        .and_then(crate::hub::usage::time::parse_ms)
                })
                .flatten();
            c.execute(
                "UPDATE retro_proposals SET state = ?, due_ms = ?, data = ? WHERE n = ?",
                params![proposal.state, due, json(proposal), n],
            )?;
            if let Some(prev) = previous_override {
                c.execute(
                    "UPDATE retro_proposals SET had_override = ?, previous_override = ? WHERE n = ?",
                    params![prev.is_some() as i64, prev, n],
                )?;
            }
            Ok(())
        })
    }

    /// Newest first.
    pub fn list(
        &self,
        states: Option<&[&str]>,
        run: Option<u64>,
        limit: usize,
    ) -> Vec<StoredProposal> {
        let states = states.map(|s| json(&s));
        q(self.0, |c| {
            let mut s = c.prepare(
                "SELECT * FROM retro_proposals WHERE (?1 IS NULL OR state IN (SELECT value FROM json_each(?1)))
                   AND (?2 IS NULL OR run_n = ?2) ORDER BY n DESC LIMIT ?3",
            )?;
            s.query_map(params![states, run.map(|r| r as i64), limit as i64], stored)?
                .collect()
        })
    }

    /// Measuring proposals whose window ended by `now_ms`, oldest due first.
    pub fn due(&self, now_ms: i64) -> Vec<StoredProposal> {
        q(self.0, |c| {
            let mut s = c.prepare("SELECT * FROM retro_proposals WHERE state = 'measuring' AND due_ms <= ? ORDER BY due_ms, n")?;
            s.query_map([now_ms], stored)?.collect()
        })
    }

    pub fn next_due_ms(&self) -> Option<i64> {
        q(self.0, |c| {
            c.query_row(
                "SELECT MIN(due_ms) FROM retro_proposals WHERE state = 'measuring'",
                [],
                |r| r.get(0),
            )
        })
    }
}
