// What the phone app takes from the desktop app, all in one place: the /app protocol's generated types, the pairing
// rules, a file's trip to and from the hub, the chat reducers, whose a project is and the tools it calls, the Add
// project flow, a project's allowed profiles, its watchers' words, its approvals', who merges' and payments' words, the prose
// diff a skill's history shows, the Update button's run and its wording, the characters an approval card marks, the
// state glyph's frames, the lead's turn line's words and how it holds steady, a chat row's second line, the New screen picker's machines, the device a phone screen shows (deviceModel), Connections' named services (Paper, Notion), custom MCPs and Tailscale's words, a cloud bot waking and the working row (wake.ts), steps in plain words (steps.ts),
// fleetd cloud's accounts call, and the agent providers (Anthropic, Google) with their models. Pure modules that import no packages, so Metro and vitest read them as they are (metro.config.js); ci.yml
// runs this app's checks when they change.
export type {
  AgentKeyInfo,
  AppErrorReport,
  Automation,
  AutomationWatch,
  KnownWatchEvery,
  KnownWatchKind,
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
  ChatFindHas,
  ChatFindHit,
  ChatFindInput,
  ChatHistoryOutput,
  ChatMessagePin,
  ChatMessagePinsEventData,
  ChatMessage,
  ChatMessageEventData,
  CommandApprovalItem,
  SecretRequestItem,
  SignInField,
  FleetStatus,
  HubRole,
  HubEvent,
  HubRestartOutput,
  HubUpdateData,
  HumanRequest,
  ProjectChatState,
  ProjectRef,
  ProjectStatusRow,
  ProjectSummary,
  PersonRef,
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
  AntigravityStatusOutput,
  ProjectSettings,
  Merger,
  MergeMode,
  MergeShared,
  RiskRules,
  UpToDateRule,
  ComputerChoice,
  ComputerImage,
  ComputerPick,
  WorktreeSetup,
  TodoItem,
  ApprovalMode,
  ProjectApprovalsOutput as ApprovalsOutput,
  ProjectPurchasesOutput as PurchasesOutput,
  OnePasswordCardsOutput,
  SkillOrigin,
  SkillSummary,
  Activity,
  LiveFrame,
  McpServer,
  McpTestResult,
  SignIns,
  BrowserFrame,
  BrowserInput,
  BrowserSession,
  BrowserSessionEventData,
  KnownVaultKind,
  VaultAuditEntry as WireVaultAuditEntry,
  VaultImportCandidate as WireVaultImportCandidate,
  VaultImportCard as WireVaultImportCard,
  VaultItemSummary as WireVaultItemSummary,
  VaultStatusOutput,
} from "../../desktop/src/shared/contracts";
export {
  ACCOUNTS_ACCEPT_PATH,
  ACCOUNTS_APP_ACCOUNT_DELETE_PATH,
  ACCOUNTS_APP_ACCOUNT_PATH,
  ACCOUNTS_APP_REDIRECT,
  ACCOUNTS_DEMO_SIGN_IN_PATH,
  ACCOUNTS_SIGN_IN_PATH,
  ACCOUNTS_SIGN_OUT_PATH,
  ACCOUNTS_TEAM_PATH,
  ACCOUNTS_WORKSPACES_PATH,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_PART_BYTES,
  type AccountsInvitation,
  type AccountsDemoSignInInput,
  type AccountsSignInInput,
  type AccountsTeam,
} from "../../desktop/src/shared/contracts";
export { cloudDomain, madeTeam, invitationLine, invitationTitle, readAccepted, readSignIn, teamOrigin, type SignedIn } from "../../desktop/src/shared/accounts";
export type { CallOutcome, HubError, HubState } from "../../desktop/src/shared/hub";
export { BOT_ADMIN_ONLY, botLocked, refusedWords, serves, WORKSPACE_DELETED } from "../../desktop/src/shared/hub";
export { RUNNER_ID } from "../../desktop/src/shared/providers";
export { settingsPath } from "../../desktop/src/shared/settingsPages";
export { CODE_SHAPE, hubOrigin, normalizeCode, type PairFailure } from "../../desktop/src/shared/pairing";
export { initials, tintIndex } from "../../desktop/src/shared/avatar";
export { glyphOf, kindOf, mimeOfFile, TAKES, type FileGlyph } from "../../desktop/src/shared/files";
export { FIRST_PIECE_BYTES, PREVIEW_SIDE, readFile, readPreview, sendFile, type Read, type TransferCall, type Wait } from "../../desktop/src/shared/transfer";
export { advanceRig, BODY, BOT_BODIES, REACH, BOT_COLORS, BOT_PAINT, BOT_SHAPES, botColorLabel, botShapeLabel, botStateOf, colorOf, shapeOf, CROP, DIMMED, drawnAt, frameOf, LARGE, listRest, moment, newRig, paintOf, random, setRigState, type BotColorName, type BotIn, type BotShapeName, type BotState, type Frame, type Rig } from "../../desktop/src/shared/bot";
export { baseScale, clampPan, clampZoom, cropOf, MAX_ZOOM, zoomAbout } from "../../desktop/src/shared/crop";
export * from "../../desktop/src/renderer/src/data/chat";
export { deleteWords, isArchived, NAME_MAX, nameProblem, PROJECT_TOOLS } from "../../desktop/src/renderer/screens/projects/model";
export { addSource, baseName, otherHost, tilde } from "../../desktop/src/renderer/screens/projects/source";
export { discovery, projectHome, repoSuggestions, target, type Discovery, type Found, type RepoPick } from "../../desktop/src/renderer/screens/projects/discovery";
export {
  botAtFolder,
  botHolding,
  botName,
  busy as createBusy,
  createStep,
  initialCreate,
  needsUpdate,
  outcomeLine,
  ownRepo,
  repoKey,
  repoLabel,
  typedRepo,
  type Call as CreateCall,
  type CopyChoice,
  type CreateMsg,
  type CreateState,
  type RepoDraft,
  type RepoJob,
} from "../../desktop/src/renderer/screens/projects/create";
export {
  allowedAfter,
  createInput,
  deleteWords as profileDeleteWords,
  draftOf,
  EFFORT_WORD,
  hasFast,
  byProviderOf,
  leadOf,
  newDraft,
  NOTE_MAX,
  problem as profileProblem,
  providerModels,
  runsLine,
  updateInput,
  type ProfileDraft,
} from "../../desktop/src/renderer/screens/settings/profilesModel";
export {
  AGENT_PROVIDERS,
  googleConnected,
  googleWords,
  modelShort,
  profileNameFor,
  providerOf,
  runsWords,
  type AgentProvider,
  type AgentProviderId,
} from "../../desktop/src/shared/agentProviders";
export { accountLabel, accountsOf, accountState, NAMED, nameFor, namedInput, namedState, turnOnInput, type Named, type NamedState } from "../../desktop/src/renderer/screens/settings/namedServers";
export {
  connectedOf,
  countText,
  customOf,
  initialOf,
  isTailnetHost,
  serverNameProblem,
  needsSignIn,
  stateOf as customState,
  suggestedName,
  testLine as connectionTestLine,
  whereOf,
  freeName,
  withEnabled,
  type StripItem,
  type Tested,
} from "../../desktop/src/renderer/screens/connections/model";
export { canConnect as tailnetCanConnect, lineOf as tailnetLineOf, MACHINES_URL as TAILSCALE_MACHINES_URL, waiting as tailnetWaits, wordOf as tailnetWordOf } from "../../desktop/src/renderer/screens/settings/tailscaleModel";
export { FLOORS, logWhy, MODES as APPROVAL_MODES } from "../../desktop/src/renderer/screens/settings/approvalsModel";
export {
  CHECKIN_ABOUT,
  CHECKIN_TITLE,
  checkInInput,
  checkInLast,
  EVERY_OPTIONS,
  isCheckIn,
  isWatcher,
  kindLabel,
  offered,
  SENTENCE_MAX,
  sentenceProblem,
  watchersAbout,
  watcherInput,
  watchLine,
} from "../../desktop/src/renderer/screens/automations/watchModel";
export { linesOf, mergesOf, RULES_WORDS, rulesText, WHO_MERGES, WHO_MERGES_WORDS } from "../../desktop/src/renderer/screens/settings/whoMergesModel";
export { MERGE_MODE_WORDS, MERGE_MODES, mergeModeOf, sharedText, upToDateText } from "../../desktop/src/renderer/screens/settings/mergeModeModel";
export { cardLabel, cardOptions, NO_CARD, PAYMENTS_HELP, purchaseLine, purchaseState } from "../../desktop/src/renderer/screens/projects/payments";
export { addPage as addApprovedPage, FIRST_PAGE as APPROVED_FIRST_PAGE, fold as foldApproved, hasMore as moreApproved, PAGE as APPROVED_PAGE, SHOWN as APPROVED_SHOWN, showAllWord, timesWord, type LogRow as ApprovedRow, type Pages as ApprovedPages } from "../../desktop/src/renderer/screens/settings/approvedLog";
export { diffLines, type DiffLine, type Piece as DiffPiece } from "../../desktop/src/renderer/screens/settings/diff";
export { versionLabel, type UpdatesState } from "../../desktop/src/shared/updates";
export { HIDDEN_WARNING, hasHidden, marked, pieces, shellWord } from "../../desktop/src/shared/hidden";
export { proposal, type Proposal } from "../../desktop/src/shared/proposal";
export { clockAt, updateStatus, type Row as UpdateRow, type Status } from "../../desktop/src/renderer/screens/updates/model";
export { loadRun, resetFlow, startUpdate, useAuto, useFlow, useReady, useRun, type Auto, type Flow, type FlowDeps } from "../../desktop/src/renderer/screens/updates/flow";
export { cellFrames, CELLS, GRAIN_BEATS, phaseOf, SHAPES, stillOf, type GlyphState } from "../../desktop/src/shared/glyph";
export { doingWords, leadLaneId, sentenceCase, workedFor, workedToward, type TurnSpan } from "../../desktop/src/shared/turnWords";
export { lineWords, requestWhat, rowLine as rowSay, type RowLine, type Waiting } from "../../desktop/src/shared/rowLine";
export {
  askedAt,
  ColdTurns,
  heldWords,
  replied,
  restartNote,
  SLOW_MS,
  START_STALE_MS,
  endedAt,
  startOf,
  STIR_MS,
  tryAgainLabel,
  tryAgainNote,
  tryAgainNow,
  waitingFor,
  atWork,
  turnClock,
  workingLine,
  wakeOf,
  wakePose,
  wakeShown,
  wakeWords,
  type Wake,
} from "../../desktop/src/shared/wake";
export { useSteady } from "../../desktop/src/shared/steady";
export { activityLabel, mergeSteps, plainStep, stepLabel, type StepLabel } from "../../desktop/src/shared/steps";
export {
  adminNames,
  askLine,
  hostsFor,
  idleFor,
  idleWords,
  KINDS as SCREEN_KINDS,
  kindLine,
  openWord,
  pickHost,
  pickModel,
  profileBusy,
  simModels,
  slotLine,
  whyOff,
  type OffReason,
  type ScreenKind,
} from "../../desktop/src/renderer/screens/sessions/pickScreen";
export { appearanceWord, CONTROL_WORD, foldWord, latLon, otherAppearance, PLACES, POSTURE, railOf, shotName, stripOf, TEXT_SIZES, textSizeWord, type StripControl } from "../../desktop/src/renderer/screens/sessions/strip";
export { bodyOf, flatOf, poseOf, type Body, type Pose } from "../../desktop/src/renderer/screens/sessions/deviceModel";
export { FrameCounts, GRAPH_H, GRAPH_W, graphOf, groupsOf, HISTORY, verdictOf, type Group, type GraphSecond, type PerfNow, type Row, type Verdict, type ViewerSecond } from "../../desktop/src/renderer/screens/sessions/perfModel";
export { moveOf, turnBetween } from "../../desktop/src/renderer/screens/sessions/turn";
export { before, change, columnsOf, count, hours, idle, money, onCloud, PERIODS, ticks, wait, type Column, type Period } from "../../desktop/src/shared/usage";
