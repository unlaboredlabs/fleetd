// An agent's browser sessions, one per agent session at most, with nothing of the machine's: where their Chrome runs,
// where their recordings go and how the hub is reached all come in (`BrokerHost`). The node's broker (./index.ts) gives
// its own: Chrome from its warm pool, recordings in a folder under its home sent to the hub, its link. A service with no
// node (fleetd cloud) gives its own, and every session's Chrome runs in its agent's box (../place/box_chrome.ts).
// Either way the agent reaches its browser only through the CDP proxy (cdp_proxy.ts), whose guard and the fills stay
// here, outside any box: the agent may be root in its box, and the no-read-back seal could not hold there.
//
// It answers agent-mcp's browser calls, the hub's `browser_watch`, `browser_input`, `browser_control` and
// `session_end` frames, reports each session to the hub as a `browser_session` lead call in its agent's name, and gives
// the heartbeat each live session's latest step. Each session is recorded (recording.ts): its action log from the
// agent's `agent-browser` commands and fleetd's own steps, its video, and its DOM trace (the page after each of the
// agent's commands and each fill, session.ts).
//
// What a session may do beyond driving: fill a login from the vault or 1Password (credentials.ts, vault.ts), an address
// from the vault (address.ts), pay at a checkout with its card (cards.ts), and take a value only the person may type
// (secure_input.ts). From the first fill on, the session is sealed: every answer to the agent is scrubbed of the
// values, and the proxy lets through a narrower list.
//
// A box's Chrome outlives a dropped connection for a while (box_chrome.ts GRACE_MS): the broker dials it again, and the
// session goes on as it was, sealed if it was. A new holder of the session (another instance of a service) takes it
// over from its `snapshot` with `adopt`. Either one that can't reach the Chrome again ends the session with a plain note.
import { randomBytes } from "node:crypto";
import type { ThreadItem } from "../../shared/sessions.ts";
import type { BrowserControl, BrowserControlTo, BrowserInput, BrowserSessionState } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { BrowserCallFrame, BrowserControlFrame, BrowserInputFrame, BrowserWatchFrame, SessionEndFrame } from "../../shared/screens_wire.ts";
import type { SecretDeliver as LinkDeliver, SecretResult } from "../../shared/node_link.ts";
import { type FillAddressCall, fillAddress } from "./address.ts";
import { policy as agentBrowserPolicy } from "./agent_browser_policy.ts";
import { purchaseFill, purchaseRequest, WAIT_ON_PERSON_MS } from "./cards.ts";
import { Proxy, type Sessions } from "./cdp_proxy.ts";
import { Credentials, type FillCredentialCall, fillCredential, filledFieldRefusal, outgoing, remoteVault, type SessionVault, unread } from "./credentials.ts";
import type { ChromeHandle, Launched } from "./launch_args.ts";
import { type Credential, type VaultFor } from "./logins.ts";
import { boxChrome, reattachChrome, type ScreenBox, timing } from "../place/box_chrome.ts";
import { type Meta, type Recording, type RecordingStore, Steps } from "./recording.ts";
import { deliver as deliverSecureInput, fillApproved, request as requestSecureInput, type Waiting, waitingKey } from "./secure_input.ts";
import { Session, type SessionState } from "./session.ts";

/** A session no step touched this long ends (BrokerHost `idleMinutes`, else 30). */
const IDLE_MINUTES = 30;

/** `secret_deliver` as the node reads it (../wire.ts). */
type SecretDeliver = Omit<LinkDeliver, "sink"> & { sink: string };

