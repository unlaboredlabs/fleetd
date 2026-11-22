// One browser session of an agent's: its Chrome's connection, who drives
// it, the page it follows (the newest one open) and that page's screencast, which goes to the hub's live view while
// the hub watches, at most one frame per LIVE_GAP and as the watcher's link has room. A person's input lands on the
// followed page while they have control; the agent's commands are refused meanwhile.
import type { BrowserAction, BrowserControl, BrowserFrame, BrowserInput } from "../../shared/contracts.ts";
import type { Cdp, Event } from "./cdp.ts";
import { jpegSize, Pacer } from "./fit.ts";
import { refusal as guardRefusal, type GuardSession } from "./guard.ts";
import { hostOf } from "./logins.ts";
import { Scrub } from "../mask.ts";
import type { Encoded, Input, LiveEncoding, MakeEncoder } from "../screen/live.ts";
import type { Recording, Steps } from "./recording.ts";

export const WIDTH = 1280;
export const HEIGHT = 800;
/** What Chrome answers `Page.startScreencast` on a page between renderers, and the longest a start waits it out. */
const NO_ACTIVE_PAGE = "Not attached to an active page";
const SCREENCAST_START = 10_000;
/** The live view's frame rate: at most one frame per this. */
const LIVE_GAP = 33.333;
/** A page's HTML past this is cut in the DOM trace. */
const DOM_MAX_BYTES = 2 << 20;
/** The longest the session's end waits for the DOM captures queued before it. */
const CAPTURES_WAIT = 30_000;

export const PAUSED =
  "A person has control of the browser now. You are told the moment they hand it back (carry on with other work meanwhile, or end your turn); your next command after that sees the page as they left it.";

/** Where a watched session's frames go, and the budget the hub last named for it. */
/** Where a watched session's frames go, the budget the hub last named for it, and whether every watcher decodes H.264. */
export type Watcher = { send: (frame: BrowserFrame) => void; kbps: number | undefined; video?: boolean };

/** The schemes of this machine's own files and browser pages, which a boxed session's page is closed on: a backstop only,
 * as Chrome's error page (chrome-error:) and an empty URL are left alone. */

/** A session as it carries over to another connection or holder (`Session.state`), plain JSON. */
export type SessionState = {
  id: string;
  threadId: string;
  startedAt: string;
  control: BrowserControl;
  credentialsFilled: number;
  secrets: [string, string][];
  filledFields: [target: string, site: string, nodes: number[]][];
  driverTargets: [session: string, target: string][];
  pages: [target: string, session: string][];
  urls: [target: string, url: string][];
  steps: number;
  heldUntil: number;
  heldForAnswer: boolean;
};

export class Session implements GuardSession {
  private controlNow: BrowserControl = "agent";
  /** Pages open, oldest first: the target and the broker's own session on it. The newest is followed. */
  private readonly pages: [target: string, session: string][] = [];
  private readonly urls = new Map<string, string>();
  private watcher: Watcher | undefined;
  private seq = 0;
  private last: BrowserFrame | undefined;
  /** The followed page's size in CSS pixels: a person's clicks come in frame pixels. */
  private pageSize: [number, number] = [WIDTH, HEIGHT];
  private sent: { at: number; seq: number } | undefined;
  private flushTimer: Timer | undefined;
  private readonly pacer = new Pacer();
  private stopEvents: (() => void) | undefined;
  credentialsFilled = 0;
  /** The latest step, for the heartbeat. */
  step: BrowserAction | undefined;
  /** Who is told when control changes here (the agent's first command after a hand-back takes it). */
  onControl: ((control: BrowserControl) => void) | undefined;
  readonly startedAt: string;
  private readonly start0: number;
  private steps_ = 0;
  /** Where its recording goes; none for a session that records nothing (tests). */
  recording: { to: Recording; steps: Steps } | undefined;
  private ticker: Timer | undefined;
  /** The DOM captures after each step, in order, and the hash of the page the last one wrote. */
  private captures: Promise<void> = Promise.resolve();
  private lastDom: string | undefined;
  /** Its own secrets, then every value filled into its browser, and their scrub: what it records and answers. */
  private readonly secrets: [string, string][];
  private scrubNow: Scrub;
  /** The fields filled from 1Password, by target: the site the target was on then and their `backendNodeId`s. The
   * driver may not write to them (credentials.ts `filledFieldRefusal`). */
  private readonly filledFields = new Map<string, { site: string; nodes: Set<number> }>();
  /** The driver's own target sessions, by session id: the target each is on, from its attach events. */
  private readonly driverTargets = new Map<string, string>();
  /** Until when the session waits on a person (a purchase's approval, a takeover such as a bank's confirmation): it
   * isn't idle meanwhile, so a held fare or room isn't lost. */
  private heldUntil = 0;
  /** The hold waits for an answer the project is woken with (a purchase, a secure input): its next browser command ends
   * it, whatever the answer was. */
  private heldForAnswer = false;

