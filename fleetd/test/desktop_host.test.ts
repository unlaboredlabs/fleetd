// The desktops with no node around them (src/node/desktop/desktops.ts): what they need comes in as a DesktopHost (the
// hub's calls and frames, the secrets, the box, a recording store), as fleetd cloud gives it. The display runs in a
// stand-in box: its Xvfb is test/fake_x.ts, made with the cookie BoxDisplay writes there and listening on a socket
// under $TMPDIR, which the box's dial reaches as socat would. It outlives a dropped holder, as a box's display does.
// Its picture is read "in the box" as fleetd's `box-frames` reads it there (src/node/desktop/box_frames.ts `serve`),
// started in this process when the holder writes its script, on a socket of its own.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import type { BrowserCallFrame } from "../src/shared/screens_wire.ts";
import type { Meta, Recording, RecordingStore } from "../src/node/browser/recording.ts";
import { type DesktopHost, DesktopSessions, type DesktopSnapshot } from "../src/node/desktop/desktops.ts";
import type { Scrub } from "../src/node/mask.ts";
import { serve } from "../src/node/desktop/box_frames.ts";
import { openPicture } from "../src/node/desktop/picture_link.ts";
import type { LiveFrame, VideoFrame } from "../src/node/desktop/screen.ts";
import { BoxDisplay, type ScreenBox, timing } from "../src/node/place/box_screens.ts";
import { FakeX } from "./fake_x.ts";

const THREAD = "t-cloud";
const SECRET = "hunter2-correct-horse";
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const until = async (what: string, ok: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
};

/** A box whose display is a FakeX: made when the box gets the display's cookie, reached by any dial but a picture's.
 * `lacks`: what its `command -v` check says is missing; `frames: false`, a box whose fleetd serves no picture (its
 * port answers nothing). `fromDisplay` counts what the holder's own connections to the display read. */
function standInBox(o: { lacks?: string[]; frames?: boolean } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "desktop-host-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const runs: string[] = [];
  const dials: number[] = [];
  // The newest display's: each one listens on a socket of its own.
  const at = { x: undefined as FakeX | undefined, socket: "", cookie: new Uint8Array(0), fromDisplay: 0 };
  let made = 0;
  // The pictures' sockets by the port the holder dials, and each one's serve.
  const pictures = new Map<number, string>();
  const served: Promise<void>[] = [];
  cleanups.push(() => Promise.all(served).then(() => {}));
  const box: ScreenBox = {
    run: async (r) => {
      const script = r.argv.join(" ");
      runs.push(script);
      const said = script.includes("command -v") ? (o.lacks ?? []).map((p) => `${p}\n`).join("") : "";
      return { exitCode: 0, outputTail: said, timedOut: false };
    },
    write: async (path, bytes) => {
      const frames = /\/frames-[0-9a-f]+\.sh$/.test(path) && /--port (\d+) --video (\w+)/.exec(new TextDecoder().decode(bytes));
      if (frames) {
        const port = Number(frames[1]);
        pictures.set(port, "");
        if (o.frames === false) return;
        const listen = join(dir, `F${port}`);
        served.push(serve({ socket: at.socket, cookie: at.cookie, listen, video: frames[2] as "jpeg", waitMs: 5_000 }));
        // Listening once its serve took the socket.
        await until("the picture to listen", () => existsSync(listen));
        pictures.set(port, listen);
        return;
      }
      if (!path.endsWith("/xauth")) return;
      at.cookie = bytes.slice(-16);
      const x = new FakeX(at.cookie, 64, 40);
      const socket = join(dir, `X${++made}`);
      await x.listen(socket);
      at.x = x;
      at.socket = socket;
      cleanups.push(() => x.close());
    },
    dial: (_host, port) =>
      new Promise<Duplex>((resolve, reject) => {
        dials.push(port);
        if (!at.x) return reject(new Error("ECONNREFUSED"));
        const picture = pictures.get(port);
        if (picture === "") return reject(new Error("ECONNREFUSED"));
        const s = connect(picture ?? at.socket);
        if (picture === undefined) s.on("data", (chunk: Buffer) => void (at.fromDisplay += chunk.length));
        s.once("connect", () => resolve(s)).once("error", reject);
      }),
  };
  return { box, runs, dials, at };
}

