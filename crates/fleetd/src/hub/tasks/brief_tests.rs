//! A task's agent reads its workstream's brief and its project's decisions itself, over a real hub with a fake node:
//! `brief_read` and `decisions_search` answer in full, another project's decisions are refused, and the first prompt
//! carries the whole brief and the decisions it names by id or key. `review_read` gives an author, and its lead, every
//! finding of its PRs' latest reviews in full, and refuses another project's.
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::ledger::{Brief, DecisionKey, DecisionScope, DecisionSource, IntakeChannel};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::tasks::TaskId;
use serde_json::{Value, json};

use super::cap_tests::{AT, Node, hub};
use super::guard_tests::{insert, next_launch, serve, start_queued};
use crate::hub::api::Hub;
use crate::hub::leads::records::NewWorkstream;
use crate::hub::ledger::Actor;
use crate::hub::ledger::repo::RecordInput;
use crate::hub::link::LeadCaller;
use crate::hub::link::lead_calls::CallerAgent;

fn project(id: &str) -> ProjectRef {
    ProjectRef {
        machine_id: MachineId::unchecked("lab-a"),
        project_id: ProjectId::unchecked(id),
    }
}

/// A why longer than any line the prompt used to cut, so a cut shows.
fn long_why() -> String {
    format!(
        "Agents asked the lead to paste their brief. {}The end of the why.",
        "Every word of it counts. ".repeat(60)
    )
}

/// W1 in p1 with a brief that names D1 by id and `api.health.path` by key.
fn briefed(hub: &Hub) -> Brief {
    let (mut w, _) = hub
        .leads
        .records
        .workstream_create(NewWorkstream {
            project_ref: project("p1"),
            title: "Agents read their brief".into(),
            text: "Agents read their brief".into(),
            channel: IntakeChannel::App,
            by: "human".into(),
            at: AT.into(),
            client_request_id: None,
        })
        .unwrap();
    let brief: Brief = serde_json::from_value(json!({
        "goal": "Every agent reads its brief itself.",
        "why": long_why(),
        "pointers": ["crates/fleetd/src/cli/agent_mcp.rs", "D1 says how tools are named."],
        "constraints": ["Keep api.health.path as decided."],
        "doneWhen": ["An agent reads its brief (test).", "Another project's decisions are refused (test)."],
    }))
    .unwrap();
    w.brief = Some(brief.clone());
    hub.leads.records.workstream_put(&w).unwrap();
    brief
}

/// Records `key` = `value` in `project`'s scope.
fn decide(hub: &Hub, project: &ProjectRef, key: &str, value: &str) -> String {
    let mut input = RecordInput::new(
        DecisionKey::unchecked(key),
        DecisionScope::Project {
            project_ref: project.clone(),
        },
        value,
    );
    input.why = Some(format!("{key} was chosen for {}", project.project_id));
    input.project_ref = Some(project.clone());
    let actor = Actor {
        source: DecisionSource::Lead,
        by: "lead:lab-a/p1".into(),
    };
    let decision = hub.decisions.record(input, &actor).unwrap();
    decision.decision_id.to_string()
}

/// `call` made by T1's agent, a task of p1.
fn as_task(hub: &Hub, call: Value) -> Result<LeadCallResult, McpToolError> {
    as_agent(hub, CallerAgent::Task(TaskId::unchecked("T1")), call)
}

/// `call` made by `agent` in p1.
fn as_agent(hub: &Hub, agent: CallerAgent, call: Value) -> Result<LeadCallResult, McpToolError> {
    let call: LeadCall = serde_json::from_value(call).unwrap();
    let op = crate::hub::link::lead_calls::op_of(&call);
    crate::hub::tasks::policy::check(&agent, &op)?;
    let caller = LeadCaller {
        project_ref: project("p1"),
        by: "lead:lab-a/p1".into(),
        agent,
    };
    let handler = hub.lead_calls.handler(&op).unwrap();
    futures_util::FutureExt::now_or_never(handler.handle(caller, call)).unwrap()
}

