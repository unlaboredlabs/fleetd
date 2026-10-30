//! A person's 1Password token over a real hub and a fake node (claude_accounts/tests.rs): sealed boxes relayed and
//! never kept, Test listing the vaults, Remove and a person's removal forgetting it, and a launch naming the person
//! whose work it is when they saved one.
use fleetd_contracts::auth::KeyKind;
use fleetd_contracts::claude_accounts::ClaudeSealedOn;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef, Timestamp};
use fleetd_contracts::node_link::CAP_ONEPASSWORD;
use fleetd_contracts::onepassword::OnePasswordToken;
use fleetd_contracts::secrets::SecretFingerprint;
use fleetd_contracts::sessions::SessionCall;
use serde_json::json;

use crate::hub::api::Caller;
use crate::hub::claude_accounts::tests::{
    call, device, every_row, hub, lab, launched, member, node, order, owner, project, request,
    sealed,
};
use crate::hub::tasks::ports::TaskPorts;

const TOKEN: &str = "ops_devbox-never-on-the-hub";

#[tokio::test]
async fn a_person_saves_their_token_sealed_tests_its_vaults_and_removes_it() {
    let (hub, _home) = hub();
    let ann = owner(&hub);
    let bob = member(&hub, "Bob");
    let mut calls = node(&hub, &[CAP_ONEPASSWORD]).await;
    let desk = device(&hub, &bob, "operate");
    let boxed = sealed(TOKEN);
    let input = json!({ "sealed": [{ "machineId": "lab", "sealed": boxed }] });
    // An agent's key has no person: it never saves one.
    let agent = Caller {
        kind: Some(KeyKind::Agent),
        ..desk.clone()
    };
    assert!(
        call(&hub, &agent, "onepassword_set", input.clone())
            .await
            .is_err()
    );
    let out = call(&hub, &desk, "onepassword_set", input).await.unwrap();
    assert_eq!(out["token"]["sealedOn"][0]["fingerprint"], "0b5e55ed");
    let SessionCall::OnePasswordToken {
        person_id,
        sealed: sent,
    } = calls.recv().await.unwrap()
    else {
        panic!("not a 1Password token");
    };
    assert_eq!(person_id, bob);
    assert_eq!(sent.unwrap().as_str(), boxed);
    assert!(!every_row(&hub).contains(&boxed), "the box is never kept");
    // Test: the node lists the vaults it reads, recorded on the token.
    let tested = call(&hub, &desk, "onepassword_test", json!({}))
        .await
        .unwrap();
    assert_eq!(tested["test"]["ok"], true);
    assert_eq!(tested["test"]["vaults"], json!(["Agents", "Shared"]));
    assert!(matches!(
        calls.recv().await.unwrap(),
        SessionCall::OnePasswordTest { person_id } if person_id == bob
    ));
    let got = call(&hub, &desk, "onepassword_get", json!({}))
        .await
        .unwrap();
    assert_eq!(
        got["token"]["lastTest"]["vaults"],
        json!(["Agents", "Shared"])
    );
    // Ann sees only her own: none.
    let anns = call(
        &hub,
        &device(&hub, &ann, "admin"),
        "onepassword_get",
        json!({}),
    )
    .await
    .unwrap();
    assert!(anns.get("token").is_none(), "{anns}");
    // Remove: each node forgets it.
    call(&hub, &desk, "onepassword_remove", json!({}))
        .await
        .unwrap();
    assert!(matches!(
        calls.recv().await.unwrap(),
        SessionCall::OnePasswordToken { sealed: None, .. }
    ));
    let got = call(&hub, &desk, "onepassword_get", json!({}))
        .await
        .unwrap();
    assert!(got.get("token").is_none(), "{got}");
    // Saved again, it goes with Bob when he is removed from the hub.
    let again = json!({ "sealed": [{ "machineId": "lab", "sealed": sealed(TOKEN) }] });
    call(&hub, &desk, "onepassword_set", again).await.unwrap();
    calls.recv().await.unwrap();
    call(
        &hub,
        &device(&hub, &ann, "admin"),
        "person_remove",
        json!({ "personId": bob.as_str() }),
    )
    .await
    .unwrap();
    loop {
        if let SessionCall::OnePasswordToken { sealed: sent, .. } = calls.recv().await.unwrap() {
            assert!(sent.is_none());
            break;
        }
    }
    assert!(super::token(&hub.db, &bob).unwrap().is_none());
}

