//! A project's built-in icon over a real hub: one never picked is derived from its id, stable and varied; a pick is
//! kept, sent in every summary and forgets the picture, each change a project.settings event; a reader can't pick
//! one, nor anyone for a project the hub doesn't know. The faces and colors match the images the apps ship.
use std::collections::HashSet;
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::auth::{Grant, KeyKind};
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::mcp::ErrorCode;
use fleetd_contracts::model::{IconColor, IconFace, ProjectIcon, ProjectSummary};
use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
use serde_json::{Value, json};

use super::icon::derived;
use crate::hub::api::{CallError, Caller, Hub, HubConfig, Listen, registry};
use crate::hub::store::test_clock::ManualClock;
use crate::hub::store::{HubDb, WaitInput};

fn project() -> ProjectRef {
    ProjectRef {
        machine_id: MachineId::unchecked("devbox"),
        project_id: ProjectId::unchecked("app"),
    }
}

fn hub() -> (Arc<Hub>, tempfile::TempDir) {
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
    let summary: ProjectSummary = serde_json::from_value(json!({
        "machineId": "devbox", "projectId": "app", "title": "Billing API", "workspaceRoot": "/work/app",
        "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 }, "lastActivityAt": "2026-10-30T10:00:00.000Z",
    }))
    .unwrap();
    hub.store
        .projects_upsert_many(&project().machine_id, &[summary])
        .unwrap();
    (hub, home)
}

