//! The agents view: its order, plain reasons, and one agent's work paged without gaps or repeats, secrets removed
//! and pages kept small.
use fleetd_contracts::agents::{AgentRow, WorkStep};
use fleetd_contracts::live::LaneStatus;
use fleetd_contracts::sessions::ThreadEvent;
use serde_json::json;

use super::sort_rows;
use super::tools::{cursor_of, fit_page, parse_cursor, step_of};
use crate::hub::executor::thread_view::{ThreadView, apply_thread_event, work_page};
use crate::hub::orders::plain_reason;

fn agent(lane: &str, status: &str, started: &str, ended: Option<&str>) -> AgentRow {
    let mut row = json!({
        "laneId": lane, "role": "implementer", "title": format!("{lane} work"), "status": status,
        "startedAt": started, "projectRef": { "machineId": "devbox", "projectId": "app" }, "projectTitle": "app",
    });
    if let Some(ended) = ended {
        row["endedAt"] = json!(ended);
    }
    serde_json::from_value(row).unwrap()
}

#[test]
fn agents_waiting_on_a_person_lead_then_working_ones_newest_first() {
    let mut rows = vec![
        agent(
            "T1",
            "done",
            "2026-10-22T09:00:00.000Z",
            Some("2026-10-22T09:30:00.000Z"),
        ),
        agent("T2", "working", "2026-10-22T10:00:00.000Z", None),
        agent("T3", "queued", "2026-10-22T11:00:00.000Z", None),
        agent("T4", "working", "2026-10-22T10:30:00.000Z", None),
        agent("T5", "waiting", "2026-10-22T08:00:00.000Z", None),
        agent(
            "T6",
            "failed",
            "2026-10-22T08:00:00.000Z",
            Some("2026-10-22T08:10:00.000Z"),
        ),
        agent("T7", "idle", "2026-10-22T07:00:00.000Z", None),
    ];
    sort_rows(&mut rows);
    let order: Vec<&str> = rows.iter().map(|r| r.lane.lane_id.as_str()).collect();
    assert_eq!(order, ["T5", "T4", "T2", "T3", "T7", "T6", "T1"]);
    assert_eq!(rows[0].lane.status, LaneStatus::Waiting);
}

#[test]
fn an_agents_row_is_its_lane_flattened_with_its_project() {
    let row = agent("T2", "working", "2026-10-22T10:00:00.000Z", None);
    let value = serde_json::to_value(&row).unwrap();
    assert_eq!(value["laneId"], "T2");
    assert_eq!(value["projectRef"]["projectId"], "app");
    assert!(
        value.get("lane").is_none(),
        "the lane's fields sit at the top level"
    );
    assert_eq!(serde_json::from_value::<AgentRow>(value).unwrap(), row);
}

#[test]
fn queued_reasons_read_as_plain_words() {
    assert_eq!(plain_reason("slots: 40/40 in use"), "40 of 40 agents busy");
    assert_eq!(
        plain_reason("slots: 38/40 in use (2 reserved for lead turns)"),
        "38 of 40 agents busy"
    );
    assert_eq!(
        plain_reason("agents: 3/3 running"),
        "at this project's max of 3 agents"
    );
    assert_eq!(
        plain_reason("usage limit: resumes 14:05"),
        "usage limit: resumes 14:05"
    );
}

/// A session with `n` messages and `n` commands, one second apart; the last command shares its message's instant.
fn view(n: usize) -> ThreadView {
    let at = |i: usize| format!("2026-10-22T10:{:02}:{:02}.000Z", i / 60, i % 60);
    let mut messages = Vec::new();
    let mut items = Vec::new();
    for i in 0..n {
        messages.push(json!({
            "id": format!("m{i:03}"), "runId": "r1", "role": "assistant",
            "text": format!("step {i}: export GH_TOKEN=ghp_{}", "a".repeat(36)),
            "createdAt": at(2 * i),
        }));
        let started = if i + 1 == n { at(2 * i) } else { at(2 * i + 1) };
        items.push(json!({
            "id": format!("i{i:03}"), "runId": "r1", "status": "completed", "title": "",
            "startedAt": started, "updatedAt": started,
            "kind": { "type": "command", "command": format!("cargo test {i}"), "output": "ok", "exitCode": 0 },
        }));
    }
    let snapshot: ThreadEvent = serde_json::from_value(json!({
        "type": "snapshot",
        "summary": {
            "sessionId": "s1", "projectId": "app", "title": "T1", "status": "running", "model": "m",
            "effort": "low", "runtimeMode": "full-access", "createdAt": at(0), "updatedAt": at(0),
        },
        "messages": messages, "items": items, "runs": [], "truncated": false,
    }))
    .unwrap();
    let mut view = ThreadView::default();
    apply_thread_event(&mut view, &snapshot);
    view
}

