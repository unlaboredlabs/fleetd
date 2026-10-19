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
  /** main → renderer: HubFrame */
  hubFrame: "hub:frame",
} as const;

export type InvokeChannel = Exclude<(typeof IPC)[keyof typeof IPC], typeof IPC.hubFrame>;
