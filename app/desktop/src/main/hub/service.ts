import type { WebContents } from "electron";
import { IPC } from "../../shared/channels";
import type { CallOutcome, ConnectOutcome, HubFrame, HubState } from "../../shared/hub";
import type { CallRequest, ConnectRequest, LiveScope } from "../../shared/ipc";
import { HubClient } from "./client";
import { clearCredentials, fromEnv, loadCredentials, saveCredentials, type CredentialEnv } from "./credentials";
import { FixtureSource, type FixtureFile } from "./fixture";
import { appUrl } from "./protocol";
import type { HubSource } from "./source";
import type { Transport } from "./transport";

export type HubMode =
  | { readonly kind: "hub"; readonly credentials: CredentialEnv; readonly vars: NodeJS.ProcessEnv; readonly transport: Transport }
  | { readonly kind: "fixture"; readonly fixture: FixtureFile };

/** The hub as main offers it to windows: one source (a connection or a fixture), fanned out to every subscriber. */
export class HubService {
  readonly #mode: HubMode;
  readonly #subscribers = new Set<WebContents>();
  /** Windows that subscribed and haven't had their snapshot yet: events and live diffs would mean nothing to them. */
  readonly #awaitingSnapshot = new Set<WebContents>();
  #source: HubSource | null = null;
  /** Set from FLEETD_HUB_URL + FLEETD_AGENT_KEY: used for this run, never stored. */
  readonly #ephemeral: boolean;
  #unpaired: HubState = { phase: "unpaired" };

  constructor(mode: HubMode) {
    this.#mode = mode;
    if (mode.kind === "fixture") {
      this.#ephemeral = true;
      this.#source = new FixtureSource(mode.fixture, (frame) => this.#broadcast(frame));
      return;
    }
    const scripted = fromEnv(mode.vars);
    this.#ephemeral = scripted !== null;
    const loaded = scripted === null ? loadCredentials(mode.credentials) : { saved: scripted };
    if (loaded.note !== undefined) this.#unpaired = { phase: "unpaired", note: loaded.note };
    if (loaded.saved !== null) this.#use(loaded.saved.url, loaded.saved.key);
  }

  state(): HubState {
    return this.#source?.state ?? this.#unpaired;
  }

  /** Each subscribe starts the window from the current state, then (when connected) a fresh snapshot and live frame. */
  subscribe(contents: WebContents): void {
    if (!this.#subscribers.has(contents)) {
      this.#subscribers.add(contents);
      contents.once("destroyed", () => this.unsubscribe(contents));
    }
    this.#awaitingSnapshot.add(contents);
    this.#send(contents, { t: "state", state: this.state() });
    this.#source?.resync();
    this.#source?.refreshLive();
  }

  unsubscribe(contents: WebContents): void {
    this.#subscribers.delete(contents);
    this.#awaitingSnapshot.delete(contents);
  }

  call(request: CallRequest): Promise<CallOutcome> {
    return this.#source?.call(request) ?? Promise.resolve({ ok: false, error: { code: "offline", message: "Not paired with a hub." } });
  }

  live(scope: LiveScope | null): void {
    this.#source?.live(scope);
  }

  resync(): void {
    this.#source?.resync();
  }

  windowFocused(): void {
    this.#source?.refreshLive();
  }

  systemResumed(): void {
    this.#source?.reconnectNow();
  }

  connect(request: ConnectRequest): ConnectOutcome {
    if (this.#source instanceof FixtureSource) return this.#source.connectAnswer;
    if (this.#mode.kind !== "hub") return { ok: false, message: "Not available." };
    const url = appUrl(request.url);
    if (!url.ok) return { ok: false, message: url.message };
    if (!this.#ephemeral) {
      try {
        saveCredentials(this.#mode.credentials, { url: request.url, key: request.key });
      } catch (error) {
        return { ok: false, message: `Couldn't save the key: ${String(error)}` };
      }
    }
    this.#use(request.url, request.key);
    return { ok: true };
  }

  forget(): void {
    if (this.#mode.kind !== "hub") return;
    this.#source?.stop();
    this.#source = null;
    if (!this.#ephemeral) clearCredentials(this.#mode.credentials);
    this.#unpaired = { phase: "unpaired" };
    this.#broadcast({ t: "state", state: this.#unpaired });
  }

  stop(): void {
    this.#source?.stop();
  }

  #use(hub: string, key: string): void {
    if (this.#mode.kind !== "hub") return;
    this.#source?.stop();
    const client = new HubClient({ hub, key, transport: this.#mode.transport, emit: (frame) => this.#broadcast(frame) });
    this.#source = client;
    client.start();
  }

  #broadcast(frame: HubFrame): void {
    for (const contents of this.#subscribers) {
      if (frame.t === "snapshot") this.#awaitingSnapshot.delete(contents);
      else if ((frame.t === "event" || frame.t === "live") && this.#awaitingSnapshot.has(contents)) continue;
      this.#send(contents, frame);
    }
  }

  #send(contents: WebContents, frame: HubFrame): void {
    if (!contents.isDestroyed()) contents.send(IPC.hubFrame, frame);
  }
}