/** A recording store that keeps everything in memory: each recording's lines, its frames, and how it ended. */
function memoryStore(o: { endNote?: string; events?: string[] } = {}) {
  const recordings: { meta: Meta; lines: string[]; frames: number; ended?: { note?: string; scrubbed: string[] } }[] = [];
  const store: RecordingStore = {
    open: async (meta) => {
      const r: (typeof recordings)[number] = { meta, lines: [], frames: 0 };
      recordings.push(r);
      const rec: Recording = {
        key: meta.sessionId,
        video: {
          frame: (jpeg) => {
            // A JPEG, as the broker feeds a browser's: what the store's ffmpeg in the box reads.
            if (jpeg[0] === 0xff && jpeg[1] === 0xd8) r.frames++;
          },
          tick: () => {},
          finish: async () => undefined,
        },
        append: (file, line) => void (file === "actions" && r.lines.push(line)),
        filled: () => {},
        end: async (ended, scrub: Scrub) => {
          o.events?.push("end");
          if (o.endNote) ended = { ...ended, note: ended.note ? `${ended.note}; ${o.endNote}` : o.endNote };
          r.ended = { ...(ended.note ? { note: ended.note } : {}), scrubbed: r.lines.map((l) => scrub.text(l)) };
          return { files: [{ file: "actions", bytes: r.lines.length }], ...(ended.note ? { note: ended.note } : {}) };
        },
      };
      return rec;
    },
  };
  return { store, recordings };
}

/** A host as a service gives it: its calls, frames and changes kept, the box given. */
function host(box: ScreenBox | undefined, store: RecordingStore, idle?: number, events?: string[]) {
  const calls: { op: string; args: Record<string, unknown> }[] = [];
  const frames: Record<string, unknown>[] = [];
  const changed: string[] = [];
  const h: DesktopHost = {
    call: async (op, args) => {
      calls.push({ op, args });
      if (op === "browser_session") events?.push(`report ${String(args.state)}`);
      return {};
    },
    send: (frame) => void frames.push(frame),
    secrets: (thread) => (thread === THREAD ? [["SHOP_TOKEN", SECRET]] : []),
    inBox: (thread) => (thread === THREAD ? box : undefined),
    recordings: store,
    ...(idle !== undefined ? { idleMinutes: () => idle } : {}),
    changed: (thread) => void changed.push(thread),
  };
  return { h, calls, frames, changed };
}

const call = (op: string, args: Record<string, unknown> = {}): BrowserCallFrame => ({ id: op, cwd: "/work", call: { op, ...args } }) as BrowserCallFrame;
const sessions = (calls: { op: string; args: Record<string, unknown> }[]) => calls.filter((c) => c.op === "browser_session").map((c) => c.args);

