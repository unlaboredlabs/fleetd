// The node link's frames and constants, as crates/fleetd-contracts/src/node_link.rs has them, for both ends: the
// hub's link (src/hub/link) and the node's (src/node). Its types are Rust-only (not rendered to contracts.ts). The
// session frames (session_call, session_reply, machine_event, thread_event, clone_progress) are src/shared/sessions.ts's.
// Fields are camelCase on the wire unless a type says otherwise.
import type { HubToNodeTag, NodeToHubTag } from "./wire_tags.ts";
import type { HubChannel, NodeSandboxTrouble, SleptSpan, Timestamp } from "./contracts.ts";

/** Any frame, by its tag: the JSON object as it travels. The typed frames below narrow the ones the link reads. */
export type NodeFrame<T extends NodeToHubTag = NodeToHubTag> = { t: T } & Record<string, unknown>;
export type HubFrame<T extends HubToNodeTag = HubToNodeTag> = { t: T } & Record<string, unknown>;

/** WebSocket close codes the hub ends a link with (`node_link::close`). */
export const CLOSE = {
  /** A frame that does not decode, or arrives out of order. */
  BAD_FRAME: 4000,
  /** Bad signature, unknown key, or an invalid, used or expired enroll token. Retrying will not help. */
  UNAUTHORIZED: 4001,
  /** The two sides speak different protocol versions. Retrying will not help. */
  PROTOCOL_MISMATCH: 4002,
  /** A newer link for the same machine took over. */
  REPLACED: 4003,
  /** No frame for 45 s. */
  HEARTBEAT_TIMEOUT: 4008,
  /**
   * WebSocket's "Service Restart": the hub is stopping (an update, a restart) and comes back within a moment, so the
   * node redials every 250 ms for a minute rather than back off.
   */
  RESTART: 1012,
} as const;
/** The longest close reason a WebSocket carries; the hub cuts a longer one short. */
export const REASON_MAX_BYTES = 123;

/** What an UNAUTHORIZED close says, and only says, for a machine the hub removed: its node stops as enrolled. A hub
 * that doesn't know a node for another reason (an import, which leaves keys behind) says it isn't enrolled. */
export const REMOVED = "was removed from this hub";
export const removedReason = (machineId: string) => `${machineId} ${REMOVED}: its node key is revoked`;
/** What an UNAUTHORIZED close says for a node whose key the hub doesn't hold at all: the agents' Mac stops as enrolled
 * on it too, as only a new code joins it again. */
export const NOT_ENROLLED = "is not enrolled";
export const notEnrolledReason = (machineId: string) => `${machineId} ${NOT_ENROLLED}: run fleetd pair --worker ${machineId} on the hub`;

/** Both directions every 15 s. */
export const HEARTBEAT_INTERVAL_SECS = 15;
/** A link silent this long is offline. */
export const HEARTBEAT_TIMEOUT_SECS = 45;
/**
 * A frame this big (as JSON) may take seconds on a slow link: 2 s at 256 kbit/s. The hub sends a heartbeat with `bulk`
 * (its length) before one, so the node, which hears a frame only once it is whole, gives it the heartbeats' time to
 * arrive instead of taking the wait for a dead link.
 */
export const LINK_BULK_BYTES = 64 * 1024;

// What a node lists in its hello's `capabilities`: calls it understands beyond the protocol's base set.
export const CAP_REPOS = "repos";
export const CAP_DETACHED = "detached_worktree";
export const CAP_LANDED_LOG = "landed_log";
export const CAP_PROJECT_SETTINGS = "project_settings";
export const CAP_PROJECT_ENV_COPY = "project_env_copy";
export const CAP_MCP_SERVERS = "mcp_servers";
/** The node relays a tailnet MCP server through the hub's Tailscale route when its machine isn't on the tailnet, and
 * takes `node_action` tailnet for it. */
export const CAP_MCP_TAILNET = "mcp_tailnet";
export const CAP_SKILLS = "skills";
export const CAP_HAS_FILE = "has_file";
export const CAP_ORDER_ENV = "order_env";
export const CAP_WORKTREE_SETUP = "worktree_setup";
/** The node builds its bots' computer images, and answers `project_image`. */
export const CAP_COMPUTER_IMAGE = "computer_image";
export const CAP_ALLOWED_ONLY = "allowed_only";
export const CAP_ISOLATED = "isolated";
export const CAP_BROWSER = "browser";
/** The node answers `browser_rtc` offers: a screen's frames and input peer to peer (src/node/rtc). */
export const CAP_BROWSER_RTC = "browser_rtc";
export const CAP_SESSION_ANDROID = "session_android";
export const CAP_SESSION_IOS = "session_ios";
export const CAP_SESSION_DESKTOP = "session_linux_desktop";
export const CAP_SELF_UPDATE = "self_update";
export const CAP_CLAUDE_INSTALL = "claude_install";
export const CAP_CLAUDE_LOGIN = "claude_login";
/** `antigravity_login`: the node signs Antigravity in from the app (`agy acp --login`), and says whether it is; then
 * `antigravity_status` says whether it is and starts nothing (an older node answers that it doesn't know it). */
