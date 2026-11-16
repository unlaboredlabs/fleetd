// Phone screens in the team's own Revyl account (W676), started and driven by the agent's own node through Revyl's
// documented CLI (cli.ts). The hub routes a phone start here (`session_route` answers `revyl`, the team's key sealed to
// this node's box key); the node starts the device (`revyl device start`), and the screen is the agent's like any
// other: a `browser_session` with `source` revyl, live view from Revyl's screenshots while a person watches, a person's
// takeover as coordinate taps, swipes and typing, and Revyl's own video as its recording once it ends. The agent drives
// it with `revyl device …` (the `revyl` on its PATH runs `fleetd revyl`, which comes here): coordinates only, never
// Revyl's AI-driven actions, remote builds, tests, feedback or billing (shared/revyl.ts `refusal`). The key never
// reaches the agent's session: each `revyl` process gets it in its own environment, and what it prints comes back
// masked.
//
// A screen ends, and Revyl's minutes stop (`revyl device stop`), at `session_end`, when the agent's session ends, after
// IDLE_MS without a command or a person's input, when the hub's key is removed, and when the node stops. A node that
// stopped without ending one (a crash) stops it at its next start, from the record it keeps in `live/` while it runs.
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { BrowserControl, BrowserInput, BrowserSessionState, KnownRevylCheckReason } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { NodeAction, NodeActionResult } from "../../shared/node_link.ts";
import { billingRefusal, CHECK_WAIT, failure, IDLE_SECS, INSTALL, mask, refusal, tail, withoutNudges } from "../../shared/revyl.ts";
import { type BrowserCallFrame, type BrowserControlFrame, type BrowserInputFrame, type BrowserWatchFrame, CAP_REVYL, type RevylStart } from "../../shared/screens_wire.ts";
import { giveUp, type Meta, report, upload, writeMeta } from "../browser/record.ts";
import { hubCall, type Node, toHub } from "../browser/node.ts";
import { type Frame } from "../device/scrcpy.ts";
import { Pump } from "../device/live.ts";
import { type Answer, router, type Screens } from "../device/router.ts";
import { loadOrCreateBoxKey } from "../identity.ts";
import { mkdirPrivate } from "../config.ts";
import { writeAtomic } from "../secrets/files.ts";
import { jsonOf, NoCli, type Run, runRevyl } from "./cli.ts";
import { self } from "../mac_tool/index.ts";
import { binDir, installShim } from "./shim.ts";

/** A screen with no agent command and no person's input this long ends (the hub's IDLE_MS). */
export const IDLE_MS = IDLE_SECS * 1000;
/** How long a `device start` may wait, Revyl's own queue included. */
export const START_WAIT = 30 * 60_000;
/** An agent's command: a build upload may take a while. */
export const COMMAND_WAIT = 10 * 60_000;
/** A stop, a screenshot, a tap. */
export const QUICK_WAIT = 60_000;
/** Revyl's video of a session can take up to 30 minutes to be ready (`session download`). */
export const VIDEO_WAIT = 35 * 60_000;
/** Between live-view frames while a person watches. */
export const FRAME_EVERY = 1000;
/** A live-view frame's JPEG quality. */
const FRAME_QUALITY = 80;

export const revylDir = (home: string) => join(home, "revyl");
/** The folder each `revyl` process gets as its home. */
const cliHome = (home: string) => join(revylDir(home), "home");
const liveDir = (home: string) => join(revylDir(home), "live");
const recordingsDir = (home: string) => join(revylDir(home), "recordings");

/** What a node keeps of a live screen until it ends, to stop it at its next start if it stopped first. */
type LiveRecord = { revylId: string; sealed: string };

