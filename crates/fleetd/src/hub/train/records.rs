//! Changes, trains and reported bypasses in the hub database. Repos are keyed lowercased.
use std::sync::Arc;

use rusqlite::{Connection, OptionalExtension, params};

use super::contract::{
    Change, ChangeId, ChangeState, GitHubRepo, MachineId, ProjectId, ProjectRef, TrainState,
    parse_state, state_str,
};
use fleetd_contracts::prim::UniqueList;

use crate::hub::store::HubDb;

pub type Db = Arc<HubDb>;

/// Runs `f` on the hub's connection. The hub treats its own database as infallible.
pub fn sql<R>(db: &HubDb, f: impl FnOnce(&Connection) -> R) -> R {
    let mut out = None;
    db.with(|conn| {
        out = Some(f(conn));
        Ok(())
    })
    .expect("hub database");
    out.expect("ran")
}

/// States a Change waits in, in its train's queue.
pub const QUEUED_STATES: &[ChangeState] = &[
    ChangeState::Queued,
    ChangeState::Reviewing,
    ChangeState::Ready,
];
/// States of the Change the train is working on.
pub const HEAD_STATES: &[ChangeState] =
    &[ChangeState::Rebasing, ChangeState::Ci, ChangeState::Merging];
/// No way back from these; a new enqueue of the PR makes a new Change.
pub const TERMINAL_STATES: &[ChangeState] = &[
    ChangeState::Merged,
    ChangeState::Refused,
    ChangeState::Abandoned,
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrainRow {
    pub repo: String,
    pub project_ref: ProjectRef,
    pub frozen: bool,
    /// Merges after this are checked for bypasses.
    pub watch_since_ms: i64,
}

#[derive(Clone, Debug, Default)]
pub struct ListFilter {
    pub project_ref: Option<ProjectRef>,
    pub repo: Option<String>,
    pub state: Option<ChangeState>,
    pub limit: i64,
}

#[derive(Clone)]
pub struct ChangeRecords {
    db: Db,
}

fn number_of(change_id: &ChangeId) -> i64 {
    change_id.as_str()[1..].parse().unwrap_or(0)
}

fn decode(data: &str) -> Change {
    serde_json::from_str(data).expect("a stored Change decodes")
}

fn encode(change: &Change) -> String {
    serde_json::to_string(change).expect("a Change encodes")
}

fn to_train(row: &rusqlite::Row<'_>) -> rusqlite::Result<TrainRow> {
    Ok(TrainRow {
        repo: row.get("repo")?,
        project_ref: ProjectRef {
            machine_id: MachineId::unchecked(row.get::<_, String>("machine_id")?),
            project_id: ProjectId::unchecked(row.get::<_, String>("project_id")?),
        },
        frozen: row.get::<_, i64>("frozen")? == 1,
        watch_since_ms: row.get("watch_since_ms")?,
    })
}

impl ChangeRecords {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    pub fn db(&self) -> &HubDb {
        &self.db
    }

    /// Numbers it (`X<n>`) and stores it at the back of its repo's train. `change.change_id` is ignored.
    pub fn create(&self, change: Change) -> Change {
        self.db
            .transaction(|tx| Ok(self.create_in(tx, change)))
            .expect("hub database")
    }

    fn create_in(&self, tx: &Connection, mut change: Change) -> Change {
        let repo = change.repo.to_lowercase();
        let pr_number = change.pr_number.get();
        let n: i64 = tx
            .query_row(
                "INSERT INTO changes (repo, pr_number, state, machine_id, project_id, train_order, data)
                 VALUES (?1, ?2, ?3, ?4, ?5, (SELECT COALESCE(MAX(train_order), 0) + 1 FROM changes WHERE repo = ?1), '') RETURNING n",
                params![repo, pr_number, state_str(change.state), change.project_ref.machine_id.as_str(), change.project_ref.project_id.as_str()],
                |r| r.get(0),
            )
            .expect("insert change");
        change.repo = GitHubRepo::unchecked(repo);
        change.change_id = ChangeId::unchecked(format!("X{n}"));
        tx.execute(
            "UPDATE changes SET state = ?1, data = ?2 WHERE n = ?3",
            params![state_str(change.state), encode(&change), n],
        )
        .expect("put change");
        change
    }

    pub fn put(&self, change: &Change) {
        sql(&self.db, |conn| {
            conn.execute(
                "UPDATE changes SET state = ?1, data = ?2 WHERE n = ?3",
                params![
                    state_str(change.state),
                    encode(change),
                    number_of(&change.change_id)
                ],
            )
            .expect("put change")
        });
    }

    pub fn get(&self, change_id: &ChangeId) -> Option<Change> {
        sql(&self.db, |conn| {
            conn.query_row(
                "SELECT data FROM changes WHERE n = ?1",
                [number_of(change_id)],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .expect("get change")
        })
        .map(|d| decode(&d))
    }

    /// Sets the Change's `lastError` and nothing else, in one statement, so a note never overwrites a state the
    /// train wrote meanwhile.
    pub fn note(&self, change_id: &ChangeId, text: &str) {
        let text: String = text.chars().take(2000).collect();
        sql(&self.db, |conn| {
            conn.execute(
                "UPDATE changes SET data = json_set(data, '$.lastError', ?1) WHERE n = ?2",
                params![text, number_of(change_id)],
            )
            .expect("note change")
        });
    }

    fn latest(&self, repo: &str, pr_number: i64, open: bool) -> Option<Change> {
        sql(&self.db, |conn| {
            let mut stmt = conn.prepare_cached("SELECT data, state FROM changes WHERE repo = ?1 AND pr_number = ?2 ORDER BY n DESC").expect("prepare");
            let rows = stmt
                .query_map(params![repo.to_lowercase(), pr_number], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })
                .expect("query");
            for row in rows {
                let (data, state) = row.expect("row");
                let terminal = parse_state(&state).is_some_and(|s| TERMINAL_STATES.contains(&s));
                if !open || !terminal {
                    return Some(decode(&data));
                }
            }
            None
        })
    }

    /// The newest Change of the PR that is not merged, refused or abandoned.
    pub fn open_for(&self, repo: &str, pr_number: i64) -> Option<Change> {
        self.latest(repo, pr_number, true)
    }

    /// The newest Change of the PR in any state.
    pub fn latest_for(&self, repo: &str, pr_number: i64) -> Option<Change> {
        self.latest(repo, pr_number, false)
    }

    /// The repo's Changes in these states, in train order.
    pub fn in_train(&self, repo: &str, states: &[ChangeState]) -> Vec<Change> {
        sql(&self.db, |conn| {
            let mut stmt = conn
                .prepare_cached(
                    "SELECT data, state FROM changes WHERE repo = ?1 ORDER BY train_order, n",
                )
                .expect("prepare");
            stmt.query_map([repo.to_lowercase()], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .expect("query")
            .map(|r| r.expect("row"))
            .filter(|(_, state)| parse_state(state).is_some_and(|s| states.contains(&s)))
            .map(|(data, _)| decode(&data))
            .collect()
        })
    }

    /// Moves it ahead of every other Change of its repo.
    pub fn to_front(&self, change_id: &ChangeId) {
        sql(&self.db, |conn| {
            conn
            .execute(
                "UPDATE changes SET train_order = (SELECT MIN(train_order) - 1 FROM changes WHERE repo = (SELECT repo FROM changes WHERE n = ?1)) WHERE n = ?1",
                [number_of(change_id)],
            )
            .expect("to front")
        });
    }

    /// Newest first.
    pub fn list(&self, filter: &ListFilter) -> Vec<Change> {
        sql(&self.db, |conn| {
            let mut stmt = conn
                .prepare_cached(
                    "SELECT data FROM changes
                     WHERE (?1 IS NULL OR (machine_id = ?1 AND project_id = ?2))
                       AND (?3 IS NULL OR repo = ?3) AND (?4 IS NULL OR state = ?4)
                     ORDER BY n DESC LIMIT ?5",
                )
                .expect("prepare");
            let machine = filter
                .project_ref
                .as_ref()
                .map(|r| r.machine_id.to_string());
            let project = filter
                .project_ref
                .as_ref()
                .map(|r| r.project_id.to_string());
            let repo = filter.repo.as_ref().map(|r| r.to_lowercase());
            let state = filter.state.map(state_str);
            stmt.query_map(params![machine, project, repo, state, filter.limit], |r| {
                r.get::<_, String>(0)
            })
            .expect("query")
            .map(|d| decode(&d.expect("row")))
            .collect()
        })
    }

    /// Creates the repo's train for `project_ref` if it has none; returns the train either way.
    pub fn ensure_train(&self, repo: &str, project_ref: &ProjectRef, now_ms: i64) -> TrainRow {
        let key = repo.to_lowercase();
        sql(&self.db, |conn| {
            conn
            .execute(
                "INSERT OR IGNORE INTO trains (repo, machine_id, project_id, watch_since_ms) VALUES (?1, ?2, ?3, ?4)",
                params![key, project_ref.machine_id.as_str(), project_ref.project_id.as_str(), now_ms],
            )
            .expect("ensure train")
        });
        self.train(&key).expect("the train just ensured")
    }

    /// Moves the repo's train to another project, keeping its freeze and watch window.
    pub fn rebind_train(&self, repo: &str, project_ref: &ProjectRef) {
        sql(&self.db, |conn| {
            conn.execute(
                "UPDATE trains SET machine_id = ?1, project_id = ?2 WHERE repo = ?3",
                params![
                    project_ref.machine_id.as_str(),
                    project_ref.project_id.as_str(),
                    repo.to_lowercase()
                ],
            )
            .expect("rebind train")
        });
    }

    pub fn train(&self, repo: &str) -> Option<TrainRow> {
        sql(&self.db, |conn| {
            conn.query_row(
                "SELECT * FROM trains WHERE repo = ?1",
                [repo.to_lowercase()],
                to_train,
            )
            .optional()
            .expect("train")
        })
    }

    pub fn trains(&self) -> Vec<TrainRow> {
        sql(&self.db, |conn| {
            let mut stmt = conn
                .prepare_cached("SELECT * FROM trains ORDER BY repo")
                .expect("prepare");
            stmt.query_map([], to_train)
                .expect("query")
                .map(|r| r.expect("row"))
                .collect()
        })
    }

    pub fn set_frozen(&self, repo: &str, frozen: bool) {
        sql(&self.db, |conn| {
            conn.execute(
                "UPDATE trains SET frozen = ?1 WHERE repo = ?2",
                params![frozen as i64, repo.to_lowercase()],
            )
            .expect("set frozen")
        });
    }

    /// True the first time a PR is reported as merged outside the train.
    pub fn mark_bypass(&self, repo: &str, pr_number: i64) -> bool {
        sql(&self.db, |conn| {
            conn.execute(
                "INSERT OR IGNORE INTO train_bypasses (repo, pr_number) VALUES (?1, ?2)",
                params![repo.to_lowercase(), pr_number],
            )
            .expect("mark bypass")
        }) == 1
    }

    /// A repo's train as the API shows it: frozen, the Change at its head, and the queue in train order.
    pub fn train_state(&self, repo: &str) -> TrainState {
        let repo = repo.to_lowercase();
        TrainState {
            frozen: self.train(&repo).is_some_and(|t| t.frozen),
            head: self
                .in_train(&repo, HEAD_STATES)
                .into_iter()
                .next()
                .map(|c| c.change_id),
            queue: UniqueList::unchecked(
                self.in_train(&repo, QUEUED_STATES)
                    .into_iter()
                    .map(|c| c.change_id)
                    .collect(),
            ),
            repo: GitHubRepo::unchecked(repo),
        }
    }

    /// The reason the polish-loop rule waived review of each listed Change's patch, in insertion order.
    pub fn waivers(&self) -> Vec<(String, String)> {
        sql(&self.db, |conn| {
            let mut stmt = conn
                .prepare_cached("SELECT change_id, reason FROM review_waivers ORDER BY rowid")
                .expect("prepare");
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .expect("query")
                .map(|r| r.expect("row"))
                .collect()
        })
    }
}