export const CAP_ANTIGRAVITY_LOGIN = "antigravity_login";
export const CAP_UPDATE_FETCH = "update_fetch";
export const CAP_UPDATE_HOLD = "update_hold";
/** The node takes a build the hub names by its number and checksums (`NodeUpdate.build`), not only the newest (D701). */
export const CAP_UPDATE_BUILD = "update_build";
export const CAP_SESSION_HOST = "session_host";
export const CAP_ASSISTANT = "assistant";
/** `signins_forget`: the node forgets a project's kept browser sign-ins. */
export const CAP_SIGNINS_FORGET = "signins_forget";
/** `node_action` `rejoin`: the node moves to another hub with a code from it (Move to the cloud). */
export const CAP_REJOIN = "rejoin";
export const CAP_FOLDER_MAKE = "folder_make";
export const CAP_SESSION_END = "session_end";
export const CAP_SESSION_SEAL = "session_seal";
export const CAP_CLAUDE_ACCOUNTS = "claude_accounts";
/** `claude_account_reseal`: the node seals a Claude account it holds to another machine's box key (the hub's runner). */
export const CAP_CLAUDE_RESEAL = "claude_reseal";
export const CAP_ONEPASSWORD = "onepassword";
export const CAP_ONEPASSWORD_CARDS = "onepassword_cards";
/** `vault_adopt`, `vault_import_read`, `vault_import_search`, and fills from the vault (node_link.rs CAP_VAULT). */
export const CAP_VAULT = "vault";
/** Fills from `vault_fill` and a purchase claim's `sealedCard` (node_link.rs CAP_VAULT_FILL). */
export const CAP_VAULT_FILL = "vault_fill";
export const CAP_CLAUDE_MODELS = "claude_models";
/** `gemini_key`: the node keeps the team's Gemini API key, which its agents on Google run on without a bot's own. */
export const CAP_GEMINI_KEY = "gemini_key";
export const CAP_PROFILE_NAMES = "profile_names";
export const CAP_SYSTEM_PROMPT = "system_prompt";
export const CAP_PROJECT_ERASE = "project_erase";
export const CAP_NO_ASK_FILL = "no_ask_fill";
export const CAP_PROJECT_SIGNINS = "project_signins";
export const CAP_ONE_LEAD_MODE = "one_lead_mode";
export const CAP_MAC_TOOL = "mac_tool";
export const CAP_AGENTS_MAC = "agents_mac";
export const CAP_LINK_DEFLATE = "link_deflate";
export const CAP_GATED_RESUME = "gated_resume";
/** Takes `SessionLaunch.ahead`: claude starts with no run, and the launch's prompt goes in with the first send. */
export const CAP_LAUNCH_AHEAD = "launch_ahead";
/** The node runs the Rust build of its `nodeVersion`, or the Bun one, and takes `NodeUpdate.flavour`. A node listing
 * neither is older and says nothing of its flavour. */
export const CAP_BUILD_RUST = "build_rust";
export const CAP_BUILD_BUN = "build_bun";

/** What the hub lists in its welcome. */
export const HUB_CAP_SESSION_ROUTE = "session_route";
export const HUB_CAP_LINK_DEFLATE = "link_deflate";
/** The hub sends a heartbeat with `bulk` before each frame of LINK_BULK_BYTES or more: the node may give a quiet link up
 * at QUIET_DEAD (12 s). A hub or cloud that doesn't list it gets the heartbeats' bound (30 s), so a big frame it sends
 * unannounced over a slow link never reads as a dead link. */
export const HUB_CAP_LINK_BULK = "link_bulk";
/** The hub takes a `leave` frame from the agents' Mac: it removes that machine, as Stop being the agents' Mac asks. */
export const HUB_CAP_MACHINE_LEAVE = "machine_leave";

