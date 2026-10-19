import type { NotifyRequest, OpenTarget } from "../shared/app";
import type { MenuCommand } from "../shared/menu";
import type { CallOutcome, ConnectOutcome, DropInfo, HubFrame, HubState, OpenOutcome, SecretOutcome } from "../shared/hub";
import type { LiveScope, SecretRequest } from "../shared/ipc";
import type { PairOutcome, PairRequest, PairStart, Probe } from "../shared/pairing";

/** `window.fleetd`: everything the renderer can ask of main. There is no other bridge. */
export interface FleetdApi {
  readonly platform: "darwin" | "linux" | "win32" | "other";
  /** The fixture standing in for the hub (FLEETD_FIXTURE), or null. The shell shows a banner while it's set. */
  readonly fixture: string | null;
  /** Writes text to the clipboard (the page has no clipboard permission of its own). */
  copy(text: string): Promise<void>;
  readonly secret: {
    /** Main seals `value` to `boxPubKey` and submits it; the value is never sent back or shown again. */
    submit(request: SecretRequest): Promise<SecretOutcome>;
  };
  /**
   * Opens an https link to github.com (or a subdomain) or fleetd.sh in the user's browser. Anything else comes back
   * as `{ ok: false, message }` saying why; it never rejects.
   */
  openExternal(url: string): Promise<OpenOutcome>;
  readonly hub: {
    state(): Promise<HubState>;
    /**
     * Frames start with the current state; when connected, a fresh snapshot follows, then events and live frames.
     * Returns the unsubscribe.
     */
    subscribe(listener: (frame: HubFrame) => void): () => void;
    /** Any MCP tool, with the saved key. Never rejects: failures come back as `{ ok: false, error }`. */
    call(tool: string, input: unknown, options?: { timeoutMs?: number }): Promise<CallOutcome>;
    /** The live subscription, or null to stop it. */
    live(scope: LiveScope | null): Promise<void>;
    resync(): Promise<void>;
    connect(url: string, key: string): Promise<ConnectOutcome>;
    forget(): Promise<void>;
  };
  readonly pair: {
    /** Whether `fleetd init` left a code on this computer (not the code), and whether a hub answers. Never rejects. */
    start(): Promise<PairStart>;
    /** The hub's version and protocol from its /healthz. Never rejects. */
    probe(hub: string): Promise<Probe>;
    /** Trades a code for a key, then saves it and connects. Never rejects: failures carry the hub's fix. */
    redeem(request: PairRequest): Promise<PairOutcome>;
    /** Pairs from app-pair.json in main, only while no key is saved; the code never comes here. */
    auto(): Promise<PairOutcome>;
  };
  readonly system: {
    /** This computer's host name (without .local). */
    hostName(): Promise<string>;
  };
  readonly projects: {
    /** A native folder picker; null when cancelled. */
    pickFolder(): Promise<string | null>;
    /** What a dropped folder or link file holds for Add project; `other` for anything else (or a File with no path). */
    readDrop(file: File): Promise<DropInfo>;
  };
  readonly app: {
    /** Command ids clicked in the app menu (an accelerator runs in the renderer's keymap instead). Returns the unsubscribe. */
    onMenuCommand(listener: (id: string) => void): () => void;
    /**
     * Clicked notifications and fleetd:// links. Targets that arrived before the first listener (a link that
     * launched the app) are delivered to it. Returns the unsubscribe.
     */
    onOpen(listener: (target: OpenTarget) => void): () => void;
    notify(request: NotifyRequest): Promise<void>;
    /** The menu commands enabled now; main greys out the other menu items. */
    setMenuState(enabled: ReadonlyArray<MenuCommand>): Promise<void>;
  };
}

declare global {
  interface Window {
    readonly fleetd: FleetdApi;
  }
}
