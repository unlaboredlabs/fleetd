//! The disk and load guard and the usage soft brake over a real hub with a fake node: new agents wait while the
//! machine is short of disk or its login's window is nearly used, running ones keep going, and room again starts the
//! waiting ones. A merged writer's worktree goes.
use std::sync::Arc;

use fleetd_contracts::ids::MachineId;
use fleetd_contracts::node_link::{HubToNode, NodeToHub};
use fleetd_contracts::sessions::SessionCall;
use fleetd_contracts::tasks::{Task, TaskId, TaskState};
use serde_json::json;
use tokio::sync::mpsc;

use super::cap_tests::{AT, Node, hub, running};
use crate::hub::api::Hub;
use crate::hub::link::guard::tests::load;
use crate::hub::store::NewEvent;

fn lab_a() -> MachineId {
    MachineId::unchecked("lab-a")
}

pub(super) fn insert(hub: &Hub, task: serde_json::Value) -> Task {
    let mut base = json!({
        "projectRef": { "machineId": "lab-a", "projectId": "p1" }, "workstreamId": "W1", "prompt": "do it",
        "kind": "read", "model": "claude-haiku-5-5", "effort": "low", "attempt": 1, "createdAt": AT,
    });
    base.as_object_mut()
        .unwrap()
        .extend(task.as_object().unwrap().clone());
    let task: Task = serde_json::from_value(base).unwrap();
    hub.db
        .with(|c| Ok(super::TaskRecords::create(c, task)?))
        .unwrap()
}

fn state(hub: &Hub, id: &str) -> Task {
    hub.tasks.get(&TaskId::unchecked(id)).unwrap().unwrap()
}

/// Applies the events the tasks area follows, as its follower would.
async fn catch_up(tasks: &Arc<super::Tasks>) {
    let _guard = tasks.lock.lock().await;
    tasks.catch_up().await;
}

/// Answers every call the hub sends the node (a file read finds nothing, the default branch is main; anything else is done) and hands each one
/// to the test.
pub(super) fn serve(hub: &Arc<Hub>, node: Node) -> mpsc::UnboundedReceiver<SessionCall> {
    serve_with(hub, node, Some("main"))
}

/// As [`serve`], with `branch` as the project's default branch: `None` for a repo with no commit yet.
fn serve_with(
    hub: &Arc<Hub>,
    mut node: Node,
    branch: Option<&'static str>,
) -> mpsc::UnboundedReceiver<SessionCall> {
    let (tx, calls) = mpsc::unbounded_channel();
    let hub = hub.clone();
    tokio::spawn(async move {
        while let Some(frame) = node.rx.recv().await {
            let HubToNode::SessionCall(f) = frame else {
                continue;
            };
            let result = match f.call {
                SessionCall::ReadFile { .. } => json!({ "ok": { "kind": "file" } }),
                SessionCall::DefaultBranch { .. } => {
                    json!({ "ok": { "kind": "default_branch", "branch": branch } })
                }
                _ => json!({ "ok": { "kind": "done" } }),
            };
            let reply = json!({ "t": "session_reply", "id": f.id, "result": result });
            hub.executors.handle_frame(
                &lab_a(),
                serde_json::from_value::<NodeToHub>(reply).unwrap(),
            );
            let _ = tx.send(f.call);
        }
    });
    calls
}

