//! Every T3 method fleetd uses, with the Rust types it sends and reads: the client calls these tags, and
//! `cargo xtask t3-conformance` diffs each entry against T3's own contracts at the pin.
use schemars::{
    JsonSchema, Schema,
    generate::{Contract, SchemaSettings},
};

use crate::types::*;

pub const LAUNCH_THREAD: &str = "orchestration.launchThread";
pub const DISPATCH_COMMAND: &str = "orchestration.dispatchCommand";
pub const SUBSCRIBE_SHELL: &str = "orchestration.subscribeShell";
pub const SUBSCRIBE_THREAD: &str = "orchestration.subscribeThread";
pub const GET_THREAD_PROJECTION: &str = "orchestration.getThreadProjection";
pub const GET_TURN_ITEM: &str = "orchestration.getTurnItem";
pub const GET_TURN_DIFF: &str = "orchestration.getTurnDiff";
pub const SERVER_GET_CONFIG: &str = "server.getConfig";
pub const SERVER_GET_SETTINGS: &str = "server.getSettings";
pub const SERVER_UPDATE_SETTINGS: &str = "server.updateSettings";
pub const PROJECTS_READ_FILE: &str = "projects.readFile";
pub const PROJECTS_MUTATE: &str = "projects.mutate";
pub const VCS_LIST_REFS: &str = "vcs.listRefs";
/// Not an RPC: the HTTP ticket exchange before the socket opens. Only its response is checked.
pub const HTTP_WS_TICKET: &str = "http:auth.webSocketTicket";

pub struct MethodSpec {
    pub tag: &'static str,
    pub stream: bool,
    /// What fleetd sends. `None` for the HTTP ticket, which has no body.
    pub payload: Option<fn() -> Schema>,
    /// What fleetd reads: the result, or each stream element.
    pub success: fn() -> Schema,
    /// The typed failure fleetd reads. `None` for the HTTP ticket.
    pub error: Option<fn() -> Schema>,
}

/// How fleetd serializes what it sends. Every optional sent field has `skip_serializing_if = "Option::is_none"`,
/// so fleetd never sends `null` and the conformance diff ignores the `null` schemars adds for an `Option`.
pub fn send_schema<T: JsonSchema>() -> Schema {
    SchemaSettings::draft2020_12()
        .with(|s| s.contract = Contract::Serialize)
        .into_generator()
        .into_root_schema_for::<T>()
}

/// A read value accepts `null` wherever a field is optional.
pub fn read_schema<T: JsonSchema>() -> Schema {
    SchemaSettings::draft2020_12()
        .into_generator()
        .into_root_schema_for::<T>()
}

const fn rpc(
    tag: &'static str,
    stream: bool,
    payload: fn() -> Schema,
    success: fn() -> Schema,
) -> MethodSpec {
    MethodSpec {
        tag,
        stream,
        payload: Some(payload),
        success,
        error: Some(read_schema::<ErrorTag>),
    }
}

pub const USED: &[MethodSpec] = &[
    rpc(
        LAUNCH_THREAD,
        false,
        send_schema::<LaunchThreadInput>,
        read_schema::<LaunchThreadResult>,
    ),
    rpc(
        DISPATCH_COMMAND,
        false,
        send_schema::<Command>,
        read_schema::<DispatchCommandResult>,
    ),
    rpc(
        SUBSCRIBE_SHELL,
        true,
        send_schema::<SubscribeShellInput>,
        read_schema::<ShellStreamItem>,
    ),
    rpc(
        SUBSCRIBE_THREAD,
        true,
        send_schema::<SubscribeThreadInput>,
        read_schema::<ThreadStreamItem>,
    ),
    rpc(
        GET_THREAD_PROJECTION,
        false,
        send_schema::<ThreadIdInput>,
        read_schema::<ThreadProjection>,
    ),
    rpc(
        GET_TURN_ITEM,
        false,
        send_schema::<GetTurnItemInput>,
        read_schema::<GetTurnItemResult>,
    ),
    rpc(
        GET_TURN_DIFF,
        false,
        send_schema::<GetTurnDiffInput>,
        read_schema::<TurnDiff>,
    ),
    rpc(
        SERVER_GET_CONFIG,
        false,
        send_schema::<Empty>,
        read_schema::<ServerConfig>,
    ),
    rpc(
        SERVER_GET_SETTINGS,
        false,
        send_schema::<Empty>,
        read_schema::<ServerSettings>,
    ),
    rpc(
        SERVER_UPDATE_SETTINGS,
        false,
        send_schema::<UpdateSettingsInput>,
        read_schema::<ServerSettings>,
    ),
    MethodSpec {
        error: Some(read_schema::<T3Error>),
        ..rpc(
            PROJECTS_READ_FILE,
            false,
            send_schema::<ReadFileInput>,
            read_schema::<ReadFileResult>,
        )
    },
    rpc(
        PROJECTS_MUTATE,
        false,
        send_schema::<ProjectMutation>,
        read_schema::<Project>,
    ),
    rpc(
        VCS_LIST_REFS,
        false,
        send_schema::<ListRefsInput>,
        read_schema::<ListRefsResult>,
    ),
    MethodSpec {
        tag: HTTP_WS_TICKET,
        stream: false,
        payload: None,
        success: read_schema::<WsTicket>,
        error: None,
    },
];