test("a desktop with no node: its display runs in the box, its recording and reports go where its host says", async () => {
  const { box, runs, at } = standInBox();
  const { store, recordings } = memoryStore();
  const { h, calls, frames, changed } = host(box, store);
  const d = new DesktopSessions(h);
  cleanups.push(() => d.shutdown());
  const started = await d.handle(THREAD, call("session_start", { kind: "linux_desktop", purpose: "check the app" }));
  expect(started).toMatchObject({ op: "session_start", desktop: "box", worktree: "/work" });
  const id = String(started.sessionId);
  expect(runs.some((r) => r.includes("setsid sh") && r.includes("/start.sh"))).toBe(true);
  expect(sessions(calls)[0]).toMatchObject({ sessionId: id, kind: "linux_desktop", state: "live", control: "agent", threadId: THREAD });
  expect(changed).toContain(THREAD);

  expect(await d.handle(THREAD, call("desktop", { action: "screenshot" }))).toMatchObject({ op: "desktop", width: 64, height: 40 });
  await d.handle(THREAD, call("desktop", { action: "type", text: SECRET }));
  // A person watches: frames go to the host.
  expect(d.watch({ t: "browser_watch", sessionId: id, on: true } as never)).toBe(true);
  await until("a frame", () => frames.some((f) => f.t === "browser_frame" && f.sessionId === id));
  await until("a video frame", () => (recordings[0]?.frames ?? 0) > 0);
  // The picture is read in the box: the holder's own connection to the display carries input, never a screen.
  const before = at.fromDisplay;
  for (const blue of [40, 80, 120]) {
    const seen = frames.length;
    at.x!.paint(blue, 20, 30);
    await until("the change's frame", () => frames.length > seen);
  }
  expect(frames.at(-1)).toMatchObject({ t: "browser_frame", sessionId: id, control: "agent", width: 64, height: 40 });
  expect(at.fromDisplay - before).toBeLessThan(64 * 40 * 4);
  expect(d.watch({ t: "browser_watch", sessionId: "Bnope", on: true } as never)).toBe(false);
  expect(d.steps()[0]).toMatchObject({ sessionId: id });

  const ended = await d.handle(THREAD, call("session_end"));
  expect(ended).toMatchObject({ op: "session_end", sessionId: id, kind: "linux_desktop", files: [{ file: "actions" }] });
  // Its end reaches the hub before the store's own reports of the recording.
  expect(sessions(calls).at(-1)).toMatchObject({ sessionId: id, state: "uploading" });
  const scrubbed = recordings[0]!.ended!.scrubbed.join("\n");
  expect(scrubbed).toContain("***SHOP_TOKEN***");
  expect(scrubbed).not.toContain("hunter2");
  expect(recordings[0]!.lines.join("\n")).not.toContain("hunter2");
  // The display goes with everything on it.
  expect(runs.at(-1)).toContain("rm -rf '/tmp/fleetd-desktop-");
  expect(d.count()).toBe(0);
});

test("a box whose fleetd serves no picture: the holder reads the screen itself, and the person still sees it", async () => {
  const upMs = timing.upMs;
  timing.upMs = 300;
  cleanups.push(() => void (timing.upMs = upMs));
  const { box, at } = standInBox({ frames: false });
  const { store, recordings } = memoryStore();
  const { h, frames } = host(box, store);
  const d = new DesktopSessions(h);
  cleanups.push(() => d.shutdown());
  const id = String((await d.handle(THREAD, call("session_start", { kind: "linux_desktop", purpose: "x" }))).sessionId);
  d.watch({ t: "browser_watch", sessionId: id, on: true } as never);
  await until("a frame", () => frames.some((f) => f.t === "browser_frame" && f.sessionId === id));
  await until("a video frame", () => (recordings[0]?.frames ?? 0) > 0);
  expect(at.fromDisplay).toBeGreaterThanOrEqual(64 * 40 * 4);
  expect(await d.handle(THREAD, call("desktop", { action: "screenshot" }))).toMatchObject({ width: 64, height: 40 });
});

