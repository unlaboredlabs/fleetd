use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use serde_json::{Value, json};

use crate::hub::api::{CallError, Caller, Hub, HubConfig, Listen};
use crate::hub::link::LeadCaller;
use crate::hub::link::lead_calls::CallerAgent;
use crate::hub::store::test_clock::ManualClock;
use crate::hub::store::{HubDb, WaitInput};

const AT: &str = "2026-10-26T10:00:00.000Z";
const NOW_MS: u64 = 1_792_000_000_000;
const S1: &str = "B0123456789abcdef0123456789abcdef";
const S2: &str = "Bfedcba9876543210fedcba9876543210";

fn project(id: &str) -> ProjectRef {
    ProjectRef {
        machine_id: MachineId::unchecked("devbox"),
        project_id: ProjectId::unchecked(id),
    }
}

fn hub() -> (Arc<Hub>, Arc<ManualClock>, tempfile::TempDir) {
    let home = tempfile::tempdir().unwrap();
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Listen::default(),
        url: None,
        queue_ttl_sec: None,
    };
    let clock = ManualClock::at(NOW_MS);
    let hub =
        crate::hub::serve::build_on(HubDb::open_memory().unwrap(), config, clock.clone()).unwrap();
    for id in ["storefront", "checkout"] {
        hub.store
            .projects_upsert_many(
                &MachineId::unchecked("devbox"),
                &[serde_json::from_value(json!({
                    "machineId": "devbox", "projectId": id, "title": id, "workspaceRoot": format!("/work/{id}"),
                    "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 }, "lastActivityAt": AT,
                }))
                .unwrap()],
            )
            .unwrap();
    }
    (hub, clock, home)
}

fn caller(grants: Value) -> Caller {
    serde_json::from_value(json!({
        "keyId": "k1", "name": "desk", "prefix": "fld_abcdef", "createdAt": AT, "grants": grants,
    }))
    .unwrap()
}

fn reader() -> Caller {
    caller(json!([{ "role": "read", "machines": "*" }]))
}

/// A lead call the node makes for a session of task T7 in `r`: the answer, or the refusal's words.
async fn node_call(hub: &Hub, r: &ProjectRef, mut call: Value, op: &str) -> Result<Value, String> {
    call["op"] = op.into();
    let call: LeadCall = serde_json::from_value(call).map_err(|e| e.to_string())?;
    let caller = LeadCaller {
        project_ref: r.clone(),
        by: crate::hub::link::lead_calls::lead_by(r),
        agent: CallerAgent::Task(fleetd_contracts::tasks::TaskId::unchecked("T7")),
    };
    let handler = hub.lead_calls.handler(op).unwrap();
    match handler.handle(caller, call).await {
        Ok(LeadCallResult::BrowserSession(out)) => Ok(serde_json::to_value(out).unwrap()),
        Ok(LeadCallResult::BrowserRecordingPart(out)) => Ok(serde_json::to_value(out).unwrap()),
        Ok(LeadCallResult::BrowserTakeover(out)) => Ok(serde_json::to_value(out).unwrap()),
        Ok(other) => Err(format!("not a browser result: {other:?}")),
        Err(e) => Err(format!("{:?} {}", e.code, e.message)),
    }
}

fn report(id: &str, state: &str, files: Value) -> Value {
    json!({
        "sessionId": id, "threadId": "th-1", "purpose": "Check the signup form", "state": state,
        "startedAt": crate::hub::store::iso_ms(NOW_MS as i64), "files": files,
    })
}

async fn part(
    hub: &Hub,
    r: &ProjectRef,
    id: &str,
    file: &str,
    offset: usize,
    data: &[u8],
) -> Result<Value, String> {
    node_call(
        hub,
        r,
        json!({ "sessionId": id, "file": file, "offset": offset, "dataB64": B64.encode(data) }),
        "browser_recording_part",
    )
    .await
}

async fn tool(hub: &Arc<Hub>, who: &Caller, name: &str, input: Value) -> Result<Value, CallError> {
    crate::hub::api::registry()
        .call(hub, who, name, input)
        .await
}

fn events(hub: &Hub) -> Vec<Value> {
    let page = futures_util::FutureExt::now_or_never(hub.events.wait(WaitInput {
        cursor: Some(0),
        types: Some(vec![HubEventType::BrowserSession]),
        machine_id: None,
        timeout_sec: 0,
    }))
    .unwrap()
    .unwrap();
    page.events
        .into_iter()
        .map(|e| serde_json::to_value(e).unwrap())
        .collect()
}

