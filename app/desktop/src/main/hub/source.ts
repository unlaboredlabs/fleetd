import type { CallOutcome, HubState } from "../../shared/hub";
import type { CallRequest, ChatScope, OrderFocus } from "../../shared/ipc";

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
}