/// A token held on `machines`.
fn saved(machines: &[&str]) -> OnePasswordToken {
    OnePasswordToken {
        sealed_on: machines
            .iter()
            .map(|m| ClaudeSealedOn {
                machine_id: MachineId::unchecked(*m),
                fingerprint: SecretFingerprint::unchecked("0b5e55ed"),
            })
            .collect(),
        saved_at: Timestamp("2026-10-30T10:00:00.000Z".into()),
        last_test: None,
    }
}

#[tokio::test]
async fn a_launch_names_the_person_whose_work_it_is_when_they_saved_a_token() {
    let (hub, _home) = hub();
    owner(&hub);
    let bob = member(&hub, "Bob");
    let cy = member(&hub, "Cy");
    super::put_token(&hub.db, &cy, &saved(&["lab"])).unwrap();
    let mut calls = node(&hub, &[CAP_ONEPASSWORD]).await;
    let ports = crate::hub::tasks::wire::HubTaskPorts::new(
        hub.executors.clone(),
        hub.node_commands.clone(),
    );
    ports.bind(&hub);
    let r = project();
    // Cy's order: her token. Bob's: he saved none. Nobody's (an automation's): none.
    let cys = order(&hub, &r, Some(&cy));
    ports.launch(&lab(), request(cys, "c1")).await.unwrap();
    assert_eq!(launched(&mut calls).await.onepassword, Some(cy.clone()));
    let bobs = order(&hub, &r, Some(&bob));
    ports.launch(&lab(), request(bobs, "b1")).await.unwrap();
    assert_eq!(launched(&mut calls).await.onepassword, None);
    let nobodys = order(&hub, &r, None);
    ports.launch(&lab(), request(nobodys, "n1")).await.unwrap();
    assert_eq!(launched(&mut calls).await.onepassword, None);
    // A project's lead serves everyone: no person. A Navi's lead is its owner's.
    assert_eq!(super::for_lead(&hub.db, &r), None);
    let navi = ProjectRef {
        machine_id: lab(),
        project_id: ProjectId::unchecked("navi-cy"),
    };
    let key = device(&hub, &cy, "operate");
    hub.db
        .with(|c| {
            crate::hub::navi::store::put(
                c,
                &navi,
                &fleetd_contracts::model::ProjectCreator {
                    key_id: key.key_id.to_string(),
                    name: "desk".into(),
                },
                Some(&cy),
                0,
            )?;
            Ok(())
        })
        .unwrap();
    assert_eq!(super::for_lead(&hub.db, &navi), Some(cy.clone()));
    // A task in Cy's Navi is hers whoever's order it is.
    assert_eq!(
        super::for_task(&hub.db, &navi, None, &lab()),
        Some(cy.clone())
    );
    // Replaced while lab was offline, her token is held only on buildbox: lab may keep the old one on disk, so no
    // launch there names her, a task's or her Navi's lead.
    super::put_token(&hub.db, &cy, &saved(&["buildbox"])).unwrap();
    let cys = order(&hub, &r, Some(&cy));
    ports
        .launch(&lab(), request(cys.clone(), "c2"))
        .await
        .unwrap();
    assert_eq!(launched(&mut calls).await.onepassword, None);
    assert_eq!(super::for_lead(&hub.db, &navi), None);
    assert_eq!(
        super::for_task(&hub.db, &r, Some(&cys), &MachineId::unchecked("buildbox")),
        Some(cy)
    );
}
