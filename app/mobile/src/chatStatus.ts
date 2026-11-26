// The line under a chat's name in its header, as a chat app's "online": the link's word while it isn't live, then
// what the lead does, then whether it waits on you, then whether its machine is offline, else where the bot runs.
// Pure, so each case is unit-tested.

export interface ChatStatusIn {
  /** The link's state in the header's words (link.ts linkStatus): busy while it dials. */
  readonly link: { readonly busy: boolean } | undefined;
  /** "Connecting…", "Updating…" while it dials (hubWord.ts); undefined: nothing for a restart's first seconds. */
  readonly linkWord: string | undefined;
  /** The chat state's leadWorking. */
  readonly working: boolean;
  /** The bot's machine is offline: the lead's "working" is stale until it is back, and a message can't start it. */
  readonly machineOffline: boolean;
  readonly waitsOnMe: boolean;
  /** "on devbox": where the bot runs. */
  readonly quiet: string | undefined;
}

/** The line, and whether the header shows the lead at work (its spinner). */
export const chatStatus = (i: ChatStatusIn): { readonly text: string | undefined; readonly busy: boolean } => {
  if (i.link?.busy === true) return { text: i.linkWord ?? i.quiet, busy: false };
  if (i.link !== undefined) return { text: "Offline", busy: false };
  // Its machine went offline mid-turn: never "Working…" beside a bot that says the machine is offline (S9).
  if (i.working && i.machineOffline) return { text: "Machine offline", busy: false };
  if (i.working) return { text: "Working…", busy: true };
  return { text: i.waitsOnMe ? "Waiting for you" : i.machineOffline ? "Machine offline" : i.quiet, busy: false };
};
