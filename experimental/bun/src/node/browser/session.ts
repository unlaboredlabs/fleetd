// One browser session of an agent's (crates/fleetd/src/node/browser/session.rs): its Chrome's connection, who drives
// it, the page it follows (the newest one open) and that page's screencast, which goes to the hub's live view while
// the hub watches, at most one frame per LIVE_GAP and as the watcher's link has room. A person's input lands on the
// followed page while they have control; the agent's commands are refused meanwhile.
import type { BrowserAction, BrowserControl, BrowserFrame, BrowserInput } from "../../shared/contracts.ts";
import type { Cdp, Event } from "./cdp.ts";
import { jpegSize, Pacer } from "./fit.ts";
import { refusal as guardRefusal, type GuardSession } from "./guard.ts";
import { RECORDING_FILES } from "../../shared/screens_wire.ts";
import { appendAction, appendLine, Scrub, type Steps, type VideoSink } from "./record.ts";

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
  "A person has control of the browser now. Wait for them to hand it back (carry on with other work meanwhile); your next command after that sees the page as they left it.";

/** Where a watched session's frames go, and the budget the hub last named for it. */
export type Watcher = { send: (frame: BrowserFrame) => void; kbps: number | undefined };

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
  readonly startedAt = new Date().toISOString();
  private readonly start0 = performance.now();
  private steps_ = 0;
  /** Where its recording goes, and what it masks; none for a session that records nothing (tests). */
  recording: { dir: string; scrub: Scrub; steps: Steps; video: VideoSink | undefined } | undefined;
  private ticker: Timer | undefined;
  /** The DOM captures after each step, in order, and the hash of the page the last one wrote. */
  private captures: Promise<void> = Promise.resolve();
  private lastDom: string | undefined;

  constructor(
    readonly id: string,
    readonly threadId: string,
    readonly cdp: Cdp,
  ) {}

  /** When a step, a person's input or a change of control last touched the session: what its idle end goes by. */
  touched = Date.now();

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
        appendAction(r.dir, action, r.scrub, r.steps, this.id);
      } catch (e) {
        console.warn(`browser ${this.id}: action not logged: ${(e as Error).message}`);
      }
      this.step = r.scrub.value(action);
    } else this.step = action;
    return seq;
  }

  /** A finished `agent-browser` command of the agent's, logged, and the page after it in the DOM trace. */
  agentStep(command: string, ok: boolean, output: string | undefined, durationMs: number): number {
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
      appendLine(r.dir, RECORDING_FILES.dom.name, { seq, offsetMs: this.offsetMs(), url, title, html }, r.scrub);
    } catch (e) {
      console.warn(`browser ${this.id}: DOM snapshot not written: ${(e as Error).message}`);
    }
  }

  /** Keeps a still page's frame showing in the video, once a second. */
  private tick(): void {
    this.ticker ??= setInterval(() => this.recording?.video?.tick(this.offsetMs()), 1000);
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
    if (watcher && this.last) {
      // As things are now: a still page sends no new frame, so the newest says who drives and where it is.
      this.offer({ ...this.last, control: this.controlNow, ...this.frameUrl() });
    }
  }

  setBudget(kbps: number | undefined): void {
    if (this.watcher) this.watcher.kbps = kbps;
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
    const video = this.recording?.video;
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
    if (!this.watcher || !this.last) return;
    this.offer(this.last);
    this.sent = { at: performance.now(), seq: this.last.seq };
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
        if (info.targetId && info.url !== undefined) this.urls.set(info.targetId, info.url);
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