const newId = () => `B${[...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

/** A PNG's width and height from its header; undefined for anything else. */
export function pngSize(b: Uint8Array): [number, number] | undefined {
  if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50) return undefined;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return [v.getUint32(16), v.getUint32(20)];
}

class Screen {
  control: BrowserControl = "agent";
  lastActive: number;
  seq = 0;
  /** A finger down from a person, in frame pixels: a release far from it is a swipe. */
  down: [number, number] | undefined;
  /** Where a person last tapped: Revyl types into the field at a point. */
  lastTap: [number, number] | undefined;
  /** Frame pixels per device unit (iOS points, Android pixels). */
  scale: number;
  watch: { pump: Pump; timer: Timer } | undefined;
  constructor(
    readonly id: string,
    readonly thread: string,
    readonly cwd: string,
    readonly kind: "ios" | "android",
    readonly revylId: string,
    readonly key: string,
    readonly meta: Meta,
    readonly dir: string,
    now: number,
    /** The screen's width in device units, as `device start` says (`screen_width`): 440 on an iPhone 16 Pro Max. */
    readonly units: number | undefined,
  ) {
    this.lastActive = now;
    // Revyl taps an iPhone in points and an Android phone in pixels; its screenshots are in pixels (a 440-point
    // iPhone's are 1320 wide), so each frame's width over `units` is the scale. Until a frame: three to an iPhone's point.
    this.scale = kind === "ios" ? 3 : 1;
  }
}

export type RevylOptions = { bin?: string; now?: () => number; boxKey?: { open(sealed: Uint8Array): Uint8Array | null } };

/** The node's Revyl screens, one per agent session at most. */
export class RevylScreens implements Screens {
  private readonly screens = new Map<string, Screen>();
  private readonly starting = new Set<string>();
  /** Ends and recordings under way: a stop at Revyl, then its video to the hub. */
  private readonly pending = new Set<Promise<unknown>>();
  private readonly housekeeping: Timer;
  private readonly now: () => number;
  private readonly box: { open(sealed: Uint8Array): Uint8Array | null };

  constructor(
    private readonly node: Node,
    private readonly options: RevylOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.box = options.boxKey ?? loadOrCreateBoxKey(node.home);
    this.housekeeping = setInterval(() => void this.housekeep(), 60_000);
  }

  /** Every `revyl` runs in its own home: Revyl's CLI keeps `.revyl/` (its sessions, input locks) where it runs. */
  private async run(argv: string[], key: string, timeoutMs: number): Promise<Run> {
    const run = await runRevyl(argv, { key, home: cliHome(this.node.home), timeoutMs, ...(this.options.bin ? { bin: this.options.bin } : {}) });
    return { ...run, out: withoutNudges(run.out) };
  }

  private readonly hub = (thread: string, cwd: string, op: string, args: Record<string, unknown>) => hubCall(this.node, op, args, { threadId: thread, cwd });

  count(): number {
    return this.screens.size;
  }

  live(thread: string): { id: string; kind: "ios" | "android" } | undefined {
    const s = this.screens.get(thread);
    return s ? { id: s.id, kind: s.kind } : undefined;
  }

  byId(id: string): Screen | undefined {
    for (const s of this.screens.values()) if (s.id === id) return s;
    return undefined;
  }

  /** Opens the team's key the hub sealed to this node. */
  private keyOf(sealed: string): string {
    const plain = this.box.open(new Uint8Array(Buffer.from(sealed, "base64")));
    if (!plain) throw new ToolError("failed", "The team's Revyl key didn't open on this machine.", "try session_start again");
    try {
      return new TextDecoder().decode(plain);
    } finally {
      plain.fill(0);
    }
  }

  /**
   * Settings' Test of the team's key (`node_action` revyl_check), here where agents' Revyl screens run:
   * `revyl device history`, which only Revyl's server can answer for the key, and which starts nothing. (`device list`
   * lists this CLI's own sessions without asking the server: any key passes it.)
   */
  async check(frame: NodeAction): Promise<NodeActionResult> {
    const no = (reason: KnownRevylCheckReason, message: string): NodeActionResult => ({ id: frame.id, ok: false, reason, message: message.slice(0, 500) });
    if (!frame.revyl) return no("failed", "the hub sent no key to test");
    let key: string;
    try {
      key = this.keyOf(frame.revyl);
    } catch (e) {
      return no("failed", (e as Error).message);
    }
    let run: Run;
    try {
      run = await this.run(["device", "history", "--json", "--limit", "1"], key, CHECK_WAIT);
    } catch (e) {
      if (e instanceof NoCli) return no("no_cli", "no revyl command");
      return no("failed", mask((e as Error).message, key));
    }
    if (run.exit === 0) return { id: frame.id, ok: true, message: "Revyl answered for the key" };
    if (run.timedOut) return no("failed", `revyl device history didn't answer within ${CHECK_WAIT / 1000} seconds.`);
    return no(failure(run.out), tail(run.out, 500) || `revyl device history exited ${run.exit}.`);
  }

  /** `session_start` the hub routed to Revyl:the device started with the team's key, and the screen reported. */
  async start(thread: string, frame: BrowserCallFrame, routed: RevylStart): Promise<Answer> {
    if (this.starting.has(thread)) throw new ToolError("invalid", "Another session_start of yours is under way.", "wait for its answer and use that session");
    const open = this.screens.get(thread);
    if (open) throw new ToolError("invalid", `Revyl session ${open.id} is open.`, "use it, or end it with session_end before starting another");
    const kind = routed.platform;
    const key = this.keyOf(routed.sealed);
    const purpose = String(frame.call.purpose ?? (kind === "ios" ? "an iPhone" : "an Android phone"));
    this.starting.add(thread);
    try {
      let run: Run;
      try {
        // --open=false: Revyl's viewer would otherwise open in a browser on this machine.
        run = await this.run(["device", "start", "--platform", kind, "--timeout", String(IDLE_SECS), "--open=false", "--json"], key, START_WAIT);
      } catch (e) {
        if (e instanceof NoCli) {
          throw new ToolError("failed", "This machine has no revyl command, so it can't start the team's Revyl screen.", `say so in your result: a person installs Revyl's CLI here: ${INSTALL}`);
        }
        throw e;
      }
      const started = run.exit === 0 ? jsonOf(run.out) : undefined;
      const revylId = String(started?.session_id ?? "");
      if (!revylId) throw this.refused("revyl device start", run);
      const units = Number(started?.screen_width) > 0 ? Number(started?.screen_width) : undefined;
      const id = newId();
      const dir = join(recordingsDir(this.node.home), id);
      const meta: Meta = { sessionId: id, kind, threadId: thread, cwd: frame.cwd, purpose: [...purpose].slice(0, 200).join(""), startedAt: new Date(this.now()).toISOString(), credentialsFilled: 0, source: "revyl" };
      writeMeta(dir, meta);
      mkdirPrivate(liveDir(this.node.home));
      writeAtomic(join(liveDir(this.node.home), `${id}.json`), JSON.stringify({ revylId, sealed: routed.sealed } satisfies LiveRecord));
      const screen = new Screen(id, thread, frame.cwd, kind, revylId, key, meta, dir, this.now(), units);
      this.screens.set(thread, screen);
      void this.report(screen, "live");
      const device = kind === "ios" ? "iPhone" : "Android phone";
      // An iPhone's screenshot is in pixels and its taps in points: say how to get from one to the other.
      const coords = kind === "ios" ? `points${units ? `, ${units} wide` : ""}; a screenshot is in pixels, three to a point` : "pixels, as in a screenshot";
      return {
        op: "session_start",
        sessionId: id,
        kind,
        source: "revyl",
        note:
          `A Revyl ${device} in the team's own Revyl account (${routed.why}). Drive it with revyl device … by coordinates ` +
          `(${coords}): revyl device screenshot --out shot.png, revyl device tap --x 120 --y 300, ` +
          "swipe, type, key; install your build with revyl build upload --file <.app or .apk>, then revyl device install. " +
          "agent-device doesn't reach it. Revyl bills the team per minute: end it with session_end as soon as you're done.",
      };
    } finally {
      this.starting.delete(thread);
    }
  }

  /** A refusal for a `revyl` run that failed: never to be retried when Revyl refused it over billing or limits. */
  private refused(what: string, run: Run): ToolError {
    const out = tail(run.out, 400);
    if (billingRefusal(run.out)) {
      return new ToolError(
        "failed",
        `Revyl refused ${what} over the team's plan or billing: ${out}`,
        "don't retry it or work around it, and never add a card: do without the screen, say so in your result, and tell your lead (an admin checks the team's Revyl plan)",
      );
    }
    if (run.timedOut) return new ToolError("failed", `${what} didn't answer in time.`, "try once more; if it fails again, do without it and say so in your result");
    return new ToolError("failed", `${what} failed: ${out || `it exited ${run.exit}`}`, "do without it and say so in your result");
  }

  async handle(thread: string, frame: BrowserCallFrame): Promise<Answer> {
    const screen = this.screens.get(thread);
    switch (frame.call.op) {
      case "session_end":
        if (!screen) throw new ToolError("not_found", "No Revyl session is open.", "nothing to end");
        this.screens.delete(thread);
        return { op: "session_end", ...(await this.close(screen, undefined)) };
      case "revyl":
        return { op: "revyl", ...(await this.command(thread, frame)) };
      case "device":
        throw new ToolError("invalid", "agent-device doesn't reach a Revyl screen.", "drive it with revyl device … (tap, swipe, type, key, screenshot)");
      default:
        throw new ToolError("invalid", `${frame.call.op} is not available on a Revyl screen.`, "drive it with revyl device …, and say in your result what you did without");
    }
  }

  /** An agent's `revyl …` on its own screen. */
  private async command(thread: string, frame: BrowserCallFrame): Promise<Record<string, unknown>> {
    const argv = Array.isArray(frame.call.argv) ? frame.call.argv.map(String) : [];
    const screen = this.screens.get(thread);
    if (!screen) {
      throw new ToolError(
        "not_found",
        "No Revyl screen is open in this session.",
        "session_start kind ios or android gives you one when the team routes phone screens to Revyl",
      );
    }
    const why = refusal(argv);
    if (why) throw new ToolError("invalid", why);
    if (screen.control === "human") throw new ToolError("failed", "A person has control of your Revyl screen.", "wait for them to hand it back, then run it again");
    if (screen.control === "handing_back") {
      screen.control = "agent";
      void this.report(screen, "live");
    }
    screen.lastActive = this.now();
    const quick = argv[0] === "device" && argv[1] !== "install";
    const run = await this.run([...inCwd(argv, frame.cwd), "--session-id", screen.revylId], screen.key, quick ? QUICK_WAIT : COMMAND_WAIT);
    if (run.exit !== 0 && billingRefusal(run.out)) throw this.refused(`revyl ${argv.slice(0, 2).join(" ")}`, run);
    return { exitCode: run.exit ?? 1, output: run.out };
  }

  /** Ends a screen already out of the map: Revyl's minutes stop now, and its video goes to the hub when Revyl has it. */
  private async close(screen: Screen, note: string | undefined): Promise<Record<string, unknown>> {
    this.unwatch(screen);
    const stopped = await this.run(["device", "stop", "--session-id", screen.revylId], screen.key, QUICK_WAIT).catch((e: Error) => e);
    const ok = !(stopped instanceof Error) && stopped.exit === 0;
    if (ok) rmSync(join(liveDir(this.node.home), `${screen.id}.json`), { force: true });
    else console.warn(`revyl ${screen.id}: not stopped at Revyl: ${stopped instanceof Error ? stopped.message : tail(stopped.out, 200)}`);
    const ended: Meta = { ...screen.meta, endedAt: new Date(this.now()).toISOString(), ...(note ? { note } : {}) };
    writeMeta(screen.dir, ended);
    void this.report(screen, "uploading", ended);
    this.track(this.recording(screen));
    return { sessionId: screen.id, kind: screen.kind, source: "revyl", ...(ok ? {} : { note: "Revyl didn't confirm the stop; its own idle timeout ends it" }) };
  }

  /** Revyl's video of the session into its recording, then to the hub; lost when Revyl has none. */
  private async recording(screen: Screen): Promise<void> {
    const into = join(screen.dir, "download");
    try {
      const run = await this.run(["session", "download", screen.revylId, "--include-full-video", "--no-clips", "--output-directory", into], screen.key, VIDEO_WAIT);
      const video = findFile(into, "video.mp4");
      if (run.exit !== 0 || !video) throw new Error(tail(run.out, 300) || "Revyl had no video for it");
      renameSync(video, join(screen.dir, "video.mp4"));
      rmSync(into, { recursive: true, force: true });
      await upload(this.hub, screen.dir);
    } catch (e) {
      await giveUp(this.hub, screen.dir, `no recording: ${(e as Error).message}`).catch(() => {});
    }
  }

  private async report(screen: Screen, state: BrowserSessionState, meta: Meta = screen.meta): Promise<void> {
    try {
      await this.hub(screen.thread, screen.cwd, "browser_session", report(meta, state, screen.control, []));
    } catch (e) {
      console.warn(`revyl ${screen.id}: not reported to the hub: ${(e as Error).message}`);
    }
  }

  private track(p: Promise<unknown>): void {
    const going = p.catch(() => {}).finally(() => this.pending.delete(going));
    this.pending.add(going);
  }

  /** Waits for the ends and recordings under way now, and those they start. */
  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  endScreen(thread: string, id: string): boolean {
    if (this.screens.get(thread)?.id !== id) return false;
    this.ended(thread);
    return true;
  }

  ended(thread: string): void {
    const screen = this.screens.get(thread);
    if (!screen) return;
    this.screens.delete(thread);
    this.track(this.close(screen, undefined));
  }

  /** Every minute: a screen with no command and no person's input for IDLE_MS ends. */
  async housekeep(): Promise<void> {
    const now = this.now();
    for (const [thread, screen] of [...this.screens]) {
      if (now - screen.lastActive >= IDLE_MS && screen.control === "agent") {
        this.screens.delete(thread);
        await this.close(screen, "ended after 30 minutes without a command").catch(() => {});
      }
    }
  }

  /** At the node's start: screens a node before this one left running are stopped at Revyl, and reported lost. */
  async sweep(): Promise<number> {
    let names: string[];
    try {
      names = readdirSync(liveDir(this.node.home)).filter((n) => n.endsWith(".json"));
    } catch {
      return 0;
    }
    let stopped = 0;
    for (const name of names) {
      const file = join(liveDir(this.node.home), name);
      try {
        const rec = JSON.parse(readFileSync(file, "utf8")) as LiveRecord;
        const run = await this.run(["device", "stop", "--session-id", rec.revylId], this.keyOf(rec.sealed), QUICK_WAIT);
        if (run.exit === 0) stopped++;
      } catch (e) {
        console.warn(`revyl ${name}: not stopped at Revyl: ${(e as Error).message}`);
      }
      rmSync(file, { force: true });
      const dir = join(recordingsDir(this.node.home), name.slice(0, -5));
      if (existsSync(dir)) await giveUp(this.hub, dir, "the node restarted, so its Revyl screen was stopped").catch(() => {});
    }
    return stopped;
  }

  /** The node stops: every screen is stopped at Revyl, so no minutes run on with nobody to end them. */
  async shutdown(): Promise<void> {
    clearInterval(this.housekeeping);
    const all = [...this.screens.values()];
    this.screens.clear();
    for (const screen of all) {
      this.unwatch(screen);
      const run = await this.run(["device", "stop", "--session-id", screen.revylId], screen.key, 15_000).catch(() => undefined);
      if (run?.exit === 0) rmSync(join(liveDir(this.node.home), `${screen.id}.json`), { force: true });
      await giveUp(this.hub, screen.dir, "the node restarted, so its Revyl screen was stopped").catch(() => {});
    }
  }

  // ---- live view and takeover ----

  /** Starts or stops sending a screen's frames to the hub: a Revyl screenshot every FRAME_EVERY while watched. */
  watch(frame: BrowserWatchFrame): void {
    const screen = this.byId(frame.sessionId);
    if (!screen) return;
    if (!frame.on) return this.unwatch(screen);
    if (screen.watch) {
      screen.watch.pump.kbps = frame.kbps;
      return;
    }
    const pump = new Pump(screen.id, () => screen.control, (f) => toHub(this.node, { t: "browser_frame", ...f }), frame.kbps);
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void this.shot(screen)
        .then((f) => f && pump.offer(f))
        .finally(() => (busy = false));
    }, FRAME_EVERY);
    screen.watch = { pump, timer };
  }

  private unwatch(screen: Screen): void {
    if (!screen.watch) return;
    clearInterval(screen.watch.timer);
    screen.watch.pump.stop();
    screen.watch = undefined;
  }

  /** One screenshot of the screen as a frame. */
  async shot(screen: Screen): Promise<Frame | undefined> {
    const out = join(screen.dir, "frame.png");
    const run = await this.run(["device", "screenshot", "--out", out, "--session-id", screen.revylId], screen.key, QUICK_WAIT).catch(() => undefined);
    if (run?.exit !== 0 || !existsSync(out)) return undefined;
    const png = new Uint8Array(readFileSync(out));
    rmSync(out, { force: true });
    // Revyl's screenshot is a PNG (RGBA, in pixels), and a frame is a JPEG: made one here.
    const jpeg = await new Bun.Image(png).jpeg({ quality: FRAME_QUALITY }).bytes().catch(() => undefined);
    if (!jpeg) return undefined;
    const [width, height] = pngSize(png) ?? [1, 1];
    if (screen.units && width > 1) screen.scale = width / screen.units;
    return { seq: ++screen.seq, jpeg, width, height, atMs: this.now() };
  }

  /** A person's input, while they have control: a click taps, a drag swipes, text types where they last tapped. */
  async input(frame: BrowserInputFrame): Promise<void> {
    const screen = this.byId(frame.sessionId);
    if (!screen || screen.control !== "human") return;
    screen.lastActive = this.now();
    const argv = inputArgv(frame.input as BrowserInput, screen);
    if (!argv) return;
    const run = await this.run([...argv, "--session-id", screen.revylId], screen.key, QUICK_WAIT).catch(() => undefined);
    if (run?.exit !== 0) console.debug(`revyl ${screen.id}: input not delivered`);
  }

  /** A person takes the screen, or hands it back. */
  control(frame: BrowserControlFrame): void {
    const screen = this.byId(frame.sessionId);
    if (!screen) return;
    screen.control = frame.control === "human" ? "human" : screen.control === "human" ? "handing_back" : screen.control;
    screen.down = undefined;
    screen.lastActive = this.now();
    void this.report(screen, "live");
  }
}