#[tokio::test]
async fn a_task_reads_its_whole_brief_and_its_projects_decisions_but_no_other_projects() {
    let (hub, _home) = hub();
    let brief = briefed(&hub);
    let named = decide(
        &hub,
        &project("p1"),
        "agents.tool_names",
        "snake_case, one verb",
    );
    let elsewhere = decide(&hub, &project("p2"), "agents.secret_plan", "p2's own");
    insert(
        &hub,
        json!({ "taskId": "T1", "title": "read it", "state": "running", "startedAt": AT }),
    );

    let Ok(LeadCallResult::BriefRead(read)) = as_task(&hub, json!({ "op": "brief_read" })) else {
        panic!("brief_read was not answered")
    };
    assert_eq!(read.workstream_id.as_str(), "W1");
    assert_eq!(read.brief.as_ref(), Some(&brief));
    assert!(
        read.brief
            .unwrap()
            .why
            .as_str()
            .ends_with("The end of the why.")
    );

    let Ok(LeadCallResult::DecisionsSearch(by_id)) =
        as_task(&hub, json!({ "op": "decisions_search", "query": named }))
    else {
        panic!("decisions_search by id was not answered")
    };
    assert_eq!(by_id.decisions.len(), 1);
    assert_eq!(by_id.decisions[0].value.as_str(), "snake_case, one verb");
    assert_eq!(
        by_id.decisions[0].why.as_ref().unwrap().as_str(),
        "agents.tool_names was chosen for p1"
    );
    let Ok(LeadCallResult::DecisionsSearch(by_words)) =
        as_task(&hub, json!({ "op": "decisions_search", "query": "agents" }))
    else {
        panic!("decisions_search by words was not answered")
    };
    let keys: Vec<_> = by_words.decisions.iter().map(|d| d.key.as_str()).collect();
    assert_eq!(keys, ["agents.tool_names"], "p2's decision leaked");

    let refused = as_task(
        &hub,
        json!({ "op": "decisions_search", "query": elsewhere }),
    )
    .unwrap_err();
    assert_eq!(refused.code, ErrorCode::Forbidden);
    assert!(
        refused.message.contains("another project's decision"),
        "{}",
        refused.message
    );
    assert!(!format!("{refused:?}").contains("p2's own"));

    // A lead has no brief of its own to read.
    assert_eq!(
        crate::hub::tasks::policy::check(&CallerAgent::Lead, "brief_read")
            .unwrap_err()
            .code,
        ErrorCode::Invalid
    );
}

#[tokio::test]
async fn a_tasks_first_prompt_carries_the_whole_brief_and_the_decisions_it_names() {
    let (hub, _home) = hub();
    let mut calls = serve(&hub, Node::link(&hub).await);
    let naming = decide(
        &hub,
        &project("p1"),
        "agents.tool_names",
        "snake_case, one verb",
    );
    assert_eq!(naming, "D1");
    decide(&hub, &project("p1"), "api.health.path", "/healthz");
    decide(&hub, &project("p1"), "api.unnamed", "never cited");
    decide(&hub, &project("p2"), "api.health.path", "/p2-health");
    briefed(&hub);
    insert(
        &hub,
        json!({ "taskId": "T1", "title": "read it", "state": "queued" }),
    );
    start_queued(&hub.tasks).await;
    let launch = next_launch(&mut calls).await;
    let prompt = launch.prompt.as_str();
    for line in [
        "Goal: Every agent reads its brief itself.".to_owned(),
        format!("Why: {}", long_why().trim()),
        "Pointers:\n- crates/fleetd/src/cli/agent_mcp.rs\n- D1 says how tools are named.".to_owned(),
        "Constraints:\n- Keep api.health.path as decided.".to_owned(),
        "Done when: done:0 An agent reads its brief (test).; done:1 Another project's decisions are refused (test)."
            .to_owned(),
        "Decisions it names:\n- D1 agents.tool_names = snake_case, one verb (why: agents.tool_names was chosen for p1)\n\
         - D2 api.health.path = /healthz (why: api.health.path was chosen for p1)"
            .to_owned(),
    ] {
        assert!(prompt.contains(&line), "missing {line:?} in\n{prompt}");
    }
    assert!(
        !prompt.contains("never cited") && !prompt.contains("/p2-health"),
        "{prompt}"
    );
}

