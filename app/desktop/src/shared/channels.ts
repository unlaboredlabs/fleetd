/** Every IPC channel. The preload exposes only these, and main validates each request against shared/ipc.ts. */
// Every hub channel takes the hub's id (shared/hubs.ts) first: the app may be paired with several.
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
  /** invoke(boolean) → void. Whether this window shows the Screens page: `screen_thumb` frames come while one does. */
  hubThumbs: "hub:thumbs",
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
  /** invoke() → CloudState. Whether this build offers fleetd cloud's Sign in, and who is signed in. */
  cloudState: "cloud:state",
  /** invoke() → SignInOutcome. WorkOS's page in the browser, then the accounts service and a key per team; resolves when it ends. */
  cloudSignIn: "cloud:sign-in",
  /** invoke() → void. Stops waiting for the sign-in under way. */
  cloudCancel: "cloud:cancel",
  /** invoke() → void. Opens the sign-in page under way again. */
  cloudReopen: "cloud:reopen",
  /** invoke() → string | null. The sign-in page under way, for Copy the sign-in link. */
  cloudLink: "cloud:link",
  /** invoke() → SignOutOutcome. Drops this device's key on each of the account's hubs, then ends the session. */
  cloudSignOut: "cloud:sign-out",
  /** invoke(hub) → ConnectComputerOutcome. A join line from the hub, run in a terminal on this computer. */
  cloudConnectComputer: "cloud:connect-computer",
  /** invoke(hub) → InvitesOutcome. A cloud team's open invites by email (GET ACCOUNTS_INVITES_PATH with its key). */
  cloudInvites: "cloud:invites",
  /** invoke(hub, InviteRequest) → InviteOutcome. Invites an email to a cloud team; WorkOS sends the email. */
  cloudInvite: "cloud:invite",
  /** invoke(hub, inviteId) → RevokeInviteOutcome. Takes an invite by email back. */
  cloudRevokeInvite: "cloud:revoke-invite",
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
  /** invoke() → void. Opens Set up this Mac for agents, a window of its own (src/main/macSetup.ts); on macOS only. */
  macSetupOpen: "mac-setup:open",
  /** invoke(MacRedeemRequest) → MacRedeemOutcome. Finds the hub and trades the 6-digit code; its token stays in main. */
  macSetupRedeem: "mac-setup:redeem",
  /** invoke() → MacJoin. Installs the hub's fleetd and joins as the agents' Mac; each change comes as `macSetupJoinChanged`. */
  macSetupJoin: "mac-setup:join",
  /** main → renderer: MacJoin, on every change. */
  macSetupJoinChanged: "mac-setup:join-changed",
  /** invoke(hub address | null) → MacHealthRead. The node's checks as it last wrote them, and whether the hub answers. */
  macSetupHealth: "mac-setup:health",
  /** invoke(MacPane) → void. Opens that pane of System Settings › Privacy & Security, or Xcode in the App Store. */
  macSetupPane: "mac-setup:pane",
  /** invoke() → MacRestartOutcome. `fleetd node restart`. */
  macSetupRestart: "mac-setup:restart",
  /** invoke() → MacSetupStatus. Where this Mac's setup stands, for a window opening on it. */
  macSetupStatus: "mac-setup:status",
  /** invoke() → void. The person declined to replace a node after the hub took the code: it is spent, nothing joins. */
  macSetupCancel: "mac-setup:cancel",
  macSetupUpdateHub: "mac-setup:update-hub",
  /** invoke() → MacMenuBarRead | null. The menu bar popover's read of this Mac (src/main/menuBar.ts); null until joined. */
  menuBarRead: "menu-bar:read",
  /** invoke(height) → void. The popover's page laid out at this height: the popover takes it. */
  menuBarFit: "menu-bar:fit",
  /** invoke() → void. Closes the popover. */
  menuBarHide: "menu-bar:hide",
  /** invoke() → void. The menu bar icon's menu (Open fleetd, Open at Login, Quit), from the popover's More. */
  menuBarMenu: "menu-bar:menu",
  /** invoke() → string | null. A native folder picker; null when cancelled. */
  projectsPickFolder: "projects:pick-folder",
  /** invoke(path) → DropInfo. What a folder or file dropped on the window holds for Add project. */
  projectsReadDrop: "projects:read-drop",
  /** invoke(text) → void. Writes the clipboard; the page itself has no clipboard permission. */
  copy: "app:copy",
  /** invoke(html) → string. Main keeps an HTML artifact and returns the sandboxed address its frame loads (artifactFrames.ts). */
  artifactFrame: "app:artifact-frame",
  /** invoke(SecretRequest) → SecretOutcome. Main seals the value to the machine's key and submits it. */
  secretSubmit: "secret:submit",
  /** invoke(ProjectEnvRequest) → CallOutcome. Main seals each secret to the project machine's key, then calls project_env_set. */
  projectEnvSubmit: "project:env-submit",
  /** invoke(McpServerRequest) → CallOutcome. Main seals each secret to each machine's key, then calls mcp_server_set. */
  mcpServerSubmit: "mcp:server-submit",
  /** invoke(HubLinkRequest) → CallOutcome. Main seals a pasted link key to the hub's own key, then calls hub_link_add. */
  hubLinkSubmit: "hub-link:submit",
  /**
   * invoke(McpOauthClientRequest) → CallOutcome. Main seals the person's own OAuth client secret to the hub's own key,
   * then calls mcp_oauth_start with the client.
   */
  mcpOauthClientSubmit: "mcp:oauth-client-submit",
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
  /** invoke(VaultSaveRequest) → CallOutcome. Main seals the typed fields to the hub's own key, then calls vault_save. */
  vaultSave: "vault:save",
  /** invoke(VaultRevealRequest) → VaultRevealOutcome. Main asks for Touch ID (or a confirm), then opens vault_reveal's fields. */
  vaultReveal: "vault:reveal",
  /** invoke(VaultCopyRequest) → { ok } | { ok: false, error }. The same, then main copies the field; the page never sees it. */
  vaultCopy: "vault:copy",
  /** invoke(VaultUnlockRequest) → CallOutcome. Main seals the passphrase to the hub's own key, then calls vault_unlock. */
  vaultUnlock: "vault:unlock",
  /** invoke(HubId, FileRequest) → OpenOutcome. Main reads a chat's file from the hub and opens it in this computer's app for its type. */
  fileOpen: "file:open",
  /** invoke(HubId, FileRequest) → OpenOutcome. Main reads a chat's file from the hub and saves it where the person picks. */
  fileSave: "file:save",
  /** invoke(HubId, FileRequest) → DownloadOutcome. Main reads a chat's file from the hub and saves it to the Downloads folder, without asking. */
  fileDownload: "file:download",
  /** invoke(path) → OpenOutcome. Shows a file fileDownload saved in its folder; main refuses any other path. */
  fileShow: "file:show",
  /** invoke(HubId, FileRequest) → OpenOutcome. Main reads a chat's picture from the hub and puts it on the clipboard. */
  fileCopyImage: "file:copy-image",
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
  /** invoke() → void. "Restart to update": now if downloaded, else once it is; the deb opens its download. */
  updatesInstall: "updates:install",
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
  | typeof IPC.machinesJoinHereChanged
  | typeof IPC.macSetupJoinChanged;
export type InvokeChannel = Exclude<(typeof IPC)[keyof typeof IPC], PushChannel>;
