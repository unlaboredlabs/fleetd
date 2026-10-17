//! Payload and result types for the T3 RPC methods fleetd calls, with only the fields fleetd sends or reads.
//!
//! Unknown fields are ignored and every tagged union fleetd reads has an `Other` fallback, so additive T3
//! changes keep decoding. `cargo xtask t3-conformance` diffs these against T3's own contracts at the pin.
//! Timestamps stay ISO strings, as on the wire.
use std::collections::BTreeMap;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

// ---------------------------------------------------------------------------------------------------------------
// T3's `ForwardCompatibleArray`

/// T3 writes an element it cannot encode as `null` and drops elements it cannot decode, so an old client keeps
/// the rest of a list when one entry gains a shape it does not know. Mirrors that: nulls and undecodable
/// elements are skipped.
#[derive(Debug, Clone, Default)]
pub struct ForwardCompatibleVec<T>(pub Vec<T>);

impl<T> std::ops::Deref for ForwardCompatibleVec<T> {
    type Target = Vec<T>;
    fn deref(&self) -> &Vec<T> {
        &self.0
    }
}

impl<'de, T: serde::de::DeserializeOwned> Deserialize<'de> for ForwardCompatibleVec<T> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let raw = Vec::<Value>::deserialize(d)?;
        Ok(ForwardCompatibleVec(
            raw.into_iter()
                .filter_map(|v| serde_json::from_value(v).ok())
                .collect(),
        ))
    }
}

impl<T: JsonSchema> JsonSchema for ForwardCompatibleVec<T> {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        format!("ForwardCompatibleVec_{}", T::schema_name()).into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let item = generator.subschema_for::<T>();
        json_schema!({ "type": "array", "items": { "anyOf": [item, { "type": "null" }] } })
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Auth (HTTP)

/// `POST /api/auth/websocket-ticket` response.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WsTicket {
    pub ticket: String,
    pub expires_at: String,
}

// ---------------------------------------------------------------------------------------------------------------
// Errors

/// The typed error of a failed request (`Exit` with a `Fail` cause). Every T3 RPC error carries `_tag`; the
/// rest varies by error, so only what fleetd looks at is typed.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct T3Error {
    #[serde(rename = "_tag")]
    pub tag: String,
    pub message: Option<String>,
    /// `ProjectReadFileError.operation`: `realpath-target` means the file does not exist. Only `projects.readFile`
    /// (and `vcs.listRefs`) errors carry it.
    pub operation: Option<String>,
}

/// The part of `T3Error` every method's error has; what the conformance check holds the other methods to.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ErrorTag {
    #[serde(rename = "_tag")]
    pub tag: String,
    pub message: Option<String>,
}

