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
  /** A subscriber wants the current data: a fresh snapshot and the stream after it. */
  resync(): void;
  /** The machine woke; the socket may be half-open. */
  reconnectNow(): void;
  /** This minute's app presence, sent only on a live link and never answered. */
  presence(frame: PresenceFrame): void;
  /** The browser session whose frames to forward, or null for none; kept across reconnects. */
  watch(session: string | null): void;
  /** A person's input to a session they have taken over; dropped while the link is down. */
  input(session: string, input: BrowserInput): void;
}
