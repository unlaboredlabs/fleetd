//! A person's sidebar order over a real hub: kept per person, the same on each of their devices, never another's, and
//! announced only to its owner's devices.
use fleetd_contracts::auth::KeyKind;
use serde_json::{Value, json};

use crate::hub::api::Caller;
use crate::hub::claude_accounts::tests::{call, device, hub, member, owner};

fn refs(ids: &[&str]) -> Value {
    json!(
        ids.iter()
            .map(|id| json!({ "machineId": "lab", "projectId": id }))
            .collect::<Vec<_>>()
    )
}

async fn order_of(hub: &std::sync::Arc<crate::hub::api::Hub>, desk: &Caller) -> Value {
    call(hub, desk, "sidebar_order_get", json!({}))
        .await
        .unwrap()["order"]
        .clone()
}

#[tokio::test]
async fn each_person_keeps_their_own_order_on_every_device() {
    let (hub, _home) = hub();
    let ann = owner(&hub);
    let bob = member(&hub, "Bob");
    let ann_laptop = device(&hub, &ann, "admin");
    let ann_desktop = device(&hub, &ann, "read");
    let bob_desk = device(&hub, &bob, "operate");

    // Nothing moved yet: empty, and the app keeps its own order.
    assert_eq!(order_of(&hub, &ann_laptop).await, json!([]));

    let set = call(
        &hub,
        &ann_laptop,
        "sidebar_order_set",
        json!({ "order": refs(&["web", "navi", "api"]) }),
    )
    .await
    .unwrap();
    assert_eq!(set["order"], refs(&["web", "navi", "api"]));
    // Her other desktop reads the same, even on a read-only key.
    assert_eq!(
        order_of(&hub, &ann_desktop).await,
        refs(&["web", "navi", "api"])
    );
    // Bob's sidebar doesn't follow hers.
    assert_eq!(order_of(&hub, &bob_desk).await, json!([]));

    call(
        &hub,
        &bob_desk,
        "sidebar_order_set",
        json!({ "order": refs(&["api", "web"]) }),
    )
    .await
    .unwrap();
    assert_eq!(order_of(&hub, &bob_desk).await, refs(&["api", "web"]));
    assert_eq!(
        order_of(&hub, &ann_desktop).await,
        refs(&["web", "navi", "api"])
    );

    // A new order replaces the one before.
    call(
        &hub,
        &ann_desktop,
        "sidebar_order_set",
        json!({ "order": refs(&["api", "web"]) }),
    )
    .await
    .unwrap();
    assert_eq!(order_of(&hub, &ann_laptop).await, refs(&["api", "web"]));
}

#[tokio::test]
async fn it_is_kept_in_the_hubs_database() {
    let (hub, _home) = hub();
    let ann = owner(&hub);
    let desk = device(&hub, &ann, "operate");
    call(
        &hub,
        &desk,
        "sidebar_order_set",
        json!({ "order": refs(&["b", "a"]) }),
    )
    .await
    .unwrap();
    // In its table, which a restarted hub reads again.
    let kept = super::order(&hub.db, &ann).unwrap();
    assert_eq!(serde_json::to_value(kept).unwrap(), refs(&["b", "a"]));
}

#[tokio::test]
async fn only_a_person_sets_one_and_a_ref_comes_once() {
    let (hub, _home) = hub();
    let ann = owner(&hub);
    let desk = device(&hub, &ann, "operate");
    let agent = Caller {
        kind: Some(KeyKind::Agent),
        ..desk.clone()
    };
    let input = json!({ "order": refs(&["a"]) });
    assert!(
        call(&hub, &agent, "sidebar_order_set", input)
            .await
            .is_err()
    );
    // An agent's key reads none.
    assert_eq!(order_of(&hub, &agent).await, json!([]));
    let twice = json!({ "order": refs(&["a", "a"]) });
    assert!(call(&hub, &desk, "sidebar_order_set", twice).await.is_err());
}

#[tokio::test]
async fn only_its_owners_devices_hear_of_a_change() {
    let (hub, _home) = hub();
    let ann = owner(&hub);
    let bob = member(&hub, "Bob");
    let ann_desk = device(&hub, &ann, "operate");
    let bob_desk = device(&hub, &bob, "operate");
    call(
        &hub,
        &ann_desk,
        "sidebar_order_set",
        json!({ "order": refs(&["a"]) }),
    )
    .await
    .unwrap();
    let types = |page: Value| -> Vec<String> {
        page["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["type"].as_str().unwrap().to_owned())
            .collect()
    };
    let wait = json!({ "cursor": 0, "timeoutSec": 0 });
    let anns = call(&hub, &ann_desk, "events_wait", wait.clone())
        .await
        .unwrap();
    assert!(types(anns).contains(&"sidebar.order".to_owned()));
    let bobs = call(&hub, &bob_desk, "events_wait", wait).await.unwrap();
    assert!(!types(bobs).contains(&"sidebar.order".to_owned()));
}
