//! A person's pinned chats over a real hub: kept per person in their order, the same on each of their devices, never
//! another's, at most nine, and announced only to their own devices.
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

async fn get(hub: &std::sync::Arc<crate::hub::api::Hub>, phone: &Caller) -> Value {
    call(hub, phone, "chat_pins_get", json!({})).await.unwrap()
}

#[tokio::test]
async fn each_person_keeps_their_own_pins_on_every_device() {
    let (hub, _home) = hub();
    let ann = owner(&hub);
    let bob = member(&hub, "Bob");
    let ann_phone = device(&hub, &ann, "operate");
    let ann_ipad = device(&hub, &ann, "read");
    let bob_phone = device(&hub, &bob, "operate");

    // Never set: empty, and a phone sends up the pins it kept on its own.
    assert_eq!(
        get(&hub, &ann_phone).await,
        json!({ "pins": [], "set": false })
    );

    let set = call(
        &hub,
        &ann_phone,
        "chat_pins_set",
        json!({ "pins": refs(&["ada", "web", "api"]) }),
    )
    .await
    .unwrap();
    assert_eq!(set["pins"], refs(&["ada", "web", "api"]));
    // Her other device reads the same, in her order, even on a read-only key.
    assert_eq!(
        get(&hub, &ann_ipad).await,
        json!({ "pins": refs(&["ada", "web", "api"]), "set": true })
    );
    // Bob's don't follow hers.
    assert_eq!(get(&hub, &bob_phone).await["set"], json!(false));

    // A new order replaces the one before; unpinning them all is still a choice made.
    call(
        &hub,
        &ann_ipad,
        "chat_pins_set",
        json!({ "pins": refs(&["api", "ada"]) }),
    )
    .await
    .unwrap();
    assert_eq!(get(&hub, &ann_phone).await["pins"], refs(&["api", "ada"]));
    call(&hub, &ann_phone, "chat_pins_set", json!({ "pins": [] }))
        .await
        .unwrap();
    assert_eq!(
        get(&hub, &ann_phone).await,
        json!({ "pins": [], "set": true })
    );
}

#[tokio::test]
async fn they_are_kept_in_the_hubs_database() {
    let (hub, _home) = hub();
    let ann = owner(&hub);
    let phone = device(&hub, &ann, "operate");
    assert_eq!(super::pins(&hub.db, &ann).unwrap(), None);
    call(
        &hub,
        &phone,
        "chat_pins_set",
        json!({ "pins": refs(&["b", "a"]) }),
    )
    .await
    .unwrap();
    // In its table, which a restarted hub reads again.
    let kept = super::pins(&hub.db, &ann).unwrap();
    assert_eq!(serde_json::to_value(kept).unwrap(), refs(&["b", "a"]));
}

#[tokio::test]
async fn only_a_person_pins_at_most_nine_each_once() {
    let (hub, _home) = hub();
    let ann = owner(&hub);
    let phone = device(&hub, &ann, "operate");
    let agent = Caller {
        kind: Some(KeyKind::Agent),
        ..phone.clone()
    };
    let one = json!({ "pins": refs(&["a"]) });
    assert!(call(&hub, &agent, "chat_pins_set", one).await.is_err());
    // An agent's key reads none.
    assert_eq!(get(&hub, &agent).await, json!({ "pins": [], "set": false }));
    let twice = json!({ "pins": refs(&["a", "a"]) });
    assert!(call(&hub, &phone, "chat_pins_set", twice).await.is_err());
    let nine = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
    let ten = [&nine[..], &["j"]].concat();
    assert!(
        call(&hub, &phone, "chat_pins_set", json!({ "pins": refs(&ten) }))
            .await
            .is_err()
    );
    call(
        &hub,
        &phone,
        "chat_pins_set",
        json!({ "pins": refs(&nine) }),
    )
    .await
    .unwrap();
    assert_eq!(get(&hub, &phone).await["pins"], refs(&nine));
}

#[tokio::test]
async fn only_their_owners_devices_hear_of_a_change() {
    let (hub, _home) = hub();
    let ann = owner(&hub);
    let bob = member(&hub, "Bob");
    let ann_phone = device(&hub, &ann, "operate");
    let bob_phone = device(&hub, &bob, "operate");
    call(
        &hub,
        &ann_phone,
        "chat_pins_set",
        json!({ "pins": refs(&["a"]) }),
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
    let anns = call(&hub, &ann_phone, "events_wait", wait.clone())
        .await
        .unwrap();
    assert!(types(anns).contains(&"chat.pins".to_owned()));
    let bobs = call(&hub, &bob_phone, "events_wait", wait).await.unwrap();
    assert!(!types(bobs).contains(&"chat.pins".to_owned()));
}