/// Reads a whole recorded file the way the app does, piece by piece.
async fn read_all(hub: &Arc<Hub>, id: &str, file: &str) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let piece = tool(
            hub,
            &reader(),
            "browser_recording_get",
            json!({ "sessionId": id, "file": file, "offset": out.len() }),
        )
        .await
        .unwrap();
        out.extend(B64.decode(piece["dataB64"].as_str().unwrap()).unwrap());
        if piece["done"] == true {
            return out;
        }
    }
}

#[tokio::test]
async fn a_session_is_reported_its_recording_uploaded_in_pieces_and_read_back() {
    let (hub, _clock, _home) = hub();
    let r = project("storefront");
    node_call(&hub, &r, report(S1, "live", json!([])), "browser_session")
        .await
        .unwrap();
    let listed = tool(
        &hub,
        &reader(),
        "browser_sessions",
        json!({ "projectRef": r }),
    )
    .await
    .unwrap();
    let session = &listed["sessions"][0];
    assert_eq!(session["state"], "live");
    assert_eq!(session["control"], "agent");
    assert_eq!(
        session["taskId"], "T7",
        "filed under the task whose agent opened it"
    );
    assert_eq!(
        listed["retention"],
        json!({ "retentionDays": 30, "maxGbPerProject": 20 })
    );

    let video: Vec<u8> = (0..1_200_000u32).map(|i| (i % 251) as u8).collect();
    let actions = b"{\"seq\":1,\"tool\":\"session_start\"}\n".to_vec();
    node_call(
        &hub,
        &r,
        report(S1, "uploading", json!([])),
        "browser_session",
    )
    .await
    .unwrap();
    let mut offset = 0;
    for piece in video.chunks(fleetd_contracts::browser::RECORDING_PART_BYTES) {
        let answer = part(&hub, &r, S1, "video", offset, piece).await.unwrap();
        offset += piece.len();
        assert_eq!(answer["bytes"], offset);
    }
    // A piece sent again after a lost answer replaces itself; one past the end would leave a gap.
    part(&hub, &r, S1, "actions", 0, &actions).await.unwrap();
    part(&hub, &r, S1, "actions", 0, &actions).await.unwrap();
    let gap = part(&hub, &r, S1, "dom", 10, b"x").await.unwrap_err();
    assert!(gap.contains("would leave a gap"), "{gap}");

    // Recorded only with the sizes the hub holds.
    let wrong = report(S1, "recorded", json!([{ "file": "video", "bytes": 5 }]));
    let refused = node_call(&hub, &r, wrong, "browser_session")
        .await
        .unwrap_err();
    assert!(refused.contains("holds 1200000 bytes"), "{refused}");
    let files = json!([{ "file": "actions", "bytes": actions.len() }, { "file": "video", "bytes": video.len() }]);
    node_call(
        &hub,
        &r,
        report(S1, "recorded", files.clone()),
        "browser_session",
    )
    .await
    .unwrap();

    let one = tool(
        &hub,
        &reader(),
        "browser_sessions",
        json!({ "projectRef": r, "sessionId": S1 }),
    )
    .await
    .unwrap();
    assert_eq!(one["sessions"][0]["state"], "recorded");
    assert_eq!(one["sessions"][0]["files"], files);
    assert_eq!(read_all(&hub, S1, "video").await, video);
    assert_eq!(read_all(&hub, S1, "actions").await, actions);
    let first = tool(
        &hub,
        &reader(),
        "browser_recording_get",
        json!({ "sessionId": S1, "file": "video" }),
    )
    .await
    .unwrap();
    assert_eq!(first["mime"], "video/webm");
    assert_eq!(first["bytes"], video.len());
    assert_eq!(first["done"], false);

    // Once recorded, nothing more lands, and a late report changes nothing.
    assert!(
        part(&hub, &r, S1, "dom", 0, b"x")
            .await
            .unwrap_err()
            .contains("takes no more pieces")
    );
    let late = node_call(&hub, &r, report(S1, "lost", json!([])), "browser_session")
        .await
        .unwrap();
    assert_eq!(late["state"], "recorded");

    let states: Vec<Value> = events(&hub)
        .iter()
        .map(|e| e["data"]["state"].clone())
        .collect();
    assert_eq!(
        states,
        [json!("live"), json!("uploading"), json!("recorded")]
    );
}

