import type { BrowserInput } from "../../shared/contracts";
import type { CallOutcome, HubState } from "../../shared/hub";
import type { CallRequest, ChatScope, OrderFocus } from "../../shared/ipc";
import type { PresenceFrame } from "../presence";

/** Where hub frames come from: the real connection, or a fixture file. HubService fans its frames out to windows. */
export interface HubSource {
  readonly state: HubState;
  start(): void;
  stop(): void;
  call(request: CallRequest): Promise<CallOutcome>;
  /** The chat whose streamed text to forward, or null for none. */
  chat(project: ChatScope | null): void;
  /** The order whose lanes stream their text, or null for none. */
  focus(workstreamId: OrderFocus | null): void;
  /** The window came to the front. */
  refreshLive(): void;
  /** Whether any window shows; the live feed pauses while none does. */
  shown(on: boolean): void;
  /** A subscriber wants the current data: a fresh snapshot and the stream after it. */
  resync(): void;
  /** Retry now: drop the link and dial again at once. */
  reconnectNow(): void;
  /** The computer woke, its screen unlocked or the network came back: the socket may be half-open. */
  woke(): void;
  /** This minute's app presence, sent only on a live link and never answered. */
  presence(frame: PresenceFrame): void;
  /** The browser session whose frames to forward, or null for none; kept across reconnects. */
  watch(session: string | null): void;
  /** Whether a window shows the Screens page: its pictures come while one does; kept across reconnects. */
  thumbs(on: boolean): void;
  /** A person's input to a session they have taken over; dropped while the link is down. */
  input(session: string, input: BrowserInput): void;
}