/** A node's first frame (`NodeHello`). */
export type NodeHello = {
  machineId: string;
  name: string;
  tags?: string[];
  nodeVersion: string;
  protocol: number;
  /** ed25519 public key, base64. */
  pubKey: string;
  /** Signature over the hub's challenge nonce (its UTF-8 bytes), base64. */
  sig: string;
  enrollToken?: string;
  boxPubKey?: string;
  capabilities?: string[];
  machineFingerprint?: string;
};

/** The hub's first frame: the node signs `nonce`. */
export type HubChallenge = { nonce: string };

/** `machineId`: the id the hub links the node as, which a code minted for no machine settles (a hub before it sends
 * none). */
export type HubWelcome = { hubId: string; protocol: number; nonce?: string; capabilities?: string[]; machineId?: string };

/** Both directions every 15 s; `load`, `steps` and `busy` are node -> hub only, `bulk` hub -> node only, right before
 * a frame of that many bytes (LINK_BULK_BYTES). */
export type Heartbeat = { at: Timestamp; load?: NodeLoad; steps?: unknown[]; busy?: NodeBusy; bulk?: number };

/** What keeps a machine busy, as its node counts it at each heartbeat. */
export type NodeBusy = { threads: number; screens: number; uploads: number; hosted: number };

/** How long an ended recording that hasn't reached the hub keeps its machine busy. */
export const UPLOAD_BUSY_SECS = 30 * 60;

/** Space on the volume holding a node's worktrees and build cache. */
export type NodeDisk = { freeBytes: number; totalBytes: number; minFreeBytes: number };

/**
 * The machine's IPv4, as its node reads its network interfaces: only those of its own hardware count, not loopback,
 * tunnels (Tailscale), bridges or containers' veths.
 */
export type NodeNetwork = {
  /** One of them holds a routable IPv4 address: not 169.254.x link-local, what's left when DHCP times out. */
  ipv4: boolean;
  /** While `ipv4` is false, the interface to bring back: the one holding a link-local address, else the first. */
  iface?: string;
};

/** One claude.ai usage window, as claude's `rate_limit_event` last reported it. */
export type LoginLimit = {
  limitType: string;
  utilization?: number;
  resetsAt?: Timestamp;
  status: string;
  observedAt?: Timestamp;
};

/** One session host's check (`machine_roles::HostCheck`). */
export type HostCheck = { host: string; ready: boolean; off?: string } & Record<string, unknown>;

/** A health report of one kind of screen (`AndroidHealth`, `IosHealth`, `DesktopHealth`). */
export type ScreenHealth = { state: string; message: string; fix?: string; backend?: string };

/** The agents' Mac's setup checks. */
export type MacHealth = {
  user: string;
  checks: { id: string; state: "ok" | "warn" | "fail" | "unknown"; message: string; fix?: string; command?: string }[];
};

/** A hosted provider in trouble on a node (shared/contracts.ts NodeSandboxTrouble), its kind narrowed. */
export type SandboxTrouble = Omit<NodeSandboxTrouble, "what"> & { what: "start" | "keep_alive" };

/** What a machine reports about itself with each heartbeat. */
export type NodeLoad = {
  cpus: number;
  load1: number;
  memUsedPct?: number;
  memTotalBytes?: number;
  memPerAgentBytes?: number;
  diskPerAgentBytes?: number;
  /** The hosted providers whose boxes the node can make (it holds their keys): the slot board may place agents there
   * once its own slots are full, each up to the team's limit (hub/slots/board.ts). Absent for none. */
  sandboxes?: string[];
  /** What is wrong with a connected provider now, one each at most: the hub shows it on the provider's row and in
   * queued agents' reasons. Absent while all is well. */
  sandboxTrouble?: SandboxTrouble[];
  /** Where each of the node's live sessions runs (thread id → "local" or a hosted provider): a hosted box from its
   * making until it is destroyed, a claude on the machine while it lives. The slot board counts a box against its
   * provider by it, held or idle. Absent for none. */
  places?: Record<string, string>;
  limits?: LoginLimit[];
  disk?: NodeDisk;
  /** Absent off Linux, on a machine with no network hardware of its own (a container), and from older nodes. */
  network?: NodeNetwork;
  hosts?: HostCheck[];
  android?: ScreenHealth;
  ios?: ScreenHealth;
  desktop?: ScreenHealth;
  /** No node of this fleetd sends it (agents run on their machine, W760): fleetd cloud reads it until its pin move.
   * Where the machine's agents ran: in a VM of their own each, or as plain processes and why. */
  sandbox?: { kind: "microvm"; why?: string; fix?: string; accountsOnly?: true } | { kind: "process"; why: string; fix?: string; expected?: true; detail?: string };
  mac?: MacHealth;
};

