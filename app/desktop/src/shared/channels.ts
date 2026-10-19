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
  /** invoke(text) → void. Writes the clipboard; the page itself has no clipboard permission. */
  copy: "app:copy",
  /** invoke(SecretRequest) → SecretOutcome. Main seals the value to the machine's key and submits it. */
  secretSubmit: "secret:submit",
  /** main → renderer: HubFrame */
  hubFrame: "hub:frame",
} as const;

export type InvokeChannel = Exclude<(typeof IPC)[keyof typeof IPC], typeof IPC.hubFrame>;
