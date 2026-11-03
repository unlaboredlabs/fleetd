use std::sync::Arc;

use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::mac::MacResultFrame;
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::node_link::{CAP_MAC_TOOL, HubToNode, NodeToHub};
use fleetd_contracts::prim::NonEmpty;
use serde_json::json;
use tokio::sync::mpsc;

use crate::hub::api::{Hub, HubConfig, Listen};
use crate::hub::link::LeadCaller;
use crate::hub::link::lead_calls::CallerAgent;
use crate::hub::store::HubDb;
use crate::hub::store::test_clock::ManualClock;

const KEY: &str = "Az+6kf/abi0V7SO+sn4h++sIgyPoNDAneLBDFaJf3TA=";

fn mid(m: &str) -> MachineId {
    MachineId::unchecked(m)
}

/// A hub with devbox and mac1 joined, mac1 as the agents' Mac; it lends only once its node lists `mac_tool`.
fn hub() -> (Arc<Hub>, tempfile::TempDir) {
    let home = tempfile::tempdir().unwrap();
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Listen::default(),
        url: None,
    };
    let hub = crate::hub::serve::build_on(
        HubDb::open_memory().unwrap(),
        config,
        ManualClock::at(1_792_000_000_000),
    )
    .unwrap();
    for m in ["devbox", "mac1"] {
        let machine = serde_json::from_value(json!({
            "machineId": m, "name": m, "tags": [], "status": "online", "lastSeenAt": "2026-10-26T10:00:00.000Z",
            "nodeVersion": "0.1.0", "boxPubKey": KEY, "agentsMac": (m == "mac1").then_some(true),
        }))
        .unwrap();
        hub.store.machine_upsert(&machine, None).unwrap();
    }
    (hub, home)
}

fn caller(agent: CallerAgent) -> LeadCaller {
    let project_ref = ProjectRef {
        machine_id: mid("devbox"),
        project_id: ProjectId::unchecked("app"),
    };
    LeadCaller {
        by: crate::hub::link::lead_calls::lead_by(&project_ref),
        project_ref,
        agent,
    }
}

fn task() -> LeadCaller {
    caller(CallerAgent::Task(
        fleetd_contracts::tasks::TaskId::unchecked("T7"),
    ))
}

async fn ask(
    hub: &Hub,
    who: LeadCaller,
    call: serde_json::Value,
) -> Result<LeadCallResult, McpToolError> {
    let call: LeadCall = serde_json::from_value(call).unwrap();
    let op = fleetd_contracts::lead_calls::op_name(&call);
    hub.lead_calls.handler(&op).unwrap().handle(who, call).await
}

#[tokio::test]
async fn agents_find_the_online_node_that_is_the_mac_and_nobody_else_does() {
    let (hub, _home) = hub();
    let none = ask(&hub, task(), json!({ "op": "mac_where" }))
        .await
        .unwrap_err();
    assert_eq!(none.code, ErrorCode::MachineOffline);
    // Listing mac_tool but offline isn't enough.
    hub.link.set_capabilities(&mid("mac1"), &[CAP_MAC_TOOL]);
    assert!(
        ask(&hub, task(), json!({ "op": "mac_where" }))
            .await
            .is_err()
    );
    let (tx, _rx) = mpsc::unbounded_channel::<HubToNode>();
    let _link = hub.node_commands.attach(&mid("mac1"), tx);
    let Ok(LeadCallResult::MacWhere(found)) = ask(&hub, task(), json!({ "op": "mac_where" })).await
    else {
        panic!("no Mac")
    };
    assert_eq!(
        (found.machine_id.as_str(), found.box_pub_key.as_str()),
        ("mac1", KEY)
    );
    let lead = ask(
        &hub,
        caller(CallerAgent::Lead),
        json!({ "op": "mac_where" }),
    )
    .await;
    assert!(lead.is_ok(), "a lead uses the Mac too");
    let person = ask(
        &hub,
        caller(CallerAgent::Person),
        json!({ "op": "mac_where" }),
    )
    .await
    .unwrap_err();
    assert_eq!(person.code, ErrorCode::Forbidden);
}

#[tokio::test]
async fn a_sealed_step_goes_to_the_mac_as_it_is_with_who_sent_it_and_its_answer_comes_back() {
    let (hub, _home) = hub();
    hub.link.set_capabilities(&mid("mac1"), &[CAP_MAC_TOOL]);
    let (tx, mut rx) = mpsc::unbounded_channel::<HubToNode>();
    let _link = hub.node_commands.attach(&mid("mac1"), tx);
    let node = hub.clone();
    tokio::spawn(async move {
        while let Some(frame) = rx.recv().await {
            let HubToNode::MacCall(call) = frame else {
                continue;
            };
            assert_eq!(call.sealed.as_str(), "c2VhbGVk");
            assert_eq!(call.caller.machine_id.as_str(), "devbox");
            assert_eq!(call.caller.project_id.as_str(), "app");
            assert_eq!(call.caller.task_id.as_ref().map(|t| t.as_str()), Some("T7"));
            assert_eq!(call.caller.thread_id.as_str(), "s1");
            node.node_commands.resolve(
                &mid("mac1"),
                NodeToHub::MacResult(MacResultFrame {
                    id: call.id,
                    sealed: Some(NonEmpty::unchecked("YW5zd2Vy")),
                    error: None,
                }),
            );
        }
    });
    let send =
        json!({ "op": "mac_send", "machineId": "mac1", "threadId": "s1", "sealed": "c2VhbGVk" });
    let Ok(LeadCallResult::MacSend(answer)) = ask(&hub, task(), send).await else {
        panic!("no answer")
    };
    assert_eq!(answer.sealed.as_str(), "YW5zd2Vy");
    // A step sealed for a machine that isn't the Mac (any more) isn't sent anywhere.
    let stale =
        json!({ "op": "mac_send", "machineId": "devbox", "threadId": "s1", "sealed": "c2VhbGVk" });
    assert!(ask(&hub, task(), stale).await.is_err());
}