/** The `revyl device …` a person's input becomes, in device units; undefined for what a phone has no use for. */
export function inputArgv(input: BrowserInput, screen: { scale: number; down: [number, number] | undefined; lastTap: [number, number] | undefined }): string[] | undefined {
  const unit = (v: number) => String(Math.round(v / screen.scale));
  switch (input.kind) {
    case "mouse": {
      if (input.action === "pressed" && input.button === "left") {
        screen.down = [input.x, input.y];
        return undefined;
      }
      if (input.action !== "released" || !screen.down) return undefined;
      const [x0, y0] = screen.down;
      screen.down = undefined;
      const dx = input.x - x0;
      const dy = input.y - y0;
      if (Math.hypot(dx, dy) < 12) {
        screen.lastTap = [input.x, input.y];
        return ["device", "tap", "--x", unit(input.x), "--y", unit(input.y)];
      }
      // Revyl swipes from a point in a direction (the finger's travel).
      const direction = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
      return ["device", "swipe", "--x", unit(x0), "--y", unit(y0), "--direction", direction];
    }
    case "text": {
      if (!screen.lastTap) return undefined;
      return ["device", "type", "--x", unit(screen.lastTap[0]), "--y", unit(screen.lastTap[1]), "--text", input.text];
    }
    case "key": {
      if (input.action !== "down") return undefined;
      // On phones Revyl's keys are ENTER and BACKSPACE alone; a key that types goes as text where they last tapped.
      if (input.key === "Enter") return ["device", "key", "--key", "ENTER"];
      if (input.key === "Backspace") return ["device", "key", "--key", "BACKSPACE"];
      const typed = input.text ?? ([...input.key].length === 1 ? input.key : undefined);
      if (typed === undefined || !screen.lastTap) return undefined;
      return ["device", "type", "--x", unit(screen.lastTap[0]), "--y", unit(screen.lastTap[1]), "--text", typed];
    }
    default:
      return undefined;
  }
}