#[test]
fn work_pages_back_through_every_step_once() {
    let view = view(12);
    let mut seen = Vec::new();
    let mut before: Option<(String, String)> = None;
    loop {
        let (rows, more) = work_page(
            &view,
            before.as_ref().map(|(a, i)| (a.as_str(), i.as_str())),
            5,
        );
        assert!(rows.len() <= 5);
        seen.extend(rows.iter().map(|(id, _)| id.clone()));
        if !more {
            break;
        }
        let (id, oldest) = rows.last().unwrap();
        before = Some((oldest.at().to_owned(), id.clone()));
    }
    assert_eq!(seen.len(), 24, "every message and command once");
    let mut unique = seen.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(unique.len(), 24);
    assert_eq!(
        &seen[..3],
        ["m011", "i011", "i010"],
        "newest first; a step at the same instant as another orders by id"
    );
}

#[test]
fn a_page_shows_no_secret_and_its_cursor_reads_the_page_before_it() {
    let view = view(3);
    let (rows, _) = work_page(&view, None, 2);
    let steps: Vec<WorkStep> = rows
        .into_iter()
        .filter_map(|(id, row)| step_of(id, row))
        .collect();
    let text = serde_json::to_string(&steps).unwrap();
    assert!(!text.contains("ghp_"), "{text}");
    assert!(text.contains("GH_TOKEN=[secret]"), "{text}");
    let (page, cut) = fit_page(steps, 1 << 20);
    assert!(!cut);
    assert_eq!(page.len(), 2);
    let cursor = cursor_of(&page[0]);
    let (at, id) = parse_cursor(&cursor).unwrap();
    let (older, _) = work_page(&view, Some((at, id)), 50);
    assert_eq!(older.len(), 4, "the six steps minus the page's two");
    assert!(parse_cursor("no-separator").is_none());
    assert!(parse_cursor("|m1").is_none());
}

#[test]
fn a_page_past_its_byte_budget_ends_early_oldest_first() {
    let view = view(10);
    let (rows, _) = work_page(&view, None, 20);
    let steps: Vec<WorkStep> = rows
        .into_iter()
        .filter_map(|(id, row)| step_of(id, row))
        .collect();
    let three: usize = steps[..3]
        .iter()
        .map(|s| serde_json::to_vec(s).unwrap().len() + 1)
        .sum();
    let (page, cut) = fit_page(steps.clone(), three);
    assert!(cut);
    assert_eq!(page.len(), 3);
    assert_eq!(page.last(), steps.first(), "the newest step ends the page");
    let (one_big, cut) = fit_page(steps[..1].to_vec(), 1);
    assert_eq!(
        one_big.len(),
        1,
        "a single step always fits, so paging never stalls"
    );
    assert!(!cut);
}

