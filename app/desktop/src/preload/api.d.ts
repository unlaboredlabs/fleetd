import type { LinkHandlerClaim, LinkHandlerStatus, NotifyRequest, OpenTarget } from "../shared/app";
import type { MenuCommand } from "../shared/menu";
import type { CallOutcome, ConnectOutcome, HubFrame, HubState, OpenOutcome } from "../shared/hub";
import type { LiveScope } from "../shared/ipc";

/** `window.fleetd`: everything the renderer can ask of main. There is no other bridge. */
export interface FleetdApi {
  readonly platform: "darwin" | "linux" | "win32" | "other";
  /** The fixture standing in for the hub (FLEETD_FIXTURE), or null. The shell shows a banner while it's set. */
  readonly fixture: string | null;
  /** Writes text to the clipboard (the page has no clipboard permission of its own). */
  copy(text: string): Promise<void>;
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
  readonly app: {
    /** Command ids clicked in the app menu (an accelerator runs in the renderer's keymap instead). Returns the unsubscribe. */
    onMenuCommand(listener: (id: string) => void): () => void;
    /**
     * Clicked notifications and fleetd:// links. Targets that arrived before the first listener (a link that
     * launched the app) are delivered to it. Returns the unsubscribe.
     */
    onOpen(listener: (target: OpenTarget) => void): () => void;
    notify(request: NotifyRequest): Promise<void>;
    /**
     * Whether this app opens fleetd:// links. With a claim ("user" from Settings, "pair-failed" from onboarding),
     * main makes it the handler first when it should; a dev build never does.
     */
    linkHandler(claim: LinkHandlerClaim | null): Promise<LinkHandlerStatus>;
    /** The menu commands enabled now; main greys out the other menu items. */
    setMenuState(enabled: ReadonlyArray<MenuCommand>): Promise<void>;
  };
}

declare global {
  interface Window {
    readonly fleetd: FleetdApi;
  }
}