  /** `startedAt`: a session that started before, on another connection (`restore`); its clock goes on from then. */
  constructor(
    readonly id: string,
    readonly threadId: string,
    /** Its Chrome's connection: another one after a dropped one (`reconnect`). */
    public cdp: Cdp,
    secrets: [string, string][] = [],
    startedAt?: string,
  ) {
    this.secrets = [...secrets];
    this.scrubNow = new Scrub(this.secrets);
    this.startedAt = startedAt ?? new Date().toISOString();
    this.start0 = startedAt === undefined ? performance.now() : performance.now() - Math.max(Date.now() - Date.parse(startedAt), 0);
  }

  /** The live view's H.264 encoder, once the broker gave it one (encodeWith). */
  private encoder: LiveEncoding | undefined;
  /** Where the driver's answers and events go (the proxy's socket), on this connection and the next. */
  private driver: ((message: Record<string, unknown>) => void) | undefined;
  /** Closes the driver's socket: at the session's end, so its next command connects again and hears why. */
  private dropDriver: (() => void) | undefined;

  /** The driver's listener of its answers and the events it may see, and its socket's close: one at a time. */
  proxyTo(fn: ((message: Record<string, unknown>) => void) | undefined, close?: () => void): void {
    this.driver = fn;
    this.dropDriver = fn ? close : undefined;
    this.cdp.proxyEvents(fn);
  }

  /** What carries the session to another connection to its Chrome, or another holder's: who drives, what it filled
   * (the values, so the next one scrubs them too, and the fields, which the driver may still not write to), the pages
   * it follows and the driver's sessions. Its values are secrets: whoever keeps this seals it. */
  state(): SessionState {
    return {
      id: this.id,
      threadId: this.threadId,
      startedAt: this.startedAt,
      control: this.controlNow,
      credentialsFilled: this.credentialsFilled,
      secrets: [...this.secrets],
      filledFields: [...this.filledFields].map(([target, on]) => [target, on.site, [...on.nodes]]),
      driverTargets: [...this.driverTargets],
      pages: this.pages.map(([t, s]) => [t, s]),
      urls: [...this.urls],
      steps: this.steps_,
      heldUntil: this.heldUntil,
      heldForAnswer: this.heldForAnswer,
    };
  }

  /** The session `state` says, on `cdp`, a new connection to its Chrome: `resume` follows its page again. */
  static restore(state: SessionState, cdp: Cdp): Session {
    const s = new Session(state.id, state.threadId, cdp, state.secrets, state.startedAt);
    s.controlNow = state.control;
    s.credentialsFilled = state.credentialsFilled;
    for (const [target, site, nodes] of state.filledFields) s.filledFields.set(target, { site, nodes: new Set(nodes) });
    for (const [session, target] of state.driverTargets) s.driverTargets.set(session, target);
    s.pages.push(...state.pages.map(([t, p]) => [t, p] as [string, string]));
    for (const [target, url] of state.urls) s.urls.set(target, url);
    s.steps_ = state.steps;
    s.heldUntil = state.heldUntil;
    s.heldForAnswer = state.heldForAnswer;
    return s;
  }

