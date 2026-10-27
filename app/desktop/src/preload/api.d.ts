import type { LinkHandlerClaim, LinkHandlerStatus, NotifyRequest, OpenTarget } from "../shared/app";
import type { MenuCommand } from "../shared/menu";
import type { BrowserInput } from "../shared/contracts";
import type { CallOutcome, ConnectOutcome, DropInfo, HubFrame, OpenOutcome, SecretOutcome } from "../shared/hub";
import type { ChatScope, ErrorReport, McpServerRequest, OrderFocus, ProjectEnvRequest, SecretRequest, SessionWindowRequest } from "../shared/ipc";
import type { JoinHere, ThisComputer } from "../shared/joinHere";
import type { KeyStore, PairOutcome, PairRequest, PairStart, Probe, SetupOutcome } from "../shared/pairing";
import type { UpdatesState } from "../shared/updates";

/** `window.fleetd`: everything the renderer can ask of main. There is no other bridge. */
export interface FleetdApi {
  readonly platform: "darwin" | "linux" | "win32" | "other";
  /** The fixture standing in for the hub (FLEETD_FIXTURE), or null. The shell shows a banner while it's set. */
  readonly fixture: string | null;
  /** The window draws a translucent sidebar (macOS vibrancy): the page leaves the sidebar's background clear. */
  readonly vibrancy: boolean;
  /** The app's version, for an error card's Copy details. */
  readonly version: string;
  /** Writes text to the clipboard (the page has no clipboard permission of its own). */
  copy(text: string): Promise<void>;
  readonly secret: {
    /** Main seals `value` to `boxPubKey` and submits it; the value is never sent back or shown again. */
    submit(request: SecretRequest): Promise<SecretOutcome>;
    /**
     * A project's environment changes: main seals each secret's value to `boxPubKey` and calls project_env_set. The
     * output lists the project's variables, a secret's by fingerprint only.
     */
    projectEnv(request: ProjectEnvRequest): Promise<CallOutcome>;
    /**
     * An MCP server to save: main seals each secret value to every machine in `boxes` and calls mcp_server_set. The
     * output has the server as the hub keeps it, a secret's by the machines holding it only.
     */
    mcpServer(request: McpServerRequest): Promise<CallOutcome>;
  };
  /**
   * Opens an https link to github.com (or a subdomain) or fleetd.sh in the user's browser. Anything else comes back
   * as `{ ok: false, message }` saying why; it never rejects.
   */
  openExternal(url: string): Promise<OpenOutcome>;
  readonly hub: {
    /**
     * Frames start with the current state; when connected, a fresh snapshot follows, then events and live frames.
     * Returns the unsubscribe.
     */
    subscribe(listener: (frame: HubFrame) => void): () => void;
    /** Any MCP tool, with the saved key. Never rejects: failures come back as `{ ok: false, error }`. */
    call(tool: string, input: unknown, options?: { timeoutMs?: number }): Promise<CallOutcome>;
    /** The chat whose streamed text arrives as `chat_delta` frames, or null to stop. Kept across reconnects. */
    chat(project: ChatScope | null): Promise<void>;
    /** The order whose lanes stream their text in live frames, or null for none. Kept across reconnects. */
    focus(workstreamId: OrderFocus | null): Promise<void>;
    /** The browser session whose frames this window shows, or null for none. Kept across reconnects. */
    watch(session: string | null): Promise<void>;
    /** A person's input to a session they took over, in its last frame's pixels; dropped while offline. */
    input(session: string, input: BrowserInput): Promise<void>;
    resync(): Promise<void>;
    /** Dials the hub now instead of at the next retry (Retry now while offline). */
    retryNow(): Promise<void>;
    /**
     * The last hub data the app saw, as the renderer wrote it (src/renderer/src/data/cache.ts). Main keeps it in
     * userData for the paired hub only; reading gives null for any other hub, and Forget deletes it.
     */
    readonly cache: {
      read(): Promise<string | null>;
      write(text: string): Promise<void>;
    };
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
    /** Where the hub key is kept: encrypted by the OS, or a private file (and why, and how to change that). */
    store(): Promise<KeyStore>;
    /** Opens `fleetd init` in the system terminal, or says why not and what to run. Never rejects; takes nothing. */
    setup(): Promise<SetupOutcome>;
  };
  readonly system: {
    /** This computer's host name (without .local). */
    hostName(): Promise<string>;
  };
  /** Add machine's "This computer" (src/main/joinHere.ts). */
  readonly machines: {
    /** Makes this computer a machine of the hub as `machineId`; resolves with how it ended. Never rejects. */
    joinHere(machineId: string): Promise<JoinHere>;
    /** Whether this computer's fleetd dir holds a hub or an enrolled node (under any id), or neither. Never rejects. */
    thisComputer(): Promise<ThisComputer>;
    /** The join running or last ended since the app started, if any. */
    joinHereState(): Promise<JoinHere | null>;
    /** Every change of a join. Returns the unsubscribe. */
    onJoinHere(listener: (state: JoinHere) => void): () => void;
  };
  readonly projects: {
    /** A native folder picker; null when cancelled. */
    pickFolder(): Promise<string | null>;
    /** What a dropped folder or link file holds for Add project; `other` for anything else (or a File with no path). */
    readDrop(file: File): Promise<DropInfo>;
  };
  /** The app's own update. */
  readonly updates: {
    state(): Promise<UpdatesState>;
    /** Every change after the first `state()`. Returns the unsubscribe. */
    subscribe(listener: (state: UpdatesState) => void): () => void;
    /** Checks now; "Checking…", then the answer, arrive through `subscribe`. */
    check(): Promise<void>;
    /** Restarts into the downloaded update, or once it's downloaded; the deb opens its download. */
    install(): Promise<void>;
    /** Takes back an `install()` whose download still runs. */
    keep(): Promise<void>;
  };
  readonly app: {
    /** Command ids clicked in the app menu (an accelerator runs in the renderer's keymap instead). Returns the unsubscribe. */
    onMenuCommand(listener: (id: string) => void): () => void;
    /**
     * Clicked notifications and fleetd:// links. Targets that arrived before the first listener (a link that
     * launched the app) are delivered to it. Returns the unsubscribe.
     */
    onOpen(listener: (target: OpenTarget) => void): () => void;
    /** False when this system shows no notifications. */
    notify(request: NotifyRequest): Promise<boolean>;
    /** The Dock (or launcher) badge count; 0 clears it. */
    setBadge(count: number): Promise<void>;
    /** Opens one session in a window of its own (the pop-out, for taking over), or brings that window forward. */
    sessionWindow(request: SessionWindowRequest): Promise<void>;
    /** Mirrors the app's light/dark choice to the window, so its translucent sidebar matches. */
    setTheme(mode: "system" | "light" | "dark"): Promise<void>;
    /**
     * Whether this app opens fleetd:// links. With a claim ("pair-failed" from onboarding),
     * main makes it the handler first when it should; a dev build never does.
     */
    linkHandler(claim: LinkHandlerClaim | null): Promise<LinkHandlerStatus>;
    /**
     * App presence: whether main tells the hub, once a minute, that the app is focused, the project on screen and
     * whether there was input. Null only reads; a boolean turns it on or off. On by default.
     */
    presence(on: boolean | null): Promise<boolean>;
    /** The menu commands enabled now; main greys out the other menu items. */
    setMenuState(enabled: ReadonlyArray<MenuCommand>): Promise<void>;
    /** Logs an error the page caught to the app log (main scrubs it). Never rejects. */
    logError(report: ErrorReport): Promise<void>;
  };
}

declare global {
  interface Window {
    readonly fleetd: FleetdApi;
  }
}
