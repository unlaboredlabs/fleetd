// What the phone app takes from the desktop app, all in one place: the /app protocol's generated types, the pairing
// rules, a file's trip to and from the hub, the chat reducers, whose a project is and the tools it calls, the Add
// project flow, a project's allowed profiles, its approvals', payments' and linked hubs' words, the prose
// diff a skill's history shows, the Update button's run and its wording, the characters an approval card marks, the
// state glyph's frames, the lead's turn line's words, the New screen picker's machines, and fleetd cloud's accounts
// call. Pure modules that import no packages, so Metro and vitest read them as they are (metro.config.js); ci.yml
// runs this app's checks when they change.
export type {
  ApprovalDecision,
  AttachmentGetOutput,
  AttachmentMime,
  AttachmentRef,
  ArtifactFormat,
  ArtifactPublished,
  ArtifactSummary,
  ArtifactVersion,
  ChatFile,
  AvatarCrop,
  ChatReplyTo,
  ChatSection,
  ChatDelta,
  ChatHistoryOutput,
  ChatMessage,
  ChatMessageEventData,
  CommandApprovalItem,
  FleetStatus,
  HubRole,
  HubEvent,
  HubRestartOutput,
  HubUpdateData,
  HumanRequest,
  ProjectChatState,
  ProjectRef,
  ProjectSummary,
  ToolInput,
  ToolName,
  ToolOutput,
  ToolPreview,
  UpdateRun,
  AgentRow,
  AgentMessage,
  AgentMessageOutcome,
  AgentMessageRecipient,
  AgentMessagesOutput,
  MachineRolesEntry,
  OrderCard,
  PrRow,
  ProfilesListOutput,
  ProjectSettings,
  TodoItem,
  NaviApprovalMode as ApprovalMode,
  NaviApprovalsOutput as ApprovalsOutput,
  NaviPurchasesOutput as PurchasesOutput,
  OnePasswordCardsOutput,
  HubLink,
  SkillOrigin,
  SkillSummary,
  Activity,
  LiveFrame,
  BrowserFrame,
  BrowserInput,
  BrowserSession,
  BrowserSessionEventData,
  KnownVaultKind,
  VaultAuditEntry as WireVaultAuditEntry,
  VaultImportCandidate as WireVaultImportCandidate,
  VaultImportCard as WireVaultImportCard,
  VaultItemSummary as WireVaultItemSummary,
  VaultScope,
  VaultStatusOutput,
} from "../../desktop/src/shared/contracts";
export {
  ACCOUNTS_ACCEPT_PATH,
  ACCOUNTS_APP_REDIRECT,
  ACCOUNTS_SIGN_IN_PATH,
  ACCOUNTS_SIGN_OUT_PATH,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_PART_BYTES,
  type AccountsInvitation,
  type AccountsSignInInput,
  type AccountsTeam,
} from "../../desktop/src/shared/contracts";
export { cloudDomain, invitationLine, invitationTitle, readAccepted, readSignIn, teamOrigin, type SignedIn } from "../../desktop/src/shared/accounts";
export type { CallOutcome, HubError, HubState } from "../../desktop/src/shared/hub";
export { serves } from "../../desktop/src/shared/hub";
export { CODE_SHAPE, hubOrigin, normalizeCode, type PairFailure } from "../../desktop/src/shared/pairing";
export { initials, tintIndex } from "../../desktop/src/shared/avatar";
export { glyphOf, kindOf, mimeOfFile, TAKES, type FileGlyph } from "../../desktop/src/shared/files";
export { PREVIEW_SIDE, readFile, readPreview, sendFile, type Read, type TransferCall, type Wait } from "../../desktop/src/shared/transfer";
export { advanceRig, BODY, BOT_COLORS, BOT_PAINT, botColorLabel, botStateOf, CROP, DIMMED, drawnAt, frameOf, LARGE, listRest, moment, newRig, paintOf, random, setRigState, type BotColorName, type BotIn, type BotState, type Frame, type Rig } from "../../desktop/src/shared/bot";
export { baseScale, clampPan, clampZoom, cropOf, MAX_ZOOM, zoomAbout } from "../../desktop/src/shared/crop";
export * from "../../desktop/src/renderer/src/data/chat";
export { deleteWords, isArchived, isOnlyMe, isYours, NAME_MAX, nameProblem, PROJECT_TOOLS } from "../../desktop/src/renderer/screens/projects/model";
export { addSource, baseName, otherHost, tilde } from "../../desktop/src/renderer/screens/projects/source";
export {
  discovery,
  newPath,
  projectHome,
  rows as foundRows,
  target,
  type Discovery,
  type Found,
  type Ready,
  type Request,
} from "../../desktop/src/renderer/screens/projects/discovery";
export { initialAdd, step as addStep, type AddMsg, type AddState, type Call as AddCall } from "../../desktop/src/renderer/screens/projects/flow";
export { allowedAfter, runsLine } from "../../desktop/src/renderer/screens/settings/profilesModel";
export { FLOORS, logWhy, MODES as APPROVAL_MODES } from "../../desktop/src/renderer/screens/settings/approvalsModel";
export { cardLabel, cardOptions, NO_CARD, PAYMENTS_HELP, purchaseLine, purchaseState } from "../../desktop/src/renderer/screens/projects/payments";
export { linkState, reachLine } from "../../desktop/src/renderer/screens/hubLinks/model";
export { addPage as addApprovedPage, FIRST_PAGE as APPROVED_FIRST_PAGE, fold as foldApproved, hasMore as moreApproved, PAGE as APPROVED_PAGE, SHOWN as APPROVED_SHOWN, showAllWord, timesWord, type LogRow as ApprovedRow, type Pages as ApprovedPages } from "../../desktop/src/renderer/screens/settings/approvedLog";
export { diffLines, type DiffLine, type Piece as DiffPiece } from "../../desktop/src/renderer/screens/settings/diff";
export { versionLabel, type UpdatesState } from "../../desktop/src/shared/updates";
export { HIDDEN_WARNING, hasHidden, marked, pieces, shellWord } from "../../desktop/src/shared/hidden";
export { openTo, proposal, type Proposal } from "../../desktop/src/shared/proposal";
export { clockAt, CLOUD_UPDATES, updateStatus, type Row as UpdateRow, type Status } from "../../desktop/src/renderer/screens/updates/model";
export { loadRun, resetFlow, startUpdate, useAuto, useFlow, useReady, useRun, type Auto, type Flow, type FlowDeps } from "../../desktop/src/renderer/screens/updates/flow";
export { cellFrames, CELLS, GRAIN_BEATS, phaseOf, SHAPES, stillOf, type GlyphState } from "../../desktop/src/shared/glyph";
export { doingWords, leadLaneId, sentenceCase, workedFor } from "../../desktop/src/shared/turnWords";
export {
  adminNames,
  askLine,
  hostsFor,
  idleFor,
  idleWords,
  KINDS as SCREEN_KINDS,
  openWord,
  pickHost,
  slotLine,
  whyOff,
  type OffReason,
  type ScreenKind,
} from "../../desktop/src/renderer/screens/sessions/pickScreen";
