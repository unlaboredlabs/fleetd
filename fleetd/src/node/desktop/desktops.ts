// An agent's Linux desktop sessions, one per agent session at most, with nothing of the machine's: how the hub is
// reached, the agent sessions' secrets, the box each agent runs in and where recordings go all come in
// (`DesktopHost`). The node's desktops (./index.ts) give their own, and lend their machine's displays and the agents'
// Mac's screen besides; a service with no node (fleetd cloud) gives its own, and every session's display runs in its
// agent's box (../place/box_screens.ts). Either way the screen is read, driven, recorded and watched from here, over
// a connection to the display; only the agent's apps run beside it.
//
// It answers the session calls the kind router sends a desktop (`session_start`, `session_end`, `desktop`,
// `request_takeover`), the hub's `browser_watch`, `browser_input` and `browser_control` for a desktop's id, and reports
// each session to the hub as a `browser_session` lead call in its agent's name.
//
// A box's display outlives the connection to it, so a new holder of a session (another instance of a service) takes
// it over from its `snapshot` with `adopt`: who drives it (a person's takeover goes on as theirs) and its action log's
// count are carried, its secrets read again. One whose display went meanwhile ends with a plain note, its control the
// agent's again.
import type { BrowserControl, BrowserControlTo, BrowserSessionState } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { BrowserCallFrame, BrowserControlFrame, BrowserInputFrame, BrowserWatchFrame } from "../../shared/screens_wire.ts";
import { type Meta, type Recording, type RecordingStore, report, Steps } from "../browser/recording.ts";
import { Scrub } from "../mask.ts";
import { BoxDisplay, type DisplayHandle, type ScreenBox } from "../place/box_screens.ts";
import { type DesktopCall, Session } from "./session.ts";

/** A session no step touched this long ends, while the agent drives it (DesktopHost `idleMinutes`, else 30). */
export const IDLE_MINUTES = 30;

/** What a desktop session call answers: its op and its result. */
export type Answer = { op: string } & Record<string, unknown>;

/** What the desktops need of where they run. */
export type DesktopHost = {
  /** A lead call to the hub in a session's name: its result, or its refusal thrown (a ToolError). */
  call(op: string, args: Record<string, unknown>, opts: { threadId?: string; cwd?: string }): Promise<Record<string, unknown>>;
  /** A frame to the hub: a watched session's `browser_frame`. */
  send(frame: { t: string } & Record<string, unknown>): void;
  /** The agent session's secrets, which its recording is scrubbed of; throws why they can't be read (nothing then
   * starts, so nothing is recorded unscrubbed). */
  secrets(thread: string): [string, string][];
  /** The box an agent session runs in (`starting` while it is made): its desktop runs in it. */
  inBox(thread: string): ScreenBox | "starting" | undefined;
  /** Where recordings go. */
  recordings: RecordingStore;
  /** The idle limit: a session no step touched this long ends, unless a person has it. */
  idleMinutes?: () => number;
  /** A session changed in what its `snapshot` holds (it started, changed hands, ended). */
  changed?: (thread: string) => void;
};

/** What carries a session to another holder (`snapshot`, `adopt`): plain JSON. The display's cookie opens only that
 * display, on its box's loopback; keep it as the browser's snapshot is kept. */
export type DesktopSnapshot = {
  v: 1;
  id: string;
  thread: string;
  cwd: string;
  purpose: string;
  startedAt: string;
  /** The last step's number: the action log goes on from it. */
  seq: number;
  control: BrowserControl;
  note?: string;
  display: { dir: string; name: string; port: number; cookieB64: string };
};

