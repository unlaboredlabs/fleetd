//! A project's picture over a real hub: the hub keeps the crop, upright, at most 512 px square, as a JPEG with none of
//! the original's metadata, and forgets the upload; the summary names it and changes with it; Remove brings the
//! letters back; each change is a project.settings event; a reader can't set one, nor a key use another's upload.
use std::io::Cursor;
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::auth::{Grant, KeyKind};
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::mcp::{AVATAR_PX, ErrorCode};
use fleetd_contracts::model::ProjectSummary;
use image::{DynamicImage, GenericImageView, ImageFormat, Rgb, RgbImage, Rgba, RgbaImage};
use serde_json::{Value, json};

use super::avatar::AVATAR_MAX_BYTES;
use crate::hub::api::{CallError, Caller, Hub, HubConfig, Listen, registry};
use crate::hub::store::test_clock::ManualClock;
use crate::hub::store::{HubDb, WaitInput};

const AT: &str = "2026-10-30T10:00:00.000Z";
const GPS: &[u8] = b"GPS 37.7749 N 122.4194 W";

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
        "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 }, "lastActivityAt": AT,
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

async fn upload(hub: &Arc<Hub>, who: &Caller, bytes: &[u8], mime: &str) -> String {
    let put = json!({ "name": "photo", "mime": mime, "dataB64": B64.encode(bytes) });
    ok(hub, who, "attachment_put", put).await["attachmentId"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn set_input(attachment: Option<&str>, crop: Option<Value>) -> Value {
    let mut v = json!({ "machineId": "devbox", "projectId": "app" });
    if let Some(a) = attachment {
        v["attachmentId"] = json!(a);
    }
    if let Some(c) = crop {
        v["crop"] = c;
    }
    v
}

fn jpeg(picture: &DynamicImage) -> Vec<u8> {
    let mut out = Vec::new();
    picture
        .write_to(&mut Cursor::new(&mut out), ImageFormat::Jpeg)
        .unwrap();
    out
}

/// A camera's JPEG: its EXIF says to turn it a quarter clockwise (orientation 6) and where it was taken.
fn with_exif(jpeg: &[u8]) -> Vec<u8> {
    let mut tiff = b"MM\0\x2a\0\0\0\x08".to_vec();
    tiff.extend_from_slice(&[0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]);
    tiff.extend_from_slice(GPS);
    let mut app1 = b"Exif\0\0".to_vec();
    app1.extend_from_slice(&tiff);
    let len = u16::try_from(app1.len() + 2).unwrap().to_be_bytes();
    let mut out = jpeg[..2].to_vec();
    out.extend_from_slice(&[0xFF, 0xE1, len[0], len[1]]);
    out.extend_from_slice(&app1);
    out.extend_from_slice(&jpeg[2..]);
    out
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

/// The red, green and blue of the kept picture at (x, y).
fn at(kept: &DynamicImage, x: u32, y: u32) -> [u8; 3] {
    let p = kept.get_pixel(x, y).0;
    [p[0], p[1], p[2]]
}

fn reddish([r, g, b]: [u8; 3]) -> bool {
    r > 180 && g < 80 && b < 80
}

fn blueish([r, g, b]: [u8; 3]) -> bool {
    b > 180 && r < 80 && g < 80
}

async fn kept(hub: &Arc<Hub>, who: &Caller) -> (String, Vec<u8>) {
    let got = ok(hub, who, "project_avatar_get", set_input(None, None)).await;
    assert_eq!(got["mime"], "image/jpeg");
    (
        got["avatar"].as_str().unwrap().to_owned(),
        B64.decode(got["dataB64"].as_str().unwrap()).unwrap(),
    )
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

#[tokio::test]
async fn a_photo_is_kept_upright_cropped_small_and_without_its_metadata() {
    let (hub, home) = hub();
    let desk = key(&hub, "operate");
    // 3000 × 2000 as stored, top half red, bottom half blue; upright (turned a quarter clockwise) it is 2000 × 3000,
    // blue on the left and red on the right.
    let stored = RgbImage::from_fn(3000, 2000, |_, y| {
        if y < 1000 {
            Rgb([230, 20, 20])
        } else {
            Rgb([20, 20, 230])
        }
    });
    let photo = with_exif(&jpeg(&DynamicImage::ImageRgb8(stored)));
    assert!(contains(&photo, b"Exif") && contains(&photo, GPS));
    let id = upload(&hub, &desk, &photo, "image/jpeg").await;

    // The square 2000 px tall from y 500: inside the upright picture only.
    let crop = json!({ "x": 0, "y": 500, "size": 2000 });
    let out = ok(
        &hub,
        &desk,
        "project_avatar_set",
        set_input(Some(&id), Some(crop)),
    )
    .await;
    let avatar = out["project"]["avatar"].as_str().unwrap().to_owned();
    assert_eq!(avatar.len(), 16);

    let (named, bytes) = kept(&hub, &desk).await;
    assert_eq!(named, avatar);
    assert!(bytes.len() <= AVATAR_MAX_BYTES, "{} bytes", bytes.len());
    assert!(!contains(&bytes, b"Exif"), "EXIF kept");
    assert!(!contains(&bytes, GPS), "location kept");
    let picture = image::load_from_memory(&bytes).unwrap();
    assert_eq!(image::guess_format(&bytes).unwrap(), ImageFormat::Jpeg);
    assert_eq!(picture.dimensions(), (AVATAR_PX, AVATAR_PX));
    assert!(
        blueish(at(&picture, 64, 256)),
        "{:?}",
        at(&picture, 64, 256)
    );
    assert!(
        reddish(at(&picture, 448, 256)),
        "{:?}",
        at(&picture, 448, 256)
    );

    // The summary every app reads names it, and the original upload is gone with its file.
    let summary = hub.store.project_get(&project()).unwrap().unwrap();
    assert_eq!(summary.avatar.as_deref(), Some(avatar.as_str()));
    assert_eq!(
        code(
            call(
                &hub,
                &desk,
                "attachment_get",
                json!({ "projectRef": project(), "attachmentId": id })
            )
            .await
        ),
        ErrorCode::NotFound
    );
    let files: Vec<_> = std::fs::read_dir(home.path().join("attachments"))
        .unwrap()
        .flatten()
        .filter(|e| e.path().is_file())
        .collect();
    assert!(files.is_empty(), "{files:?}");
}

#[tokio::test]
async fn a_small_transparent_png_is_centred_on_white_and_not_enlarged() {
    let (hub, _home) = hub();
    let desk = key(&hub, "operate");
    // 300 × 200: clear but for a red block in the middle.
    let logo = RgbaImage::from_fn(300, 200, |x, y| {
        if (100..200).contains(&x) && (50..150).contains(&y) {
            Rgba([230, 20, 20, 255])
        } else {
            Rgba([0, 0, 0, 0])
        }
    });
    let mut png = Vec::new();
    DynamicImage::ImageRgba8(logo)
        .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
        .unwrap();
    let id = upload(&hub, &desk, &png, "image/png").await;
    ok(
        &hub,
        &desk,
        "project_avatar_set",
        set_input(Some(&id), None),
    )
    .await;
    let picture = image::load_from_memory(&kept(&hub, &desk).await.1).unwrap();
    assert_eq!(picture.dimensions(), (200, 200));
    assert!(reddish(at(&picture, 100, 100)));
    let [r, g, b] = at(&picture, 5, 5);
    assert!(r > 240 && g > 240 && b > 240, "{:?}", [r, g, b]);
}

#[tokio::test]
async fn a_new_picture_changes_its_id_and_remove_brings_the_letters_back_each_with_an_event() {
    let (hub, _home) = hub();
    let desk = key(&hub, "operate");
    let red = jpeg(&DynamicImage::ImageRgb8(RgbImage::from_pixel(
        64,
        64,
        Rgb([230, 20, 20]),
    )));
    let blue = jpeg(&DynamicImage::ImageRgb8(RgbImage::from_pixel(
        64,
        64,
        Rgb([20, 20, 230]),
    )));
    let first = upload(&hub, &desk, &red, "image/jpeg").await;
    let one = ok(
        &hub,
        &desk,
        "project_avatar_set",
        set_input(Some(&first), None),
    )
    .await["project"]["avatar"]
        .clone();
    let second = upload(&hub, &desk, &blue, "image/jpeg").await;
    let two = ok(
        &hub,
        &desk,
        "project_avatar_set",
        set_input(Some(&second), None),
    )
    .await["project"]["avatar"]
        .clone();
    assert_ne!(one, two);
    assert!(blueish(at(
        &image::load_from_memory(&kept(&hub, &desk).await.1).unwrap(),
        32,
        32
    )));

    let out = ok(&hub, &desk, "project_avatar_set", set_input(None, None)).await;
    assert!(out["project"].get("avatar").is_none(), "{out}");
    assert_eq!(
        hub.store.project_get(&project()).unwrap().unwrap().avatar,
        None
    );
    assert_eq!(
        code(call(&hub, &desk, "project_avatar_get", set_input(None, None)).await),
        ErrorCode::NotFound
    );
    assert_eq!(
        settings_events(&hub),
        vec![
            json!({ "avatar": one }),
            json!({ "avatar": two }),
            json!({ "avatar": null })
        ]
    );
}

#[tokio::test]
async fn a_reader_cant_set_one_nor_a_key_use_another_keys_upload_nor_a_file_that_isnt_a_picture() {
    let (hub, _home) = hub();
    let desk = key(&hub, "operate");
    let other = key(&hub, "operate");
    let reader = key(&hub, "read");
    let photo = jpeg(&DynamicImage::ImageRgb8(RgbImage::from_pixel(
        64,
        64,
        Rgb([230, 20, 20]),
    )));
    let id = upload(&hub, &desk, &photo, "image/jpeg").await;

    assert_eq!(
        code(
            call(
                &hub,
                &reader,
                "project_avatar_set",
                set_input(Some(&id), None)
            )
            .await
        ),
        ErrorCode::Forbidden
    );
    assert_eq!(
        code(call(&hub, &reader, "project_avatar_set", set_input(None, None)).await),
        ErrorCode::Forbidden
    );
    assert_eq!(
        code(
            call(
                &hub,
                &other,
                "project_avatar_set",
                set_input(Some(&id), None)
            )
            .await
        ),
        ErrorCode::NotFound
    );
    let text = upload(&hub, &desk, b"not a picture at all", "image/png").await;
    assert_eq!(
        code(
            call(
                &hub,
                &desk,
                "project_avatar_set",
                set_input(Some(&text), None)
            )
            .await
        ),
        ErrorCode::Invalid
    );
    // Nothing changed, and a reader still reads the picture once there is one.
    assert!(settings_events(&hub).is_empty());
    ok(
        &hub,
        &desk,
        "project_avatar_set",
        set_input(Some(&id), None),
    )
    .await;
    assert_eq!(kept(&hub, &reader).await.0.len(), 16);
}

#[test]
fn a_crop_is_clamped_inside_the_picture() {
    use fleetd_contracts::mcp::AvatarCrop;
    use fleetd_contracts::prim::Int;
    let crop = |x, y, size| {
        Some(AvatarCrop {
            x: Int::unchecked(x),
            y: Int::unchecked(y),
            size: Int::unchecked(size),
        })
    };
    let picture = DynamicImage::ImageRgb8(RgbImage::from_fn(100, 60, |x, _| {
        if x < 50 {
            Rgb([230, 20, 20])
        } else {
            Rgb([20, 20, 230])
        }
    }));
    let bytes = jpeg(&picture);
    // Too big and past the right edge: the 60 px square at the right.
    let kept = image::load_from_memory(&super::avatar::render(&bytes, crop(90, 10, 500)).unwrap())
        .unwrap();
    assert_eq!(kept.dimensions(), (60, 60));
    assert!(blueish(at(&kept, 45, 30)));
    // A 20 px square at the left.
    let kept =
        image::load_from_memory(&super::avatar::render(&bytes, crop(0, 0, 20)).unwrap()).unwrap();
    assert_eq!(kept.dimensions(), (20, 20));
    assert!(reddish(at(&kept, 10, 10)));
}