mod over_a_hub {
    use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef, Timestamp};
    use fleetd_contracts::live::{AgentRole, LaneStatus};
    use serde_json::json;

    use crate::hub::api::{Caller, HubConfig, Listen};
    use crate::hub::store::HubDb;
    use crate::hub::store::test_clock::ManualClock;

    const AT: &str = "2026-10-22T10:00:00.000Z";

    fn reader(machines: serde_json::Value) -> Caller {
        serde_json::from_value(json!({
            "keyId": "k1", "name": "laptop", "prefix": "fld_abcdef", "createdAt": AT,
            "grants": [{ "role": "read", "machines": machines }],
        }))
        .unwrap()
    }

    fn project(machine: &str, id: &str) -> ProjectRef {
        ProjectRef {
            machine_id: MachineId::unchecked(machine),
            project_id: ProjectId::unchecked(id),
        }
    }

    /// Two projects on two machines; the first has a lead, two live tasks and one that ended, the second one task.
    fn hub() -> (std::sync::Arc<crate::hub::api::Hub>, tempfile::TempDir) {
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
            ManualClock::at(1_792_666_800_000),
        )
        .unwrap();
        for (machine, id, title) in [
            ("devbox", "app", "Storefront"),
            ("laptop", "web", "Website"),
        ] {
            hub.store
                .projects_upsert_many(
                    &MachineId::unchecked(machine),
                    &[serde_json::from_value(json!({
                        "machineId": machine, "projectId": id, "title": title, "workspaceRoot": "/work",
                        "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 }, "lastActivityAt": AT,
                    }))
                    .unwrap()],
                )
                .unwrap();
        }
        hub.db
            .with(|c| {
                let task = |n: i64, machine: &str, id: &str, state: &str, extra: serde_json::Value| {
                    let mut data = json!({
                        "taskId": format!("T{n}"), "projectRef": { "machineId": machine, "projectId": id },
                        "workstreamId": "W1", "title": format!("Task {n}"), "kind": "write", "prompt": "do it",
                        "model": "claude-haiku-5-5", "effort": "low", "state": state,
                        "attempt": 1, "createdAt": AT, "startedAt": format!("2026-10-22T10:0{n}:00.000Z"),
                    });
                    if let (serde_json::Value::Object(d), serde_json::Value::Object(e)) = (&mut data, extra) {
                        d.extend(e);
                    }
                    c.execute(
                        "INSERT INTO tasks (n, machine_id, project_id, workstream_id, state, data) VALUES (?1, ?2, ?3, 'W1', ?4, ?5)",
                        rusqlite::params![n, machine, id, state, data.to_string()],
                    )
                };
                task(1, "devbox", "app", "running", json!({}))?;
                task(2, "devbox", "app", "queued", json!({ "queuedReason": "slots: 4/4 in use" }))?;
                task(3, "devbox", "app", "done", json!({ "endedAt": "2026-10-22T10:30:00.000Z" }))?;
                task(4, "laptop", "web", "running", json!({}))?;
                c.execute(
                    "INSERT INTO leads (machine_id, project_id, thread_id, started_at, session_generation)
                     VALUES ('devbox', 'app', 'lead-1', ?1, 0)",
                    [AT],
                )?;
                Ok(())
            })
            .unwrap();
        (hub, home)
    }

    #[test]
    fn every_agent_of_the_projects_a_key_reads_with_its_lead() {
        let (hub, _home) = hub();
        let (rows, truncated) =
            super::super::rows(&hub, &reader(json!(["devbox"])), None, None, 100);
        assert!(!truncated);
        let lanes: Vec<(&str, AgentRole)> = rows
            .iter()
            .map(|r| (r.lane.lane_id.as_str(), r.lane.role))
            .collect();
        assert_eq!(
            lanes,
            [
                ("T1", AgentRole::Implementer),
                ("lead:devbox/app", AgentRole::Lead),
                ("T2", AgentRole::Implementer),
            ],
            "laptop's task is not this key's to read; the finished one needs endedSince"
        );
        assert!(rows.iter().all(|r| r.project_title == "Storefront"));
        assert_eq!(rows[2].lane.status, LaneStatus::Queued);
        assert_eq!(
            rows[2].lane.status_reason.as_deref(),
            Some("4 of 4 agents busy")
        );
        assert_eq!(
            rows[0].workstream_id.as_ref().map(|w| w.as_str()),
            Some("W1")
        );
        assert!(
            rows[1].workstream_id.is_none(),
            "a lead belongs to no one piece of work"
        );

        let since = Timestamp::from("2026-10-22T10:15:00.000Z");
        let (all, _) = super::super::rows(&hub, &reader(json!("*")), None, Some(&since), 100);
        let ids: Vec<&str> = all.iter().map(|r| r.lane.lane_id.as_str()).collect();
        assert_eq!(ids, ["T4", "T1", "lead:devbox/app", "T2", "T3"]);
        let (one, _) = super::super::rows(
            &hub,
            &reader(json!("*")),
            Some(&project("laptop", "web")),
            None,
            100,
        );
        assert_eq!(one.len(), 1);
        let (cut, truncated) = super::super::rows(&hub, &reader(json!("*")), None, None, 2);
        assert_eq!((cut.len(), truncated), (2, true));
    }

    #[test]
    fn the_live_board_covers_every_listed_agent() {
        let (hub, _home) = hub();
        let caller = reader(json!("*"));
        let (rows, _) = super::super::rows(&hub, &caller, None, None, 100);
        let listed: Vec<String> = rows.iter().map(|r| r.lane.lane_id.to_string()).collect();
        let live: Vec<String> = crate::hub::app_ws::live::board_lanes(&hub, &caller)
            .into_iter()
            .map(|l| l.lane.lane_id.to_string())
            .collect();
        for lane in &live {
            assert!(listed.contains(lane), "{lane} is live but not listed");
        }
        assert!(
            listed
                .iter()
                .any(|l| l.starts_with("lead:") && !live.contains(l)),
            "the agents view also lists an idle lead"
        );
        let one = crate::hub::app_ws::live::agent_lanes(&hub, &caller, "lead:devbox/app");
        assert_eq!(one.len(), 1);
        assert!(
            crate::hub::app_ws::live::agent_lanes(&hub, &reader(json!(["laptop"])), "T1")
                .is_empty()
        );
    }
}