  /** Goes on over `cdp`, a new connection to the same Chrome: the broker's own sessions on it carried over (still
   * hidden from the driver), the driver's listener moved, and the page followed again. */
  async reconnect(cdp: Cdp): Promise<void> {
    this.stopEvents?.();
    cdp.adoptOwned(this.cdp.owned());
    this.cdp = cdp;
    this.cdp.proxyEvents(this.driver);
    await this.resume();
  }

  /**
   * Follows the browser's pages again on a connection that took over from another: what changed while none was there
   * (a page opened or closed) is looked at now, and the followed page's screencast started again, as a frame it sent
   * meanwhile went unacknowledged.
   */
  async resume(): Promise<void> {
    this.stopEvents = this.cdp.events((e) => void this.event(e));
    const { targetInfos } = (await this.cdp.call(undefined, "Target.getTargets")) as { targetInfos: { targetId: string; type: string; url: string }[] };
    const open = new Set(targetInfos.filter((t) => t.type === "page").map((t) => t.targetId));
    for (const t of targetInfos) if (t.type === "page") this.urls.set(t.targetId, t.url);
    this.pages.splice(0, this.pages.length, ...this.pages.filter(([t]) => open.has(t)));
    for (const target of open) {
      if (this.pages.some(([t]) => t === target)) continue;
      try {
        this.pages.push([target, await this.cdp.attach(target)]);
      } catch {
        // Gone before the attach.
      }
    }
    const now = this.page()?.[1];
    if (now) await this.cdp.call(now, "Page.stopScreencast").catch(() => {});
    await this.follow(undefined);
  }

  /** When a step, a person's input or a change of control last touched the session: what its idle end goes by. */
  touched = Date.now();

  /** A command of the driver's came: whatever ran agent-browser, the session is in use. */
  used(): void {
    this.touched = Date.now();
  }

  /** How long nothing touched it; none while it waits on a person (`hold`). */
  idleFor(now = Date.now()): number {
    return this.heldUntil > now ? 0 : now - this.touched;
  }

  /** The session waits on a person for at most `forMs` (undefined: no more): it doesn't idle out meanwhile. */
  hold(forMs: number | undefined): void {
    this.heldUntil = forMs === undefined ? 0 : Date.now() + forMs;
    this.heldForAnswer = false;
    this.touched = Date.now();
  }

  /** As `hold`, until the project's next browser command, which comes once it is woken with the person's answer. */
  holdForAnswer(forMs: number): void {
    this.hold(forMs);
    this.heldForAnswer = true;
  }

  /** What it scrubs everything it records or answers with. */
  scrub(): Scrub {
    return this.scrubNow;
  }

  /** A value the session must never show: scrubbed from everything recorded or answered from now on. */
  addSecret(name: string, value: string): void {
    if (this.secrets.some(([, v]) => v === value)) return;
    this.secrets.push([name, value]);
    this.scrubNow = new Scrub(this.secrets);
  }

  /**
   * A field the node filled from 1Password, by its target, the site the target was on and its `backendNodeId`, which
   * is unique only within one renderer process: it counts until that target moves to another site (`targetMoved`).
   * `fieldSite` is the field's own document's host, for a target the browser hasn't said the address of.
   */
  filledField(target: string, fieldSite: string, backend: number): void {
    const known = this.urls.get(target);
    const site = (known === undefined ? undefined : hostOf(known)) ?? fieldSite;
    let on = this.filledFields.get(target);
    if (!on) this.filledFields.set(target, (on = { site, nodes: new Set() }));
    on.nodes.add(backend);
  }

  /** Whether `backend` is a field the node filled on `target`; with no target known, on any. */
  isFilledField(target: string | undefined, backend: number): boolean {
    if (target !== undefined) return this.filledFields.get(target)?.nodes.has(backend) ?? false;
    return [...this.filledFields.values()].some((on) => on.nodes.has(backend));
  }

  /** The target the driver's session `driver` is on, if its attach was seen. */
  driverTarget(driver: string): string | undefined {
    return this.driverTargets.get(driver);
  }

