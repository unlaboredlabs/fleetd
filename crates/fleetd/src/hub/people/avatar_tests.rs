//! A person's own picture over a real hub: it is kept as a project's is (a JPEG at most 512 px square), named on the
//! person in hub_info and people_list, readable by anyone on the hub, removed again, and forgotten when the person is
//! removed; each change is a people.changed event; only a person's own device sets theirs.
use std::io::Cursor;
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::auth::{Grant, KeyKind};
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::mcp::{AVATAR_PX, ErrorCode};
use image::{DynamicImage, GenericImageView, ImageFormat, Rgb, RgbImage};
use serde_json::{Value, json};

use crate::hub::api::{CallError, Caller, Hub, HubConfig, Listen, registry};
use crate::hub::pair::{Limiter, PairCodes, handle};
use crate::hub::store::HubDb;
use crate::hub::store::test_clock::ManualClock;

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
    (hub, home)
}

/// A device paired with `code`, as the hub sees it on its next call.
fn redeem(hub: &Hub, code: &str, device: &str) -> Caller {
    let body = json!({ "code": code, "deviceName": device }).to_string();
    let (status, out) = handle(hub, &Limiter::default(), None, None, body.as_bytes());
    assert_eq!(status, axum::http::StatusCode::OK, "{out}");
    hub.auth.verify(out["key"].as_str().unwrap()).unwrap()
}

/// The owner's phone, paired with a plain `fleetd pair` code.
fn owner_phone(hub: &Hub) -> Caller {
    let minted = PairCodes::new(hub.db.clone(), hub.clock.clone())
        .create(None, crate::hub::pair::DEFAULT_ROLE)
        .unwrap();
    redeem(hub, &minted.code, "phone")
}

fn agent_key(hub: &Hub) -> Caller {
    let grants: Vec<Grant> =
        serde_json::from_value(json!([{ "role": "operate", "machines": "*" }])).unwrap();
    hub.auth
        .create_key_for("agent", &grants, KeyKind::Agent, None)
        .unwrap()
        .info
}

async fn call(hub: &Arc<Hub>, who: &Caller, tool: &str, input: Value) -> Result<Value, CallError> {
    registry().call(hub, who, tool, input).await
}

async fn ok(hub: &Arc<Hub>, who: &Caller, tool: &str, input: Value) -> Value {
    match call(hub, who, tool, input).await {
        Ok(v) => v,
        Err(e) => panic!("{tool}: {e:?}"),
    }
}

fn code(result: Result<Value, CallError>) -> ErrorCode {
    match result {
        Err(CallError::Tool(e)) => e.code,
        other => panic!("not refused: {other:?}"),
    }
}

