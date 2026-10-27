import type { WebContents } from "electron";
import { IPC } from "../../shared/channels";
import type { BrowserInput } from "../../shared/contracts";
import type { CallOutcome, ConnectOutcome, HubFrame, HubState } from "../../shared/hub";
import type { CallRequest, ChatScope, ConnectRequest, OrderFocus } from "../../shared/ipc";
import type { HubCacheFile } from "./cache";
import { HubClient } from "./client";
import { clearCredentials, fromEnv, loadCredentials, saveCredentials, type CredentialEnv } from "./credentials";
import { FixtureSource, type FixtureFile } from "./fixture";
import type { PresenceFrame } from "../presence";
import { appUrl } from "./protocol";
import type { HubSource } from "./source";
import type { Transport } from "./transport";

export type HubMode =
  | {
      readonly kind: "hub";
      readonly credentials: CredentialEnv;
      readonly vars: NodeJS.ProcessEnv;
      readonly transport: Transport;
      /** The renderer's offline cache (main/hub/cache.ts). */
      readonly cache: HubCacheFile;
    }
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
  /** The chat on screen, kept here so a client made later (a first pairing, a re-pair) starts with it. */
  #chat: ChatScope | null = null;
  #focus: OrderFocus | null = null;
  /** Each window's watched browser session: the hub watches the one asked for last (a pop-out over its main window). */
  readonly #watches = new Map<WebContents, string>();
  #watching: string | null = null;

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

  /**
   * Each subscribe starts the window from the current state, then (when connected) a fresh snapshot and live frame.
   * A window that loads a new page (a reload) is no subscriber until that page subscribes itself: frames meant for the
   * page before (a fixture's replay still running) would reach the new one ahead of its own reads, the cache's too.
   */
  subscribe(contents: WebContents): void {
    if (!this.#subscribers.has(contents)) {
      this.#subscribers.add(contents);
      const gone = () => {
        contents.off("destroyed", gone);
        contents.off("did-navigate", gone);
        this.unsubscribe(contents);
      };
      contents.once("destroyed", gone);
      contents.once("did-navigate", gone);
    }
    this.#awaitingSnapshot.add(contents);
    this.#send(contents, { t: "state", state: this.state() });
    this.#source?.resync();
    this.#source?.refreshLive();
  }

  unsubscribe(contents: WebContents): void {
    this.#subscribers.delete(contents);
    this.#awaitingSnapshot.delete(contents);
    if (this.#watches.delete(contents)) this.#rewatch();
  }

  /** The browser session `contents` shows live, or null when it shows none. */
  watch(contents: WebContents, session: string | null): void {
    // Asked again, it is the newest ask.
    this.#watches.delete(contents);
    if (session !== null) this.#watches.set(contents, session);
    this.#rewatch();
  }

  #rewatch(): void {
    const last = [...this.#watches.values()].at(-1) ?? null;
    if (last === this.#watching) return;
    this.#watching = last;
    this.#source?.watch(last);
  }

  input(session: string, input: BrowserInput): void {
    this.#source?.input(session, input);
  }

  call(request: CallRequest): Promise<CallOutcome> {
    return this.#source?.call(request) ?? Promise.resolve({ ok: false, error: { code: "offline", message: "Not paired with a hub." } });
  }

  chat(project: ChatScope | null): void {
    this.#chat = project;
    this.#source?.chat(project);
  }

  focus(workstreamId: OrderFocus | null): void {
    this.#focus = workstreamId;
    this.#source?.focus(workstreamId);
  }

  resync(): void {
    this.#source?.resync();
  }

  /** The project whose chat is on screen, which is the project the app shows. */
  onScreen(): ChatScope | null {
    return this.#chat;
  }

  presence(frame: PresenceFrame): void {
    this.#source?.presence(frame);
  }

  /** The offline banner's Retry now: dial at once rather than at the next retry. */
  retryNow(): void {
    this.#source?.reconnectNow();
  }

  /** The disk cache for the hub this app is paired with; a fixture's own, which it never overwrites. */
  cacheRead(): string | null {
    if (this.#mode.kind === "fixture") return this.#mode.fixture.cache === undefined ? null : JSON.stringify(this.#mode.fixture.cache);
    const hub = this.#hub();
    return hub === null ? null : this.#mode.cache.read(hub);
  }

  cacheWrite(text: string): void {
    if (this.#mode.kind !== "hub") return;
    const hub = this.#hub();
    if (hub !== null) this.#mode.cache.write(text, hub);
  }

  /** The paired hub's address as the state names it; null while unpaired. */
  #hub(): string | null {
    const state = this.state();
    return state.phase === "unpaired" ? null : state.hub;
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
    this.#mode.cache.clear();
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
    client.chat(this.#chat);
    client.focus(this.#focus);
    client.watch(this.#watching);
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
