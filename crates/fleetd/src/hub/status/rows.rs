//! The Status screen's rows: one per project, a state word, the two-tone bar, agents running and the last merge.
//! Read from the same world a status doc renders from; measured or observed only, never an ETA.
use std::collections::HashMap;

use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::model::MachineStatus;
use fleetd_contracts::prim::{Count, Text};
use fleetd_contracts::status::{CiState, LastMerged, ProjectRowState, ProjectStatusRow, StaleMark};
use rusqlite::Connection;
use serde_json::Value;

use super::render::{World, line, machine_stale, project_progress, ts};
use crate::hub::api::Hub;
use crate::hub::plan;

/// A project's latest merge.
#[derive(Clone, Debug, PartialEq)]
pub struct Merged {
    pub at_ms: i64,
    pub title: String,
    pub pr_number: i64,
    pub pr_url: Option<String>,
}

/// How many PRs looked back for the latest merge of each project.
const MERGES_READ: i64 = 1000;

/// Per project: its latest merge (from `pr.merged`, titled by the writer task, else the order), and its PRs in
/// review, CI or the train now.
pub fn read_changes(
    c: &Connection,
) -> rusqlite::Result<(HashMap<String, Merged>, HashMap<String, i64>)> {
    let mut in_flight = HashMap::new();
    let mut stmt = c.prepare_cached(
        "SELECT machine_id || '/' || project_id, COUNT(*) FROM changes
         WHERE state IN ('queued', 'reviewing', 'ready', 'rebasing', 'ci', 'merging') GROUP BY 1",
    )?;
    for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))? {
        let (pk, n) = row?;
        in_flight.insert(pk, n);
    }
    let mut merges: HashMap<String, Merged> = HashMap::new();
    let mut stmt = c.prepare_cached(
        "SELECT created_ms, json_extract(data, '$.machineId') || '/' || json_extract(data, '$.projectId'),
           json_extract(data, '$.data.changeId'), json_extract(data, '$.data.prNumber')
         FROM events WHERE type = 'pr.merged' ORDER BY seq DESC LIMIT ?1",
    )?;
    // (at, project, change, PR number)
    type MergeRow = (i64, Option<String>, Option<String>, Option<i64>);
    let rows: Vec<MergeRow> = stmt
        .query_map([MERGES_READ], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    for (at, pk, change, pr) in rows {
        let Some(pk) = pk else { continue };
        if merges.contains_key(&pk) {
            continue;
        }
        let change: Option<Value> = match change.as_deref().and_then(|x| x.strip_prefix('X')) {
            Some(n) => c
                .prepare_cached("SELECT data FROM changes WHERE n = ?1")?
                .query_row([n.parse::<i64>().unwrap_or(-1)], |r| r.get::<_, String>(0))
                .ok()
                .and_then(|d| serde_json::from_str(&d).ok()),
            None => None,
        };
        let s = |k: &str| {
            change
                .as_ref()
                .and_then(|v| v.get(k))
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        let title_of = |sql: &str, id: Option<String>| -> Option<String> {
            let n = id?.get(1..)?.parse::<i64>().ok()?;
            c.query_row(sql, [n], |r| r.get::<_, Option<String>>(0))
                .ok()
                .flatten()
        };
        let title = title_of(
            "SELECT json_extract(data, '$.title') FROM tasks WHERE n = ?1",
            s("taskId"),
        )
        .or_else(|| {
            title_of(
                "SELECT json_extract(data, '$.title') FROM workstreams WHERE n = ?1",
                s("workstreamId"),
            )
        });
        let pr_number = pr
            .or_else(|| change.as_ref()?.get("prNumber")?.as_i64())
            .unwrap_or(0);
        merges.insert(
            pk,
            Merged {
                at_ms: at,
                title: title.unwrap_or_else(|| format!("PR #{pr_number}")),
                pr_number,
                pr_url: s("prUrl"),
            },
        );
    }
    Ok((merges, in_flight))
}

/// What decides a row's state word.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Facts {
    /// The lead waits for the person's reply: the chat's own needs-you.
    pub needs_you: bool,
    /// Why nothing can move, if something outside the work stops it.
    pub blocked: Option<String>,
    pub agents: i64,
    /// PRs in review, CI or the train.
    pub in_flight: i64,
}

/// Waiting on you first (only you can move it), then blocked, then working; idle when nothing runs or waits.
pub fn state_of(f: &Facts) -> ProjectRowState {
    if f.needs_you {
        ProjectRowState::WaitingOnYou
    } else if f.blocked.is_some() {
        ProjectRowState::Blocked
    } else if f.agents > 0 || f.in_flight > 0 {
        ProjectRowState::Working
    } else {
        ProjectRowState::Idle
    }
}