  /** The target now shows `url`: on another site (or gone, undefined), its filled fields are no more. */
  private targetMoved(target: string, url: string | undefined): void {
    const on = this.filledFields.get(target);
    if (on && (url === undefined ? undefined : hostOf(url)) !== on.site) this.filledFields.delete(target);
  }

  /** A message from the browser on its way to the driver: the driver's attaches say which target each of its sessions
   * is on, and once the session filled a credential every form of the values is scrubbed (credentials.ts). */
  outgoing(message: Record<string, unknown>): Record<string, unknown> {
    const params = (message.params ?? {}) as Record<string, unknown>;
    if (message.method === "Target.attachedToTarget") {
      const target = (params.targetInfo as { targetId?: unknown } | undefined)?.targetId;
      if (typeof params.sessionId === "string" && typeof target === "string") this.driverTargets.set(params.sessionId, target);
    } else if (message.method === "Target.detachedFromTarget" && typeof params.sessionId === "string") {
      this.driverTargets.delete(params.sessionId);
    }
    return this.outgoingHook ? this.outgoingHook(this, message) : message;
  }
  /** credentials.ts `outgoing`, set by the broker: kept out of this module so the guard stays one place. */
  outgoingHook: ((session: Session, message: Record<string, unknown>) => Record<string, unknown>) | undefined;
  /** Milliseconds since the session started: the recording's clock. */
  offsetMs(): number {
    return Math.round(performance.now() - this.start0);
  }

  /** Logs one step of the session's, a tool call of the agent's or fleetd's own, and returns its number. */
  stepAt(tool: string, args: unknown, ok: boolean, result: string | undefined, durationMs: number): number {
    this.touched = Date.now();
    const seq = ++this.steps_;
    const action: BrowserAction = {
      seq,
      at: new Date().toISOString(),
      offsetMs: Math.max(this.offsetMs() - durationMs, 0),
      tool,
      args,
      ok,
      ...(result === undefined ? {} : { result: [...result].slice(0, 500).join("") }),
      durationMs,
    };
    const r = this.recording;
    if (r) {
      try {
        const clean = this.scrubNow.value(action);
        r.steps.note(r.to.key ?? this.id, this.id, clean);
        r.to.append("actions", JSON.stringify(clean));
      } catch (e) {
        console.warn(`browser ${this.id}: action not logged: ${(e as Error).message}`);
      }
      this.step = this.scrubNow.value(action);
    } else this.step = this.scrubNow.value(action);
    return seq;
  }

  /** A finished `agent-browser` command of the agent's, logged, and the page after it in the DOM trace. */
  agentStep(command: string, ok: boolean, output: string | undefined, durationMs: number): number {
    // The project drives again: a hold for an answer it is woken with has done its work, approved or denied.
    if (this.heldForAnswer) {
      this.heldForAnswer = false;
      this.heldUntil = 0;
    }
    const seq = this.stepAt("agent-browser", { command }, ok, output, durationMs);
    this.queueCapture(seq);
    return seq;
  }

  /** Queues the DOM capture after action `seq`, behind those before it. */
  queueCapture(seq: number): void {
    if (!this.recording) return;
    this.captures = this.captures.then(() => this.captureDom(seq)).catch(() => {});
  }

  /** Every DOM capture queued so far, landed (at most CAPTURES_WAIT): the session's end waits for them first. */
  async flushCaptures(): Promise<void> {
    const done = await Promise.race([this.captures.then(() => true), Bun.sleep(CAPTURES_WAIT).then(() => false)]);
    if (!done) console.warn(`browser ${this.id}: DOM captures not finished in ${CAPTURES_WAIT / 1000} s`);
  }