#[tokio::test]
async fn a_session_stays_its_projects() {
    let (hub, _clock, _home) = hub();
    let (mine, other) = (project("storefront"), project("checkout"));
    node_call(
        &hub,
        &mine,
        report(S1, "live", json!([])),
        "browser_session",
    )
    .await
    .unwrap();
    let refused = node_call(
        &hub,
        &other,
        report(S1, "live", json!([])),
        "browser_session",
    )
    .await
    .unwrap_err();
    assert!(refused.contains("another project's"), "{refused}");
    assert!(
        part(&hub, &other, S1, "video", 0, b"x")
            .await
            .unwrap_err()
            .contains("another project's")
    );
    // Read through the other project, it isn't there.
    let listed = tool(
        &hub,
        &reader(),
        "browser_sessions",
        json!({ "projectRef": other, "sessionId": S1 }),
    )
    .await
    .unwrap();
    assert_eq!(listed["sessions"], json!([]));
    // And a key that can't read its machine can't read its recording.
    let elsewhere = caller(json!([{ "role": "read", "machines": ["laptop"] }]));
    let hidden = tool(
        &hub,
        &elsewhere,
        "browser_recording_get",
        json!({ "sessionId": S1, "file": "video" }),
    )
    .await
    .unwrap_err();
    assert!(
        format!("{hidden:?}").contains("No browser session"),
        "{hidden:?}"
    );
}

#[tokio::test]
async fn retention_expires_old_recordings_then_a_projects_oldest_past_its_size() {
    let (hub, clock, home) = hub();
    let r = project("storefront");
    for id in [S1, S2] {
        node_call(&hub, &r, report(id, "live", json!([])), "browser_session")
            .await
            .unwrap();
        part(&hub, &r, id, "video", 0, b"0123456789").await.unwrap();
        let files = json!([{ "file": "video", "bytes": 10 }]);
        node_call(&hub, &r, report(id, "recorded", files), "browser_session")
            .await
            .unwrap();
    }
    assert_eq!(super::prune(&hub).unwrap(), 0);

    // Only an admin on every machine sets it.
    let one_machine = caller(json!([{ "role": "admin", "machines": ["devbox"] }]));
    let input = json!({ "retentionDays": 7, "maxGbPerProject": 1 });
    assert!(
        tool(&hub, &one_machine, "browser_retention_set", input.clone())
            .await
            .is_err()
    );
    let admin = caller(json!([{ "role": "admin", "machines": "*" }]));
    tool(&hub, &admin, "browser_retention_set", input)
        .await
        .unwrap();

    clock.advance(Duration::from_secs(8 * 86_400));
    assert_eq!(super::prune(&hub).unwrap(), 2);
    let listed = tool(
        &hub,
        &reader(),
        "browser_sessions",
        json!({ "projectRef": r }),
    )
    .await
    .unwrap();
    for s in listed["sessions"].as_array().unwrap() {
        assert_eq!(s["state"], "expired");
        assert_eq!(s["files"], json!([]));
    }
    assert!(!home.path().join("browser").join(S1).exists());
    assert!(
        tool(
            &hub,
            &reader(),
            "browser_recording_get",
            json!({ "sessionId": S1, "file": "video" })
        )
        .await
        .is_err()
    );
}

#[test]
fn the_size_cap_drops_a_projects_oldest_first() {
    let (hub, _clock, _home) = hub();
    let r = project("storefront");
    hub.db
        .transaction(|c| {
            super::set_retention(
                c,
                &serde_json::from_value(json!({ "retentionDays": 30, "maxGbPerProject": 1 }))
                    .unwrap(),
            )
        })
        .unwrap();
    // Two recordings of 0.6 GB each, as their rows say: together over 1 GB, so the older goes.
    for (id, started) in [(S1, NOW_MS - 2_000), (S2, NOW_MS - 1_000)] {
        let mut s: fleetd_contracts::browser::BrowserSession = serde_json::from_value(json!({
            "sessionId": id, "projectRef": r, "threadId": "th-1", "purpose": "p", "state": "recorded",
            "control": "agent", "startedAt": AT, "files": [{ "file": "video", "bytes": 644_245_094 }],
        }))
        .unwrap();
        s.credentials_filled = fleetd_contracts::prim::Count::unchecked(0);
        hub.db
            .transaction(|c| super::put_on(c, &s, started as i64))
            .unwrap();
    }
    assert_eq!(super::prune(&hub).unwrap(), 1);
    let old = super::get(
        &hub.db,
        &fleetd_contracts::browser::BrowserSessionId::unchecked(S1),
    )
    .unwrap()
    .unwrap();
    let new = super::get(
        &hub.db,
        &fleetd_contracts::browser::BrowserSessionId::unchecked(S2),
    )
    .unwrap()
    .unwrap();
    assert_eq!(old.state.as_str(), "expired");
    assert_eq!(new.state.as_str(), "recorded");
}

