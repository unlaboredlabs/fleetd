/** Every IPC channel. The preload exposes only these, and main validates each request against shared/ipc.ts. */
export const IPC = {
  /** invoke() → HubState */
  hubState: "hub:state",
  /** invoke() → HubState. Main starts pushing `hubFrame` to this window and asks the hub for a fresh snapshot. */
  hubSubscribe: "hub:subscribe",
  /** invoke() → void. Stops the pushes to this window. */
  hubUnsubscribe: "hub:unsubscribe",
  /** invoke(CallRequest) → CallOutcome */
  hubCall: "hub:call",
  /** invoke(LiveScope | null) → void. Kept across reconnects and re-sent when the window is focused. */
  hubLive: "hub:live",
  /** invoke(ProjectRef | null) → void. The chat whose streamed text comes as `chat_delta` frames; kept across reconnects. */
  hubChat: "hub:chat",
  /** invoke() → void. A fresh snapshot, then events from its cursor. */
  hubResync: "hub:resync",
  /** invoke() → void. Dials the hub now instead of at the next retry. */
  hubRetryNow: "hub:retry-now",
  /** invoke() → string | null. The disk cache (renderer src/data/cache.ts) for the paired hub, or null. */
  hubCacheRead: "hub:cache-read",
  /** invoke(string) → void. Keeps the disk cache when it is for the paired hub; a fixture keeps nothing. */
  hubCacheWrite: "hub:cache-write",
  /** invoke(ConnectRequest) → ConnectOutcome. Saves the hub URL and key, then connects. */
  hubConnect: "hub:connect",
  /** invoke() → void. Disconnects and deletes the saved key. */
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
  /** invoke() → string | null. A native folder picker; null when cancelled. */
  projectsPickFolder: "projects:pick-folder",
  /** invoke(path) → DropInfo. What a folder or file dropped on the window holds for Add project. */
  projectsReadDrop: "projects:read-drop",
  /** invoke(text) → void. Writes the clipboard; the page itself has no clipboard permission. */
  copy: "app:copy",
  /** invoke(SecretRequest) → SecretOutcome. Main seals the value to the machine's key and submits it. */
  secretSubmit: "secret:submit",
  /** invoke(url) → OpenOutcome. Opens an https github.com / fleetd.sh link in the user's browser; refuses the rest. */
  openExternal: "app:openExternal",
  /** main → renderer: HubFrame */
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
  /** invoke(MenuCommand[]) → void. The menu commands enabled now; main greys out the rest. */
  appMenuState: "app:menuState",
  /** main → renderer: a command id (shared/shortcuts.ts or the palette registry), from a click in the app menu. */
  menuCommand: "menu:command",
  /** main → renderer: OpenTarget, from a clicked notification or a fleetd:// link. */
  appOpen: "app:open",
} as const;

type PushChannel = typeof IPC.hubFrame | typeof IPC.menuCommand | typeof IPC.appOpen;
export type InvokeChannel = Exclude<(typeof IPC)[keyof typeof IPC], PushChannel>;