  /** Writes the page's HTML to the DOM trace after action `seq`, unless it is as the last one left it. */
  private async captureDom(seq: number): Promise<void> {
    const r = this.recording;
    const page = this.page();
    if (!r || !page) return;
    const doc = (await this.cdp.call(page[1], "DOM.getDocument", { depth: 0 })) as { root?: { nodeId?: number } };
    const root = doc.root?.nodeId;
    if (typeof root !== "number") return;
    const outer = (await this.cdp.call(page[1], "DOM.getOuterHTML", { nodeId: root })) as { outerHTML?: unknown };
    let html = typeof outer.outerHTML === "string" ? outer.outerHTML : "";
    const info = ((await this.cdp.call(undefined, "Target.getTargetInfo", { targetId: page[0] }).catch(() => ({}))) ?? {}) as {
      targetInfo?: { url?: unknown; title?: unknown };
    };
    const url = typeof info.targetInfo?.url === "string" ? info.targetInfo.url : "";
    const title = typeof info.targetInfo?.title === "string" ? info.targetInfo.title : "";
    const hash = new Bun.CryptoHasher("sha256").update(`${url}\n${html}`).digest("hex");
    if (hash === this.lastDom) return;
    this.lastDom = hash;
    const bytes = Buffer.from(html, "utf8");
    if (bytes.length > DOM_MAX_BYTES) {
      let end = DOM_MAX_BYTES;
      while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
      html = bytes.subarray(0, end).toString("utf8");
    }
    try {
      r.to.append("dom", JSON.stringify(this.scrubNow.value({ seq, offsetMs: this.offsetMs(), url, title, html })));
    } catch (e) {
      console.warn(`browser ${this.id}: DOM snapshot not written: ${(e as Error).message}`);
    }
  }

  /** Keeps a still page's frame showing in the video, once a second. */
  private tick(): void {
    this.ticker ??= setInterval(() => this.recording?.to.video?.tick(this.offsetMs()), 1000);
  }

  /** Follows the browser's pages and their screencast, from the page it has now. */
  async start(): Promise<void> {
    this.stopEvents = this.cdp.events((e) => void this.event(e));
    await this.cdp.call(undefined, "Target.setDiscoverTargets", { discover: true });
    const { targetInfos } = (await this.cdp.call(undefined, "Target.getTargets")) as { targetInfos: { targetId: string; type: string; url: string }[] };
    const page = targetInfos.find((t) => t.type === "page");
    if (page) {
      this.urls.set(page.targetId, page.url);
      await this.follow([page.targetId, await this.cdp.attach(page.targetId)]);
    }
  }

  control(): BrowserControl {
    return this.controlNow;
  }

  setControl(control: BrowserControl): void {
    this.touched = Date.now();
    this.controlNow = control;
  }

  sealed(): boolean {
    return this.credentialsFilled > 0;
  }
  isOwn(session: string): boolean {
    return this.cdp.isOwn(session);
  }
  isOwnTarget(target: string): boolean {
    return this.cdp.isOwnTarget(target);
  }

  /** Why the agent's command is refused here; undefined sends it to the browser. */
  refusal(command: { id?: unknown; method?: unknown; params?: Record<string, unknown>; sessionId?: unknown }): string | undefined {
    const why = guardRefusal(this, command);
    if (why) return why;
    switch (this.controlNow) {
      case "agent":
        return undefined;
      // Handed back: the agent's first command takes control again and sees the page as the person left it.
      case "handing_back":
        this.controlNow = "agent";
        this.heldUntil = 0;
        this.onControl?.("agent");
        return undefined;
      default:
        return PAUSED;
    }
  }

  page(): [string, string] | undefined {
    return this.pages.at(-1);
  }

  /** Sends this session's frames to the hub from now on (a watcher), the newest at once, or no more. */
  setWatcher(watcher: Watcher | undefined): void {
    this.watcher = watcher;
    this.encoder?.key();
    if (!watcher) this.encoder?.stop();
    if (watcher && this.last) {
      // As things are now: a still page sends no new frame, so the newest says who drives and where it is.
      this.offer({ ...this.last, control: this.controlNow, ...this.frameUrl() });
    }
  }

  /** The watchers' budget and whether they all decode H.264, as the hub says it. Only a switch between H.264 and
   * JPEG sends the page anew: a budget told again costs nothing. */
  setBudget(kbps: number | undefined, video = this.watcher?.video): void {
    const w = this.watcher;
    if (!w) return;
    const switched = (w.video === true) !== (video === true);
    w.kbps = kbps;
    w.video = video;
    if (switched) this.key();
  }

