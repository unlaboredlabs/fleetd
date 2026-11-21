// The desktops with no node around them (src/node/desktop/desktops.ts): what they need comes in as a DesktopHost (the
// hub's calls and frames, the secrets, the box, a recording store), as fleetd cloud gives it. The display runs in a
// stand-in box: its Xvfb is test/fake_x.ts, made with the cookie BoxDisplay writes there and listening on a socket
// under $TMPDIR, which the box's dial reaches as socat would. It outlives a dropped holder, as a box's display does.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import type { BrowserCallFrame } from "../src/shared/screens_wire.ts";
import type { Meta, Recording, RecordingStore } from "../src/node/browser/recording.ts";
import { type DesktopHost, DesktopSessions, type DesktopSnapshot } from "../src/node/desktop/desktops.ts";
import type { Scrub } from "../src/node/mask.ts";
import type { ScreenBox } from "../src/node/place/box_screens.ts";
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

/** A box whose display is a FakeX: made when the box gets the display's cookie, reached by any dial. `lacks`: what its
 * `command -v` check says is missing. */
function standInBox(o: { lacks?: string[] } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "desktop-host-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const runs: string[] = [];
  const dials: number[] = [];
  const at = { x: undefined as FakeX | undefined };
  const socket = join(dir, "X");
  const box: ScreenBox = {
    run: async (r) => {
      const script = r.argv.join(" ");
      runs.push(script);
      const said = script.includes("command -v") ? (o.lacks ?? []).map((p) => `${p}\n`).join("") : "";
      return { exitCode: 0, outputTail: said, timedOut: false };
    },
    write: async (path, bytes) => {
      if (!path.endsWith("/xauth")) return;
      const x = new FakeX(bytes.slice(-16), 64, 40);
      await x.listen(socket);
      at.x = x;
      cleanups.push(() => x.close());
    },
    dial: (_host, port) =>
      new Promise<Duplex>((resolve, reject) => {
        dials.push(port);
        if (!at.x) return reject(new Error("ECONNREFUSED"));
        const s = connect(socket);
        s.once("connect", () => resolve(s)).once("error", reject);
      }),
  };
  return { box, runs, dials, at };
}

/** A recording store that keeps everything in memory: each recording's lines, its frames, and how it ended. */
function memoryStore() {
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
function host(box: ScreenBox | undefined, store: RecordingStore, idle?: number) {
  const calls: { op: string; args: Record<string, unknown> }[] = [];
  const frames: Record<string, unknown>[] = [];
  const changed: string[] = [];
  const h: DesktopHost = {
    call: async (op, args) => {
      calls.push({ op, args });
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
  const { box, runs } = standInBox();
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
  expect(adopted).toMatchObject({ note: expect.stringContaining("the desktop in the box went: the desktop in the agent's box is gone") });
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
