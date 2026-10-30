import type { LinkHandlerClaim, LinkHandlerStatus, NotifyRequest, OpenTarget } from "../shared/app";
import type { MenuCommand } from "../shared/menu";
import type { BrowserInput } from "../shared/contracts";
import type { CallOutcome, ConnectOutcome, DropInfo, HubFrame, OpenOutcome, SecretOutcome } from "../shared/hub";
import type { HubColor, HubEntry, HubId, PairTarget } from "../shared/hubs";
import type { ChatScope, ClaudeAccountRequest, ErrorReport, GithubAppRequest, HubLinkRequest, McpServerRequest, OnePasswordRequest, OrderFocus, ProjectEnvRequest, SecretRequest, SessionWindowRequest } from "../shared/ipc";
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
    /** Main seals `value` to `boxPubKey` and submits it to `hub`; the value is never sent back or shown again. */
    submit(hub: HubId, request: SecretRequest): Promise<SecretOutcome>;
    /**
     * A project's environment changes: main seals each secret's value to `boxPubKey` and calls project_env_set. The
     * output lists the project's variables, a secret's by fingerprint only.
     */
    projectEnv(hub: HubId, request: ProjectEnvRequest): Promise<CallOutcome>;
    /**
     * An MCP server to save: main seals each secret value to every machine in `boxes` and calls mcp_server_set. The
     * output has the server as the hub keeps it, a secret's by the machines holding it only.
     */
    mcpServer(hub: HubId, request: McpServerRequest): Promise<CallOutcome>;
    /**
     * A link key pasted into a Navi's Linked hubs: main seals it to `boxPubKey`, the hub's own key, and calls
     * hub_link_add. The output has the link and what it reaches, never the key.
     */
    hubLink(hub: HubId, request: HubLinkRequest): Promise<CallOutcome>;
    /**
     * A Claude account's key or token: main seals it to every machine in `boxes` and calls claude_hub_api_set or
     * claude_subscription_set. The output has where it is sealed, by fingerprint only; nothing returns the value.
     */
    claudeAccount(hub: HubId, request: ClaudeAccountRequest): Promise<CallOutcome>;
    /**
     * The person's 1Password service account token: main seals it to every machine in `boxes` and calls
     * onepassword_set. The output has where it is sealed, by fingerprint only; nothing returns the value.
     */
    onePassword(hub: HubId, request: OnePasswordRequest): Promise<CallOutcome>;
  };
  readonly github: {
    /**
     * Creates the hub's own GitHub App: main posts its manifest to GitHub from a page on 127.0.0.1, catches GitHub's
     * code there and calls github_app_create, answering as it does. Error code `cancelled` after `cancel()`.
     */
    createApp(hub: HubId, request: GithubAppRequest): Promise<CallOutcome>;
    /**
     * Connects the person's own GitHub through the hub's App: main opens GitHub's sign-in in the browser, catches the
     * answer on 127.0.0.1 and calls github_connect, answering as it does. Error code `cancelled` after `cancel()`.
     */
    connect(hub: HubId): Promise<CallOutcome>;
    /** Stops waiting for GitHub. */
    cancel(): Promise<void>;
  };
  /**
   * Opens an https link to github.com (or a subdomain) or fleetd.sh in the user's browser. Anything else comes back
   * as `{ ok: false, message }` saying why; it never rejects.
   */
  openExternal(url: string): Promise<OpenOutcome>;
  /** The hubs this app is paired with (docs/design/hubs.md), in sidebar order; never empty. */
  readonly hubs: {
    /** The hubs as main had them when it made this window, so the page renders without waiting; `list()` is current. */
    readonly initial: readonly HubEntry[];
    list(): Promise<readonly HubEntry[]>;
    /** Every change after the first `list()`: a hub added, renamed or removed, or first paired. Returns the unsubscribe. */
    subscribe(listener: (list: readonly HubEntry[]) => void): () => void;
    /** A new label (free text, trimmed) and colour; null takes the colour away. */
    update(hub: HubId, change: { label: string; color: HubColor | null }): Promise<ConnectOutcome>;
  };
  /** One hub's connection: every call names the hub first. */
  readonly hub: {
    /**
     * Frames start with the current state; when connected, a fresh snapshot follows, then events and live frames.
     * Returns the unsubscribe.
     */
    subscribe(hub: HubId, listener: (frame: HubFrame) => void): () => void;
    /** Any MCP tool, with the hub's saved key. Never rejects: failures come back as `{ ok: false, error }`. */
    call(hub: HubId, tool: string, input: unknown, options?: { timeoutMs?: number }): Promise<CallOutcome>;
    /** The chat whose streamed text arrives as `chat_delta` frames, or null to stop. Kept across reconnects. */
    chat(hub: HubId, project: ChatScope | null): Promise<void>;
    /** The order whose lanes stream their text in live frames, or null for none. Kept across reconnects. */
    focus(hub: HubId, workstreamId: OrderFocus | null): Promise<void>;
    /** The browser session whose frames this window shows, or null for none. Kept across reconnects. */
    watch(hub: HubId, session: string | null): Promise<void>;
    /** A person's input to a session they took over, in its last frame's pixels; dropped while offline. */
    input(hub: HubId, session: string, input: BrowserInput): Promise<void>;
    resync(hub: HubId): Promise<void>;
    /** Dials the hub now instead of at the next retry (Retry now while offline). */
    retryNow(hub: HubId): Promise<void>;
    /**
     * The last data the app saw from a hub, as the renderer wrote it (src/renderer/src/data/cache.ts). Main keeps one
     * per hub in userData, for the address it is paired with only; Forget deletes it.
     */
    readonly cache: {
      read(hub: HubId): Promise<string | null>;
      write(hub: HubId, text: string): Promise<void>;
    };
    /** Saves a key into the hub `target` names (absent: the first) and connects. */
    connect(url: string, key: string, target?: PairTarget): Promise<ConnectOutcome>;
    /** Forgets the hub's key and cache and takes it off the list; the last one stays, not paired. */
    forget(hub: HubId): Promise<void>;
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
    /** Makes this computer a machine of `hub` as `machineId`; resolves with how it ended. Never rejects. */
    joinHere(hub: HubId, machineId: string): Promise<JoinHere>;
    /** Whether this computer's fleetd dir holds a hub or an enrolled node (under any id), or neither. Never rejects. */
    thisComputer(): Promise<ThisComputer>;
    /** `hub`'s join, running or last ended since the app started, if any. */
    joinHereState(hub: HubId): Promise<JoinHere | null>;
    /** Every change of `hub`'s join. Returns the unsubscribe. */
    onJoinHere(hub: HubId, listener: (state: JoinHere) => void): () => void;
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