  /** A watcher lost an H.264 frame, or just came (the hub's `key`): the page now, under a seq newer than any frame
   * sent, as a keyframe of a new encoder where H.264 goes, else as the JPEG it is, even if it doesn't change. */
  key(): void {
    const last = this.last;
    if (!this.watcher || !last) return;
    this.encoder?.key();
    this.seq += 1;
    this.last = { ...last, seq: this.seq, control: this.controlNow, ...this.frameUrl() };
    this.sendNewest();
  }

  /** Makes the live view's H.264 with `make` (x264, ../screen/x264.ts) for watchers that decode it. */
  encodeWith(make: MakeEncoder): void {
    this.encoder ??= make(
      (f, input) => this.encoded(f, input),
      (why) => console.warn(`browser ${this.id}: the live view stays JPEG: ${why}`),
    );
  }

  private encoded(f: Encoded, input: Input): void {
    const w = this.watcher;
    if (!w?.video || !("jpeg" in input)) return;
    const [width, height] = input.jpeg;
    this.seq += 1;
    w.send({ sessionId: this.id, seq: this.seq, width, height, control: this.controlNow, h264B64: Buffer.from(f.data).toString("base64"), key: f.key, ...this.frameUrl() });
  }

  watched(): boolean {
    return this.watcher !== undefined;
  }