test("box-frames serves only a holder with the display's cookie, answers screenshots and ends with its connection", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "box-frames-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const cookie = new Uint8Array(16).fill(7);
  const x = new FakeX(cookie, 32, 24);
  await x.listen(join(dir, "X"));
  cleanups.push(() => x.close());
  const reach = (listen: string) =>
    new Promise<Duplex>((resolve, reject) => {
      const s = connect(listen);
      s.once("connect", () => resolve(s)).once("error", reject);
    });
  // Another cookie: refused before anything of the display's goes.
  const refused = join(dir, "F1");
  // It goes on waiting for the holder's, until its wait is up.
  const one = serve({ socket: join(dir, "X"), cookie, listen: refused, video: "none", waitMs: 500 });
  await until("it to listen", () => existsSync(refused));
  await expect(openPicture(await reach(refused), new Uint8Array(16).fill(8), { live: () => {}, video: () => {} })).rejects.toThrow("the box's picture stopped");
  await one;

  const at = join(dir, "F2");
  const served = serve({ socket: join(dir, "X"), cookie, listen: at, video: "jpeg" });
  await until("it to listen", () => existsSync(at));
  const live: LiveFrame[] = [];
  const video: VideoFrame[] = [];
  const run = await openPicture(await reach(at), cookie, { live: (f) => void live.push(f), video: (f) => void video.push(f) });
  run.watch({ kbps: undefined, video: false });
  x.paint(200, 10, 10);
  await until("a live frame", () => live.some((f) => f.jpegB64 !== undefined && f.width === 32));
  await until("a video frame", () => video.some((f) => f.kind === "jpeg"));
  const shot = await run.shot();
  expect(shot).toMatchObject({ width: 32, height: 24 });
  expect([shot.jpeg[0], shot.jpeg[1]]).toEqual([0xff, 0xd8]);
  // Nobody watches: no live frame from then on, the video's go on.
  run.watch(undefined);
  await Bun.sleep(100);
  const seen = live.length;
  x.paint(10, 200, 10);
  const videos = video.length;
  await until("the change in the video", () => video.length > videos);
  expect(live.length).toBe(seen);
  // The holder goes: so does it.
  run.stop();
  expect(await run.ended).toBeUndefined();
  await served;
}, 20_000);

test("a box without Xvfb, openbox or socat says so at once, and nothing waits on it", async () => {
  const { box, dials } = standInBox({ lacks: ["openbox", "socat"] });
  const { store, recordings } = memoryStore();
  const { h } = host(box, store);
  const d = new DesktopSessions(h);
  const t0 = performance.now();
  await expect(d.handle(THREAD, call("session_start", { kind: "linux_desktop", purpose: "x" }))).rejects.toThrow(
    "The desktop did not start: the agent's box has no openbox, socat, which a desktop needs there.",
  );
  expect(performance.now() - t0).toBeLessThan(2_000);
  expect(dials).toEqual([]);
  expect(recordings).toEqual([]);
  // An agent in no box is told plainly: this desktop runs only in boxes.
  await expect(d.handle("t-other", call("session_start", { kind: "linux_desktop", purpose: "x" }))).rejects.toThrow("runs only in an agent's box");
});

test("a desktop session survives a dropped and re-made holder, a person's takeover with it", async () => {
  const { box, at } = standInBox();
  const { store, recordings } = memoryStore();
  const first = host(box, store);
  const a = new DesktopSessions(first.h);
  const started = await a.handle(THREAD, call("session_start", { kind: "linux_desktop", purpose: "check the app" }));
  const id = String(started.sessionId);
  await a.handle(THREAD, call("desktop", { action: "type", text: "hi" }));
  // A person takes it over on the first holder.
  expect(a.control({ t: "browser_control", sessionId: id, control: "human", by: "ada" } as never)).toBe(true);
  const snap = JSON.parse(JSON.stringify(a.snapshot(THREAD))) as DesktopSnapshot;
  expect(snap).toMatchObject({ v: 1, id, thread: THREAD, control: "human", purpose: "check the app" });
  expect(JSON.stringify(snap)).not.toContain(SECRET);
  const seq = snap.seq;
  // The holder goes (a deploy): nothing ends, nothing is reported.
  const reportsBefore = sessions(first.calls).length;
  await a.letGo();
  expect(sessions(first.calls).length).toBe(reportsBefore);
  expect(recordings[0]!.ended).toBeUndefined();
  expect(a.count()).toBe(0);

  // Another holder takes it over: the same session, the person still driving it.
  const second = host(box, store);
  const b = new DesktopSessions(second.h);
  cleanups.push(() => b.shutdown());
  expect(await b.adopt(THREAD, snap)).toEqual({ adopted: true, sessionId: id });
  expect(recordings[1]!.meta).toMatchObject({ sessionId: id, resumed: true, startedAt: snap.startedAt });
  expect(sessions(second.calls).at(-1)).toMatchObject({ sessionId: id, state: "live", control: "human" });
  await expect(b.handle(THREAD, call("desktop", { action: "screenshot" }))).rejects.toThrow("A person has control");
  // Their input reaches the display through the new holder.
  expect(b.input({ t: "browser_input", sessionId: id, input: { kind: "mouse", action: "moved", x: 7, y: 9 } } as never)).toBe(true);
  await until("the pointer to move", () => at.x!.pointer[0] === 7 && at.x!.pointer[1] === 9);
  // The idle end leaves a session a person has.
  b.control({ t: "browser_control", sessionId: id, control: "agent", by: "ada" } as never);
  expect(b.session(THREAD)!.control()).toBe("handing_back");
  expect(await b.handle(THREAD, call("desktop", { action: "cursor_position" }))).toMatchObject({ message: "The mouse is at (7, 9)." });
  expect(b.session(THREAD)!.control()).toBe("agent");
  // Its action log goes on from where the first holder's left.
  const first2 = JSON.parse(recordings[1]!.lines[0]!) as { seq: number; tool: string };
  expect(first2).toMatchObject({ seq: seq + 1, tool: "desktop_adopted" });
  const ended = await b.handle(THREAD, call("session_end"));
  expect(ended).toMatchObject({ sessionId: id });
  expect(recordings[1]!.ended!.scrubbed.join("\n")).toContain("handback");
});