const newId = () => `B${[...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

/** One open session: its browser, and what goes with it. */
type Open = {
  session: Session;
  browser: Launched;
  purpose: string;
  note?: string;
  /** Lets go of the bot's kept profile in a box it runs on. */
  release?: () => Promise<void>;
  /** The box its Chrome runs in, to dial it again after a dropped connection. */
  box?: ScreenBox;
  /** How many connections to its Chrome came before this one's: each new one's ids start past the last's. */
  gen: number;
  /** The bot whose kept profile it runs on in its box, while it does. */
  kept?: string;
  /** Its Chrome runs on this machine, held past the node (held.ts), rather than in an agent's box. */
  here?: boolean;
};

/** Where an agent session's hosted box is, for its browser, which runs in it (../place/box_chrome.ts), or `starting`
 * while it is being made. */
export type BoxedFor = { box: ScreenBox } | "starting";

/** A bot's kept profile in the box its lead runs in, readied there, and its let-go once the browser on it closed. */
export type KeptInBox = { dir: string; release(): Promise<void> };

/** A kept profile in a box a session's browser holds: its bot, where it is, and its let-go. */
type HeldKept = { project: string; dir: string; release: () => Promise<void> };

/** A session's project, whose kept profile its browser runs on: a lead's, or a person's screen. */
export type KeptOwner = {
  name: string;
  /** A person's screen, or a lead with repos: with the kept profile busy, it opens on a fresh one rather than not at all. */
  freshIfBusy: boolean;
  /** Its browser runs on this machine, never one the hub would pick: a lead that does its own work. */
  staysHere: boolean;
};

/** What a broker needs of where it runs. */
export type BrokerHost = {
  /** A lead call to the hub in a session's name: its result, or its refusal thrown (a ToolError). */
  call(op: string, args: Record<string, unknown>, opts: { threadId?: string; cwd?: string; waitMs?: number }): Promise<Record<string, unknown>>;
  /** A frame to the hub: a watched session's `browser_frame`. */
  send(frame: { t: string } & Record<string, unknown>): void;
  /** The agent session's own secrets, which its recording is scrubbed of. */
  secrets(thread: string): [string, string][];
  /** The key the hub seals vault values to, for this broker's sessions. */
  boxKey(): { open(sealed: Uint8Array): Uint8Array | null };
  /** Where recordings go. */
  recordings: RecordingStore;
  /** agent-browser's action policy `text` for the agent session, written where its agent-browser reads it. */
  policy(thread: string, text: string): Promise<void>;
  /** The proxy's key (64 hex characters), which a new holder signs the same tokens with (none: a random one, this
   * broker's alone); or the proxy itself. */
  proxyKey?: string;
  proxy?: (sessions: Sessions) => Proxy;
  /** The box an agent session runs in, if it runs in one: its browser then runs in it. */
  boxed?: (thread: string) => BoxedFor | undefined;
  /** The bot's kept profile in the box of agent session `thread` (a lead's), restored there; `inUse`: the folder a
   * session a holder before ran on, still there, whose let-go alone is wanted. None: the browser opens on a fresh one. */
  keptInBox?: (thread: string, project: string, inUse?: string) => Promise<KeptInBox | undefined>;
  /** 1Password, made with a session's token; none: a fill of a 1Password reference is refused. */
  vaultFor?: VaultFor;
  /** The idle limit: a session no step touched this long ends. */
  idleMinutes?: () => number;
  /** A session changed in what its `snapshot` holds (it started, filled a value, changed hands, ended). */
  changed?: (thread: string) => void;
};

/** What carries a session to another holder (`BrowserBroker.snapshot`, `adopt`): plain JSON, its filled values in it,
 * so whoever keeps it seals it. */
export type BrowserSnapshot = {
  v: 1;
  session: SessionState;
  purpose: string;
  note?: string;
  handle: ChromeHandle;
  owned: { sessions: string[]; targets: string[] };
  gen: number;
  kept?: string;
  /** The values filled into the agent session's browsers (Credentials `filledSince`). */
  filled: [string, string][];
  /** The secure inputs a person was asked for that the session waits on: each request, where it types, never a
   * value. Absent in a snapshot from before they were carried. */
  waiting?: Waiting[];
};

/** A connection's first id: each of ten generations takes its own span, far below Chrome's 32-bit ids. */
export const firstIdFor = (gen: number) => (gen % 10) * 200_000_000 + 1;

/** Why a session that reached its box's Chrome no more ends, in the agent's and the person's words. */
export const goneNote = (why: string) => `the browser in the box went: ${why}`;
/** And one whose Chrome ran on this machine, held past the node. */
const heldGoneNote = (why: string) => `the browser went: ${why}`;

/** How a session ended other than by its agent's session_end: when, and why in plain words. */
export type Ended = { sessionId: string; at: string; why: string };

/** What the agent is told while its session is being taken over (a restarted node's, from the node before). */
export const TAKING_OVER = "Your browser session is being taken over after this machine's fleetd node restarted: try again in a moment.";

/** What the agent is told of a session that ended under it: at its next browser command, or its session_end. */
export const endedNote = (e: Ended) =>
  `Your browser session ${e.sessionId} ended at ${e.at.slice(11, 16)} UTC: ${e.why}. Start a new one with session_start.`;

const noBrowserHere = () => new ToolError("failed", "This browser runs only in an agent's box, and this session has none.", "say so in your result: a person can check the bot's computer");

export class BrowserBroker {
  readonly sessions = new Map<string, Open>();
  readonly proxy: Proxy;
  private readonly starting = new Set<string>();
  readonly steps_: Steps;
  private readonly housekeeping: Timer;
  /** A session of this node's agent hosted on another machine (session_route): its relay and key. */
  remote: ((thread: string) => { url: string; key: Uint8Array } | undefined) | undefined;
  gone: ((thread: string) => void) | undefined;
  /** The box an agent session runs in, if it runs in one (the node's places): its browser then goes out through it, or
   * runs in it (a hosted box's). */
  boxed: ((thread: string) => BoxedFor | undefined) | undefined;
  /** How a hosted box's browser starts in it, on the bot's kept profile at `profile` there if given: the box's Chrome,
   * or a test's. */
  inBox: (box: ScreenBox, profile?: string) => Promise<Launched> = (box, profile) => boxChrome(box, [], profile ? { profile } : {});
  /** How the box's Chrome is reached again after its connection dropped: a test's may stand in. */
  reattach: (box: ScreenBox, handle: ChromeHandle, firstId: number, ms?: number) => Promise<Launched> = reattachChrome;
  /** 1Password: each session's vault and what it resolved, and each agent session's filled values. */
  readonly credentials: Credentials;
  /** The typed secure inputs sessions wait for, by browser session and request (secure_input.ts). */
  readonly waiting = new Map<string, Waiting>();
  /** Payment-provider hosts a card may fill in beyond cards.ts's PAYMENT_FRAMES (tests: a fake provider). */
  readonly extraPaymentFrames: string[] = [];
  /** The project of each agent session whose browser runs on its kept profile, by the agent session. */
  protected readonly owners = new Map<string, KeptOwner>();
  /** The bots whose kept profile in a box a browser runs on now: one at a time each. */
  private readonly keptBusy = new Set<string>();
  /** Reports and calls for the hub, sent in order (a takeover request never reaches the hub before its session). */
  private reports: Promise<unknown> = Promise.resolve();
  /** Let go of (`letGo`): its connections dropped, nothing more reported or ended. */
  private lettingGo = false;
  /** Why a sealed session refuses the driver's DOM write (a test's stand-in, or credentials.ts's). */
  writeRefusal: (session: Session, command: Record<string, unknown>) => Promise<string | undefined> = filledFieldRefusal;

  /** `steps`: each live session's latest step, kept while its recording is (the node's: while its folder is there). */
  constructor(
    protected readonly host: BrokerHost,
    steps: Steps = new Steps(),
  ) {
    this.steps_ = steps;
    this.credentials = new Credentials(
      host.vaultFor ??
        (() => {
          throw new Error("this machine reads no 1Password: fill the login from the team vault");
        }),
    );
    this.boxed = host.boxed;
    const sessions: Sessions = {
      live: (thread) => this.live(thread),
      remote: (thread) => this.remote?.(thread),
      gone: (thread) => this.gone?.(thread),
      ended: (thread) => {
        if (this.takingOver.has(thread)) return TAKING_OVER;
        const e = this.endedFor.get(thread);
        return e && endedNote(e);
      },
      writeRefusal: (session, command) => this.writeRefusal(session, command),
    };
    // No key given: a random one, never one an agent could compute a token with.
    this.proxy = host.proxy ? host.proxy(sessions) : Proxy.serve(host.proxyKey ?? randomBytes(32).toString("hex"), sessions);
    this.housekeeping = setInterval(() => void this.housekeep(), 60_000);
  }

  live(thread: string): Session | undefined {
    return this.sessions.get(thread)?.session;
  }

  byId(id: string): Session | undefined {
    for (const o of this.sessions.values()) if (o.session.id === id) return o.session;
    return undefined;
  }

  count(): number {
    return this.sessions.size;
  }

  /** The session's secrets for its start (session_route), to scrub its recording with: taken once by `open`; none
   * (`undefined`) drops what a start refused before it left. */
  secretsFor(thread: string, secrets: [string, string][] | undefined): void {
    if (secrets) this.pendingSecrets.set(thread, secrets);
    else this.pendingSecrets.delete(thread);
  }
  private readonly pendingSecrets = new Map<string, [string, string][]>();

  /** The agent session's own secrets, as where it runs holds them. */
  protected ownSecrets(thread: string): [string, string][] {
    return this.host.secrets(thread);
  }

  /** Writes agent-browser's action policy for `thread` (sealed once a value was filled) where it reads it. */
  async policy(thread: string, credentials: boolean): Promise<void> {
    await this.host.policy(thread, agentBrowserPolicy(credentials));
  }

  /** The machine as a box, for a browser of its own held past it (held.ts): the node's; none elsewhere. */
  protected boxOf(_browser: Launched): ScreenBox | undefined {
    return undefined;
  }

  /** A browser for an agent session that runs in no box: the node's own (./index.ts); a broker with no machine of its
   * own has none. */
  protected launchHere(_thread: string): Promise<Launched> {
    return Promise.reject(noBrowserHere());
  }

  /** The agent's `session_start`: a browser for its session, reported live to the hub. */
  async open(thread: string, purpose: string, given?: [string, string][]): Promise<{ sessionId: string; cdp: string; startMs: number }> {
    const secrets = given ?? this.pendingSecrets.get(thread);
    this.pendingSecrets.delete(thread);
    const started = performance.now();
    const open = this.sessions.get(thread);
    if (open) {
      throw new ToolError(
        "invalid",
        `Your browser session ${open.session.id} is open already.`,
        "use it, or end it with session_end before starting another",
      );
    }
    if (this.takingOver.has(thread)) throw new ToolError("invalid", TAKING_OVER, "use it in a moment, with no session_start");
    if (this.starting.has(thread)) throw new ToolError("invalid", "Your browser session is starting already.", "wait for it");
    this.starting.add(thread);
    this.setEnded(thread, undefined);
    try {
      const boxed = this.boxed?.(thread);
      if (boxed === "starting") throw new ToolError("invalid", "Your sandbox is still starting.", "try session_start again in a moment");
      // A hosted box's browser runs in the box, with nothing of this machine's: no pool, no egress.
      const inside = boxed?.box;
      let browser: Launched;
      let kept: HeldKept | undefined;
      try {
        if (inside) {
          kept = await this.keptFor(thread);
          try {
            browser = await this.inBox(inside, kept?.dir);
          } catch (e) {
            await kept?.release().catch(() => {});
            throw e;
          }
        } else browser = await this.launchHere(thread);
      } catch (e) {
        if (e instanceof ToolError) throw e;
        throw new ToolError(
          "failed",
          `The browser didn't start: ${(e as Error).message}`,
          "do without it and say so in your result; a person can check this machine's browser screens in Settings › Hub › Machines",
        );
      }
      let own: [string, string][];
      try {
        own = secrets ?? this.ownSecrets(thread);
      } catch (e) {
        await browser.close?.().catch(() => {});
        await kept?.release().catch(() => {});
        throw new ToolError(
          "failed",
          `The node could not read this session's secrets to scrub its recording (${(e as Error).message}).`,
          "try again; if it keeps failing, check the node's log",
        );
      }
      // The agent's agent-browser may connect to no other browser (agent_browser.rs `write_policy`).
      await this.policy(thread, false);
      const session = new Session(newId(), thread, browser.cdp, own);
      const here = inside ? undefined : this.boxOf(browser);
      const entry: Open = {
        session,
        browser,
        purpose,
        gen: 0,
        ...(inside ? { box: inside } : here ? { box: here, here: true } : {}),
        ...(kept ? { kept: kept.project, release: kept.release } : {}),
      };
      let recording: Recording;
      try {
        recording = await this.host.recordings.open(this.meta(session, purpose));
      } catch (e) {
        await browser.close?.().catch(() => {});
        await entry.release?.().catch(() => {});
        throw new ToolError("failed", `The browser's recording didn't start: ${(e as Error).message}`, "try session_start again in a moment");
      }
      if (recording.note) entry.note = recording.note;
      this.attach(thread, entry, recording);
      try {
        await session.start();
      } catch (e) {
        this.sessions.delete(thread);
        await browser.close?.().catch(() => {});
        await entry.release?.().catch(() => {});
        throw new ToolError("failed", `The browser didn't start: ${(e as Error).message}`);
      }
      await this.report(session, "live");
      return { sessionId: session.id, cdp: this.proxy.url(thread), startMs: Math.round(performance.now() - started) };
    } finally {
      this.starting.delete(thread);
    }
  }

  /** The bot's kept profile in the box of agent session `thread`, for its lead, held until its browser lets go. */
  private async keptFor(thread: string, inUse?: string): Promise<HeldKept | undefined> {
    const owner = this.host.keptInBox ? this.owners.get(thread) : undefined;
    if (!owner) return undefined;
    // One browser at a time runs on a kept profile: a person's screen meanwhile opens on a fresh one, signed out.
    if (this.keptBusy.has(owner.name)) {
      if (owner.freshIfBusy) return undefined;
      throw new ToolError(
        "invalid",
        "This bot's browser is open in another session: it keeps the bot's sign-ins, and one browser at a time runs on them.",
        "end that session first (session_end there), or wait for it to end, then session_start again",
      );
    }
    this.keptBusy.add(owner.name);
    let given: KeptInBox | undefined;
    try {
      given = await this.host.keptInBox!(thread, owner.name, inUse);
    } catch (e) {
      this.keptBusy.delete(owner.name);
      throw new Error(`the bot's sign-ins didn't reach its box: ${(e as Error).message}`);
    }
    if (!given) {
      this.keptBusy.delete(owner.name);
      return undefined;
    }
    const held = given;
    let released = false;
    return {
      project: owner.name,
      dir: held.dir,
      release: async () => {
        if (released) return;
        released = true;
        this.keptBusy.delete(owner.name);
        await held.release();
      },
    };
  }

  /** What a session's recording says of it. */
  private meta(session: Session, purpose: string, resumed = false): Meta {
    return {
      sessionId: session.id,
      kind: "browser",
      threadId: session.threadId,
      cwd: "/",
      purpose,
      startedAt: session.startedAt,
      credentialsFilled: session.credentialsFilled,
      ...(resumed ? { resumed: true } : {}),
    };
  }

  /** Puts an open session in the map, recorded to `recording`, with its hooks: its control's report, the driver's
   * scrub, and a dial again when its box's Chrome's connection drops. */
  private attach(thread: string, entry: Open, recording: Recording): void {
    const { session } = entry;
    session.onControl = () => {
      session.stepAt("agent_resumed", {}, true, undefined, 0);
      void this.report(session, "live");
    };
    session.outgoingHook = outgoing;
    session.recording = { to: recording, steps: this.steps_ };
    this.sessions.set(thread, entry);
    this.watchDrop(thread, entry);
  }

  /** When the connection to a box's Chrome drops while its session is open: dialled again for as long as Chrome waits
   * for a new one, the session going on as it was; or, gone, ended with a plain note. */
  private watchDrop(thread: string, entry: Open): void {
    if (!entry.box || !entry.browser.handle) return;
    const cdp = entry.session.cdp;
    cdp.onClose(() => {
      if (this.lettingGo || this.sessions.get(thread) !== entry || entry.session.cdp !== cdp) return;
      void this.redial(thread, entry);
    });
  }

  private async redial(thread: string, entry: Open): Promise<void> {
    const handle = entry.browser.handle!;
    let why: string;
    try {
      const again = await this.reattach(entry.box!, handle, firstIdFor(entry.gen + 1), timing.graceMs);
      if (this.lettingGo || this.sessions.get(thread) !== entry) {
        again.cdp.shut();
        return;
      }
      entry.gen += 1;
      entry.browser = { ...again, handle };
      await entry.session.reconnect(again.cdp);
      this.watchDrop(thread, entry);
      entry.session.stepAt("browser_reconnected", {}, true, undefined, 0);
      this.host.changed?.(thread);
      return;
    } catch (e) {
      why = (e as Error).message;
    }
    if (this.lettingGo || this.sessions.get(thread) !== entry) return;
    entry.session.stepAt("browser_gone", { why }, false, undefined, 0);
    await this.end(thread, entry.here ? heldGoneNote(why) : goneNote(why)).catch(() => {});
  }

  /** The agent's `session_end`, or the end of a session under it: closes the browser and reports the session ended.
   * `note`: why it ended when the agent didn't end it (idle, its Chrome went, the node stopped), which the agent is
   * told at its next browser command (the proxy's answer) or session_end. */
  async end(thread: string, note?: string): Promise<{ sessionId: string; kind: "browser"; files: { file: string; bytes: number }[]; note?: string }> {
    const open = this.sessions.get(thread);
    if (!open) throw this.noSession(thread);
    this.sessions.delete(thread);
    const { session } = open;
    this.setEnded(thread, note ? { sessionId: session.id, at: new Date().toISOString(), why: note } : undefined);
    // Out of the map but not yet ended: housekeeping's sweep leaves its recording alone until it is.
    this.ending.add(session.id);
    try {
      return await this.close(open, note);
    } finally {
      this.ending.delete(session.id);
      this.host.changed?.(thread);
    }
  }

  /** Sessions out of the map whose end is still under way (their video, their DOM captures), and those being taken
   * over: not yet a recording to send, nor one a stopped node left. */
  private readonly ending = new Set<string>();

  /** The last session of each agent session that ended under it (`end`'s note), until its next session_start: kept
   * where the broker runs says (`endedChanged`), so a node that restarts still tells the agent. */
  protected readonly endedFor = new Map<string, Ended>();

  /** The agent sessions whose browser session is about to be taken over (a restarted node's, from the node before). */
  protected readonly takingOver = new Set<string>();

  protected setEnded(thread: string, e: Ended | undefined): void {
    if (e) this.endedFor.set(thread, e);
    else if (!this.endedFor.delete(thread)) return;
    this.endedChanged();
  }

  /** `endedFor` changed: the node keeps it on disk. */
  protected endedChanged(): void {}

  /** The refusal of a browser call with no session open: why the last one ended, when one ended under the agent. */
  noSession(thread: string): ToolError {
    return this.endedRefusal(thread) ?? new ToolError("not_found", "No browser session is open.", "start one with session_start");
  }

  /** Why the agent session's last browser session ended under it, as a browser call's refusal (or that it is being
   * taken over); none if none did. */
  endedRefusal(thread: string): ToolError | undefined {
    if (this.takingOver.has(thread)) return new ToolError("invalid", TAKING_OVER, "try again in a moment");
    const e = this.endedFor.get(thread);
    return e && new ToolError("not_found", endedNote(e), "start a new one with session_start");
  }

  /**
   * Lets go of the agent session's browser session without ending it (the node stops, and the next one takes it over
   * from its snapshot): its connection to Chrome drops, which waits for the next holder; nothing is reported or
   * recorded.
   */
  keep(thread: string): void {
    const open = this.sessions.get(thread);
    if (!open) return;
    this.sessions.delete(thread);
    open.session.end();
    open.session.cdp.shut();
  }

  private async close(open: Open, why?: string): Promise<{ sessionId: string; kind: "browser"; files: { file: string; bytes: number }[]; note?: string }> {
    const { session } = open;
    // Every step's DOM capture queued so far lands first, while the page is still there.
    await session.flushCaptures();
    session.end();
    this.credentials.forget(session.id);
    for (const key of [...this.waiting.keys()]) if (key.startsWith(`${session.id}/`)) this.waiting.delete(key);
    await open.browser.close?.();
    await open.release?.().catch((e) => console.warn(`browser ${session.id}: the bot's sign-ins were not kept: ${(e as Error).message}`));
    const r = session.recording;
    const endedAt = new Date().toISOString();
    if (!r) {
      const note = why ?? open.note;
      await this.report(session, "recorded", { endedAt, ...(note ? { note } : {}) }, open.purpose);
      return { sessionId: session.id, kind: "browser", files: [], ...(note ? { note } : {}) };
    }
    const done = await r.to.end({ endedAt, credentialsFilled: session.credentialsFilled, ...(why ? { note: why } : {}) }, session.scrub(), session.offsetMs());
    return { sessionId: session.id, kind: "browser", files: done.files, ...(done.note ? { note: done.note } : {}) };
  }

  /** A session's meta with how many values it filled, after a fill. */
  filledMeta(session: Session): void {
    session.recording?.to.filled(session.credentialsFilled);
    this.host.changed?.(session.threadId);
  }

  /** The key the hub seals vault values to. */
  boxKey(): { open(sealed: Uint8Array): Uint8Array | null } {
    return this.host.boxKey();
  }

  /** The session's 1Password vault: the one made at its first fill, or a new one with the token from its secrets. */
  vault(session: Session): SessionVault {
    return this.credentials.vaultBy(session.id, () => this.ownSecrets(session.threadId));
  }

  /** A reference read from this machine's 1Password, with the token from agent session `thread`'s secrets, for its
   * session whose browser runs on another machine: only the value goes there (sealed), never the token. */
  async resolveCredential(thread: string, reference: string): Promise<Credential> {
    const vault = this.credentials.vaultBy(remoteVault(thread), () => this.ownSecrets(thread));
    try {
      return await vault.cache.get(vault.vault, reference);
    } catch (e) {
      throw unread(reference, e);
    }
  }

  /** One browser call of an agent's for its session here, other than its start and end (node/device's router). */
  async call(thread: string, frame: BrowserCallFrame, given?: Credential): Promise<{ op: string } & Record<string, unknown>> {
    const call = frame.call as { op: string } & Record<string, unknown>;
    switch (call.op) {
      case "session_start":
        return { op: "session_start", ...(await this.open(thread, String(call.purpose ?? "a browser session"))) };
      case "session_end":
        return { op: "session_end", ...(await this.end(thread)) };
      case "request_takeover":
        return { op: "request_takeover", ...(await this.requestTakeover(thread, String(call.reason ?? ""))) };
      case "fill_credential":
        return { op: "fill_credential", ...(await fillCredential(this, thread, call as FillCredentialCall, given)) };
      case "fill_address":
        return { op: "fill_address", ...(await fillAddress(this, thread, call as FillAddressCall)) };
      case "purchase_request":
        return { op: "purchase_request", ...(await purchaseRequest(this, thread, call)) };
      case "purchase_fill":
        return { op: "purchase_fill", ...(await purchaseFill(this, thread, call)) };
      case "request_secure_input":
        return { op: "request_secure_input", ...(await requestSecureInput(this, thread, call)) };
      case "secure_input_fill":
        return { op: "secure_input_fill", ...(await fillApproved(this, thread, call)) };
      case "desktop":
        throw new ToolError("invalid", "The desktop tool drives desktop sessions, not browsers.", "drive the browser with agent-browser");
      case "device":
        throw new ToolError("not_found", "No iOS session is open.", "start a simulator with mac sim start; agent-device then drives it");
      default:
        throw new ToolError("invalid", `${call.op} is not a browser call.`);
    }
  }

  /** The sealed value of a `fill:` sink from the hub: a person's secure input, typed into its session's field. */
  deliver(frame: SecretDeliver, boxKey: { open(sealed: Uint8Array): Uint8Array | null } | undefined, machine: string): Promise<SecretResult> {
    return deliverSecureInput(this, frame, boxKey, machine);
  }

  /** An agent's `request_takeover`: the hub lists it under "waiting on you". */
  private async requestTakeover(thread: string, reason: string): Promise<{ message: string }> {
    const session = this.live(thread);
    if (!session) throw this.noSession(thread);
    await this.inTurn(session, "browser_takeover", { sessionId: session.id, reason });
    // A person may take a while (a bank's confirmation, a captcha): the session waits for them, and a held fare or room
    // with it.
    session.hold(WAIT_ON_PERSON_MS);
    session.stepAt("request_takeover", { reason }, true, undefined, 0);
    return {
      message:
        "Asked: it shows under waiting on you. Carry on with what you can, or end your turn: you are told the moment they hand it back, and your next browser command then sees the page as they left it.",
    };
  }

  /** A call about a session for the hub, after every report before it, and its answer. */
  inTurn(session: Session, op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.inOrder(() => this.host.call(op, args, { threadId: session.threadId }));
  }

  /** Runs `fn` after every report and call queued before it: at once when none is. */
  private inOrder<T>(fn: () => Promise<T>): Promise<T> {
    const run = () => fn().finally(() => (this.queued -= 1));
    const answer = this.queued === 0 ? run() : this.reports.then(run);
    this.queued += 1;
    this.reports = answer.catch(() => {});
    return answer;
  }
  private queued = 0;

  /** A person's screen `key` for project `project` of this machine's, as the hub's own frame names it (D239): on its
   * kept profile, or a fresh one while that profile is busy. */
  personScreen(key: string, project: string): void {
    this.owners.set(key, { name: project, freshIfBusy: true, staysHere: true });
  }

  /** The agent session's claude launched as a lead of `project` (ScreenHooks `launched`). */
  lead(thread: string, role: string, project: string): void {
    if (role === "assistant") this.owners.set(thread, { name: project, freshIfBusy: false, staysHere: true });
    else if (role === "lead") this.owners.set(thread, { name: project, freshIfBusy: true, staysHere: false });
  }

  /** Whether the agent session's browser runs on this machine whatever the hub would pick: a lead that does its own
   * work, whose kept profile is here. */
  staysHere(thread: string): boolean {
    return this.owners.get(thread)?.staysHere ?? false;
  }

  /** Whether the session's browser runs here on its project's kept profile: a project's lead's, or a person's screen. */
  hasKept(thread: string): boolean {
    return this.owners.has(thread);
  }

  /** The session ended: its browser no longer runs on a kept profile. */
  dropKept(thread: string): void {
    this.owners.delete(thread);
  }

  /** The agent session's claude exited (the launch area's `ended`, before session_route ends its screens elsewhere):
   * its browser session here ends now, and what it filled is let go. */
  exited(thread: string): void {
    this.credentials.ended(thread);
    this.credentials.forget(remoteVault(thread));
    this.dropKept(thread);
    const open = this.sessions.get(thread);
    if (!open) return;
    open.session.stepAt("agent_session_ended", {}, true, undefined, 0);
    void this.end(thread, "its agent's session ended").catch(() => {});
    this.setEnded(thread, undefined);
  }

  private housekeepingNow = false;

  /**
   * Every minute: ends sessions no step touched for the idle limit (none while they wait on a person), and sends the
   * recordings still waiting to go.
   */
  async housekeep(now = Date.now()): Promise<void> {
    // A run that outlasts the minute isn't joined by the next.
    if (this.housekeepingNow || this.lettingGo) return;
    this.housekeepingNow = true;
    try {
      await this.housekeepOnce(now);
    } finally {
      this.housekeepingNow = false;
    }
  }

  private async housekeepOnce(now: number): Promise<void> {
    const minutes = this.host.idleMinutes?.() ?? IDLE_MINUTES;
    for (const [thread, open] of this.sessions) {
      if (open.session.control() === "human" || open.session.idleFor(now) < minutes * 60_000) continue;
      await this.end(thread, `no browser command for ${minutes} minutes`).catch(() => {});
    }
    const live = [...this.sessions.values()].map((o) => o.session.id).concat([...this.ending]);
    await this.host.recordings.sweep?.(live, now);
  }

  /** A finished thread item of `thread`'s: an `agent-browser` command is a step of its live session. */
  item(thread: string, item: ThreadItem): boolean {
    const open = this.sessions.get(thread);
    const kind = item.kind;
    if (!open || kind.type !== "command" || !drivesBrowser(kind.command)) return false;
    if (item.status !== "completed" && item.status !== "failed") return false;
    const end = item.completedAt ? Date.parse(item.completedAt) : Number.NaN;
    const durationMs = Number.isNaN(end) ? 0 : Math.max(end - Date.parse(item.startedAt), 0);
    const ok = item.status === "completed" && (kind.exitCode === undefined || kind.exitCode === 0);
    open.session.agentStep(kind.command, ok, kind.output, durationMs);
    return true;
  }

  /** Tells the hub how the session is now, in its agent's name, after what was reported before. */
  report(
    session: Session,
    state: BrowserSessionState,
    extra: { endedAt?: string; note?: string; files?: { file: string; bytes: number }[] } = {},
    purpose = [...this.sessions.values()].find((o) => o.session === session)?.purpose,
  ): Promise<void> {
    if (state === "live") this.host.changed?.(session.threadId);
    return this.inOrder(async () => {
      try {
        await this.host.call(
          "browser_session",
          {
            threadId: session.threadId,
            sessionId: session.id,
            kind: "browser",
            purpose: purpose ?? "a browser session",
            state,
            control: session.control(),
            startedAt: session.startedAt,
            files: [],
            credentialsFilled: session.credentialsFilled,
            ...extra,
          },
          { threadId: session.threadId },
        );
      } catch (e) {
        console.warn(`browser ${session.id}: not reported to the hub: ${(e as Error).message}`);
      }
    });
  }

  watch(frame: BrowserWatchFrame): void {
    const session = this.byId(frame.sessionId);
    if (!session) return;
    if (!frame.on) return session.setWatcher(undefined);
    if (session.watched()) return session.setBudget(frame.kbps);
    session.setWatcher({
      kbps: frame.kbps,
      send: (f) => this.host.send({ t: "browser_frame", ...f }),
    });
  }

  input(frame: BrowserInputFrame): void {
    const session = this.byId(frame.sessionId);
    // Queued behind what came before it: each input lands in order.
    if (session) this.inputs = this.inputs.then(() => session.input(frame.input as BrowserInput).catch(() => {}));
  }
  private inputs: Promise<void> = Promise.resolve();

  /** A person takes a session over, or hands it back; the hub waits for the node to say who drives, changed or not. */
  control(frame: BrowserControlFrame): void {
    const session = this.byId(frame.sessionId);
    if (!session) return;
    const to: BrowserControlTo = frame.control;
    const now = session.control();
    let next: BrowserControl | undefined;
    if (to === "human" && now !== "human") next = "human";
    else if (to === "agent" && now === "human") next = "handing_back";
    if (next) {
      session.setControl(next);
      session.stepAt(next === "human" ? "takeover" : "handback", { by: frame.by }, true, undefined, 0);
    }
    void this.report(session, "live");
  }

  /** The hub ended the task of `threadId`: its screen `sessionId` goes, if it still holds it. Its claude runs on: it is
   * still its project's lead, for its next session_start. */
  sessionEnd(frame: SessionEndFrame): void {
    const open = this.sessions.get(frame.threadId);
    if (open?.session.id === frame.sessionId) void this.end(frame.threadId, "fleetd ended it, as its task ended").catch(() => {});
  }

  /** Each live session's latest step, for the heartbeat. */
  steps(): { sessionId: string; step: unknown }[] {
    return this.steps_.list();
  }

  /**
   * What carries the agent session's browser session to another holder: undefined for none, or one whose Chrome
   * doesn't run in a box (it can't be dialled again). Its filled values are in it: seal it.
   */
  snapshot(thread: string): BrowserSnapshot | undefined {
    const open = this.sessions.get(thread);
    if (!open?.box || !open.browser.handle) return undefined;
    return {
      v: 1,
      session: open.session.state(),
      purpose: open.purpose,
      ...(open.note ? { note: open.note } : {}),
      handle: open.browser.handle,
      owned: open.session.cdp.owned(),
      gen: open.gen,
      ...(open.kept ? { kept: open.kept } : {}),
      filled: this.credentials.filledSince(thread, 0) ?? [],
      waiting: [...this.waiting].filter(([key]) => key.startsWith(`${open.session.id}/`)).map(([, w]) => ({ ...w })),
    };
  }

  /**
   * Takes over agent session `thread`'s browser session from the holder before (`snapshot`): its box's Chrome dialled
   * again, the session as it was (sealed if it filled a value, the broker's own sessions on its Chrome still hidden from
   * the driver, the secure inputs it waits on still waiting), recording on from there. A Chrome that went meanwhile
   * (its grace ran out, or its box) ends the session plainly instead: its recording ends with a note, and it is
   * reported ended, so control never stays with a person on a session nobody drives. Throws for a snapshot it can't read, and when the recording store refuses to go on (its
   * Chrome then waits on in its grace, for a try again).
   */
  async adopt(thread: string, snapshot: BrowserSnapshot, here?: ScreenBox): Promise<{ adopted: true; sessionId: string } | { adopted: false; note: string }> {
    if (snapshot?.v !== 1 || snapshot.session?.threadId !== thread || !snapshot.handle) throw new Error("not a browser session's snapshot for this agent session");
    if (this.sessions.has(thread)) return { adopted: true, sessionId: this.sessions.get(thread)!.session.id };
    if (this.starting.has(thread)) throw new Error("a browser of this agent session is starting or being taken over here already");
    // Held until the session is in the map (or ended): a session_start meanwhile can't open a second browser. Its
    // recording, meanwhile, is no stopped node's to end.
    this.starting.add(thread);
    this.ending.add(snapshot.session.id);
    try {
      return await this.adoptHeld(thread, snapshot, here);
    } finally {
      this.starting.delete(thread);
      this.ending.delete(snapshot.session.id);
    }
  }

  /** `adopt`, with the agent session held; `here`: its Chrome is this machine's, held past the node before. */
  private async adoptHeld(thread: string, snapshot: BrowserSnapshot, here?: ScreenBox): Promise<{ adopted: true; sessionId: string } | { adopted: false; note: string }> {
    for (const [ref, value] of snapshot.filled) this.credentials.filled(thread, ref, value);
    const boxed = here ? undefined : this.boxed?.(thread);
    const box = here ?? (boxed && boxed !== "starting" ? boxed.box : undefined);
    const gone = (why: string) => (here ? heldGoneNote(`${why}, while the node restarted`) : goneNote(`${why}, while it moved to another server`));
    let browser: Launched | undefined;
    let why = "its box is gone";
    if (box) {
      try {
        browser = await this.reattach(box, snapshot.handle, firstIdFor(snapshot.gen + 1));
      } catch (e) {
        why = (e as Error).message;
      }
    }
    const state: SessionState = { ...snapshot.session, control: browser ? snapshot.session.control : "agent" };
    if (!browser) {
      // A Chrome that isn't there to drive: its session ends now, recorded as far as it went.
      // No connection: it records its end and nothing more.
      const session = Session.restore(state, undefined as never);
      const note = gone(why);
      const recording = await this.host.recordings.open(this.meta(session, snapshot.purpose, true));
      session.recording = { to: recording, steps: this.steps_ };
      session.stepAt("browser_gone", { why }, false, undefined, 0);
      await recording.end({ endedAt: new Date().toISOString(), credentialsFilled: session.credentialsFilled, note }, session.scrub(), session.offsetMs());
      this.setEnded(thread, { sessionId: session.id, at: new Date().toISOString(), why: note });
      this.host.changed?.(thread);
      return { adopted: false, note };
    }
    browser.cdp.adoptOwned(snapshot.owned);
    const session = Session.restore(state, browser.cdp);
    const entry: Open = { session, browser: { ...browser, handle: snapshot.handle }, purpose: snapshot.purpose, gen: snapshot.gen + 1, box, ...(here ? { here: true } : {}) };
    if (snapshot.note) entry.note = snapshot.note;
    if (snapshot.kept) {
      const kept = await this.keptFor(thread, snapshot.handle.profile).catch(() => undefined);
      if (kept) Object.assign(entry, { kept: kept.project, release: kept.release });
    }
    let recording: Recording;
    try {
      recording = await this.host.recordings.open(this.meta(session, snapshot.purpose, true));
    } catch (e) {
      // Its Chrome waits on in its grace for a try again; only this connection goes.
      browser.cdp.shut();
      await entry.release?.().catch(() => {});
      throw new Error(`the browser session's recording didn't go on: ${(e as Error).message}`);
    }
    this.attach(thread, entry, recording);
    // A secure input the person was asked for is typed in here once they give it: the hub's delivery finds it.
    for (const w of snapshot.waiting ?? []) {
      this.waiting.set(waitingKey(session.id, w.requestId), { requestId: w.requestId, domain: w.domain, target: w.target, label: w.label });
    }
    try {
      await session.resume();
    } catch (e) {
      await this.end(thread, gone((e as Error).message)).catch(() => {});
      return { adopted: false, note: gone((e as Error).message) };
    }
    session.stepAt("browser_adopted", {}, true, undefined, 0);
    await this.report(session, "live");
    return { adopted: true, sessionId: session.id };
  }

  /**
   * Lets go of every session without ending one (this holder stops, or lost the team): each connection to its Chrome
   * drops, which waits in its box for the next holder's `adopt`, and the proxy stops with its sockets. Nothing is
   * reported or recorded: the next holder goes on with it.
   */
  letGo(): void {
    this.lettingGo = true;
    clearInterval(this.housekeeping);
    for (const open of this.sessions.values()) {
      open.session.end();
      open.session.cdp.shut();
    }
    this.sessions.clear();
    this.proxy.stop();
  }

  async shutdown(): Promise<void> {
    clearInterval(this.housekeeping);
    for (const thread of [...this.sessions.keys()]) await this.end(thread, "this machine's fleetd node stopped").catch(() => {});
    this.proxy.stop();
  }
}

/** Whether a command the agent ran drove its browser. */
export const drivesBrowser = (command: string) => command.includes("agent-browser");