/** Hub -> node: run a `cmd` check. argv only, never through a shell. */
export type CmdCheck = { id: string; cwd: string; argv: string[]; timeoutSec: number };

/** Node -> hub, one per `cmd_check`. `exitCode` is null when the process didn't exit on its own. */
export type CmdResult = { id: string; exitCode: number | null; outputTail: string; timedOut: boolean };

/** Hub -> node: a secret sealed to this node's `boxPubKey`; the hub never sees the plaintext. */
export type SecretDeliver = {
  id: string;
  sink: unknown;
  sealed: string;
  secretKey: string;
  envName?: string;
  projectId?: string;
  requestId?: string;
};

/** Node -> hub, one per `secret_deliver`: exactly one of `fingerprint` and `error`. */
export type SecretResult = { id: string; fingerprint?: string; error?: string };

/** Hub -> node: run an approved request's stored command, confined like a `cmd_check`. */
export type GatedRun = {
  id: string;
  argv: string[];
  cwd: string;
  timeoutSec: number;
  secretEnv?: unknown;
  requestId?: string;
};

/** Hub -> node, only to nodes listing CAP_GATED_RESUME: the result of the command it ran for `requestId`. */
export type GatedResume = { id: string; requestId: string; timeoutSec: number };

/** Node -> hub, one per `gated_run` or `gated_resume`. */
export type GatedResult = {
  id: string;
  exitCode: number | null;
  outputTail: string;
  timedOut: boolean;
  error?: string;
  unknown?: string;
};

export type NodeActionKind =
  | "probe"
  | "update"
  | "fetch"
  | "claude"
  | "claude_login"
  | "claude_login_code"
  | "antigravity_login"
  | "antigravity_login_code"
  | "antigravity_status"
  | "hold"
  | "sandbox_check"
  | "sandbox_limits"
  | "github_tokens"
  | "tailnet"
  | "rejoin"
  | "mac_ended";

/** The build a node updates to. With `build` and `sha256`, the build's own release and its checksums (the rollout's
 * pick, D701), which a node from before rollouts ignores, taking the channel's newest. Edge goes out as `nightly`, its name before D203. `flavour` is the hub's own: a node on
 * the other one switches to it; one from before ignores it and installs its own flavour of `version`. */
export type NodeUpdate = { version: string; channel: HubChannel | "nightly"; flavour?: string; build?: string; sha256?: Record<string, string> };

/** Hub -> node: the doctor's probe and the hub's update of its nodes. Its fields are single words. */
export type NodeAction = {
  id: string;
  action: NodeActionKind;
  update?: NodeUpdate;
  claude?: string;
  code?: string;
  /** `sandbox_check`: `{"provider","key","domain"?}` sealed to this node's box key (base64), for Settings' Test (hub/sandbox). */
  sandbox?: string;
  /** `sandbox_limits`: the team's connected hosted providers and each one's limit, in the order agents go to them. */
  limits?: { provider: string; max: number }[];
  /** `sandbox_limits`: each connected provider's `{"provider","key","domain"?}` sealed to this node's box key (base64),
   * for the node to make agents' boxes with. Never given to a session. */
  keys?: Record<string, string>;
  /** `github_tokens`, to the hub's runner only: an installation token of the hub's GitHub App for each `owner/name` of
   * its bots' repos, sealed to its box key (base64), for its own clones and fetches (node/repos/github.ts). */
  tokens?: Record<string, string>;
  /** `tailnet`, to the machines that make hosted boxes: the team's Tailscale gateway is on, with its MagicDNS suffix
   * (hub/tailnet), or off (null). Their boxes send tailnet connections and lookups through the hub while it is on. */
  tailnet?: { suffix: string } | null;
  /**
   * `hold` only: when the node's sessions carry on through its restart (its answer's `hosted`), hold nothing, and count
   * only the sessions mid-step that aren't hosted (a project's); else hold every one, as without it. An older node ignores
   * it and holds every one, answering no `hosted`.
   */
  unhosted?: boolean;
  /**
   * `rejoin`, to a node that lists CAP_REJOIN: its hub moved to `hub` (Move to the cloud), and `code` enrols this
   * machine there under its id. The node enrols, then links to that hub from its next start; it answers ok once enrolled.
   */
  rejoin?: { hub: string; code: string };
  /** `mac_ended`, to the agents' Mac: tasks that ended for good (their worktree gone, or cancelled), whose folders on the
   * Mac go. An older node answers that it doesn't know the action, and sweeps them after its FOLDER_DAYS. */
  tasks?: string[];
};