/// Every project, by title.
pub fn rows(hub: &Hub, w: &World) -> Vec<ProjectStatusRow> {
    let mut projects: Vec<(&String, &String)> = w.titles.iter().collect();
    projects.sort_by(|a, b| {
        a.1.to_lowercase()
            .cmp(&b.1.to_lowercase())
            .then(a.0.cmp(b.0))
    });
    let mut out = Vec::new();
    for (pk, title) in projects {
        let r: ProjectRef = plan::store::project_ref(pk);
        let machine = w.machines.iter().find(|m| m.machine_id == r.machine_id);
        let mname = machine.map_or(r.machine_id.as_str(), |m| m.name.as_str());
        let repos: Vec<&String> = w
            .repos
            .iter()
            .filter(|(_, p)| p == pk)
            .map(|(repo, _)| repo)
            .collect();
        let usage_hit = w
            .loads
            .get(r.machine_id.as_str())
            .is_some_and(|l| l.limits.iter().any(|x| x.status.as_str() == "rejected"));
        let red = repos.iter().find(|repo| {
            hub.train
                .main_ci(repo)
                .is_some_and(|m| m.state == CiState::Red)
        });
        let blocked = match machine.map(|m| m.status) {
            Some(MachineStatus::Offline) => Some(format!("{mname} is offline")),
            Some(MachineStatus::Degraded) => {
                Some(format!("{mname} can't run agents (see Machines)"))
            }
            _ if usage_hit => Some(format!("claude usage limit reached on {mname}")),
            _ => red.map(|repo| format!("main CI is red on {repo}")),
        };
        let facts = Facts {
            // The lead chat's own rule, so the row and the chat's needs-you dot never disagree.
            needs_you: crate::hub::chat::flow::state(hub, &r).is_ok_and(|c| c.needs_you),
            blocked,
            agents: w
                .slots
                .per_project
                .iter()
                .find(|p| p.project_ref == r)
                .map_or(0, |p| p.used.get()),
            in_flight: w.in_flight.get(pk).copied().unwrap_or(0),
        };
        let stale: Option<StaleMark> = machine.and_then(|m| machine_stale(m, w.now, w.tz));
        out.push(ProjectStatusRow {
            project_ref: r,
            title: line(title),
            state: state_of(&facts),
            blocked_reason: facts.blocked.as_deref().map(line),
            progress: project_progress(hub, w, pk).and_then(|(_, p)| p.estimate),
            agents_running: Count::unchecked(facts.agents.max(0)),
            last_merged: w.merges.get(pk).map(|m| LastMerged {
                title: line(&m.title),
                pr_number: (m.pr_number > 0).then(|| Count::unchecked(m.pr_number)),
                pr_url: m.pr_url.as_deref().and_then(|u| Text::new(u).ok()),
                at: ts(m.at_ms),
            }),
            as_of: ts(w.now),
            stale,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::store::HubDb;

    #[test]
    fn the_state_word_puts_you_first_then_blocked_then_work() {
        let f = |needs_you, blocked: Option<&str>, agents, in_flight| Facts {
            needs_you,
            blocked: blocked.map(str::to_owned),
            agents,
            in_flight,
        };
        assert_eq!(
            state_of(&f(true, Some("devbox is offline"), 3, 0)),
            ProjectRowState::WaitingOnYou
        );
        assert_eq!(
            state_of(&f(false, Some("devbox is offline"), 3, 0)),
            ProjectRowState::Blocked
        );
        assert_eq!(state_of(&f(false, None, 2, 0)), ProjectRowState::Working);
        assert_eq!(
            state_of(&f(false, None, 0, 1)),
            ProjectRowState::Working,
            "a PR in CI is work with no agent running"
        );
        assert_eq!(state_of(&f(false, None, 0, 0)), ProjectRowState::Idle);
    }

    /// "Waiting on you" is the chat's needs-you: a lead question the person hasn't answered, gone once they reply.
    #[test]
    fn waiting_on_you_is_the_lead_chats_needs_you() {
        use fleetd_contracts::chat::ChatAuthor;
        use fleetd_contracts::ids::{MachineId, ProjectId};

        use crate::hub::api::{HubConfig, Listen};
        use crate::hub::chat::NewMessage;
        use crate::hub::store::test_clock::ManualClock;

        let home = tempfile::tempdir().unwrap();
        let config = HubConfig {
            home: home.path().to_path_buf(),
            listen: Listen::default(),
            url: None,
            queue_ttl_sec: None,
            retro_model: None,
        };
        let hub = crate::hub::serve::build_on(
            HubDb::open_memory().unwrap(),
            config,
            ManualClock::at(1_792_000_000_000),
        )
        .unwrap();
        hub.store
            .projects_upsert_many(
                &MachineId::unchecked("devbox"),
                &[serde_json::from_value(serde_json::json!({
                    "machineId": "devbox", "projectId": "app", "title": "app", "workspaceRoot": "/work/app",
                    "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 },
                    "lastActivityAt": "2026-10-19T10:00:00.000Z",
                }))
                .unwrap()],
            )
            .unwrap();
        let r = ProjectRef {
            machine_id: MachineId::unchecked("devbox"),
            project_id: ProjectId::unchecked("app"),
        };
        let row = || {
            let world = World::read(&hub, 1_792_000_000_000, None, Default::default()).unwrap();
            rows(&hub, &world).remove(0)
        };
        assert_eq!(row().state, ProjectRowState::Idle);
        let say = |author, text: &str| {
            hub.chat
                .add(
                    &r,
                    NewMessage {
                        author: Some(author),
                        text: text.into(),
                        ..Default::default()
                    },
                )
                .unwrap();
        };
        say(
            ChatAuthor::Lead,
            "1. Public link or image only? I'd pick the link.",
        );
        assert!(crate::hub::chat::flow::state(&hub, &r).unwrap().needs_you);
        assert_eq!(row().state, ProjectRowState::WaitingOnYou);
        say(ChatAuthor::Human, "1 rec");
        assert_eq!(row().state, ProjectRowState::Idle);
    }

    /// The latest merge per project, titled by its writer task (else its order), and PRs in flight per project.
    #[test]
    fn last_merged_and_in_flight_come_from_the_train() {
        let db = HubDb::open_memory().unwrap();
        db.transaction(|c| {
            let change = |n: i64, task: Option<&str>, state: &str| {
                let data = serde_json::json!({
                    "changeId": format!("X{n}"), "taskId": task, "workstreamId": "W1",
                    "prNumber": 10 + n, "prUrl": format!("https://github.com/acme/web/pull/{}", 10 + n),
                });
                c.execute(
                    "INSERT INTO changes (n, repo, pr_number, state, machine_id, project_id, train_order, data)
                     VALUES (?1, 'acme/web', ?2, ?3, 'devbox', 'p1', ?1, ?4)",
                    rusqlite::params![n, 10 + n, state, data.to_string()],
                )
            };
            change(1, Some("T1"), "merged")?;
            change(2, None, "merged")?;
            change(3, Some("T3"), "ci")?;
            change(4, Some("T4"), "reviewing")?;
            c.execute(
                "INSERT INTO tasks (n, machine_id, project_id, workstream_id, state, data)
                 VALUES (1, 'devbox', 'p1', 'W1', 'done', '{\"title\":\"Add the login page\"}')",
                [],
            )?;
            c.execute(
                "INSERT INTO workstreams (n, machine_id, project_id, state, data)
                 VALUES (1, 'devbox', 'p1', 'running', '{\"title\":\"Accounts\"}')",
                [],
            )?;
            let merged = |at: i64, n: i64| {
                let body = serde_json::json!({ "type": "pr.merged", "machineId": "devbox", "projectId": "p1",
                    "data": { "changeId": format!("X{n}"), "prNumber": 10 + n } });
                c.execute(
                    "INSERT INTO events (created_ms, type, machine_id, data) VALUES (?1, 'pr.merged', 'devbox', ?2)",
                    rusqlite::params![at, body.to_string()],
                )
            };
            merged(1_000, 1)?;
            let (merges, in_flight) = read_changes(c)?;
            assert_eq!(
                merges["devbox/p1"],
                Merged {
                    at_ms: 1_000,
                    title: "Add the login page".into(),
                    pr_number: 11,
                    pr_url: Some("https://github.com/acme/web/pull/11".into()),
                }
            );
            assert_eq!(in_flight["devbox/p1"], 2);
            merged(2_000, 2)?;
            let (merges, _) = read_changes(c)?;
            assert_eq!(
                (merges["devbox/p1"].title.as_str(), merges["devbox/p1"].at_ms),
                ("Accounts", 2_000),
                "no writer task: the order's title"
            );
            Ok(())
        })
        .unwrap();
    }
}