  private frameUrl(): { url?: string } {
    const target = this.page()?.[0];
    const url = target === undefined ? undefined : this.urls.get(target);
    if (url === undefined) return {};
    // Once the session filled a credential, its query and fragment go: a value may be there.
    const shown = this.credentialsFilled > 0 ? url.replace(/[?#].*$/, "") : url;
    return { url: [...shown].slice(0, 2000).join("") };
  }

  private offer(frame: BrowserFrame): void {
    const w = this.watcher;
    if (!w) return;
    void this.pacer.fit(w.kbps, frame).then((fitted) => this.watcher?.send(fitted));
  }

  /** One screencast frame of the followed page: the newest, and sent while the hub watches, as LIVE_GAP allows. */
  private liveFrame(data: string, metadata: Record<string, unknown>): void {
    const video = this.recording?.to.video;
    if (video) {
      video.frame(Buffer.from(data, "base64"), this.offsetMs());
      this.tick();
    }
    const size = jpegSize(Buffer.from(data.slice(0, 4096), "base64"));
    if (!size) return;
    const [width, height] = size;
    this.seq += 1;
    const css = (key: string, or: number) => (typeof metadata[key] === "number" && (metadata[key] as number) > 0 ? (metadata[key] as number) : or);
    this.pageSize = [css("deviceWidth", width), css("deviceHeight", height)];
    this.last = { sessionId: this.id, seq: this.seq, jpegB64: data, width, height, control: this.controlNow, ...this.frameUrl() };
    if (!this.watcher) return;
    const now = performance.now();
    const due = this.sent ? Math.max(this.sent.at + LIVE_GAP, now + this.pacer.wait(this.watcher.kbps)) : now;
    if (due > now) {
      // A frame that waits for its turn goes then, unless a newer one went first.
      this.flushTimer ??= setTimeout(() => {
        this.flushTimer = undefined;
        if (this.last && (!this.sent || this.sent.seq < this.last.seq)) this.sendNewest();
      }, due - now);
      return;
    }
    this.sendNewest();
  }

  private sendNewest(): void {
    const w = this.watcher;
    const last = this.last;
    if (!w || !last) return;
    // Chrome makes the screencast's JPEGs anyway: they go as they are while the watchers' links keep up. Once one is the
    // bound (the hub named a budget), H.264, at a third of the bytes or less, for ~35% of a core more (Chrome's JPEGs
    // decoded and encoded again); as JPEG while the encoder can't.
    const encoded = w.video === true && w.kbps !== undefined && this.encoder !== undefined && last.jpegB64 !== undefined
      && this.encoder.put({ jpeg: [last.width, last.height] }, Buffer.from(last.jpegB64, "base64"), w.kbps);
    if (!encoded) this.encoder?.stop();
    if (!encoded) this.offer(last);
    this.sent = { at: performance.now(), seq: last.seq };
  }

  private async event(e: Event): Promise<void> {
    switch (e.method) {
      case "Page.screencastFrame": {
        const page = e.sessionId;
        if (!page) return;
        if (e.params.sessionId !== undefined) this.cdp.post(page, "Page.screencastFrameAck", { sessionId: e.params.sessionId });
        if (this.page()?.[1] !== page) return;
        this.liveFrame(String(e.params.data ?? ""), (e.params.metadata ?? {}) as Record<string, unknown>);
        return;
      }
      case "Target.targetInfoChanged": {
        const info = e.params.targetInfo as { targetId?: string; url?: string };
        if (info.targetId && info.url !== undefined) {
          this.targetMoved(info.targetId, info.url);
          this.urls.set(info.targetId, info.url);
        }
        return;
      }
      case "Target.targetCreated": {
        const info = e.params.targetInfo as { targetId: string; type: string; url?: string };
        if (info.type !== "page") return;
        if (info.url !== undefined) this.urls.set(info.targetId, info.url);
        // Pages the driver opens show here too: follow each once, by the broker's own session.
        if (this.pages.some(([t]) => t === info.targetId)) return;
        try {
          await this.follow([info.targetId, await this.cdp.attach(info.targetId)]);
        } catch {
          // Gone before the attach.
        }
        return;
      }
      case "Target.targetDestroyed":
      case "Target.detachedFromTarget": {
        // A page closed, or the broker's own session to it ended; the driver detaching changes nothing.
        const target = e.method === "Target.targetDestroyed" ? String(e.params.targetId ?? "") : "";
        const gone = e.method === "Target.detachedFromTarget" ? String(e.params.sessionId ?? "") : "";
        this.urls.delete(target);
        if (target) this.targetMoved(target, undefined);
        const current = this.page();
        const left = this.pages.filter(([t, s]) => t !== target && s !== gone);
        this.pages.splice(0, this.pages.length, ...left);
        if (current && (current[0] === target || current[1] === gone)) await this.follow(undefined);
        return;
      }
    }
  }

  /** Follows `page` (a new one), or the newest left when none: its screencast feeds the live view from now on. */
  private async follow(page: [string, string] | undefined): Promise<void> {
    const before = this.page();
    if (page) this.pages.push(page);
    const now = this.page()?.[1];
    if (!now) return;
    if (before && before[1] !== now) await this.cdp.call(before[1], "Page.stopScreencast").catch(() => {});
    await this.cdp.call(now, "Page.enable").catch(() => {});
    // A page swapping renderers has none to screencast for a moment, and Chrome refuses: start again once it has one.
    const deadline = performance.now() + SCREENCAST_START;
    for (;;) {
      try {
        await this.cdp.call(now, "Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: WIDTH, maxHeight: HEIGHT });
        return;
      } catch (e) {
        if (!(e as Error).message.includes(NO_ACTIVE_PAGE) || performance.now() >= deadline) {
          console.warn(`browser ${this.id}: screencast not started: ${(e as Error).message}`);
          return;
        }
        await Bun.sleep(20);
      }
    }
  }

  /** A person's input, on the followed page, while they have control. Coordinates come in the last frame's pixels. */
  async input(input: BrowserInput): Promise<void> {
    if (this.controlNow !== "human") throw new Error("the agent has control");
    this.touched = Date.now();
    const page = this.page()?.[1];
    if (!page) throw new Error("no page");
    const [scaleX, scaleY] = this.last ? [this.pageSize[0] / this.last.width, this.pageSize[1] / this.last.height] : [1, 1];
    const i = input as BrowserInput & Record<string, unknown>;
    switch (i.kind) {
      case "navigate":
        await this.cdp.call(page, "Page.navigate", { url: navigable(String(i.url)) });
        return;
      case "reload":
        await this.cdp.call(page, "Page.reload");
        return;
      case "back":
      case "forward": {
        const history = await this.cdp.call(page, "Page.getNavigationHistory");
        const entry = historyEntry(history, i.kind === "back" ? -1 : 1);
        if (entry !== undefined) await this.cdp.call(page, "Page.navigateToHistoryEntry", { entryId: entry });
        return;
      }
    }
    const command = cdpInput(input, scaleX, scaleY);
    if (command) await this.cdp.call(page, command[0], command[1]);
  }

  end(): void {
    this.stopEvents?.();
    clearTimeout(this.flushTimer);
    clearInterval(this.ticker);
    this.watcher = undefined;
    const drop = this.dropDriver;
    this.dropDriver = undefined;
    drop?.();
  }
}

/** Where a person's address bar may take the page: an http or https URL, as the URL parser writes it. */
export function navigable(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch (e) {
    throw new Error(`not a URL: ${(e as Error).message}`);
  }
  if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname) return parsed.href;
  throw new Error(`a person's browser goes only to http and https pages, not ${parsed.protocol}`);
}

/** The id of the history entry `step` from the current one; undefined at either end. */
export function historyEntry(history: Record<string, unknown>, step: number): number | undefined {
  const at = (history.currentIndex as number | undefined) ?? Number.NaN;
  const entry = (history.entries as { id: number }[] | undefined)?.[at + step];
  return entry?.id;
}

const KEY_CODES: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Escape: 27,
  " ": 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
};

/** The Windows virtual key code of a key the browser names, for the keys whose default action needs one. */
function keyCode(key: string): number | undefined {
  if (key in KEY_CODES) return KEY_CODES[key];
  if ([...key].length !== 1) return undefined;
  const c = key.toUpperCase();
  return /^[A-Z0-9]$/.test(c) ? c.charCodeAt(0) : undefined;
}

const MOUSE: Record<string, string> = { pressed: "mousePressed", released: "mouseReleased", moved: "mouseMoved", wheel: "mouseWheel" };

/** The CDP command for a person's pointer or key input, its coordinates scaled from frame to page pixels. */
export function cdpInput(input: BrowserInput, scaleX: number, scaleY: number): [string, Record<string, unknown>] | undefined {
  const i = input as BrowserInput & Record<string, unknown>;
  switch (i.kind) {
    case "mouse":
      return [
        "Input.dispatchMouseEvent",
        {
          type: MOUSE[String(i.action)] ?? "mouseMoved",
          x: Number(i.x) * scaleX,
          y: Number(i.y) * scaleY,
          button: (i.button as string | undefined) ?? "none",
          clickCount: (i.clickCount as number | undefined) ?? 0,
          deltaX: (i.deltaX as number | undefined) ?? 0,
          deltaY: (i.deltaY as number | undefined) ?? 0,
          modifiers: (i.modifiers as number | undefined) ?? 0,
        },
      ];
    case "key": {
      const key = String(i.key);
      const text = (i.text as string | undefined) ?? (key === "Enter" ? "\r" : undefined);
      const down = i.action === "down";
      const params: Record<string, unknown> = {
        type: down ? (text !== undefined ? "keyDown" : "rawKeyDown") : "keyUp",
        key,
        modifiers: (i.modifiers as number | undefined) ?? 0,
      };
      if (typeof i.code === "string") params.code = i.code;
      const vk = keyCode(key);
      if (vk !== undefined) {
        params.windowsVirtualKeyCode = vk;
        params.nativeVirtualKeyCode = vk;
      }
      if (text !== undefined && down) {
        params.text = text;
        params.unmodifiedText = text;
      }
      return ["Input.dispatchKeyEvent", params];
    }
    case "text":
      return ["Input.insertText", { text: String(i.text) }];
    default:
      return undefined;
  }
}

/** The ref an `agent-browser` command names an element by (`@e3`), if any. */
export function elementRef(command: string): string | undefined {
  return command.split(/[\s"']/).find((w) => /^@e\d+$/.test(w));
}
