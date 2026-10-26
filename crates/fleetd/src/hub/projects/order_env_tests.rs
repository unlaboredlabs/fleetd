//! Setup commands in a project's settings, and an order's variables: an order sink only for an open order of the
//! project on a node that takes them, and their end once the order closes.
use fleetd_contracts::ledger::{WorkstreamId, WorkstreamState};
use fleetd_contracts::node_link::CAP_ORDER_ENV;

use super::*;
use crate::hub::projects::order_env::{OrderEnvRow, drop_closed, refusal};

#[tokio::test]
async fn setup_commands_save_and_show_with_the_settings() {
    let (hub, _home) = hub();
    let _calls = node(&hub, true).await;
    let me = person();
    let get = || {
        call(
            &hub,
            &me,
            "project_settings_get",
            json!({ "machineId": "lab", "projectId": "p1" }),
        )
    };
    let none = get().await.unwrap();
    assert_eq!(
        none["settings"]["setup"],
        json!({ "commands": [], "timeoutSec": 600, "runAnyway": false, "inputs": [] })
    );
    let setup = json!({ "commands": ["pnpm install", "pnpm codegen"], "timeoutSec": 900, "runAnyway": true,
        "inputs": ["pnpm-lock.yaml"] });
    let out = call(
        &hub,
        &person(),
        "project_settings_set",
        json!({ "machineId": "lab", "projectId": "p1", "setup": setup }),
    )
    .await
    .unwrap();
    assert_eq!(out["settings"]["setup"], setup);
    // This node lists no worktree_setup: the answer says so.
    assert!(
        out["next"]
            .as_str()
            .unwrap()
            .contains("too old to run setup commands"),
        "{out}"
    );
    assert_eq!(get().await.unwrap()["settings"]["setup"], setup);
    assert!(
        hub.db
            .project_settings()
            .setup(&project())
            .unwrap()
            .is_some()
    );
    // No commands turns setup off.
    call(
        &hub,
        &person(),
        "project_settings_set",
        json!({ "machineId": "lab", "projectId": "p1", "setup": { "commands": [] } }),
    )
    .await
    .unwrap();
    assert_eq!(hub.db.project_settings().setup(&project()).unwrap(), None);
}

fn order(hub: &Hub, id: &str, state: WorkstreamState) {
    let w: fleetd_contracts::ledger::Workstream = serde_json::from_value(json!({
        "workstreamId": id, "projectRef": { "machineId": "lab", "projectId": "p1" }, "title": "staging db",
        "source": { "text": "staging db", "channel": "app", "by": "human", "at": AT }, "state": "open", "createdAt": AT, "updatedAt": AT,
    }))
    .unwrap();
    let n: i64 = id[1..].parse().unwrap();
    hub.db
        .with(|c| {
            c.execute(
                "INSERT OR IGNORE INTO workstreams (n, machine_id, project_id, state, data) VALUES (?, 'lab', 'p1', 'open', '')",
                [n],
            )?;
            Ok(())
        })
        .unwrap();
    hub.leads
        .records
        .workstream_put(&fleetd_contracts::ledger::Workstream { state, ..w })
        .unwrap();
}

#[tokio::test]
async fn a_closed_orders_variables_go_from_its_node_and_the_hub() {
    let (hub, _home) = hub();
    let mut calls = node(&hub, true).await;
    order(&hub, "W1", WorkstreamState::Open);
    order(&hub, "W2", WorkstreamState::Open);
    let r = project();
    // A node that doesn't list order_env takes no order variable.
    let why = refusal(&hub, &r, "W1").unwrap();
    assert!(why.contains("too old"), "{why}");
    hub.link
        .set_capabilities(&lab(), &[CAP_PROJECT_SETTINGS, CAP_ORDER_ENV]);
    assert_eq!(refusal(&hub, &r, "W1"), None);
    assert!(refusal(&hub, &r, "W9").is_some());
    let other = ProjectRef {
        project_id: ProjectId::unchecked("p2"),
        ..r.clone()
    };
    assert!(
        refusal(&hub, &other, "W1").is_some(),
        "another project's order"
    );
    let row = |name: &str| OrderEnvRow {
        name: name.into(),
        fingerprint: "ab12cd34".into(),
        bytes: 24,
        request_id: "Q1".into(),
        updated_at: AT.into(),
    };
    hub.db.order_env().save(&r, "W1", &row("DB_URL")).unwrap();
    hub.db.order_env().save(&r, "W2", &row("API_KEY")).unwrap();
    assert!(!every_row(&hub).contains("postgres://"));
    // Both open: nothing goes.
    assert_eq!(drop_closed(&hub).await.unwrap(), 0);

    order(&hub, "W1", WorkstreamState::Done);
    assert!(refusal(&hub, &r, "W1").unwrap().contains("closed"));
    assert_eq!(drop_closed(&hub).await.unwrap(), 1);
    loop {
        if let SessionCall::OrderEnvDrop {
            project_id,
            order_id,
            name: None,
            fingerprint: None,
        } = calls.recv().await.unwrap()
        {
            assert_eq!(
                (project_id.as_str(), order_id),
                ("p1", WorkstreamId::unchecked("W1"))
            );
            break;
        }
    }
    assert!(hub.db.order_env().list(&r, "W1").unwrap().is_empty());
    assert_eq!(hub.db.order_env().list(&r, "W2").unwrap(), [row("API_KEY")]);
    // A stopped order goes the same way.
    order(&hub, "W2", WorkstreamState::Stopped);
    assert_eq!(drop_closed(&hub).await.unwrap(), 1);
    assert!(hub.db.order_env().held().unwrap().is_empty());
}

/// A variable the node saved but the hub can't record would never go with its order: the node drops it again, alone.
#[tokio::test]
async fn a_variable_the_hub_cant_record_is_dropped_from_its_node() {
    let (hub, _home) = hub();
    let mut calls = node(&hub, true).await;
    hub.link
        .set_capabilities(&lab(), &[CAP_PROJECT_SETTINGS, CAP_ORDER_ENV]);
    hub.db
        .with(|c| Ok(c.execute_batch("DROP TABLE order_env")?))
        .unwrap();
    let saved = crate::hub::approvals::OrderEnvSaved {
        project: crate::hub::usage::ports::ProjectRef {
            machine_id: "lab".into(),
            project_id: "p1".into(),
        },
        order_id: "W1".into(),
        name: "DB_URL".into(),
        fingerprint: "ab12cd34".into(),
        bytes: 24,
        request_id: "Q1".into(),
    };
    let at = fleetd_contracts::ids::Timestamp(AT.into());
    let why = crate::hub::projects::order_env::saved(&hub, &saved, &at)
        .await
        .unwrap_err();
    assert!(why.contains("dropped it again"), "{why}");
    loop {
        if let SessionCall::OrderEnvDrop {
            order_id,
            name,
            fingerprint,
            ..
        } = calls.recv().await.unwrap()
        {
            assert_eq!(order_id, WorkstreamId::unchecked("W1"));
            assert_eq!(name.as_ref().map(|n| n.as_str()), Some("DB_URL"));
            // Only the value whose record failed: one delivered since stays.
            assert_eq!(fingerprint.as_ref().map(|f| f.as_str()), Some("ab12cd34"));
            break;
        }
    }
}