fn key(hub: &Hub, role: &str) -> Caller {
    let grants: Vec<Grant> =
        serde_json::from_value(json!([{ "role": role, "machines": "*" }])).unwrap();
    hub.auth
        .create_key_for("desk", &grants, KeyKind::Agent, None)
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

fn pick(face: &str, color: &str) -> Value {
    json!({ "machineId": "devbox", "projectId": "app", "icon": { "face": face, "color": color } })
}

fn icon_of(hub: &Hub) -> ProjectIcon {
    hub.store
        .project_get(&project())
        .unwrap()
        .unwrap()
        .icon
        .unwrap()
}

fn settings_events(hub: &Hub) -> Vec<Value> {
    let page = futures_util::FutureExt::now_or_never(hub.events.wait(WaitInput {
        cursor: Some(0),
        types: Some(vec![HubEventType::ProjectSettings]),
        machine_id: None,
        timeout_sec: 0,
    }))
    .unwrap()
    .unwrap();
    page.events.into_iter().filter_map(|e| e.data).collect()
}

fn r(project_id: &str) -> ProjectRef {
    ProjectRef {
        machine_id: MachineId::unchecked("devbox"),
        project_id: ProjectId::unchecked(project_id),
    }
}

#[test]
fn an_unpicked_icon_is_derived_from_its_id_the_same_every_time_and_varied() {
    // Pinned: a change here would give every existing project and Navi another face.
    assert_eq!(
        derived(&r("app")),
        ProjectIcon {
            face: IconFace::Wink,
            color: IconColor::Teal
        }
    );
    assert_eq!(derived(&r("app")), derived(&r("app")));
    let many: Vec<ProjectIcon> = (0..60).map(|i| derived(&r(&format!("navi-{i}")))).collect();
    let faces: HashSet<IconFace> = many.iter().map(|i| i.face).collect();
    let colors: HashSet<IconColor> = many.iter().map(|i| i.color).collect();
    assert_eq!(faces.len(), IconFace::ALL.len(), "{faces:?}");
    assert!(colors.len() >= 10, "{colors:?}");
    let pairs: HashSet<ProjectIcon> = many.into_iter().collect();
    assert!(pairs.len() >= 40, "{} different of 60", pairs.len());
}

#[tokio::test]
async fn a_summary_wears_its_derived_icon_until_one_is_picked_which_is_kept_and_sent() {
    let (hub, _home) = hub();
    let desk = key(&hub, "operate");
    assert_eq!(icon_of(&hub), derived(&project()));
    let sent = serde_json::to_value(hub.store.project_get(&project()).unwrap().unwrap()).unwrap();
    assert_eq!(
        sent["icon"],
        json!({ "face": "wink", "color": "teal" }),
        "{sent}"
    );

    let out = ok(&hub, &desk, "project_icon_set", pick("wink", "sun")).await;
    assert_eq!(
        out["project"]["icon"],
        json!({ "face": "wink", "color": "sun" })
    );
    assert_eq!(
        icon_of(&hub),
        ProjectIcon {
            face: IconFace::Wink,
            color: IconColor::Sun
        }
    );
    // A node's report of the project keeps the pick: the hub's alone.
    let again: ProjectSummary = serde_json::from_value(json!({
        "machineId": "devbox", "projectId": "app", "title": "Billing API", "workspaceRoot": "/work/app",
        "threads": { "running": 1, "waiting": 0, "idle": 0, "failed": 0 }, "lastActivityAt": "2026-10-30T11:00:00.000Z",
        "icon": { "face": "mo", "color": "fleet" },
    }))
    .unwrap();
    hub.store
        .projects_upsert_many(&project().machine_id, &[again])
        .unwrap();
    assert_eq!(icon_of(&hub).face, IconFace::Wink);

    ok(&hub, &desk, "project_icon_set", pick("joy", "graphite")).await;
    assert_eq!(
        icon_of(&hub),
        ProjectIcon {
            face: IconFace::Joy,
            color: IconColor::Graphite
        }
    );
    assert_eq!(
        settings_events(&hub),
        vec![
            json!({ "icon": { "face": "wink", "color": "sun" }, "avatar": null }),
            json!({ "icon": { "face": "joy", "color": "graphite" }, "avatar": null }),
        ]
    );
}

#[tokio::test]
async fn picking_an_icon_takes_the_place_of_its_picture() {
    let (hub, _home) = hub();
    let desk = key(&hub, "operate");
    let mut photo = Vec::new();
    DynamicImage::ImageRgb8(RgbImage::from_pixel(64, 64, Rgb([200, 40, 40])))
        .write_to(&mut std::io::Cursor::new(&mut photo), ImageFormat::Png)
        .unwrap();
    let put = json!({ "name": "photo", "mime": "image/png", "dataB64": B64.encode(&photo) });
    let id = ok(&hub, &desk, "attachment_put", put).await["attachmentId"].clone();
    let set = json!({ "machineId": "devbox", "projectId": "app", "attachmentId": id });
    ok(&hub, &desk, "project_avatar_set", set).await;
    assert!(
        hub.store
            .project_get(&project())
            .unwrap()
            .unwrap()
            .avatar
            .is_some()
    );

    let out = ok(&hub, &desk, "project_icon_set", pick("cy", "plum")).await;
    assert!(out["project"].get("avatar").is_none(), "{out}");
    assert_eq!(
        out["project"]["icon"],
        json!({ "face": "cy", "color": "plum" })
    );
    let read = call(
        &hub,
        &desk,
        "project_avatar_get",
        json!({ "machineId": "devbox", "projectId": "app" }),
    )
    .await;
    assert_eq!(code(read), ErrorCode::NotFound);
}

#[tokio::test]
async fn a_reader_cant_pick_one_nor_anyone_for_an_unknown_project_nor_a_face_that_isnt_one() {
    let (hub, _home) = hub();
    assert_eq!(
        code(
            call(
                &hub,
                &key(&hub, "read"),
                "project_icon_set",
                pick("wink", "sun")
            )
            .await
        ),
        ErrorCode::Forbidden
    );
    let desk = key(&hub, "operate");
    let elsewhere = json!({ "machineId": "devbox", "projectId": "gone", "icon": { "face": "wink", "color": "sun" } });
    assert_eq!(
        code(call(&hub, &desk, "project_icon_set", elsewhere).await),
        ErrorCode::NotFound
    );
    assert!(
        call(&hub, &desk, "project_icon_set", pick("smiley", "sun"))
            .await
            .is_err()
    );
    assert!(
        call(&hub, &desk, "project_icon_set", pick("wink", "neon"))
            .await
            .is_err()
    );
    assert_eq!(icon_of(&hub), derived(&project()));
    assert!(settings_events(&hub).is_empty());
}

/// The faces and colors the hub names are the ones app/shared/bot-icons builds images of, in the same order.
#[test]
fn its_faces_and_colors_are_the_shipped_ones() {
    let beings: Value = serde_json::from_str(include_str!(
        "../../../../../app/shared/bot-icons/glass/beings.json"
    ))
    .unwrap();
    let palette: Value = serde_json::from_str(include_str!(
        "../../../../../app/shared/bot-icons/palette.json"
    ))
    .unwrap();
    let ids = |list: &Value| -> Vec<String> {
        list.as_array()
            .unwrap()
            .iter()
            .map(|v| v["id"].as_str().unwrap().to_owned())
            .collect()
    };
    let names = |all: Vec<Value>| -> Vec<String> {
        all.into_iter()
            .map(|v| v.as_str().unwrap().to_owned())
            .collect()
    };
    assert_eq!(
        names(
            IconFace::ALL
                .iter()
                .map(|f| serde_json::to_value(f).unwrap())
                .collect()
        ),
        ids(&beings["beings"])
    );
    assert_eq!(
        names(
            IconColor::ALL
                .iter()
                .map(|c| serde_json::to_value(c).unwrap())
                .collect()
        ),
        ids(&palette["colors"])
    );
}
