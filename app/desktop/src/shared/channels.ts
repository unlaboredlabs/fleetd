/** Every IPC channel. The preload exposes only these, and main validates each request against shared/ipc.ts. */
// Every hub channel takes the hub's id (shared/hubs.ts) first: the app may be paired with several (docs/design/hubs.md).
export const IPC = {
  /** invoke() → HubEntry[]. The hubs this app is paired with, in sidebar order. */
  hubsList: "hubs:list",
  /** invoke(HubId, {label, color}) → ConnectOutcome. Renames a hub, or changes its colour. */
  hubsUpdate: "hubs:update",
  /** main → renderer: HubEntry[], on every change (a hub added, renamed or removed, or first paired). */
  hubsChanged: "hubs:changed",
  /** invoke() → HubState. Main starts pushing `hubFrame` to this window and asks the hub for a fresh snapshot. */
  hubSubscribe: "hub:subscribe",
  /** invoke() → void. Stops the pushes to this window. */
  hubUnsubscribe: "hub:unsubscribe",
  /** invoke(CallRequest) → CallOutcome */
  hubCall: "hub:call",
  /** invoke(ProjectRef | null) → void. The chat whose streamed text comes as `chat_delta` frames; kept across reconnects. */
  hubChat: "hub:chat",
  /** invoke(workstreamId | null) → void. The order whose lanes stream their text in live frames; kept across reconnects. */
  hubFocus: "hub:focus",
  /** invoke(BrowserSessionId | null) → void. The session whose `browser_frame`s come; kept across reconnects. */
  hubWatch: "hub:watch",
  /** invoke(BrowserSessionId, BrowserInput) → void. A person's input to a session they took over; never answered. */
  hubInput: "hub:input",
  /** invoke() → void. A fresh snapshot, then events from its cursor. */
  hubResync: "hub:resync",
  /** invoke() → void. Dials the hub now instead of at the next retry. */
  hubRetryNow: "hub:retry-now",
  /** invoke() → string | null. The disk cache (renderer src/data/cache.ts) for the paired hub, or null. */
  hubCacheRead: "hub:cache-read",
  /** invoke(string) → void. Keeps the disk cache when it is for the paired hub; a fixture keeps nothing. */
  hubCacheWrite: "hub:cache-write",
  /** invoke(ConnectRequest) → ConnectOutcome. Saves the hub URL and key (into the hub its target names), then connects. */
  hubConnect: "hub:connect",
  /** invoke() → void. Disconnects, deletes the saved key and cache, and takes the hub off the list (the last one stays). */
  hubForget: "hub:forget",
  /** invoke() → PairStart. app-pair.json and whether a hub answers, for the connect screen. */
  pairStart: "pair:start",
  /** invoke(hub address) → Probe. The hub's /healthz. */
  pairProbe: "pair:probe",
  /** invoke(PairRequest) → PairOutcome. POST <hub>/pair with a typed code, then saves the key and connects. */
  pairRedeem: "pair:redeem",
  /** invoke() → PairOutcome. Main pairs from app-pair.json itself (its code never reaches the page), then deletes it. */
  pairAuto: "pair:auto",
  /** invoke() → KeyStore. Where the hub key is kept (the OS store, or a 0600 file and why). */
  pairStore: "pair:store",
  /** invoke() → SetupOutcome. Opens `fleetd init` in the system terminal; the one command, with no arguments. */
  pairSetup: "pair:setup",
  /** invoke() → string. This computer's host name, to tell whether it is one of the hub's machines. */
  systemHostName: "system:host-name",
  /**
   * invoke(machineId) → JoinHere. Makes this computer a machine of the hub (src/main/joinHere.ts); each step comes as
   * `machinesJoinHereChanged`. One at a time: a second call while one runs answers with the one running.
   */
  machinesJoinHere: "machines:join-here",
  /** invoke() → ThisComputer. Whether this computer's fleetd dir holds a hub or an enrolled node, or neither. */
  machinesThisComputer: "machines:this-computer",
  /** invoke() → JoinHere | null. The join running or last ended since the app started. */
  machinesJoinHereState: "machines:join-here-state",
  /** main → renderer: JoinHere, on every change. */
  machinesJoinHereChanged: "machines:join-here-changed",
  /** invoke() → string | null. A native folder picker; null when cancelled. */
  projectsPickFolder: "projects:pick-folder",
  /** invoke(path) → DropInfo. What a folder or file dropped on the window holds for Add project. */
  projectsReadDrop: "projects:read-drop",
  /** invoke(text) → void. Writes the clipboard; the page itself has no clipboard permission. */
  copy: "app:copy",
  /** invoke(SecretRequest) → SecretOutcome. Main seals the value to the machine's key and submits it. */
  secretSubmit: "secret:submit",
  /** invoke(ProjectEnvRequest) → CallOutcome. Main seals each secret to the project machine's key, then calls project_env_set. */
  projectEnvSubmit: "project:env-submit",
  /** invoke(McpServerRequest) → CallOutcome. Main seals each secret to each machine's key, then calls mcp_server_set. */
  mcpServerSubmit: "mcp:server-submit",
  /** invoke(HubLinkRequest) → CallOutcome. Main seals a pasted link key to the hub's own key, then calls hub_link_add. */
  hubLinkSubmit: "hub-link:submit",
  /** invoke(GoogleClientRequest) → CallOutcome. Main seals the client secret to each machine's key, then calls google_client_set. */
  googleClientSubmit: "google:client-submit",
  /** invoke(GooglePubsubRequest) → CallOutcome. Main seals the service account key to the reading machine's key, then calls google_pubsub_set. */
  googlePubsubSubmit: "google:pubsub-submit",
  /**
   * invoke(GoogleConnectRequest) → CallOutcome. Main opens Google's consent page, catches the code on a loopback port
   * and calls google_connect; `cancelled` when the person stops waiting.
   */
  googleConnect: "google:connect",
  /** invoke() → void. Stops waiting for Google's answer to the connect under way, if any. */
  googleCancel: "google:cancel",
  /**
   * invoke(GithubAppRequest) → CallOutcome. Main posts the hub's App manifest to GitHub from a loopback page, catches
   * GitHub's code there and calls github_app_create; `cancelled` when the admin stops waiting.
   */
  githubAppCreate: "github:app-create",
  /** invoke() → void. Stops waiting for GitHub to send the App back, or a person's sign-in, if either is under way. */
  githubAppCancel: "github:app-cancel",
  /**
   * invoke() → CallOutcome. Main opens GitHub's sign-in for the hub's App with PKCE, catches the code on a loopback
   * port and calls github_connect; `cancelled` when the person stops waiting.
   */
  githubConnect: "github:connect",
  /** invoke(ClaudeAccountRequest) → CallOutcome. Main seals a Claude key or token to each machine's key, then calls claude_hub_api_set or claude_subscription_set. */
  claudeAccountSubmit: "claude-account:submit",
  /** invoke(OnePasswordRequest) → CallOutcome. Main seals a person's 1Password service account token to each machine's key, then calls onepassword_set. */
  onePasswordSubmit: "onepassword:submit",
  /** invoke(url) → OpenOutcome. Opens an http(s) link in the user's browser; refuses other schemes. */
  openExternal: "app:openExternal",
  /** main → renderer: (HubId, HubFrame) */
  hubFrame: "hub:frame",
  /** invoke() → void. The page can take commands and targets now; main sends what it held for it. */
  appReady: "app:ready",
  /**
   * invoke(NotifyRequest) → boolean. Posts a system notification; clicking it sends `appOpen` with its target. False
   * when this system shows none.
   */
  appNotify: "app:notify",
  /** invoke(count) → void. The Dock (or launcher) badge: how many projects need you; 0 clears it. */
  appBadge: "app:badge",
  /** invoke(ThemeMode) → void. The app's light/dark choice, so the window's own material (vibrancy) matches it. */
  appTheme: "app:theme",
  /** invoke(LinkHandlerClaim | null) → LinkHandlerStatus. Null only reads; a reason claims fleetd:// if it should. */
  appLinkHandler: "app:linkHandler",
  /** invoke(boolean | null) → boolean. App presence (src/main/presence.ts): null only reads; a boolean turns it on or off. */
  appPresence: "app:presence",
  /** invoke(MenuCommand[]) → void. The menu commands enabled now; main greys out the rest. */
  appMenuState: "app:menuState",
  /** invoke(ErrorReport) → void. An error the page caught (an error card, an uncaught error); main logs it, scrubbed. */
  appLog: "app:log",
  /** invoke(SessionWindowRequest) → void. Opens one session in a window of its own, or brings that window forward. */
  appSessionWindow: "app:sessionWindow",
  /** invoke() → UpdatesState. The app's own update (src/main/updater.ts). */
  updatesState: "updates:state",
  /** invoke() → void. A check someone asked for; its answer comes as `updatesChanged`. */
  updatesCheck: "updates:check",
  /** invoke() → void. "Update and restart": now if downloaded, else once it is; the deb opens its download. */
  updatesInstall: "updates:install",
  /** invoke() → void. Takes back "Update and restart" while the download runs. */
  updatesKeep: "updates:keep",
  /** main → renderer: UpdatesState, on every change. */
  updatesChanged: "updates:changed",
  /** main → renderer: a command id (shared/shortcuts.ts or the palette registry), from a click in the app menu. */
  menuCommand: "menu:command",
  /** main → renderer: OpenTarget, from a clicked notification or a fleetd:// link. */
  appOpen: "app:open",
} as const;

type PushChannel =
  | typeof IPC.hubFrame
  | typeof IPC.hubsChanged
  | typeof IPC.menuCommand
  | typeof IPC.appOpen
  | typeof IPC.updatesChanged
  | typeof IPC.machinesJoinHereChanged;
export type InvokeChannel = Exclude<(typeof IPC)[keyof typeof IPC], PushChannel>;
