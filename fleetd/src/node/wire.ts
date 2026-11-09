// The node link's frames (crates/fleetd-contracts/src/node_link.rs), which the contracts don't render to TypeScript:
// typed here as far as the node's modules read and write them. One JSON object per WebSocket message, tagged by `t`.
import type { HubToNodeTag, NodeToHubTag } from "../shared/wire_tags.ts";
import * as link from "../shared/node_link.ts";
import type { HubFrame } from "../shared/node_link.ts";
export type { HubToNodeTag, NodeToHubTag };
export type {
  CmdCheck,
  CmdResult,
  GatedResult,
  GatedResume,
  Heartbeat,
  HubFrame,
  NodeAction,
  NodeActionKind,
  NodeActionResult,
  NodeBusy,
  NodeFrame,
  SecretResult,
} from "../shared/node_link.ts";
export { CLOSE, HEARTBEAT_INTERVAL_SECS, HEARTBEAT_TIMEOUT_SECS, protocolBehind } from "../shared/node_link.ts";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Obj = Record<string, unknown>;

/** The capabilities a node lists beyond the base set (src/shared/node_link.ts's CAP_*), by their Rust names. */
export const CAP = {
  REPOS: link.CAP_REPOS, DETACHED: link.CAP_DETACHED, LANDED_LOG: link.CAP_LANDED_LOG, PROJECT_SETTINGS: link.CAP_PROJECT_SETTINGS,
  PROJECT_ENV_COPY: link.CAP_PROJECT_ENV_COPY, MCP_SERVERS: link.CAP_MCP_SERVERS, SKILLS: link.CAP_SKILLS, HAS_FILE: link.CAP_HAS_FILE,
  ORDER_ENV: link.CAP_ORDER_ENV, WORKTREE_SETUP: link.CAP_WORKTREE_SETUP, ALLOWED_ONLY: link.CAP_ALLOWED_ONLY, ISOLATED: link.CAP_ISOLATED,
  BROWSER: link.CAP_BROWSER, SESSION_HOST: link.CAP_SESSION_HOST, SELF_UPDATE: link.CAP_SELF_UPDATE, CLAUDE_INSTALL: link.CAP_CLAUDE_INSTALL,
  CLAUDE_LOGIN: link.CAP_CLAUDE_LOGIN, UPDATE_FETCH: link.CAP_UPDATE_FETCH, UPDATE_HOLD: link.CAP_UPDATE_HOLD, ASSISTANT: link.CAP_ASSISTANT,
  NAVI_SIGNINS: link.CAP_NAVI_SIGNINS, FOLDER_MAKE: link.CAP_FOLDER_MAKE, SESSION_END: link.CAP_SESSION_END, SESSION_SEAL: link.CAP_SESSION_SEAL,
  CLAUDE_ACCOUNTS: link.CAP_CLAUDE_ACCOUNTS, CLAUDE_RESEAL: link.CAP_CLAUDE_RESEAL, ONEPASSWORD: link.CAP_ONEPASSWORD,
  ONEPASSWORD_CARDS: link.CAP_ONEPASSWORD_CARDS, CLAUDE_MODELS: link.CAP_CLAUDE_MODELS, PROFILE_NAMES: link.CAP_PROFILE_NAMES,
  SYSTEM_PROMPT: link.CAP_SYSTEM_PROMPT, SCREEN_SETTINGS: link.CAP_SCREEN_SETTINGS, NAVI_ERASE: link.CAP_NAVI_ERASE,
  PROJECT_ERASE: link.CAP_PROJECT_ERASE, NO_ASK_FILL: link.CAP_NO_ASK_FILL, PROJECT_SIGNINS: link.CAP_PROJECT_SIGNINS,
  ONE_LEAD_MODE: link.CAP_ONE_LEAD_MODE, LINK_DEFLATE: link.CAP_LINK_DEFLATE, GATED_RESUME: link.CAP_GATED_RESUME,
  BUILD_RUST: link.CAP_BUILD_RUST, BUILD_BUN: link.CAP_BUILD_BUN,
} as const;
export const HUB_CAP = { SESSION_ROUTE: link.HUB_CAP_SESSION_ROUTE, LINK_DEFLATE: link.HUB_CAP_LINK_DEFLATE } as const;

/** `secret_deliver` as the node reads it: its sink is a string (SecretSink). */
export type SecretDeliver = Omit<link.SecretDeliver, "sink"> & { sink: string };
export type SecretEnvEntry = { name: string; secretKey: string };
/** `gated_run` as the node reads it: `secretEnv` names each variable and the secret it is read from. */
export type GatedRun = Omit<link.GatedRun, "secretEnv"> & { secretEnv?: SecretEnvEntry[] };

/** `text` held to `max` UTF-16 units from its start (a message), as the Rust `head_text`. */
export { headUtf16 as headText, tailUtf16 as tailText } from "./util.ts";