/// Every `machine.guard` event's `data.paused`, in order.
fn guard_events(hub: &Hub) -> Vec<bool> {
    hub.db
        .with(|c| {
            let mut stmt = c.prepare(
                "SELECT json_extract(data, '$.data.paused') FROM events WHERE type = 'machine.guard' ORDER BY seq",
            )?;
            let rows = stmt
                .query_map([], |r| r.get::<_, bool>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .unwrap()
}

#[tokio::test]
async fn low_disk_holds_new_agents_keeps_running_ones_and_room_again_starts_them() {
    let (hub, _home) = hub();
    let mut calls = serve(&hub, Node::link(&hub).await);
    running(&hub, 1);
    insert(
        &hub,
        json!({ "taskId": "T2", "title": "next slice", "state": "queued", "queuedReason": "Max agents: 1 of 1 running" }),
    );

    hub.link
        .observe_load(&lab_a(), Some(load(14, 3.0)), NODE_AT);
    let paused = "Paused new agents: 14 GB free on lab-a";
    assert_eq!(hub.link.paused(&lab_a()).as_deref(), Some(paused));
    catch_up(&hub.tasks).await;
    let waiting = state(&hub, "T2");
    assert_eq!(waiting.state, TaskState::Queued);
    assert_eq!(waiting.queued_reason.as_ref().unwrap().as_str(), paused);
    assert_eq!(state(&hub, "T1").state, TaskState::Running);
    while let Ok(call) = calls.try_recv() {
        assert!(
            !matches!(call, SessionCall::Stop { .. }),
            "a running agent is never stopped"
        );
    }

    // Within the margin it stays paused; the line follows the figure, with no new event.
    hub.link
        .observe_load(&lab_a(), Some(load(105, 3.0)), NODE_AT);
    assert_eq!(
        hub.link.paused(&lab_a()).as_deref(),
        Some("Paused new agents: 105 GB free on lab-a")
    );
    assert_eq!(guard_events(&hub), [true]);

    hub.link
        .observe_load(&lab_a(), Some(load(111, 3.0)), NODE_AT);
    assert_eq!(hub.link.paused(&lab_a()), None);
    assert_eq!(guard_events(&hub), [true, false]);
    catch_up(&hub.tasks).await;
    assert_eq!(state(&hub, "T2").state, TaskState::Running);
    assert_eq!(state(&hub, "T1").state, TaskState::Running);
}

/// The heartbeat's time on the node's clock: the test clock's, when the 5-hour reading below was taken.
const NODE_AT: &str = "2026-10-14T17:46:40.000Z";

/// `load` with one 5-hour window `used` of the way through, read at the test clock's time and resetting after it.
fn used(used: f64) -> fleetd_contracts::node_link::NodeLoad {
    let mut l = load(500, 3.0);
    l.limits = serde_json::from_value(json!([{
        "limitType": "five_hour", "utilization": used, "resetsAt": "2026-10-30T14:00:00.000Z", "status": "allowed",
        "observedAt": "2026-10-14T17:46:40.000Z",
    }]))
    .unwrap();
    l
}

#[tokio::test]
async fn a_nearly_used_window_holds_new_agents_keeps_running_ones_and_below_85_starts_them() {
    let (hub, _home) = hub();
    let mut calls = serve(&hub, Node::link(&hub).await);
    running(&hub, 1);
    insert(
        &hub,
        json!({ "taskId": "T2", "title": "next slice", "state": "queued", "queuedReason": "Max agents: 1 of 1 running" }),
    );

    hub.link.observe_load(&lab_a(), Some(used(0.91)), NODE_AT);
    let paused = "Paused new agents: 5-hour limit 91% on lab-a as of Wed 17:46 UTC, resets Fri 14:00 UTC (pauses at 90%, lifts below 85%)";
    assert_eq!(hub.link.paused(&lab_a()).as_deref(), Some(paused));
    catch_up(&hub.tasks).await;
    let waiting = state(&hub, "T2");
    assert_eq!(waiting.state, TaskState::Queued);
    assert_eq!(waiting.queued_reason.as_ref().unwrap().as_str(), paused);
    assert_eq!(state(&hub, "T1").state, TaskState::Running);
    while let Ok(call) = calls.try_recv() {
        assert!(
            !matches!(call, SessionCall::Stop { .. }),
            "a running agent is never stopped"
        );
    }

    hub.link.observe_load(&lab_a(), Some(used(0.87)), NODE_AT);
    assert!(
        hub.link.paused(&lab_a()).is_some(),
        "between 85% and 90% it stays braked"
    );
    assert_eq!(guard_events(&hub), [true]);

    hub.link.observe_load(&lab_a(), Some(used(0.84)), NODE_AT);
    assert_eq!(hub.link.paused(&lab_a()), None);
    assert_eq!(guard_events(&hub), [true, false]);
    catch_up(&hub.tasks).await;
    assert_eq!(state(&hub, "T2").state, TaskState::Running);
}

#[tokio::test]
async fn a_merged_writer_has_the_node_remove_its_worktree() {
    let (hub, _home) = hub();
    let mut calls = serve(&hub, Node::link(&hub).await);
    // The store numbers tasks itself: this one is T1.
    let task = insert(
        &hub,
        json!({ "taskId": "T3", "title": "fix", "kind": "write", "state": "done",
            "threadRef": { "machineId": "lab-a", "threadId": "t3" }, "branch": "fleetd/T3-fix", "startedAt": AT,
            "endedAt": AT }),
    );
    let merged: NewEvent = serde_json::from_value(json!({
        "at": AT, "type": "pr.merged", "machineId": "lab-a", "projectId": "p1", "summary": "X1 merged",
        "data": { "changeId": "X1", "taskId": task.task_id, "repo": "o/r", "prNumber": 7 },
    }))
    .unwrap();
    hub.events.append(merged).unwrap();
    catch_up(&hub.tasks).await;
    loop {
        if let SessionCall::Stop {
            session_id,
            remove_worktree,
        } = calls.recv().await.unwrap()
        {
            assert_eq!(session_id.as_str(), "t3");
            assert!(remove_worktree);
            break;
        }
    }
}

/// Tries every queued task, as a freed slot does.
pub(super) async fn start_queued(tasks: &Arc<super::Tasks>) {
    let _guard = tasks.lock.lock().await;
    tasks.retry_queue().await;
}

/// The next launch the hub sends the node.
pub(super) async fn next_launch(
    calls: &mut mpsc::UnboundedReceiver<SessionCall>,
) -> fleetd_contracts::sessions::SessionLaunch {
    loop {
        if let SessionCall::Launch(launch) = calls.recv().await.unwrap() {
            return launch;
        }
    }
}

/// A node from before detached worktrees can't decode one and would drop its link, so its readers and reviewers start
/// as before, in the project root, with a brief that says so. A node that lists the capability gets the worktree.
#[tokio::test]
async fn a_node_too_old_for_detached_worktrees_gets_the_old_launch() {
    use fleetd_contracts::node_link::CAP_DETACHED;
    use fleetd_contracts::prim::NonEmpty;
    use fleetd_contracts::sessions::SessionWorkspace;
    let (hub, _home) = hub();
    let mut calls = serve(&hub, Node::link(&hub).await);
    // So old it takes no system prompt either: its brief's rules come in its first message.
    hub.link.set_capabilities(&lab_a(), &[]);
    let pr = "https://github.com/o/r/pull/7";
    insert(
        &hub,
        json!({ "taskId": "T1", "title": "old node", "state": "queued", "kind": "review", "pr": pr }),
    );
    start_queued(&hub.tasks).await;
    let old = next_launch(&mut calls).await;
    assert_eq!(old.workspace, SessionWorkspace::Root);
    assert!(
        old.prompt
            .contains("the project's own checkout, which is the human's"),
        "{}",
        old.prompt.as_str()
    );
    assert!(!old.prompt.contains("worktree of your own"));

    hub.link.set_capabilities(&lab_a(), &[CAP_DETACHED]);
    insert(
        &hub,
        json!({ "taskId": "T2", "title": "new node", "state": "queued", "kind": "review", "pr": pr }),
    );
    start_queued(&hub.tasks).await;
    let new = next_launch(&mut calls).await;
    assert_eq!(
        new.workspace,
        SessionWorkspace::Detached {
            base_ref: NonEmpty::unchecked("main"),
            pr: Some(NonEmpty::unchecked(pr)),
        }
    );
    assert!(
        new.prompt
            .contains("a detached git worktree of your own, at the PR's head")
    );
}

/// In a repo with no commit yet the node names no default branch, so a reader starts in the project root, as before,
/// with the brief that says it is the human's checkout, rather than failing.
#[tokio::test]
async fn a_reader_of_a_repo_with_no_commit_yet_starts_in_the_project_root() {
    use fleetd_contracts::node_link::CAP_DETACHED;
    use fleetd_contracts::sessions::SessionWorkspace;
    let (hub, _home) = hub();
    let mut calls = serve_with(&hub, Node::link(&hub).await, None);
    hub.link.set_capabilities(&lab_a(), &[CAP_DETACHED]);
    insert(
        &hub,
        json!({ "taskId": "T1", "title": "new repo", "state": "queued" }),
    );
    start_queued(&hub.tasks).await;
    let launch = next_launch(&mut calls).await;
    assert_eq!(launch.workspace, SessionWorkspace::Root);
    assert!(
        launch
            .prompt
            .contains("the project's own checkout, which is the human's"),
        "{}",
        launch.prompt.as_str()
    );
}

/// A task's launch names its order, whose variables its session gets, and carries the project's setup commands to a
/// node that runs them; a node too old for setup gets none.
#[tokio::test]
async fn a_launch_carries_its_order_and_the_projects_setup() {
    use fleetd_contracts::node_link::CAP_WORKTREE_SETUP;
    let (hub, _home) = hub();
    let mut calls = serve(&hub, Node::link(&hub).await);
    let project = fleetd_contracts::ids::ProjectRef {
        machine_id: lab_a(),
        project_id: fleetd_contracts::ids::ProjectId::unchecked("p1"),
    };
    let setup: fleetd_contracts::project_settings::WorktreeSetup = serde_json::from_value(
        json!({ "commands": ["pnpm install --frozen-lockfile"], "inputs": ["pnpm-lock.yaml"] }),
    )
    .unwrap();
    hub.db
        .project_settings()
        .set_setup(&project, &setup)
        .unwrap();
    insert(
        &hub,
        json!({ "taskId": "T1", "title": "old node", "state": "queued", "kind": "write" }),
    );
    start_queued(&hub.tasks).await;
    let old = next_launch(&mut calls).await;
    assert_eq!(old.order_id.as_ref().map(|o| o.as_str()), Some("W1"));
    assert_eq!(old.setup, None);

    hub.link.set_capabilities(&lab_a(), &[CAP_WORKTREE_SETUP]);
    insert(
        &hub,
        json!({ "taskId": "T2", "title": "new node", "state": "queued", "kind": "write" }),
    );
    start_queued(&hub.tasks).await;
    let new = next_launch(&mut calls).await;
    assert_eq!(new.order_id.as_ref().map(|o| o.as_str()), Some("W1"));
    assert_eq!(new.setup.as_deref(), Some(&setup));
}

/// A launch carries its repo's setup commands, for now the project's own repo's, and the project's when the repo has
/// none of its own.
#[tokio::test]
async fn a_launch_carries_its_repos_setup() {
    use fleetd_contracts::node_link::CAP_WORKTREE_SETUP;
    let (hub, _home) = hub();
    let mut calls = serve(&hub, Node::link(&hub).await);
    hub.link.set_capabilities(&lab_a(), &[CAP_WORKTREE_SETUP]);
    let project = fleetd_contracts::ids::ProjectRef {
        machine_id: lab_a(),
        project_id: fleetd_contracts::ids::ProjectId::unchecked("p1"),
    };
    let setup = |command: &str| -> fleetd_contracts::project_settings::WorktreeSetup {
        serde_json::from_value(json!({ "commands": [command] })).unwrap()
    };
    let repo = hub
        .repos
        .ensure_own(&project, Some("/work/p1"))
        .unwrap()
        .unwrap();
    let store = hub.db.project_settings();
    store.set_setup(&project, &setup("make deps")).unwrap();
    insert(
        &hub,
        json!({ "taskId": "T1", "title": "the project's", "state": "queued", "kind": "write" }),
    );
    start_queued(&hub.tasks).await;
    let launch = next_launch(&mut calls).await;
    assert_eq!(launch.setup.as_deref(), Some(&setup("make deps")));

    store
        .set_setup_in(&project, Some(&repo.repo_id), &setup("pnpm install"))
        .unwrap();
    insert(
        &hub,
        json!({ "taskId": "T2", "title": "the repo's", "state": "queued", "kind": "write" }),
    );
    start_queued(&hub.tasks).await;
    let launch = next_launch(&mut calls).await;
    assert_eq!(launch.setup.as_deref(), Some(&setup("pnpm install")));
}