test("a holder that adopts a session whose display went ends it plainly, control back to the agent", async () => {
  const { box, at, runs } = standInBox();
  const { store, recordings } = memoryStore();
  const first = host(box, store);
  const a = new DesktopSessions(first.h);
  const id = String((await a.handle(THREAD, call("session_start", { kind: "linux_desktop", purpose: "x" }))).sessionId);
  a.control({ t: "browser_control", sessionId: id, control: "human", by: "ada" } as never);
  const snap = a.snapshot(THREAD)!;
  await a.letGo();
  // The display goes meanwhile (the box restarted, or it was swept).
  at.x!.close();
  at.x = undefined;
  const second = host(box, store);
  const b = new DesktopSessions(second.h);
  const adopted = await b.adopt(THREAD, snap);
  expect(adopted.adopted).toBe(false);
  // The note a person reads says it once: what went, when, and why.
  expect(adopted).toMatchObject({ note: expect.stringMatching(/^the desktop in the box went while it moved to another server: it doesn't answer \(.+\)$/) });
  expect(b.count()).toBe(0);
  expect(sessions(second.calls).at(-1)).toMatchObject({ sessionId: id, state: "uploading", control: "agent" });
  expect(recordings[1]!.ended?.note).toContain("while it moved to another server");
  expect(recordings[1]!.lines.map((l) => (JSON.parse(l) as { tool: string }).tool)).toEqual(["desktop_gone"]);
  // What was left of the display in the box is swept.
  expect(runs.at(-1)).toContain(`rm -rf '${snap.display.dir}'`);
  // A snapshot for another agent session is refused.
  await expect(b.adopt("t-else", snap)).rejects.toThrow("not a desktop session's snapshot");
  // The new holder tries the display for 5 s (BoxDisplay.reattach) before it counts it gone.
}, 15_000);

test("the idle end leaves a session a person has or is handing back, and ends one the agent drives", async () => {
  const { box } = standInBox();
  const { store, recordings } = memoryStore();
  const { h, calls } = host(box, store, 0);
  const d = new DesktopSessions(h);
  cleanups.push(() => d.shutdown());
  const id = String((await d.handle(THREAD, call("session_start", { kind: "linux_desktop", purpose: "x" }))).sessionId);
  d.control({ t: "browser_control", sessionId: id, control: "human", by: "ada" } as never);
  await d.housekeep();
  expect(d.count()).toBe(1);
  d.control({ t: "browser_control", sessionId: id, control: "agent", by: "ada" } as never);
  await d.housekeep();
  expect(d.count()).toBe(1);
  await d.handle(THREAD, call("desktop", { action: "cursor_position" }));
  await d.housekeep();
  expect(d.count()).toBe(0);
  expect(recordings[0]!.ended).toBeDefined();
  expect(sessions(calls).at(-1)).toMatchObject({ sessionId: id, state: "uploading" });
});

test("a session's end reaches the hub after its recording ends, with why it has no video", async () => {
  const { box } = standInBox();
  const events: string[] = [];
  const { store } = memoryStore({ endNote: "no video: ffmpeg failed (1)", events });
  const { h, calls } = host(box, store, undefined, events);
  const d = new DesktopSessions(h);
  const id = String((await d.handle(THREAD, call("session_start", { kind: "linux_desktop", purpose: "x" }))).sessionId);
  const ended = await d.handle(THREAD, call("session_end"));
  expect(ended).toMatchObject({ sessionId: id, note: "no video: ffmpeg failed (1)" });
  expect(events.slice(-2)).toEqual(["end", "report uploading"]);
  expect(sessions(calls).at(-1)).toMatchObject({ sessionId: id, state: "uploading", note: "no video: ffmpeg failed (1)" });
});

test("a session_start while the agent session's desktop is being taken over is refused, and no second display opens", async () => {
  const { box, runs } = standInBox();
  const { store, recordings } = memoryStore();
  const a = new DesktopSessions(host(box, store).h);
  const id = String((await a.handle(THREAD, call("session_start", { kind: "linux_desktop", purpose: "x" }))).sessionId);
  const snap = a.snapshot(THREAD)!;
  await a.letGo();
  const b = new DesktopSessions(host(box, store).h);
  cleanups.push(() => b.shutdown());
  let reached!: () => void;
  const gate = new Promise<void>((r) => (reached = r));
  b.reattachDisplay = async (given, handle) => {
    await gate;
    return BoxDisplay.reattach(given, handle);
  };
  const adopting = b.adopt(THREAD, snap);
  const starts = runs.filter((r) => r.includes("/start.sh")).length;
  await expect(b.handle(THREAD, call("session_start", { kind: "linux_desktop", purpose: "another" }))).rejects.toThrow("Another session_start of yours is under way.");
  await expect(b.adopt(THREAD, snap)).rejects.toThrow("being taken over here already");
  reached();
  expect(await adopting).toEqual({ adopted: true, sessionId: id });
  expect(b.count()).toBe(1);
  expect(runs.filter((r) => r.includes("/start.sh")).length).toBe(starts);
  expect(recordings.length).toBe(2);
  // Once it is in, a start is refused for the open session, as ever.
  await expect(b.handle(THREAD, call("session_start", { kind: "linux_desktop", purpose: "another" }))).rejects.toThrow(`Desktop session ${id} is open.`);
});

test("a snapshot whose display folder isn't a desktop's is refused before anything reaches the box", async () => {
  const { box, runs } = standInBox();
  const { store, recordings } = memoryStore();
  const a = new DesktopSessions(host(box, store).h);
  await a.handle(THREAD, call("session_start", { kind: "linux_desktop", purpose: "x" }));
  const snap = a.snapshot(THREAD)!;
  await a.letGo();
  const b = new DesktopSessions(host(box, store).h);
  const before = runs.length;
  for (const dir of ["/", "/home/agent", "/tmp/fleetd-desktop-", "/tmp/fleetd-desktop-ab/../..", "/tmp/fleetd-desktop-ab cd"]) {
    await expect(b.adopt(THREAD, { ...snap, display: { ...snap.display, dir } })).rejects.toThrow("the snapshot's display isn't a desktop's folder in the box");
  }
  expect(runs.length).toBe(before);
  expect(recordings.length).toBe(1);
  // BoxDisplay.reattach itself never sweeps another folder either.
  await expect(BoxDisplay.reattach(box, { ...snap.display, dir: "/", cookie: new Uint8Array(16) })).rejects.toThrow("not a desktop's folder in the box");
  expect(runs.length).toBe(before);
});
