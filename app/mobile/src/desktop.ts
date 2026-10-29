// What the phone app takes from the desktop app, all in one place: the /app protocol's generated types, the pairing
// rules, the chat reducers, what makes a project a Navi and who it belongs to, the Add project flow, a project's allowed
// profiles and worktrees, and the Update button's run and its wording. Pure modules that import no packages, so Metro
// and vitest read them as they are (metro.config.js); mobile.yml runs this app's checks when they change.
export type {
  ApprovalDecision,
  AttachmentGetOutput,
  AttachmentMime,
  AttachmentRef,
  ChatReplyTo,
  AppServerMessage,
  ChatDelta,
  ChatHistoryOutput,
  ChatMessage,
  ChatMessageEventData,
  FleetStatus,
  GatedRunSpec,
  HubEvent,
  HumanRequest,
  ProjectChatState,
  ProjectRef,
  ProjectSummary,
  ToolInput,
  ToolName,
  ToolOutput,
  ToolPermission,
  ToolPreview,
  UpdateRun,
  AgentRow,
  MachineRolesEntry,
  OrderCard,
  PrRow,
  ProfilesListOutput,
  ProjectSettings,
  TodoItem,
} from "../../desktop/src/shared/contracts";
export { ATTACHMENT_MAX_BYTES, ATTACHMENT_PART_BYTES, PROTOCOL_VERSION } from "../../desktop/src/shared/contracts";
export type { CallOutcome, HubError, HubState } from "../../desktop/src/shared/hub";
export { hubOrigin, normalizeCode, protocolFit, type PairFailure } from "../../desktop/src/shared/pairing";
export * from "../../desktop/src/renderer/src/data/chat";
export { canHost, firstHome, isArchived, isNavi, isYours, NAME_MAX, nameProblem, naviHomes } from "../../desktop/src/renderer/screens/navi/model";
export { addSource, baseName, otherHost, tilde } from "../../desktop/src/renderer/screens/projects/source";
export {
  discovery,
  rows as foundRows,
  target,
  type Discovery,
  type FailAction,
  type Failure,
  type Found,
  type Ready,
  type Request,
  type Worker,
} from "../../desktop/src/renderer/screens/projects/discovery";
export { initialAdd, requestWhat, step as addStep, type AddMsg, type AddState, type Call as AddCall } from "../../desktop/src/renderer/screens/projects/flow";
export { allowedAfter, runsLine } from "../../desktop/src/renderer/screens/settings/profilesModel";
export { unsavedWorktrees } from "../../desktop/src/renderer/screens/settings/projectModel";
export { versionLabel, type UpdatesState } from "../../desktop/src/shared/updates";
export { updatesView, type Line, type PartLine, type UpdatesView } from "../../desktop/src/renderer/screens/updates/model";
export { loadRun, resetFlow, retryMachine, startOver, startUpdate, useFlow, useReady, useRun, type Flow, type FlowDeps } from "../../desktop/src/renderer/screens/updates/flow";