const newId = () => `B${[...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

/** Why a session whose display went while it changed holders ends, in the agent's and the person's words. */
export const goneNote = (why: string) => `the desktop in the box went while it moved to another server: ${why}`;

/** A box display's folder, as BoxDisplay.start names it: nothing else of the box is ever swept for a snapshot. */
const DISPLAY_DIR = /^\/tmp\/fleetd-desktop-[0-9a-f]+$/;

export class DesktopSessions {
  /** Live sessions by the agent session they belong to: one each. */
  protected readonly sessions = new Map<string, Session>();
  /** The box displays of live sessions, by agent session: what a snapshot carries. */
  private readonly displays = new Map<string, BoxDisplay>();
  /** Agent sessions whose `session_start` is under way. */
  protected readonly starting = new Set<string>();
  /** Each session's latest step, for the heartbeat (the node's: while its recording's folder is there). */
  protected latest: Steps = new Steps();
  /** Sessions out of the map whose end is still under way (their video): not yet a recording to send. */
  protected readonly ending = new Set<string>();
  private lettingGo = false;
  /** The box an agent session runs in, where its desktop runs (`starting` while it is made); a test's own. */
  inBox: (thread: string) => ScreenBox | "starting" | undefined = (thread) => this.host.inBox(thread);
  /** How a display starts in a box: Xvfb there, or a test's. */
  boxDisplay: (box: ScreenBox) => Promise<BoxDisplay> = (box) => BoxDisplay.start(box);
  /** How a box's display is reached again by a new holder: a test's may stand in. */
  reattachDisplay: (box: ScreenBox, handle: DisplayHandle) => Promise<BoxDisplay> = (box, handle) => BoxDisplay.reattach(box, handle);

  constructor(protected readonly host: DesktopHost) {}

  count(): number {
    return this.sessions.size;
  }

  session(thread: string): Session | undefined {
    return this.sessions.get(thread);
  }

  live(thread: string): { id: string; kind: "linux_desktop" | "mac" } | undefined {
    const s = this.sessions.get(thread);
    return s ? { id: s.id, kind: s.kind } : undefined;
  }

  byId(id: string): Session | undefined {
    for (const s of this.sessions.values()) if (s.id === id) return s;
    return undefined;
  }

  /** Each session's latest step, for the heartbeat: the live ones', and those whose recording is still kept. */
  steps(): { sessionId: string; step: unknown }[] {
    const listed = this.latest.list();
    const live = [...this.sessions.values()].flatMap((s) => (s.step && !listed.some((l) => l.sessionId === s.id) ? [{ sessionId: s.id, step: s.step }] : []));
    return [...listed, ...live];
  }

  /** A session call for `thread`'s desktop (the kind router sends it here). */
  async handle(thread: string, frame: BrowserCallFrame): Promise<Answer> {
    const call = frame.call;
    switch (call.op) {
      case "session_start":
        return { op: "session_start", ...(await this.startKind(thread, frame.cwd, call)) };
      case "session_end":
        return { op: "session_end", ...(await this.sessionEnd(thread)) };
      case "desktop":
        return { op: "desktop", ...(await this.act(thread, call as unknown as DesktopCall)) };
      case "request_takeover":
        return { op: "request_takeover", ...(await this.requestTakeover(thread, String(call.reason ?? ""))) };
      default:
        throw new ToolError("invalid", `${call.op} is for browser sessions.`, "do without it and say so in your result");
    }
  }

  /** `session_start` of a desktop kind: a Linux desktop here; the node's lend the Mac's screen too. */
  protected startKind(thread: string, cwd: string, call: BrowserCallFrame["call"]): Promise<Record<string, unknown>> {
    if (call.kind === "mac") throw new ToolError("failed", "This machine lends no Mac screen.", "say so in your result");
    return this.sessionStart(thread, cwd, String(call.purpose ?? "a desktop session"));
  }

  async sessionStart(thread: string, cwd: string, purpose: string): Promise<Record<string, unknown>> {
    const own = this.inBox(thread);
    if (own) return this.boxStart(thread, cwd, purpose, own);
    return this.machineStart(thread, cwd, purpose);
  }

  /** `session_start` of an agent in no box: a display of the machine's own, where it lends one (the node's). */
  protected async machineStart(_thread: string, _cwd: string, _purpose: string): Promise<Record<string, unknown>> {
    throw new ToolError("failed", "This desktop runs only in an agent's box, and this session has none.", "say so in your result");
  }

  /** `session_start` of an agent in a box: a display of its own in that box, recorded and watched from here. */
  private async boxStart(thread: string, cwd: string, purpose: string, own: ScreenBox | "starting"): Promise<Record<string, unknown>> {
    if (own === "starting") throw new ToolError("invalid", "Your sandbox is still starting.", "try session_start again in a moment");
    const started = performance.now();
    this.notTwice(thread);
    this.starting.add(thread);
    try {
      const secrets = this.secrets(thread);
      let display: BoxDisplay;
      let x;
      try {
        display = await this.boxDisplay(own);
      } catch (e) {
        throw new ToolError("failed", `The desktop did not start: ${(e as Error).message}.`, "try session_start again");
      }
      try {
        x = await display.connect();
      } catch (e) {
        await display.drop();
        throw new ToolError("failed", `The desktop did not start: ${(e as Error).message}.`, "try session_start again");
      }
      const id = newId();
      let recording: Recording;
      try {
        recording = await this.record(this.metaOf(id, thread, cwd, purpose, new Date().toISOString(), "linux_desktop"));
      } catch (e) {
        x.close();
        await display.drop();
        throw e;
      }
      const session = new Session(display, x, { id, thread, cwd, purpose, secrets, kind: "linux_desktop", recording, steps: this.latest });
      this.sessions.set(thread, session);
      this.displays.set(thread, display);
      session.open();
      session.logStep("session_start", { purpose, kind: "linux_desktop", backend: display.backend, worktree: cwd }, true);
      await this.report(session, "live");
      this.host.changed?.(thread);
      // Its apps run in the box, in the agent's own files.
      return { sessionId: session.id, desktop: display.backend, worktree: cwd, startMs: Math.round(performance.now() - started) };
    } finally {
      this.starting.delete(thread);
    }
  }

  /** Refuses a second start while one is under way or a session is open. */
  protected notTwice(thread: string, what = "Desktop"): void {
    if (this.starting.has(thread)) throw new ToolError("invalid", "Another session_start of yours is under way.", "wait for its answer and use that session");
    const open = this.sessions.get(thread);
    if (open) throw new ToolError("invalid", `${what} session ${open.id} is open.`, "use it, or end it with session_end before starting another");
  }

  /** What a session's recording says of it as it starts. */
  protected metaOf(id: string, thread: string, cwd: string, purpose: string, startedAt: string, kind: "linux_desktop" | "mac", resumed = false): Meta {
    return { sessionId: id, kind, threadId: thread, cwd, purpose, startedAt, credentialsFilled: 0, ...(resumed ? { resumed: true } : {}) };
  }

  /** A session's recording, opened; refused plainly when the store won't. */
  protected async record(meta: Meta): Promise<Recording> {
    try {
      return await this.host.recordings.open(meta);
    } catch (e) {
      throw new ToolError("failed", `The desktop's recording didn't start: ${(e as Error).message}`, "try session_start again in a moment");
    }
  }

  async sessionEnd(thread: string): Promise<Record<string, unknown>> {
    const session = this.sessions.get(thread);
    if (!session) throw new ToolError("not_found", "No desktop session is open.", "nothing to end");
    this.sessions.delete(thread);
    return this.close(session);
  }

  /** The session's secrets for its recording; refused when they can't be read, so nothing is recorded unscrubbed. */
  protected secrets(thread: string): [string, string][] {
    try {
      return this.host.secrets(thread);
    } catch (e) {
      throw new ToolError(
        "failed",
        `The node could not read this session's secrets to scrub its recording (${(e as Error).message}).`,
        "try again; if it keeps failing, check the node's log",
      );
    }
  }

  /** Ends a session already out of the map: its recording ends, then its end reaches the hub, with why it has no
   * video if it hasn't. */
  protected async close(session: Session): Promise<Record<string, unknown>> {
    // Out of the map but not yet ended: the sweep leaves its recording alone until it has.
    this.ending.add(session.id);
    this.displays.delete(session.thread);
    try {
      session.logStep("session_end", {}, true);
      const files = await session.close();
      const note = session.note();
      // The end reaches the hub now, not only with the store's own reports of its recording, which a missing or
      // unreadable recording stops. A hub takes a recorded session's state as final, so one that comes after them
      // changes nothing.
      await this.report(session, "uploading", new Date().toISOString());
      return { sessionId: session.id, kind: session.kind, files: files.map(([file, bytes]) => ({ file, bytes })), ...(note ? { note } : {}) };
    } finally {
      this.closed(session);
      this.ending.delete(session.id);
      this.host.changed?.(session.thread);
    }
  }

  /** A session ended, its screen closed and its last command stopped (the node's Mac gives back its lease here). */
  protected closed(_session: Session): void {}

  /** Tells the hub where a session is now, in its agent's name. */
  async report(session: Session, state: BrowserSessionState, endedAt?: string): Promise<void> {
    try {
      await this.host.call("browser_session", report(session.meta(endedAt), state, session.control(), []), { threadId: session.thread, cwd: session.cwd });
    } catch (e) {
      console.warn(`desktop session ${session.id} not reported to the hub: ${(e as Error).message}`);
    }
  }

  /** The agent's `desktop` action, on its live session. Refused while a person has control; the first after a handback
   * gives the desktop back to the agent. */
  async act(thread: string, call: DesktopCall): Promise<Record<string, unknown>> {
    const session = this.sessions.get(thread);
    if (!session) throw new ToolError("not_found", "No desktop session is open.", "start one with session_start kind linux_desktop");
    switch (session.control()) {
      case "human":
        throw new ToolError(
          "invalid",
          "A person has control of this desktop.",
          "carry on with what you can without it; once they hand it back, take a screenshot first: they may have changed things",
        );
      case "handing_back":
        session.setControl("agent", "agent");
        session.logStep("agent_resumed", {}, true);
        void this.report(session, "live");
        this.host.changed?.(thread);
    }
    await this.beforeAct(session, call);
    try {
      return await session.act(call);
    } catch (e) {
      throw new ToolError("failed", (e as Error).message, "check the action's arguments, take a screenshot, and try again");
    }
  }

  /** Before an agent's action, once it may drive (the node's Mac takes its lease or a claim here). */
  protected async beforeAct(_session: Session, _call: DesktopCall): Promise<void> {}

  /** An agent's `request_takeover`: the hub lists it under "waiting on you". */
  async requestTakeover(thread: string, reason: string): Promise<Record<string, unknown>> {
    const session = this.sessions.get(thread);
    if (!session) throw new ToolError("not_found", "No desktop session is open.", "start one with session_start");
    await this.host.call("browser_takeover", { sessionId: session.id, reason }, { threadId: thread, cwd: session.cwd });
    session.logStep("request_takeover", { reason }, true);
    return {
      message:
        "Asked: it shows under waiting on you. Carry on with what you can, or end your turn: you are told the moment they hand it back; then take a screenshot first.",
    };
  }

  /** The hub's live view for one of these sessions: false when the id isn't one of these. */
  watch(frame: BrowserWatchFrame): boolean {
    const session = this.byId(frame.sessionId);
    if (!session) return false;
    if (!frame.on) session.setWatcher(undefined);
    else if (session.watched()) session.setBudget(frame.kbps);
    else session.setWatcher({ kbps: frame.kbps, send: (f) => this.host.send({ t: "browser_frame", ...f }) });
    return true;
  }

  input(frame: BrowserInputFrame): boolean {
    const session = this.byId(frame.sessionId);
    if (!session) return false;
    session.queueInput(frame.input);
    return true;
  }

  /** A person takes a session over, or hands it back; the hub hears who drives, changed or not. */
  control(frame: BrowserControlFrame): boolean {
    const session = this.byId(frame.sessionId);
    if (!session) return false;
    const to: BrowserControlTo = frame.control;
    const now = session.control();
    if (to === "human" && now !== "human") {
      this.takingOver(session);
      session.setControl("human", frame.by);
    } else if (to === "agent" && now === "human") session.setControl("handing_back", frame.by);
    void this.report(session, "live");
    if (session.control() !== now) this.host.changed?.(session.thread);
    return true;
  }

  /** A person takes `session` over (the node's Mac gives them its lease here). */
  protected takingOver(_session: Session): void {}

  endScreen(thread: string, id: string): boolean {
    if (this.sessions.get(thread)?.id !== id) return false;
    this.ended(thread);
    return true;
  }

  /** The agent session ended: its desktop session ends too. */
  ended(thread: string): void {
    const session = this.sessions.get(thread);
    if (!session) return;
    this.sessions.delete(thread);
    session.logStep("agent_session_ended", {}, true);
    void this.close(session);
  }

  /** The idle limit of `session`, in ms. */
  protected idleLimit(_session: Session): number {
    return 60_000 * (this.host.idleMinutes?.() ?? IDLE_MINUTES);
  }

  /** Each minute: ends sessions idle past the limit that the agent drives, then sends recordings still to go. */
  async housekeep(now = Date.now()): Promise<void> {
    if (this.lettingGo) return;
    for (const [thread, session] of [...this.sessions]) {
      if (session.idleFor() >= this.idleLimit(session) && session.control() === "agent") {
        console.info(`desktop session ${session.id} idle; ending it`);
        this.sessions.delete(thread);
        await this.close(session);
      }
    }
    await this.sweep(now);
  }

  /** Sends the recordings still waiting to go, but live sessions'. */
  async sweep(now = Date.now()): Promise<void> {
    const live = [...this.sessions.values()].map((s) => s.id).concat([...this.ending]);
    await this.host.recordings.sweep?.(live, now);
  }

  /** What carries agent session `thread`'s desktop to another holder: undefined for none, or one whose display isn't
   * in a box (it can't be reached again). */
  snapshot(thread: string): DesktopSnapshot | undefined {
    const session = this.sessions.get(thread);
    const display = this.displays.get(thread);
    if (!session || !display) return undefined;
    const at = display.handle();
    const note = session.note();
    return {
      v: 1,
      id: session.id,
      thread,
      cwd: session.cwd,
      purpose: session.purpose,
      startedAt: session.startedAt,
      seq: session.lastSeq(),
      control: session.control(),
      ...(note !== undefined ? { note } : {}),
      display: { dir: at.dir, name: at.name, port: at.port, cookieB64: Buffer.from(at.cookie).toString("base64") },
    };
  }

  /**
   * Takes over agent session `thread`'s desktop from the holder before (`snapshot`): its box's display reached again,
   * the session as it was (a person who drives it drives on; the agent stays refused until they hand it back),
   * recording on from there. A display that went meanwhile (its box did, or it was swept) ends the session plainly
   * instead: its recording ends with a note, and it is reported ended with the agent in control, so control never
   * stays with a person on a session nobody drives. Throws for a snapshot it can't read, when the session's secrets
   * can't be read, and when the recording store refuses to go on (the display then waits on in its box, for a try
   * again).
   */
  async adopt(thread: string, snapshot: DesktopSnapshot): Promise<{ adopted: true; sessionId: string } | { adopted: false; note: string }> {
    if (snapshot?.v !== 1 || snapshot.thread !== thread || !snapshot.display?.dir || !/^B[0-9a-f]{32}$/.test(String(snapshot.id))) {
      throw new Error("not a desktop session's snapshot for this agent session");
    }
    if (!DISPLAY_DIR.test(snapshot.display.dir)) throw new Error("the snapshot's display isn't a desktop's folder in the box");
    const open = this.sessions.get(thread);
    if (open) return { adopted: true, sessionId: open.id };
    if (this.starting.has(thread)) throw new Error("a desktop of this agent session is starting or being taken over here already");
    // Held until the session is in the map (or ended): a session_start meanwhile can't open a second display.
    this.starting.add(thread);
    try {
      return await this.adoptHeld(thread, snapshot);
    } finally {
      this.starting.delete(thread);
    }
  }

  /** `adopt`, with the agent session held. */
  private async adoptHeld(thread: string, snapshot: DesktopSnapshot): Promise<{ adopted: true; sessionId: string } | { adopted: false; note: string }> {
    const secrets = this.host.secrets(thread);
    const handle: DisplayHandle = {
      dir: snapshot.display.dir,
      name: snapshot.display.name,
      port: snapshot.display.port,
      cookie: new Uint8Array(Buffer.from(snapshot.display.cookieB64, "base64")),
    };
    const own = this.inBox(thread);
    const box = own && own !== "starting" ? own : undefined;
    let display: BoxDisplay | undefined;
    let x;
    let why = "its box is gone";
    if (box) {
      try {
        display = await this.reattachDisplay(box, handle);
        x = await display.connect();
      } catch (e) {
        why = (e as Error).message;
        await display?.drop();
        display = undefined;
      }
    }
    const meta = this.metaOf(snapshot.id, thread, snapshot.cwd, snapshot.purpose, snapshot.startedAt, "linux_desktop", true);
    let recording: Recording;
    try {
      recording = await this.host.recordings.open(meta);
    } catch (e) {
      x?.close();
      throw new Error(`the desktop session's recording didn't go on: ${(e as Error).message}`);
    }
    if (!display || !x) {
      // A display that isn't there to drive: its session ends now, recorded as far as it went.
      const note = goneNote(why);
      const scrub = new Scrub(secrets);
      const offsetMs = Math.max(0, Date.now() - Date.parse(snapshot.startedAt));
      const step = { seq: snapshot.seq + 1, at: new Date().toISOString(), offsetMs, tool: "desktop_gone", args: { why }, ok: false, durationMs: 0 };
      try {
        recording.append("actions", JSON.stringify(scrub.value(step)));
      } catch {}
      const endedAt = new Date().toISOString();
      await this.host
        .call("browser_session", report({ ...meta, endedAt, note }, "uploading", "agent", []), { threadId: thread, cwd: snapshot.cwd })
        .catch((e: Error) => console.warn(`desktop session ${snapshot.id} not reported to the hub: ${e.message}`));
      await recording.end({ endedAt, credentialsFilled: 0, note }, scrub, offsetMs).catch(() => {});
      this.host.changed?.(thread);
      return { adopted: false, note };
    }
    const session = new Session(display, x, {
      id: snapshot.id,
      thread,
      cwd: snapshot.cwd,
      purpose: snapshot.purpose,
      secrets,
      kind: "linux_desktop",
      recording,
      steps: this.latest,
      resumed: { startedAt: snapshot.startedAt, seq: snapshot.seq, control: snapshot.control, ...(snapshot.note !== undefined ? { note: snapshot.note } : {}) },
    });
    this.sessions.set(thread, session);
    this.displays.set(thread, display);
    session.open();
    session.logStep("desktop_adopted", {}, true);
    await this.report(session, "live");
    this.host.changed?.(thread);
    return { adopted: true, sessionId: session.id };
  }

  /**
   * Lets go of every session without ending one (this holder stops, or lost the team): each connection to its
   * display drops, and the display waits in its box for the next holder's `adopt`. Nothing is reported or recorded:
   * the next holder goes on with it.
   */
  async letGo(): Promise<void> {
    this.lettingGo = true;
    const all = [...this.sessions.values()];
    this.sessions.clear();
    this.displays.clear();
    for (const session of all) await session.detach();
  }

  /** Ends every live session (this holder stops for good). */
  async shutdown(): Promise<void> {
    for (const [thread, session] of [...this.sessions]) {
      this.sessions.delete(thread);
      await this.close(session);
    }
  }
}
