//! Status: one row per project, a state word, its work in groups, agents running and the last merge. Observed only,
//! never an estimate.
use std::collections::HashMap;

use chrono_tz::Tz;
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef, Timestamp};
use fleetd_contracts::model::{Machine, MachineStatus};
use fleetd_contracts::prim::{Count, Line, List, NonNegative, Text};
use fleetd_contracts::status::{CiState, LastMerged, ProjectRowState, ProjectStatusRow, StaleMark};
use rusqlite::Connection;
use serde_json::Value;

use super::fresh::{self, Fresh};
use crate::hub::api::Hub;
use crate::hub::store::{iso_ms, parse_ms};

const DAY_MS: i64 = 24 * 3_600_000;

pub fn pkey(r: &ProjectRef) -> String {
    format!("{}/{}", r.machine_id, r.project_id)
}

pub fn project_ref(key: &str) -> ProjectRef {
    let (m, p) = key.split_once('/').unwrap_or((key, ""));
    ProjectRef {
        machine_id: MachineId::unchecked(m),
        project_id: ProjectId::unchecked(p),
    }
}

/// One line of at most `max` UTF-16 units, with "…" when cut.
pub fn clip(s: &str, max: usize) -> String {
    let one_line: String = s
        .chars()
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .collect();
    if one_line.encode_utf16().count() <= max {
        return one_line;
    }
    let mut out = String::new();
    for ch in one_line.chars() {
        if out.encode_utf16().count() + ch.len_utf16() + 1 > max {
            break;
        }
        out.push(ch);
    }
    out + "…"
}

/// Event types that can change a row: `fleetd status --watch` reads the rows again after one.
pub const CHANGES_A_ROW: &[HubEventType] = &[
    HubEventType::MachineOnline,
    HubEventType::MachineOffline,
    HubEventType::MachineDegraded,
    HubEventType::MachineGuard,
    HubEventType::ProjectAdded,
    HubEventType::ProjectRemoved,
    HubEventType::ChatMessage,
    HubEventType::ChatWaiting,
    HubEventType::LeadStarted,
    HubEventType::WorkstreamCreated,
    HubEventType::WorkstreamRunning,
    HubEventType::WorkstreamState,
    HubEventType::WorkstreamDone,
    HubEventType::TaskQueued,
    HubEventType::TaskStarted,
    HubEventType::TaskCompleted,
    HubEventType::TaskFailed,
    HubEventType::TaskCancelled,
    HubEventType::ThreadWaiting,
    HubEventType::ThreadUsageLimited,
    HubEventType::ThreadStarted,
    HubEventType::ThreadCompleted,
    HubEventType::ThreadFailed,
    HubEventType::ThreadInterrupted,
    HubEventType::RequestOpened,
    HubEventType::RequestUpdated,
    HubEventType::ReviewVerdict,
    HubEventType::ChangeQueued,
    HubEventType::ChangeReady,
    HubEventType::ChangeNeedsRebase,
    HubEventType::ChangeCiFailed,
    HubEventType::ChangeRefused,
    HubEventType::ChangeState,
    HubEventType::PrMerged,
    HubEventType::PrMergedOutside,
    HubEventType::UsageBreaker,
    HubEventType::UsageResumed,
    HubEventType::CiMain,
    HubEventType::SourceStale,
    HubEventType::SourceFresh,
];

fn ts(ms: i64) -> Timestamp {
    Timestamp(iso_ms(ms))
}

fn line<const N: usize>(s: &str) -> Line<1, N> {
    let s = clip(s, N);
    Line::unchecked(if s.is_empty() { "—".to_owned() } else { s })
}

/// "14:02" today, "Thu 14:00" within a week, else "Oct 21 14:00", in the hub's zone.
pub fn clock(ms: i64, now: i64, tz: Tz) -> String {
    let Some(t) = chrono::DateTime::from_timestamp_millis(ms).map(|d| d.with_timezone(&tz)) else {
        return iso_ms(ms);
    };
    let n = chrono::DateTime::from_timestamp_millis(now).map(|d| d.with_timezone(&tz));
    if n.is_some_and(|n| n.date_naive() == t.date_naive()) {
        t.format("%H:%M").to_string()
    } else if (ms - now).abs() < 6 * DAY_MS {
        t.format("%a %H:%M").to_string()
    } else {
        t.format("%b %-d %H:%M").to_string()
    }
}

