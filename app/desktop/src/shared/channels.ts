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
  /** invoke() → void. A fresh snapshot, then events from its cursor. */
  hubResync: "hub:resync",
  /** invoke(ConnectRequest) → ConnectOutcome. Saves the hub URL and key, then connects. */
  hubConnect: "hub:connect",
  /** invoke() → void. Disconnects and deletes the saved key. */
  hubForget: "hub:forget",
  /** invoke() → string. This computer's host name, to tell whether it is one of the hub's machines. */
  systemHostName: "system:host-name",
  /** invoke() → string | null. A native folder picker; null when cancelled. */
  projectsPickFolder: "projects:pick-folder",
  /** invoke(path) → DropInfo. What a folder or file dropped on the window holds for Add project. */
  projectsReadDrop: "projects:read-drop",
  /** invoke(text) → void. Writes the clipboard; the page itself has no clipboard permission. */
  copy: "app:copy",
  /** invoke(url) → OpenOutcome. Opens an https github.com / fleetd.sh link in the user's browser; refuses the rest. */
  openExternal: "app:openExternal",
  /** main → renderer: HubFrame */
  hubFrame: "hub:frame",
  /** invoke() → void. The page can take commands and targets now; main sends what it held for it. */
  appReady: "app:ready",
  /** invoke(NotifyRequest) → void. Posts a system notification; clicking it sends `appOpen` with its target. */
  appNotify: "app:notify",
  /** invoke(MenuCommand[]) → void. The menu commands enabled now; main greys out the rest. */
  appMenuState: "app:menuState",
  /** main → renderer: a command id (shared/shortcuts.ts or the palette registry), from a click in the app menu. */
  menuCommand: "menu:command",
  /** main → renderer: OpenTarget, from a clicked notification or a fleetd:// link. */
  appOpen: "app:open",
} as const;

type PushChannel = typeof IPC.hubFrame | typeof IPC.menuCommand | typeof IPC.appOpen;
export type InvokeChannel = Exclude<(typeof IPC)[keyof typeof IPC], PushChannel>;