/// Records `task`'s verdict on `pr` at `sha`, as `report` does.
fn verdict(hub: &Hub, task: &str, pr: &str, sha: char, blocking: i64, summary: &str) {
    let sha = sha.to_string().repeat(40);
    let data = json!({ "taskId": task, "prHeadSha": sha, "blocking": blocking, "nonBlocking": 1, "summary": summary });
    hub.db
        .with(|conn| {
            conn.execute(
                "INSERT INTO review_verdicts (task_id, pr_key, sha, blocking, at_ms, data) VALUES (?1, ?2, ?3, ?4, 0, ?5)",
                rusqlite::params![task, crate::hub::reviews::verdicts::pr_key(pr), sha, blocking, data.to_string()],
            )?;
            Ok(())
        })
        .unwrap();
}

#[tokio::test]
async fn an_author_reads_every_finding_of_its_prs_latest_reviews_but_no_other_projects() {
    let (hub, _home) = hub();
    let (mine, theirs) = (
        "https://github.com/acme/app/pull/7",
        "https://github.com/acme/other/pull/8",
    );
    insert(
        &hub,
        json!({ "taskId": "T1", "title": "write it", "kind": "write", "state": "running", "startedAt": AT, "pr": mine }),
    );
    let full = format!(
        "blocking: src/a.rs:3 leaks the handle. non-blocking: src/b.rs:9 {}the last nit.",
        "names a helper twice. ".repeat(150)
    );
    verdict(&hub, "T9", mine, 'a', 2, "src/old.rs:1 was fixed since");
    verdict(&hub, "T9", mine, 'b', 1, &full);
    verdict(
        &hub,
        "T10",
        mine,
        'b',
        0,
        "non-blocking: src/c.rs:12 a clearer name",
    );
    verdict(&hub, "T20", theirs, 'c', 1, "p2's own: secret/plan.rs:1");

    let Ok(LeadCallResult::ReviewRead(read)) = as_task(&hub, json!({ "op": "review_read" })) else {
        panic!("review_read was not answered")
    };
    assert_eq!(read.prs.len(), 1);
    assert_eq!(read.prs[0].pr.as_str(), mine);
    let reviews: Vec<_> = read.prs[0]
        .reviews
        .iter()
        .map(|r| (r.task_id.as_str(), r.blocking.get(), r.findings.as_str()))
        .collect();
    assert_eq!(
        reviews,
        [
            ("T10", 0, "non-blocking: src/c.rs:12 a clearer name"),
            ("T9", 1, full.as_str()),
        ],
        "the latest head's reviews, whole; the older head's are gone"
    );
    let Ok(LeadCallResult::ReviewRead(by_number)) =
        as_task(&hub, json!({ "op": "review_read", "pr": "#7" }))
    else {
        panic!("review_read by number was not answered")
    };
    assert_eq!(by_number.prs, read.prs);

    // The lead reads its project's PRs too, and neither reads another project's.
    let Ok(LeadCallResult::ReviewRead(lead)) = as_agent(
        &hub,
        CallerAgent::Lead,
        json!({ "op": "review_read", "pr": mine }),
    ) else {
        panic!("review_read was not answered for the lead")
    };
    assert_eq!(lead.prs, read.prs);
    for agent in [
        CallerAgent::Task(TaskId::unchecked("T1")),
        CallerAgent::Lead,
    ] {
        let refused =
            as_agent(&hub, agent, json!({ "op": "review_read", "pr": theirs })).unwrap_err();
        assert_eq!(refused.code, ErrorCode::Forbidden);
        assert!(
            refused.message.contains("another project's reviews"),
            "{}",
            refused.message
        );
        assert!(!format!("{refused:?}").contains("p2's own"));
    }
}
