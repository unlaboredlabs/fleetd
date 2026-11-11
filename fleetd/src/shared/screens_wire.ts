// The node link's frames for screens, sessions hosted elsewhere and the agents' Mac, as the Rust contracts declare them
// (crates/fleetd-contracts/src/{browser,machine_roles,mac,node_link}.rs). The node link isn't rendered to TypeScript,
// so these follow the Rust structs field for field; every frame is `{ t: <snake_case tag>, ...fields }`.
import type {
  BrowserAction,
  BrowserControlTo,
  BrowserFrame,
  BrowserInput,
  BrowserRecordingEntry,
  BrowserSessionId,
  BrowserSessionState,
  BrowserControl,
  ErrorCode,
  ErrorReason,
  HostCheck,
  MachineId,
 
  ProjectId,
  SessionHost,
  SessionKind,
  TaskId,
  ThreadId,
  Timestamp,
} from "./contracts.ts";

/** A tool error on the wire (the contracts' McpToolError): `{ code, message, fix?, reason? }`. */
export type McpToolError = { code: ErrorCode; message: string; fix?: string; reason?: ErrorReason };

// ---- capabilities a node lists in its hello (node_link.rs) ----
export const CAP_BROWSER = "browser";
export const CAP_SESSION_HOST = "session_host";
export const CAP_SESSION_END = "session_end";
export const CAP_SESSION_SEAL = "session_seal";
export const CAP_SCREEN_SETTINGS = "screen_settings";
export const CAP_PROJECT_SIGNINS = "project_signins";
export const CAP_NAVI_SIGNINS = "navi_signins";
export const CAP_MAC_TOOL = "mac_tool";
export const CAP_AGENTS_MAC = "agents_mac";

// ---- browser.rs constants ----
export const RECORDING_PART_BYTES = 512 * 1024;
export const DEFAULT_RETENTION_DAYS = 30;
export const DEFAULT_MAX_GB_PER_PROJECT = 20;
export const SCREEN_WAIT_MINUTES = 30;
export const THUMB_SIDE = 640;
export const THUMB_EVERY_SECS = 20;
export const SCREEN_STEPS_MAX = 64;
export const STEP_ARGS_BYTES = 600;
export const STEP_RESULT_CHARS = 200;
export const IOS_GONE =
  "iOS screens are gone: start an iOS simulator of your own on the agents' Mac with `mac sim start`, then drive it with agent-device as before.";

/** A recording file's name on disk (browser.rs `RecordingFile::file_name`). */
export const RECORDING_FILES = {
  actions: { name: "actions.jsonl", mime: "application/x-ndjson" },
  dom: { name: "dom.jsonl", mime: "application/x-ndjson" },
  video: { name: "video.webm", mime: "video/webm" },
  video_mp4: { name: "video.mp4", mime: "video/mp4" },
} as const;
export type RecordingFileName = keyof typeof RECORDING_FILES;

/** `SessionHost::noun`. */
export const HOST_NOUN: Record<string, string> = {
  browser: "a browser",
  android: "an Android emulator",
  ios: "an iOS simulator",
  desktop: "a desktop",
  mac: "the agents' Mac screen",
};

// ---- the agent's browser-mcp <-> its node, and through the hub ----

/** `BrowserCall`: `{ op, ... }`; the ops' own fields stay open here, each module reads its own. */
export type BrowserCall = { op: string; [field: string]: unknown };

export type BrowserCallFrame = {
  id: string;
  cwd: string;
  call: BrowserCall;
  threadId?: ThreadId;
};

/** Exactly one of `result` and `error`. */
export type BrowserResultFrame = {
  id: string;
  result?: { op: string; [field: string]: unknown };
  error?: McpToolError;
};

export type ScreenStep = { sessionId: BrowserSessionId; step: BrowserAction };

// ---- hub -> node ----
export type BrowserWatchFrame = { sessionId: BrowserSessionId; on: boolean; kbps?: number };
export type BrowserInputFrame = { sessionId: BrowserSessionId; input: BrowserInput };
export type BrowserControlFrame = { sessionId: BrowserSessionId; control: BrowserControlTo; by: string };
export type SessionHostFrame = {
  id: string;
  hostKey: string;
  frame: BrowserCallFrame;
  sealed?: string;
  navi?: ProjectId;
};
export type SessionStepFrame = { hostKey: string; item: unknown };
export type RelayDialFrame = { hostKey: string; token: string; stream?: "cdp" };
export type SessionEndFrame = { threadId: ThreadId; sessionId: BrowserSessionId };
export type MacCaller = { machineId: MachineId; projectId: ProjectId; taskId?: TaskId; threadId: ThreadId };
export type MacCallFrame = { id: string; caller: MacCaller; sealed: string };

// ---- node -> hub ----
export type SessionHostResult = { id: string; frame: BrowserResultFrame };
export type MacResultFrame = { id: string; sealed?: string; error?: McpToolError };

/** `ScreenSettings`: what node_action `screens` changes in a node's node.json. */
export type ScreenSettings = { host?: SessionHost; on?: boolean };

/** The tagged frames, as they go on the link. */
export type HubToNodeFrame =
  | ({ t: "browser_watch" } & BrowserWatchFrame)
  | ({ t: "browser_input" } & BrowserInputFrame)
  | ({ t: "browser_control" } & BrowserControlFrame)
  | ({ t: "session_host" } & SessionHostFrame)
  | ({ t: "session_step" } & SessionStepFrame)
  | ({ t: "relay_dial" } & RelayDialFrame)
  | ({ t: "session_end" } & SessionEndFrame)
  | ({ t: "mac_call" } & MacCallFrame)
  | { t: string; [field: string]: unknown };

export type NodeToHubFrame =
  | ({ t: "browser_frame" } & BrowserFrame)
  | ({ t: "session_host_result" } & SessionHostResult)
  | ({ t: "mac_result" } & MacResultFrame)
  | { t: string; [field: string]: unknown };

// ---- lead calls (lead_calls.rs) the node makes for a session ----
export type BrowserSessionCall = {
  sessionId: BrowserSessionId;
  kind?: SessionKind;
  threadId: ThreadId;
  purpose: string;
  state: BrowserSessionState;
  control?: BrowserControl;
  startedAt: Timestamp;
  endedAt?: Timestamp;
  files?: BrowserRecordingEntry[];
  credentialsFilled?: number;
  note?: string;
};
export type BrowserRecordingPartCall = {
  sessionId: BrowserSessionId;
  file: RecordingFileName;
  offset: number;
  dataB64: string;
};
export type BrowserTakeoverCall = { sessionId: BrowserSessionId; reason: string };
export type SealedForRunner = { runner: MachineId; dataB64: string };
export type SessionRouteCall = { frame: BrowserCallFrame; host?: SessionHost; sealed?: SealedForRunner };
export type SessionRouteResult = {
  runner: MachineId;
  here: boolean;
  answer?: BrowserResultFrame;
  relay?: string;
  sealTo?: string;
  relayOnly?: boolean;
};
export type SessionStepCall = { threadId: ThreadId; item: unknown };
export type MacSendCall = { machineId: MachineId; threadId: ThreadId; sealed: string };

/** A node's heartbeat fields this area reads (node_link.rs `Heartbeat`, `NodeLoad`). */
export type HeartbeatLoad = {
  cpus: number;
  memTotalBytes?: number;
  hosts?: HostCheck[];
  [field: string]: unknown;
};