/// An offline machine's mark: since its last heartbeat.
fn machine_stale(m: &Machine, now: i64, tz: Tz) -> Option<StaleMark> {
    if m.status != MachineStatus::Offline {
        return None;
    }
    let seen = parse_ms(m.last_seen_at.as_str()).unwrap_or(now);
    Some(StaleMark {
        since: ts(seen),
        reason: line(&format!(
            "no heartbeat from {} since {}",
            m.machine_id,
            clock(seen, now, tz)
        )),
    })
}

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
    /// The lead is mid-turn.
    pub lead_working: bool,
}

/// Waiting on you first (only you can move it), then blocked, then working; idle when nothing runs or waits.
pub fn state_of(f: &Facts) -> ProjectRowState {
    if f.needs_you {
        ProjectRowState::WaitingOnYou
    } else if f.blocked.is_some() {
        ProjectRowState::Blocked
    } else if f.agents > 0 || f.in_flight > 0 || f.lead_working {
        ProjectRowState::Working
    } else {
        ProjectRowState::Idle
    }
}

/// Every project's row, by title, read at `now`.
pub fn read(hub: &Hub, fresh: &Fresh, now: i64) -> anyhow::Result<Vec<ProjectStatusRow>> {
    let tz = crate::hub::attention::hub_zone();
    let (merges, in_flight) = hub.db.with(|c| Ok(read_changes(c)?))?;
    // The 7-day fact counts the merge whose event this read may be answering.
    if let Err(e) = crate::hub::metrics::project::catch_up(&hub.db, &hub.events) {
        tracing::warn!(error = %e, "status: metrics not caught up");
    }
    // Status never fails on the metrics: a row whose 7-day fact can't be read leaves it out.
    let weeks = hub
        .db
        .with(|c| crate::hub::metrics::weeks(c, now, tz))
        .unwrap_or_else(|e| {
            tracing::warn!(error = %e, "status: 7-day merges not read");
            Default::default()
        });
    let machines = hub.store.machines_list()?;
    let mut projects: Vec<(String, String)> = hub
        .store
        .projects_list(None, None)?
        .into_iter()
        .map(|p| (format!("{}/{}", p.machine_id, p.project_id), p.title))
        .collect();
    projects.sort_by(|a, b| {
        a.1.to_lowercase()
            .cmp(&b.1.to_lowercase())
            .then(a.0.cmp(&b.0))
    });
    let repos: Vec<(String, String)> = hub
        .train
        .repos()
        .into_iter()
        .map(|(r, p)| (r.to_lowercase(), pkey(&p)))
        .collect();
    let mut out = Vec::new();
    for (pk, title) in &projects {
        let r: ProjectRef = project_ref(pk);
        let machine = machines.iter().find(|m| m.machine_id == r.machine_id);
        let mname = machine.map_or(r.machine_id.as_str(), |m| m.name.as_str());
        let repos: Vec<&String> = repos
            .iter()
            .filter(|(_, p)| p == pk)
            .map(|(repo, _)| repo)
            .collect();
        let usage_hit = hub
            .link
            .load(&r.machine_id)
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
            _ if usage_hit => Some(format!("usage limit reached on {mname}")),
            _ => hub
                .link
                .paused(&r.machine_id)
                .or_else(|| red.map(|repo| format!("main CI is red on {repo}"))),
        };
        // The lead chat's own rule, so the row and the chat's needs-you dot never disagree; the side-effect-free
        // read, since a status read must not announce chat state.
        let chat = hub
            .chat
            .state(&r, crate::hub::chat::flow::lead_working(hub, &r))
            .ok();
        let facts = Facts {
            needs_you: chat.as_ref().is_some_and(|c| c.needs_you),
            blocked,
            // The agents the chat header and the max-agents cap count: the lead's own turn is not one.
            agents: hub.slots.agents(&r).running,
            in_flight: in_flight.get(pk).copied().unwrap_or(0),
            lead_working: chat.as_ref().is_some_and(|c| c.lead_working),
        };
        // Its machine first, then GitHub and the merge train of its repos.
        let stale = machine.and_then(|m| machine_stale(m, now, tz)).or_else(|| {
            repos.iter().find_map(|repo| {
                [fresh::github(repo), fresh::train(repo)]
                    .iter()
                    .find_map(|source| fresh.view(source, now)?.stale)
                    .map(|st| StaleMark {
                        since: ts(st.since_ms),
                        reason: line(&st.reason),
                    })
            })
        });
        let (counts, items) = super::groups::read(hub, &r, facts.needs_you, now);
        out.push(ProjectStatusRow {
            project_ref: r,
            title: line(title),
            state: state_of(&facts),
            blocked_reason: facts.blocked.as_deref().map(line),
            counts,
            items: List::unchecked(items),
            agents_running: Count::unchecked(facts.agents.max(0)),
            last_merged: merges.get(pk).map(|m| LastMerged {
                title: line(&m.title),
                pr_number: (m.pr_number > 0).then(|| Count::unchecked(m.pr_number)),
                pr_url: m.pr_url.as_deref().and_then(|u| Text::new(u).ok()),
                at: ts(m.at_ms),
            }),
            merged_7d: weeks.get(pk).map(|w| Count::unchecked(w.merged)),
            through_fleetd_pct_7d: weeks
                .get(pk)
                .and_then(|w| w.through_fleetd_pct)
                .map(NonNegative::unchecked),
            as_of: ts(now),
            stale,
        });
    }
    Ok(out)
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
            lead_working: false,
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
        assert_eq!(
            state_of(&Facts {
                lead_working: true,
                ..f(false, None, 0, 0)
            }),
            ProjectRowState::Working,
            "a lead-only turn is work, though it is no agent"
        );
    }

    fn test_hub() -> (std::sync::Arc<Hub>, tempfile::TempDir, ProjectRef) {
        use fleetd_contracts::ids::{MachineId, ProjectId};

        use crate::hub::api::{HubConfig, Listen};
        use crate::hub::store::test_clock::ManualClock;

        let home = tempfile::tempdir().unwrap();
        let config = HubConfig {
            home: home.path().to_path_buf(),
            listen: Listen::default(),
            url: None,
            queue_ttl_sec: None,
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
        (hub, home, r)
    }

    fn row_of(hub: &Hub) -> ProjectStatusRow {
        read(hub, &Fresh::default(), 1_792_000_000_000)
            .unwrap()
            .remove(0)
    }

    /// The chat header's count: task agents holding a slot.
    #[test]
    fn agents_running_counts_task_agents() {
        use crate::hub::slots::{SlotPriority, SlotRequest};

        let (hub, _home, r) = test_hub();
        for (holder, priority) in [
            ("T1".to_owned(), SlotPriority::Work),
            ("T2".to_owned(), SlotPriority::Review),
        ] {
            let grant = hub
                .slots
                .acquire(SlotRequest {
                    holder: &holder,
                    project_ref: &r,
                    priority,
                })
                .unwrap();
            assert!(grant.granted());
        }
        assert_eq!(hub.slots.agents(&r).running, 2);
        let row = row_of(&hub);
        assert_eq!(row.agents_running.get(), 2);
        assert_eq!(row.state, ProjectRowState::Working);
    }

    /// Reading the rows only reads: the chat's needs-you is not announced from here.
    #[test]
    fn a_status_read_writes_no_events() {
        use fleetd_contracts::chat::ChatAuthor;

        use crate::hub::chat::NewMessage;

        let (hub, _home, r) = test_hub();
        hub.chat
            .add(
                &r,
                NewMessage {
                    author: Some(ChatAuthor::Lead),
                    text: "1. Public link or image only? I'd pick the link.".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        let head = hub.events.head();
        assert_eq!(row_of(&hub).state, ProjectRowState::WaitingOnYou);
        assert_eq!(hub.events.head(), head);
    }

    /// "Waiting on you" is the chat's needs-you: a lead question the person hasn't answered, gone once they reply.
    #[test]
    fn waiting_on_you_is_the_lead_chats_needs_you() {
        use fleetd_contracts::chat::ChatAuthor;

        use crate::hub::chat::NewMessage;

        let (hub, _home, r) = test_hub();
        assert_eq!(row_of(&hub).state, ProjectRowState::Idle);
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
        assert!(hub.chat.state(&r, false).unwrap().needs_you);
        assert_eq!(row_of(&hub).state, ProjectRowState::WaitingOnYou);
        say(ChatAuthor::Human, "1 rec");
        assert_eq!(row_of(&hub).state, ProjectRowState::Idle);
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
                 VALUES (1, 'devbox', 'p1', 'open', '{\"title\":\"Accounts\"}')",
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