/** Flags whose value is a file: `device screenshot`/`hierarchy --out`, `build upload --file`. */
const PATH_FLAGS = new Set(["--out", "--file", "-f"]);

/** `argv` with each file it names made absolute against `cwd`, the agent's own folder, since `revyl` runs elsewhere. */
export function inCwd(argv: string[], cwd: string): string[] {
  const at = (v: string) => (isAbsolute(v) ? v : resolve(cwd, v));
  return argv.map((a, i) => {
    const eq = a.indexOf("=");
    if (eq > 0 && PATH_FLAGS.has(a.slice(0, eq))) return `${a.slice(0, eq + 1)}${at(a.slice(eq + 1))}`;
    return i > 0 && PATH_FLAGS.has(argv[i - 1]!) && !a.startsWith("-") ? at(a) : a;
  });
}

/** The first file named `name` under `dir`, at most three folders down. */
function findFile(dir: string, name: string, depth = 3): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const e of entries) {
    const p = join(dir, e);
    if (e === name) return p;
    if (depth > 0 && statSync(p).isDirectory()) {
      const found = findFile(p, name, depth - 1);
      if (found) return found;
    }
  }
  return undefined;
}

/** The node's Revyl screens. */
export const revyl = (node: Node, options?: RevylOptions) => node.area("revyl", (n) => new RevylScreens(n, options));