/** How long a `hold` lasts unless the hub asks again. */
export const HOLD_LEASE_SECS = 60;

/**
 * Whether systemd starts the user's service manager, which runs the hub and the node, again by itself: linger starts it
 * at boot and keeps it after a logout, and `Restart=always` on `user@<uid>.service` starts it again after it stops.
 */
export type NodeManager = { user: string; uid: number; linger: boolean; restarts: boolean };

/** `manager`: absent off Linux, from a node that isn't a systemd user service, and from older nodes. */
export type NodeProbe = { gitEmail?: string; gitEmailFrom?: "env" | "git_config"; manager?: NodeManager };

/** Node -> hub, one per `node_action`. Not camelCase: its sign-in URL is `login_url` on the wire. */
export type NodeActionResult = {
  id: string;
  ok: boolean;
  message: string;
  probe?: NodeProbe;
  stage?: string;
  login_url?: string;
  /** `antigravity_login`, `antigravity_login_code`, `antigravity_status`: the machine's Antigravity is signed in, on this plan ("Google AI Pro"). */
  signed_in?: string;
  /** `sandbox_check` that failed: why, as SandboxCheck's `reason`. */
  reason?: string;
  /** `hold`: the sessions still mid-step, a tool call of theirs running; with `unhosted` and `hosted`, only those not hosted. */
  steps?: number;
  hosts?: HostCheck[];
  /**
   * `hold` with `unhosted`: the host protocol of the node's session hosts, when each runs in a systemd scope of its own
   * that outlives the node, so its agent carries on through the restart. Absent without scopes (their hosts die with
   * the node), and from an older node.
   */
  hosted?: number;
};

/** Node -> hub: time spans from the node's outbox rows `fromRid..=toRid`, oldest first. */
export type SpansFrame = { fromRid: number; toRid: number; spans: unknown[] };

/** Hub -> node: rows up to `upto` are stored; with `rewind`, send again from `upto`. */
export type SpansAck = { upto: number; rewind?: boolean };

/** Hub -> node: the screen `sessionId` of the ended agent session `threadId` ends too. */
export type SessionEndFrame = { threadId: string; sessionId: string };

/** The frames this file types, by tag; the rest are `NodeFrame`/`HubFrame`. */
export type NodeToHubFrames = {
  hello: NodeHello;
  hb: Heartbeat;
  cmd_result: CmdResult;
  secret_result: SecretResult;
  gated_result: GatedResult;
  node_action_result: NodeActionResult;
  slept: SleptSpan;
  spans: SpansFrame;
};
export type HubToNodeFrames = {
  challenge: HubChallenge;
  welcome: HubWelcome;
  hb: Heartbeat;
  cmd_check: CmdCheck;
  secret_deliver: SecretDeliver;
  gated_run: GatedRun;
  gated_resume: GatedResume;
  node_action: NodeAction;
  spans_ack: SpansAck;
  session_end: SessionEndFrame;
};

/** The reply each request frame expects, by the request's tag. */
export const REPLY_OF = {
  cmd_check: "cmd_result",
  secret_deliver: "secret_result",
  gated_run: "gated_result",
  gated_resume: "gated_result",
  node_action: "node_action_result",
  session_call: "session_reply",
  session_host: "session_host_result",
  mac_call: "mac_result",
  screen_control: "screen_control_result",
} as const satisfies Partial<Record<HubToNodeTag, NodeToHubTag>>;
export type RequestTag = keyof typeof REPLY_OF;
export type ReplyTag = (typeof REPLY_OF)[RequestTag];
export const REPLY_TAGS: ReadonlySet<string> = new Set(Object.values(REPLY_OF));

/** `crate::protocol_behind`: the close reason for a node on another protocol, its fix in it. */
export function protocolBehind(hub: number, node: number): string {
  return hub < node
    ? "the hub runs an older fleetd than this machine. Fix: update the hub (Updates in the app on your main machine, or fleetd update on the hub)"
    : "this machine runs an older fleetd than the hub. Fix: update this machine (fleetd update on it)";
}

/** WebSocket close reasons are capped at 123 bytes: a longer one is cut at a character, with "...". */
export function closeReason(reason: string): string {
  const bytes = Buffer.from(reason);
  if (bytes.length <= REASON_MAX_BYTES) return reason;
  let end = REASON_MAX_BYTES - 4;
  // Back up off a UTF-8 continuation byte.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return `${bytes.subarray(0, end).toString()}...`;
}