// ---------------------------------------------------------------------------------------------------------------
// Shared

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelSelection {
    pub model: String,
    pub options: Option<Vec<ModelOption>>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ModelOption {
    pub id: String,
    pub value: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeMode {
    ApprovalRequired,
    AutoAcceptEdits,
    Auto,
    FullAccess,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum InteractionMode {
    Default,
    Plan,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CreatedBy {
    User,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CreationSource {
    Web,
}

/// Where a launched thread runs. Default for fleetd: the project root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WorkspaceStrategy {
    Root(RootWorkspace),
    ExistingWorktree(ExistingWorktree),
    Worktree(NewWorktree),
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RootWorkspace {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExistingWorktree {
    pub worktree_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NewWorktree {
    pub base_ref: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_from_origin: Option<bool>,
}

// ---------------------------------------------------------------------------------------------------------------
// orchestration.subscribeShell

#[derive(Debug, Clone, Default, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeShellInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after_sequence: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_completion_marker: Option<bool>,
}

// Each item is decoded once and consumed, so boxing the large variants buys nothing.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(tag = "kind")]
pub enum ShellStreamItem {
    #[serde(rename = "synchronized")]
    Synchronized,
    #[serde(rename = "snapshot")]
    Snapshot(ShellSnapshotItem),
    #[serde(rename = "project.updated")]
    ProjectUpdated(ProjectUpdatedItem),
    #[serde(rename = "project.removed")]
    ProjectRemoved(ProjectRemovedItem),
    #[serde(rename = "thread.updated")]
    ThreadUpdated(ThreadUpdatedItem),
    #[serde(rename = "thread.removed")]
    ThreadRemoved(ThreadRemovedItem),
    #[serde(other)]
    #[schemars(skip)]
    Other,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ShellSnapshotItem {
    pub snapshot: ShellSnapshot,
    /// Present on a metadata-only refresh that lists some projects and no threads.
    pub resolved_repository_identity_roots: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ShellSnapshot {
    pub snapshot_sequence: u64,
    pub projects: Vec<ShellProject>,
    pub threads: Vec<ThreadShell>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ShellProject {
    pub id: String,
    pub title: String,
    pub workspace_root: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadShell {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub status: String,
    pub pending_runtime_request: Option<PendingRuntimeRequest>,
    pub last_error: Option<String>,
    pub last_error_class: Option<String>,
    pub usage_limit_reset_at: Option<String>,
    pub updated_at: String,
    pub model_selection: ModelSelection,
    pub latest_visible_message: Option<VisibleMessage>,
    pub latest_run_id: Option<String>,
    pub active_run_id: Option<String>,
    pub activity_run_status: Option<String>,
    pub deleted_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct PendingRuntimeRequest {
    pub id: String,
    pub kind: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct VisibleMessage {
    pub role: String,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUpdatedItem {
    pub sequence: u64,
    pub project: ShellProject,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRemovedItem {
    pub sequence: u64,
    pub project_id: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadUpdatedItem {
    pub sequence: u64,
    /// `active` or `archive`.
    pub location: String,
    pub thread: ThreadShell,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRemovedItem {
    pub sequence: u64,
    pub thread_id: String,
}

// ---------------------------------------------------------------------------------------------------------------
// orchestration.subscribeThread / getThreadProjection / getTurnItem

#[derive(Debug, Clone, Default, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeThreadInput {
    pub thread_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after_sequence: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_completion_marker: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accept_bounded_snapshot: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(tag = "kind")]
pub enum ThreadStreamItem {
    #[serde(rename = "synchronized")]
    Synchronized,
    #[serde(rename = "snapshot")]
    Snapshot(ThreadSnapshotItem),
    #[serde(rename = "event")]
    Event(ThreadEventItem),
    #[serde(other)]
    #[schemars(skip)]
    Other,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSnapshotItem {
    pub snapshot_sequence: u64,
    pub projection: ThreadProjection,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadEventItem {
    pub sequence: u64,
    pub event: ThreadEvent,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(tag = "type")]
pub enum ThreadEvent {
    #[serde(rename = "message.updated")]
    MessageUpdated(Payload<ConversationMessage>),
    #[serde(rename = "turn-item.updated")]
    TurnItemUpdated(Payload<TurnItem>),
    #[serde(rename = "run.created")]
    RunCreated(Payload<Run>),
    #[serde(rename = "run.updated")]
    RunUpdated(Payload<Run>),
    #[serde(other)]
    #[schemars(skip)]
    Other,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct Payload<T> {
    pub payload: T,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadIdInput {
    pub thread_id: String,
}

/// A thread's projection: `getThreadProjection`'s result and a thread stream snapshot's `projection`.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadProjection {
    pub thread: ProjectionThread,
    pub runs: Vec<Run>,
    pub runtime_requests: Vec<RuntimeRequest>,
    pub messages: Vec<ConversationMessage>,
    pub turn_items: Vec<TurnItem>,
    pub checkpoints: Vec<Checkpoint>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionThread {
    pub branch: Option<String>,
    pub worktree_path: Option<String>,
    pub linked_pull_request: Option<LinkedPullRequest>,
    pub pull_requests: Option<Vec<PullRequestLink>>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct LinkedPullRequest {
    pub url: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct PullRequestLink {
    pub url: String,
    /// `stack-dismissed` links are not the thread's.
    pub source: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct Checkpoint {
    pub files: Vec<CheckpointFile>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct CheckpointFile {
    pub path: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct RuntimeRequest {
    pub id: String,
    pub kind: String,
    pub status: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConversationMessage {
    pub id: String,
    pub role: String,
    pub text: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct Run {
    pub id: String,
    pub status: String,
    pub ordinal: u64,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TurnItem {
    pub id: String,
    pub run_id: Option<String>,
    pub status: String,
    pub title: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub updated_at: String,
    #[serde(flatten)]
    pub kind: TurnItemKind,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TurnItemKind {
    CommandExecution(CommandExecutionItem),
    FileChange(FileChangeItem),
    DynamicTool(DynamicToolItem),
    FileSearch(FileSearchItem),
    WebSearch(WebSearchItem),
    Subagent(SubagentItem),
    Error(ErrorItem),
    UserInputRequest(UserInputRequestItem),
    ApprovalRequest(ApprovalRequestItem),
    #[serde(other)]
    #[schemars(skip)]
    Other,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CommandExecutionItem {
    pub input: String,
    pub output: Option<String>,
    /// The bounded snapshot withheld the output; fetch it with `getTurnItem`.
    pub output_omitted: Option<bool>,
    pub output_indicates_failure: Option<bool>,
    pub exit_code: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeItem {
    pub file_name: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DynamicToolItem {
    pub tool_name: Option<String>,
    pub input: Value,
    pub output: Option<Value>,
    pub output_omitted: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct FileSearchItem {
    pub pattern: Option<String>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct WebSearchItem {
    pub patterns: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct SubagentItem {
    pub prompt: String,
    pub result: Option<String>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ErrorItem {
    pub failure: Failure,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct Failure {
    pub class: String,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UserInputRequestItem {
    pub request_id: String,
    pub questions: Vec<UserInputQuestion>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct UserInputQuestion {
    pub question: String,
    pub options: Vec<UserInputOption>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct UserInputOption {
    pub label: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequestItem {
    pub request_id: String,
    pub request_kind: String,
    pub prompt: Option<String>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GetTurnItemInput {
    pub thread_id: String,
    pub item_id: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct GetTurnItemResult {
    pub item: Option<TurnItem>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GetTurnDiffInput {
    pub thread_id: String,
    pub from_turn_count: u64,
    pub to_turn_count: u64,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct TurnDiff {
    pub diff: String,
}

// ---------------------------------------------------------------------------------------------------------------
// orchestration.launchThread / dispatchCommand

#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LaunchThreadInput {
    /// T3 keeps a receipt per command id, so a retried launch returns the same thread.
    pub command_id: String,
    pub project_id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generate_title: Option<bool>,
    pub model_selection: ModelSelectionInput,
    pub runtime_mode: RuntimeMode,
    pub interaction_mode: InteractionMode,
    pub workspace_strategy: WorkspaceStrategy,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initial_message: Option<InitialMessage>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelSelectionInput {
    pub instance_id: String,
    pub model: String,
    pub options: Vec<ModelOptionInput>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct ModelOptionInput {
    pub id: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct InitialMessage {
    pub text: String,
    /// fleetd sends none.
    pub attachments: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LaunchThreadResult {
    pub thread_id: String,
}

/// The orchestration commands fleetd dispatches.
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(tag = "type")]
pub enum Command {
    #[serde(rename = "message.dispatch")]
    MessageDispatch(MessageDispatch),
    #[serde(rename = "run.interrupt")]
    RunInterrupt(RunInterrupt),
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MessageDispatch {
    pub created_by: CreatedBy,
    pub creation_source: CreationSource,
    pub command_id: String,
    pub thread_id: String,
    pub message_id: String,
    pub text: String,
    pub attachments: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery_intent: Option<DeliveryIntent>,
    pub dispatch_mode: DispatchMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryIntent {
    /// T3 picks: start a run if idle, steer a running one, queue behind one still starting.
    Auto,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DispatchMode {
    StartImmediately,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunInterrupt {
    pub command_id: String,
    pub thread_id: String,
    pub run_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct DispatchCommandResult {
    pub sequence: u64,
}

// ---------------------------------------------------------------------------------------------------------------
// server.getConfig / getSettings / updateSettings

#[derive(Debug, Clone, Default, Serialize, JsonSchema)]
pub struct Empty {}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ServerConfig {
    pub providers: ForwardCompatibleVec<ServerProvider>,
    pub settings: ServerSettings,
    pub observability: Observability,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Observability {
    pub logs_directory_path: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ServerProvider {
    pub instance_id: String,
    pub driver: String,
    pub enabled: bool,
    pub installed: bool,
    pub status: String,
    pub availability: Option<String>,
    pub auth: ProviderAuth,
    pub models: Vec<ProviderModel>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ProviderAuth {
    pub status: String,
    #[serde(rename = "type")]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModel {
    pub slug: String,
    pub aliases: Option<Vec<String>>,
    pub is_default: Option<bool>,
    pub is_legacy: Option<bool>,
}

/// T3's server settings. Absent keys take T3's defaults (see its `settings.ts`).
#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ServerSettings {
    pub provider_instances: Option<BTreeMap<String, ProviderInstanceConfig>>,
    pub auto_resume_limited_threads: Option<bool>,
}

/// One provider instance. Read and written back whole: T3 redacts secret values when it reads them out and keeps
/// the stored value when a redacted one is written back, so the fields fleetd does not type ride along in `extra`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ProviderInstanceConfig {
    pub driver: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<Vec<EnvironmentVariable>>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EnvironmentVariable {
    pub name: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSettingsInput {
    pub patch: SettingsPatch,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_instance_mutation: Option<ProviderInstanceMutation>,
}

#[derive(Debug, Clone, Default, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_resume_limited_threads: Option<bool>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub enum ProviderInstanceMutation {
    Upsert(ProviderInstanceUpsert),
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInstanceUpsert {
    pub instance_id: String,
    pub instance: ProviderInstanceConfig,
}

// ---------------------------------------------------------------------------------------------------------------
// projects.readFile / projects.mutate / vcs.listRefs

#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileInput {
    /// Must be a T3 workspace root.
    pub cwd: String,
    pub relative_path: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ReadFileResult {
    pub contents: String,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(tag = "type")]
pub enum ProjectMutation {
    #[serde(rename = "project.create")]
    Create(ProjectCreate),
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCreate {
    pub command_id: String,
    pub project_id: String,
    pub title: String,
    pub workspace_root: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub title: String,
    pub workspace_root: String,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListRefsInput {
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ref_kind: Option<RefKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RefKind {
    All,
    Local,
    Remote,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ListRefsResult {
    pub refs: Vec<VcsRef>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VcsRef {
    pub name: String,
    pub is_remote: Option<bool>,
    pub is_default: bool,
    pub current: bool,
}