#[tokio::test]
async fn a_lost_session_keeps_no_partial_recording() {
    let (hub, _clock, home) = hub();
    let r = project("storefront");
    node_call(&hub, &r, report(S1, "live", json!([])), "browser_session")
        .await
        .unwrap();
    part(&hub, &r, S1, "video", 0, b"half").await.unwrap();
    let mut lost = report(S1, "lost", json!([]));
    lost["note"] = "its upload kept failing".into();
    node_call(&hub, &r, lost, "browser_session").await.unwrap();
    assert!(!home.path().join("browser").join(S1).exists());
    let listed = tool(
        &hub,
        &reader(),
        "browser_sessions",
        json!({ "projectRef": r }),
    )
    .await
    .unwrap();
    assert_eq!(listed["sessions"][0]["note"], "its upload kept failing");
}

fn person(grants: Value) -> Caller {
    Caller {
        kind: Some(fleetd_contracts::auth::KeyKind::Human),
        ..caller(grants)
    }
}

#[tokio::test]
async fn only_a_persons_device_takes_a_live_session_over_and_only_through_its_node() {
    let (hub, _clock, _home) = hub();
    let r = project("storefront");
    node_call(&hub, &r, report(S1, "live", json!([])), "browser_session")
        .await
        .unwrap();
    let input = json!({ "sessionId": S1, "control": "human" });
    let agent_key = caller(json!([{ "role": "operate", "machines": "*" }]));
    let refused = tool(&hub, &agent_key, "browser_control", input.clone())
        .await
        .unwrap_err();
    assert!(
        format!("{refused:?}").contains("Only a person's device"),
        "{refused:?}"
    );
    let reader = person(json!([{ "role": "read", "machines": "*" }]));
    assert!(
        tool(&hub, &reader, "browser_control", input.clone())
            .await
            .is_err()
    );
    // No node with the browser capability: it says so, and nothing changes.
    let operator = person(json!([{ "role": "operate", "machines": "*" }]));
    let offline = tool(&hub, &operator, "browser_control", input.clone())
        .await
        .unwrap_err();
    assert!(
        format!("{offline:?}").contains("isn't connected"),
        "{offline:?}"
    );
    let s = super::get(
        &hub.db,
        &fleetd_contracts::browser::BrowserSessionId::unchecked(S1),
    )
    .unwrap()
    .unwrap();
    assert_eq!(s.control, fleetd_contracts::browser::BrowserControl::Agent);
    // A session that ended can't be taken over.
    node_call(
        &hub,
        &r,
        report(S1, "uploading", json!([])),
        "browser_session",
    )
    .await
    .unwrap();
    let ended = tool(&hub, &operator, "browser_control", input)
        .await
        .unwrap_err();
    assert!(format!("{ended:?}").contains("not live"), "{ended:?}");
}

#[tokio::test]
async fn a_takeover_request_waits_on_you_until_a_person_has_control() {
    let (hub, _clock, _home) = hub();
    let r = project("storefront");
    node_call(&hub, &r, report(S1, "live", json!([])), "browser_session")
        .await
        .unwrap();
    node_call(
        &hub,
        &r,
        json!({ "sessionId": S1, "reason": "Solve the captcha" }),
        "browser_takeover",
    )
    .await
    .unwrap();
    let (counts, items) = crate::hub::status::groups::read(&hub, &r, false, NOW_MS as i64);
    assert_eq!(counts.waiting_on_you.get(), 1);
    let item = items
        .iter()
        .find(|i| i.why.as_ref().is_some_and(|w| w.as_str() == "browser"))
        .unwrap();
    assert_eq!(
        item.title.as_str(),
        "Take over the browser: Solve the captcha"
    );
    assert_eq!(item.task_id.as_ref().unwrap().as_str(), "T7");
    // The node reports the person has control: no longer waiting.
    let mut human = report(S1, "live", json!([]));
    human["control"] = "human".into();
    node_call(&hub, &r, human, "browser_session").await.unwrap();
    assert!(super::waiting(&hub.db, &r).unwrap().is_empty());
    let (counts, _) = crate::hub::status::groups::read(&hub, &r, false, NOW_MS as i64);
    assert_eq!(counts.waiting_on_you.get(), 0);
}

