import type { WebContents } from "electron";
import { IPC } from "../../shared/channels";
import type { CallOutcome, ConnectOutcome, HubFrame, HubState } from "../../shared/hub";
import type { CallRequest, ConnectRequest, LiveScope } from "../../shared/ipc";

/** The hub as main offers it to windows: one connection, fanned out to every subscribed window. */
export class HubService {
  #state: HubState = { phase: "unpaired" };
  readonly #subscribers = new Set<WebContents>();

  state(): HubState {
    return this.#state;
  }

  subscribe(contents: WebContents): void {
    if (!this.#subscribers.has(contents)) {
      this.#subscribers.add(contents);
      contents.once("destroyed", () => this.#subscribers.delete(contents));
    }
    this.#send(contents, { t: "state", state: this.#state });
  }

  unsubscribe(contents: WebContents): void {
    this.#subscribers.delete(contents);
  }

  call(_request: CallRequest): Promise<CallOutcome> {
    return Promise.resolve({ ok: false, error: { code: "offline", message: "Not connected to a hub." } });
  }

  live(_scope: LiveScope | null): void {}

  resync(): void {}

  connect(_request: ConnectRequest): Promise<ConnectOutcome> {
    return Promise.resolve({ ok: false, message: "Not implemented yet." });
  }

  forget(): Promise<void> {
    return Promise.resolve();
  }

  #send(contents: WebContents, frame: HubFrame): void {
    if (!contents.isDestroyed()) contents.send(IPC.hubFrame, frame);
  }
}
