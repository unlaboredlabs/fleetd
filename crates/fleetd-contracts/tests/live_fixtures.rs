//! Every fixture in `tests/fixtures/live` decodes as its wire type and encodes back to the same JSON, so the app's
//! fixtures and the hub agree on the shapes.

use fleetd_contracts::app::{AppClientMessage, AppServerMessage};
use fleetd_contracts::events::HubEvent;
use fleetd_contracts::mcp::*;
use fleetd_contracts::node_link::NodeToHub;
use fleetd_contracts::sessions::{SessionCallFrame, SessionReplyFrame, ThreadEventFrame};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

fn round_trip<T: DeserializeOwned + Serialize>(file: &str) {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/live")
        .join(file);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{file}: {e}"));
    let json: Value = serde_json::from_str(&text).unwrap();
    let decoded: T = serde_json::from_value(json.clone())
        .unwrap_or_else(|e| panic!("{file} does not decode: {e}"));
    assert_eq!(
        serde_json::to_value(&decoded).unwrap(),
        json,
        "{file} does not encode back to itself"
    );
}

#[test]
fn every_live_fixture_round_trips() {
    round_trip::<AppClientMessage>("app_client_live.json");
    round_trip::<AppClientMessage>("app_client_live_board_only.json");
    round_trip::<AppServerMessage>("app_server_live_full.json");
    round_trip::<AppServerMessage>("app_server_live_delta.json");
    round_trip::<OrdersBoardInput>("orders_board.input.json");
    round_trip::<OrdersBoardOutput>("orders_board.output.json");
    round_trip::<OrderGetInput>("order_get.input.json");
    round_trip::<OrderGetOutput>("order_get.output.json");
    round_trip::<OrderNoteInput>("order_note.input.json");
    round_trip::<OrderNoteOutput>("order_note.output.json");
    round_trip::<OrderStopInput>("order_stop.input.json");
    round_trip::<OrderStopOutput>("order_stop.output.json");
    round_trip::<IntakePreviewInput>("intake_preview.input.json");
    round_trip::<IntakePreviewOutput>("intake_preview.output.json");
    round_trip::<AttachmentPutInput>("attachment_put.input.json");
    round_trip::<AttachmentPutOutput>("attachment_put.output.json");
    round_trip::<ProjectFilesInput>("project_files.input.json");
    round_trip::<ProjectFilesOutput>("project_files.output.json");
    round_trip::<IntakeSubmitInput>("intake_submit.input.json");
    round_trip::<HubEvent>("hub_event_workstream_note.json");
    round_trip::<NodeToHub>("node_heartbeat.json");
    round_trip::<ThreadEventFrame>("thread_event_usage.json");
    round_trip::<SessionCallFrame>("session_call_list_files.json");
    round_trip::<SessionCallFrame>("session_call_put_file.json");
    round_trip::<SessionReplyFrame>("session_reply_files.json");
}

#[test]
fn every_fixture_file_is_checked() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/live");
    let listed = include_str!("live_fixtures.rs");
    for entry in std::fs::read_dir(dir).unwrap() {
        let name = entry.unwrap().file_name().into_string().unwrap();
        assert!(
            listed.contains(&format!("(\"{name}\")")),
            "{name} has no round_trip line"
        );
    }
}
