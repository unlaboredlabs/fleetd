// What the phone app takes from the desktop app, all in one place: the /app protocol's generated types, the pairing
// rules, the chat reducers and what makes a project a Navi. Pure modules that import no packages, so Metro and vitest
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
} from "../../desktop/src/shared/contracts";
export { PROTOCOL_VERSION } from "../../desktop/src/shared/contracts";
export type { CallOutcome, HubError, HubState } from "../../desktop/src/shared/hub";
export { hubOrigin, normalizeCode, protocolFit, type PairFailure } from "../../desktop/src/shared/pairing";
export * from "../../desktop/src/renderer/src/data/chat";
export { isArchived, isNavi } from "../../desktop/src/renderer/screens/navi/model";
