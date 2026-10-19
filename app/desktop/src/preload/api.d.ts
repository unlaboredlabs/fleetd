import type { CallOutcome, ConnectOutcome, HubFrame, HubState } from "../shared/hub";
import type { LiveScope } from "../shared/ipc";
import type { PairOutcome, PairRequest, PairStart, Probe } from "../shared/pairing";

/** `window.fleetd`: everything the renderer can ask of main. There is no other bridge. */
export interface FleetdApi {
  readonly platform: "darwin" | "linux" | "win32" | "other";
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
    /** A code `fleetd init` left on this computer, and whether a hub answers there. Never rejects. */
    start(): Promise<PairStart>;
    /** The hub's version and protocol from its /healthz. Never rejects. */
    probe(hub: string): Promise<Probe>;
    /** Trades a code for a key, then saves it and connects. Never rejects: failures carry the hub's fix. */
    redeem(request: PairRequest): Promise<PairOutcome>;
  };
}

declare global {
  interface Window {
    readonly fleetd: FleetdApi;
  }
}