#[tokio::test]
async fn live_frames_go_only_to_watchers_of_their_session_and_the_node_hears_the_first_and_last() {
    use fleetd_contracts::browser::{BrowserFrame, BrowserSessionId};
    let (hub, _clock, _home) = hub();
    let live = hub.link.browser_live.clone();
    let devbox = MachineId::unchecked("devbox");
    let (s1, s2) = (
        BrowserSessionId::unchecked(S1),
        BrowserSessionId::unchecked(S2),
    );
    let frame = |id: &str, seq: u64| -> BrowserFrame {
        serde_json::from_value(json!({
            "sessionId": id, "seq": seq, "jpegB64": "AA==", "width": 4, "height": 3, "control": "agent",
        }))
        .unwrap()
    };
    let mut first = live.watch(&hub.link, &devbox, &s1);
    let second = live.watch(&hub.link, &devbox, &s1);
    assert_eq!(live.watchers(&s1), 2);
    assert_eq!(
        live.rewatch(&devbox).len(),
        1,
        "a reconnecting node hears it again"
    );
    assert!(live.rewatch(&MachineId::unchecked("laptop")).is_empty());
    // A frame of an unwatched session, or from another machine, goes nowhere.
    live.frame(&devbox, frame(S2, 1));
    live.frame(&MachineId::unchecked("laptop"), frame(S1, 1));
    live.frame(&devbox, frame(S1, 2));
    assert_eq!(first.frames.try_recv().unwrap().seq, 2);
    assert!(first.frames.try_recv().is_err());
    drop(second);
    assert_eq!(live.watchers(&s1), 1);
    drop(first);
    assert_eq!(live.watchers(&s1), 0);
    assert_eq!(live.watchers(&s2), 0);
}

#[tokio::test]
async fn partial_uploads_count_toward_the_cap_and_go_once_stale_past_the_retention() {
    let (hub, clock, home) = hub();
    let r = project("storefront");
    // An upload a node started and never finished.
    node_call(
        &hub,
        &r,
        report(S1, "uploading", json!([])),
        "browser_session",
    )
    .await
    .unwrap();
    part(&hub, &r, S1, "video", 0, b"0123456789").await.unwrap();
    assert_eq!(
        super::prune(&hub).unwrap(),
        0,
        "an upload still going is never cut short"
    );

    // Past its retention it goes, files and all, though it never became a recording.
    let admin = caller(json!([{ "role": "admin", "machines": "*" }]));
    let tight = json!({ "retentionDays": 2, "maxGbPerProject": 20 });
    tool(&hub, &admin, "browser_retention_set", tight)
        .await
        .unwrap();
    clock.advance(Duration::from_secs(3 * 86_400));
    assert_eq!(super::prune(&hub).unwrap(), 1);
    let s = super::get(
        &hub.db,
        &fleetd_contracts::browser::BrowserSessionId::unchecked(S1),
    )
    .unwrap()
    .unwrap();
    assert_eq!(s.state.as_str(), "expired");
    assert!(!home.path().join("browser").join(S1).exists());
}

#[tokio::test]
async fn a_fresh_partial_upload_counts_toward_its_projects_size() {
    let (hub, clock, _home) = hub();
    let r = project("storefront");
    // A recording of 0.6 GB as its row says, then, a day later, an upload in progress whose disk use is checked.
    let s: fleetd_contracts::browser::BrowserSession = serde_json::from_value(json!({
        "sessionId": S1, "projectRef": r, "threadId": "th-1", "purpose": "p", "state": "recorded",
        "control": "agent", "startedAt": AT, "files": [{ "file": "video", "bytes": 644_245_094 }],
    }))
    .unwrap();
    hub.db
        .transaction(|c| super::put_on(c, &s, NOW_MS as i64))
        .unwrap();
    hub.db
        .transaction(|c| {
            super::set_retention(
                c,
                &serde_json::from_value(json!({ "retentionDays": 30, "maxGbPerProject": 1 }))
                    .unwrap(),
            )
        })
        .unwrap();
    clock.advance(Duration::from_secs(86_400 + 60));
    node_call(
        &hub,
        &r,
        report(S2, "uploading", json!([])),
        "browser_session",
    )
    .await
    .unwrap();
    // Its file stands in for half a GB on disk: sparse, so the test writes nothing much.
    let dir = super::dir(
        &hub,
        &fleetd_contracts::browser::BrowserSessionId::unchecked(S2),
    );
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::File::create(dir.join("video.webm"))
        .unwrap()
        .set_len(536_870_912)
        .unwrap();
    assert_eq!(
        super::prune(&hub).unwrap(),
        1,
        "together over 1 GB: the older recording goes"
    );
    let old = super::get(
        &hub.db,
        &fleetd_contracts::browser::BrowserSessionId::unchecked(S1),
    )
    .unwrap()
    .unwrap();
    let new = super::get(
        &hub.db,
        &fleetd_contracts::browser::BrowserSessionId::unchecked(S2),
    )
    .unwrap()
    .unwrap();
    assert_eq!(old.state.as_str(), "expired");
    assert_eq!(
        new.state.as_str(),
        "uploading",
        "the upload in progress stays"
    );
}