/// A 1200 × 800 photo, uploaded as `who`: its attachment id.
async fn upload_photo(hub: &Arc<Hub>, who: &Caller) -> String {
    let photo = RgbImage::from_fn(1200, 800, |x, _| {
        if x < 600 {
            Rgb([230, 20, 20])
        } else {
            Rgb([20, 20, 230])
        }
    });
    let mut bytes = Vec::new();
    DynamicImage::ImageRgb8(photo)
        .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Jpeg)
        .unwrap();
    let put = json!({ "name": "photo", "mime": "image/jpeg", "dataB64": B64.encode(&bytes) });
    ok(hub, who, "attachment_put", put).await["attachmentId"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn picture_changes(hub: &Hub) -> Vec<Value> {
    hub.events
        .page(0, Some(&[HubEventType::PeopleChanged]), None)
        .unwrap()
        .events
        .into_iter()
        .filter_map(|e| e.data)
        .filter(|d| d["change"] == "picture_changed")
        .collect()
}

#[tokio::test]
async fn a_person_sets_their_own_picture_everyone_sees_it_and_removing_it_brings_the_initials_back()
{
    let (hub, _home) = hub();
    let phone = owner_phone(&hub);
    let me = phone.person.clone().expect("the phone is the owner's");
    let info = ok(&hub, &phone, "hub_info", json!({})).await;
    assert!(info["me"].get("avatar").is_none(), "{info}");

    let id = upload_photo(&hub, &phone).await;
    let crop = json!({ "x": 600, "y": 0, "size": 600 });
    let set = ok(
        &hub,
        &phone,
        "person_avatar_set",
        json!({ "attachmentId": id, "crop": crop }),
    )
    .await;
    let avatar = set["person"]["avatar"].as_str().unwrap().to_owned();
    assert_eq!(avatar.len(), 16);
    assert_eq!(set["person"]["personId"], json!(me.person_id));

    // hub_info's me and people_list name it, for every app.
    let info = ok(&hub, &phone, "hub_info", json!({})).await;
    assert_eq!(info["me"]["avatar"], json!(avatar));
    let list = ok(&hub, &phone, "people_list", json!({})).await;
    assert_eq!(list["people"][0]["avatar"], json!(avatar));

    // Anyone on the hub reads its bytes: the crop, a JPEG at most 512 px square.
    let got = ok(
        &hub,
        &agent_key(&hub),
        "person_avatar_get",
        json!({ "personId": me.person_id }),
    )
    .await;
    assert_eq!(got["avatar"], json!(avatar));
    assert_eq!(got["mime"], "image/jpeg");
    let bytes = B64.decode(got["dataB64"].as_str().unwrap()).unwrap();
    assert_eq!(image::guess_format(&bytes).unwrap(), ImageFormat::Jpeg);
    let picture = image::load_from_memory(&bytes).unwrap();
    assert_eq!(picture.dimensions(), (AVATAR_PX, AVATAR_PX));
    let [r, _, b, _] = picture.get_pixel(256, 256).0;
    assert!(b > 180 && r < 80, "the crop's right half, blue: {r} {b}");

    // Every open app hears it.
    let changes = picture_changes(&hub);
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0]["person"]["personId"], json!(me.person_id));

    // No attachment removes it: the initials again, and a read finds none.
    let removed = ok(&hub, &phone, "person_avatar_set", json!({})).await;
    assert!(removed["person"].get("avatar").is_none(), "{removed}");
    let info = ok(&hub, &phone, "hub_info", json!({})).await;
    assert!(info["me"].get("avatar").is_none(), "{info}");
    assert_eq!(
        code(
            call(
                &hub,
                &phone,
                "person_avatar_get",
                json!({ "personId": me.person_id })
            )
            .await
        ),
        ErrorCode::NotFound
    );
    assert_eq!(picture_changes(&hub).len(), 2);
}

#[tokio::test]
async fn only_a_persons_own_device_sets_theirs_and_a_removed_person_loses_it() {
    let (hub, _home) = hub();
    let owner = owner_phone(&hub);

    // An agent's key is no one's: refused, and nothing changes.
    assert_eq!(
        code(call(&hub, &agent_key(&hub), "person_avatar_set", json!({})).await),
        ErrorCode::Forbidden
    );
    assert!(picture_changes(&hub).is_empty());

    // A member sets their own, which leaves the owner's initials alone.
    let invite = ok(&hub, &owner, "invite_create", json!({ "name": "Alice" })).await;
    let alice = redeem(&hub, invite["code"].as_str().unwrap(), "Alice's phone");
    let alice_id = alice.person.clone().unwrap().person_id;
    let id = upload_photo(&hub, &alice).await;
    ok(
        &hub,
        &alice,
        "person_avatar_set",
        json!({ "attachmentId": id }),
    )
    .await;
    let list = ok(&hub, &owner, "people_list", json!({})).await;
    let people = list["people"].as_array().unwrap();
    assert!(people[0].get("avatar").is_none(), "{list}");
    assert!(people[1]["avatar"].is_string(), "{list}");

    // Removed, they keep their name but not their picture.
    ok(
        &hub,
        &owner,
        "person_remove",
        json!({ "personId": alice_id }),
    )
    .await;
    assert_eq!(
        code(
            call(
                &hub,
                &owner,
                "person_avatar_get",
                json!({ "personId": alice_id })
            )
            .await
        ),
        ErrorCode::NotFound
    );
    let list = ok(
        &hub,
        &owner,
        "people_list",
        json!({ "includeRemoved": true }),
    )
    .await;
    let gone = list["people"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["personId"] == json!(alice_id))
        .unwrap();
    assert!(gone.get("avatar").is_none(), "{gone}");
}