/** Chains a hub frame's handler: a Revyl screen's frame comes here, any other goes on to the one before. */
function before(node: Node, tag: "browser_watch" | "browser_input" | "browser_control", mine: (f: Record<string, unknown>) => boolean): void {
  const link = node.area("link");
  const earlier = link.handler(tag);
  link.on(tag, (frame, ctx) => {
    if (!mine(frame as Record<string, unknown>)) earlier?.(frame, ctx);
  });
}

/** Wires the Revyl screens into the node: the kind router, the hub's frames, the agent's `revyl`, its hello. */
export function start(node: Node, options?: RevylOptions): RevylScreens {
  const r = revyl(node, options);
  router(node).revyl = r;
  const ours = (f: Record<string, unknown>) => r.byId(String(f.sessionId)) !== undefined;
  before(node, "browser_watch", (f) => ours(f) && (r.watch(f as unknown as BrowserWatchFrame), true));
  before(node, "browser_input", (f) => ours(f) && (void r.input(f as unknown as BrowserInputFrame), true));
  before(node, "browser_control", (f) => ours(f) && (r.control(f as unknown as BrowserControlFrame), true));
  // The agent's `revyl …` (`fleetd revyl`, which the `revyl` first on its PATH runs), in its own working directory.
  node.area("local").on("revyl", async (thread, frame) => {
    try {
      if (!thread) throw new ToolError("forbidden", "A Revyl screen belongs to an agent's session, and this call comes from none.");
      const cwd = typeof frame.cwd === "string" && frame.cwd.startsWith("/") ? frame.cwd : "/";
      const call = { ...((frame.call ?? {}) as Record<string, unknown>), op: "revyl" };
      const { op: _, ...result } = await router(node).handle(thread, { id: "revyl", cwd, call });
      return { result: { op: "revyl", ...result } };
    } catch (e) {
      if (e instanceof ToolError) return { error: e.toJSON() };
      return { error: { code: "failed", message: (e as Error).message } };
    }
  });
  // Every agent session gets `revyl` first on its PATH: Revyl's CLI with the team's key held back, for its own screen.
  try {
    installShim(node.home, self(node));
    node.area("launch").contribute({ env: (_thread, path) => [["PATH", path ? `${binDir(node.home)}:${path}` : binDir(node.home)]] });
  } catch (e) {
    console.warn(`the agents' \`revyl\` command was not written: ${(e as Error).message}`);
  }
  node.area("caps").contribute(() => [CAP_REVYL]);
  node.area("hb").contribute((hb) => {
    hb.busy.screens = (hb.busy.screens ?? 0) + r.count();
  });
  void r.sweep().then((n) => n > 0 && console.info(`${n} Revyl screens a stopped node left running were stopped`));
  return r;
}

export async function stop(node: Node): Promise<void> {
  await router(node).revyl?.shutdown();
}
