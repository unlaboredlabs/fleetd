// What the phone app takes from the desktop app, all in one place: the /app protocol's generated types, the pairing
// rules, the chat reducers, what makes a project a Navi, and the Update button's run and its wording. Pure modules that import no packages, so Metro and vitest
// read them as they are (metro.config.js); mobile.yml runs this app's checks when they change.
export type {
  ApprovalDecision,
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
} from "../../desktop/src/shared/contracts";
export { PROTOCOL_VERSION } from "../../desktop/src/shared/contracts";
export type { CallOutcome, HubError, HubState } from "../../desktop/src/shared/hub";
export { hubOrigin, normalizeCode, protocolFit, type PairFailure } from "../../desktop/src/shared/pairing";
export * from "../../desktop/src/renderer/src/data/chat";
export { isArchived, isNavi } from "../../desktop/src/renderer/screens/navi/model";
export { versionLabel, type UpdatesState } from "../../desktop/src/shared/updates";
export { updatesView, type Line, type PartLine, type UpdatesView } from "../../desktop/src/renderer/screens/updates/model";
export { loadRun, resetFlow, retryMachine, startOver, startUpdate, useFlow, useReady, useRun, type Flow, type FlowDeps } from "../../desktop/src/renderer/screens/updates/flow";
