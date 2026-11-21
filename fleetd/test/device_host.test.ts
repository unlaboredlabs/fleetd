// Android sessions with no node around them (src/node/device/devices.ts): what they need comes in as a DeviceHost (the
// hub's calls, a recording store, the agent's box), as fleetd cloud gives it, and everything that needs adb, scrcpy or
// ffmpeg runs in the box. Here the box is a stand-in rooted in a folder of the test's: its commands run on this machine
// with its paths moved there, the box's own part (src/node/device/android_part.mjs) runs as it would in a box, and adb,
// the emulator, scrcpy's server and ffmpeg are stand-ins (a shell script, a sleep, a local socket, `cat`). Nothing here
// starts a real emulator, and the holder spawns nothing itself.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import { AndroidSessions, backoff, type DeviceHost, type DeviceSnapshot, redialing } from "../src/node/device/devices.ts";
import type { Meta, Recording, RecordingStore } from "../src/node/browser/recording.ts";
import type { Scrub } from "../src/node/mask.ts";
import { type AndroidBox, BOX_ROOT, boxAgentEnv, boxControlPath, timing, toolsScript } from "../src/node/place/box_emulator.ts";
import { AGENT_DEVICE_INTEGRITY, AGENT_DEVICE_URL, CLIENT_PACKAGES } from "../src/node/device/pins.ts";
import { findings, readRepo } from "./pkg/purity.ts";

const THREAD = "t-cloud";
/** A test that drives the stand-in box: its commands are real processes, slow on a busy machine. */
const BOX_TEST_MS = 30_000;
const SECRET = "hunter2-correct-horse";
const cleanups: (() => void | Promise<void>)[] = [];
const saved = { ...timing };
const savedRedial = { ...redialing };
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  Object.assign(timing, saved);
  Object.assign(redialing, savedRedial);
});

const until = async (what: () => boolean, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!what()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(10);
  }
};

/** A minimal JPEG: SOI, an APP0 segment, SOF0 with height 1280 and width 576, then EOI. */
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x05, 0x00, 0x02, 0x40, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]);

/** scrcpy's server, as the box's adb forwards it: the first connection is the video (a dummy byte, then the "H.264",
 * here JPEGs that the stand-in ffmpeg passes on), the second the control socket, whose bytes it keeps. */
async function standInScrcpy() {
  const control: Buffer[] = [];
  const sockets = new Set<Socket>();
  let n = 0;
  const server: Server = createServer((s) => {
    sockets.add(s);
    s.on("error", () => {});
    s.once("close", () => sockets.delete(s));
    if (n++ % 2 === 0) {
      s.write(Uint8Array.of(0));
      const timer = setInterval(() => s.write(JPEG), 40);
      s.once("close", () => clearInterval(timer));
    } else s.on("data", (d: Buffer) => control.push(d));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  cleanups.push(() => {
    for (const s of sockets) s.destroy();
    server.close();
  });
  return { port: (server.address() as { port: number }).port, control: () => Buffer.concat(control) };
}

/** A box rooted in a folder of the test's: its paths under BOX_ROOT are there, its commands run here, and what would
 * fetch the pinned pieces finds stand-ins in their place. */
async function standInBox() {
  const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-box-android-"));
  const bin = join(root, ".bin");
  const scrcpy = await standInScrcpy();
  const put = (path: string, text: string, mode = 0o755) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    chmodSync(path, mode);
  };
  put(
    join(root, "sdk/platform-tools/adb"),
    [
      "#!/bin/sh",
      '[ "$1" = "-s" ] && shift 2',
      'case "$1" in',
      "  forward) [ \"$2\" = \"--remove\" ] && exit 0; echo " + scrcpy.port + "; exit 0;;",
      '  shell) case "$2" in getprop) echo 1; exit 0;; settings) exit 0;; esac; exec sleep 3600;;',
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );
  put(join(root, "sdk/emulator/emulator"), "#!/bin/sh\nexec sleep 3601\n");
  put(join(root, "ffmpeg/ffmpeg-6.0.1-amd64-static/ffmpeg"), "#!/bin/sh\nexec cat\n");
  put(join(root, "scrcpy-server.jar"), "jar", 0o644);
  mkdirSync(bin, { recursive: true });
  symlinkSync(process.execPath, join(bin, "bun"));
  const here = (s: string) => s.replaceAll(BOX_ROOT, root);
  const runs: string[] = [];
  let up = true;
  const box: AndroidBox = {
    run: async (r) => {
      if (!up) return { exitCode: null, outputTail: "", timedOut: false, notRun: "the box didn't run it: the box is gone" };
      const script = here(r.argv[2] ?? "");
      runs.push(script);
      if (script.includes("/dev/kvm")) return { exitCode: 0, outputTail: "ok\n", timedOut: false };
      if (script.includes("curl ")) return { exitCode: 0, outputTail: "", timedOut: false };
      const proc = Bun.spawn(["sh", "-c", script], { cwd: root, env: { ...r.env, PATH: `${bin}:${r.env?.PATH ?? ""}` }, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { exitCode: code, outputTail: out + err, timedOut: false };
    },
    write: async (path, bytes, mode = 0o600) => {
      if (!up) throw new Error("the box is gone");
      const local = here(path);
      mkdirSync(dirname(local), { recursive: true });
      writeFileSync(local, here(new TextDecoder().decode(bytes)), { mode });
    },
    read: async (path) => new Uint8Array(readFileSync(here(path))),
    dial: (host, port) =>
      new Promise<Duplex>((resolve, reject) => {
        if (!up) return reject(new Error("the box's link is down"));
        const s = connect(port, host);
        s.once("connect", () => {
          dials.push(s);
          resolve(s);
        });
        s.once("error", reject);
      }),
  };
  const dials: Socket[] = [];
  // Whatever the box started (the emulator's and each part's process session) goes with the test.
  const kill = () => {
    const pids = [join(root, "emulator.pid")];
    const parts = join(root, "parts");
    if (existsSync(parts)) for (const d of readdirSync(parts)) pids.push(join(parts, d, "part.pid"));
    for (const f of pids) {
      try {
        process.kill(-Number(readFileSync(f, "utf8").trim()), "SIGKILL");
      } catch {
        // Gone already.
      }
    }
  };
  cleanups.push(() => {
    kill();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    box,
    root,
    runs,
    scrcpy,
    here,
    /** The box's link drops: every connection the guest dialled goes, the part waits in its grace. */
    dropLinks: () => {
      for (const s of dials.splice(0)) s.destroy();
    },
    /** The box goes for good. */
    gone: () => {
      up = false;
      for (const s of dials.splice(0)) s.destroy();
      kill();
    },
    parts: () => (existsSync(join(root, "parts")) ? readdirSync(join(root, "parts")) : []),
    /** The pids of the emulator's and the parts' process sessions, while their files name them. */
    pids: () => {
      const files = [join(root, "emulator.pid")];
      if (existsSync(join(root, "parts"))) for (const d of readdirSync(join(root, "parts"))) files.push(join(root, "parts", d, "part.pid"));
      return files.filter((f) => existsSync(f)).map((f) => Number(readFileSync(f, "utf8").trim()));
    },
  };
}

/** Recordings kept in memory: what each session's recording took, across holders. */
function standInStore() {
  const recs = new Map<string, { metas: Meta[]; actions: string[]; frames: number[]; ended?: { note?: string } }>();
  const store: RecordingStore = {
    open(meta) {
      const r = recs.get(meta.sessionId) ?? { metas: [], actions: [], frames: [] };
      recs.set(meta.sessionId, r);
      r.metas.push(meta);
      const recording: Recording = {
        append: (file, line) => void (file === "actions" && r.actions.push(line)),
        video: {
          frame: (_jpeg, atMs) => void r.frames.push(atMs),
          tick: () => {},
          finish: async () => undefined,
        },
        filled: () => {},
        end: async (ended, scrub: Scrub) => {
          r.actions = r.actions.map((l) => scrub.text(l));
          r.ended = { ...(ended.note ? { note: ended.note } : {}) };
          return { files: [{ file: "actions.jsonl", bytes: r.actions.join("\n").length }] };
        },
      };
      return recording;
    },
  };
  return { store, recs };
}

function standInHost(box: AndroidBox | "starting" | undefined, store: RecordingStore, o: { bootWaitMs?: number } = {}) {
  const reports: Record<string, unknown>[] = [];
  const frames: Record<string, unknown>[] = [];
  const changed: string[] = [];
  const host: DeviceHost = {
    call: async (op, args) => {
      if (op === "browser_session") reports.push(args);
      return {};
    },
    send: (f) => void frames.push(f),
    secrets: () => [["TOKEN", SECRET]],
    inBox: () => box,
    recordings: store,
    changed: (t) => void changed.push(t),
    ...(o.bootWaitMs !== undefined ? { bootWaitMs: o.bootWaitMs } : {}),
  };
  return { host, reports, frames, changed };
}

const sessions = (host: DeviceHost) => {
  const s = new AndroidSessions(host);
  cleanups.push(() => s.letGo());
  return s;
};

const startFrame = (purpose = "check the app") => ({ cwd: "/work", call: { op: "session_start", kind: "android", purpose } }) as never;
const command = (cmd: string, output = "") =>
  ({ id: "i1", kind: { type: "command", command: cmd, exitCode: 0, output }, status: "completed", startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:01.000Z" }) as never;

test("an Android session is driven, watched, taken over and recorded through a stand-in host, the box doing the rest", async () => {
  timing.pollMs = 10;
  const b = await standInBox();
  const { store, recs } = standInStore();
  const h = standInHost(b.box, store);
  const d = sessions(h.host);

  const started = (await d.handle(THREAD, startFrame())) as { sessionId: string; serial: string };
  expect(started.serial).toBe("emulator-5554");
  const id = started.sessionId;
  // The box got its emulator booted and the agent's agent-device pointed at it.
  expect(b.pids()).toHaveLength(2);
  expect(JSON.parse(readFileSync(join(b.root, `sessions/${THREAD}/agent-device/config.json`), "utf8"))).toEqual({ platform: "android", serial: "emulator-5554" });
  expect(h.reports.at(-1)).toMatchObject({ sessionId: id, kind: "android", state: "live", control: "agent" });

  // Frames come out of the box's part into the recording, and to a watcher as `browser_frame`s.
  await until(() => (recs.get(id)?.frames.length ?? 0) > 2);
  d.watch({ sessionId: id, on: true } as never);
  await until(() => h.frames.length > 0);
  expect(h.frames[0]).toMatchObject({ t: "browser_frame", sessionId: id, width: 576, height: 1280, control: "agent" });

  // The agent's commands are steps, scrubbed of its secrets.
  expect(d.item(THREAD, command(`agent-device tap --token ${SECRET}`, "tapped"))).toBe(true);
  expect(recs.get(id)!.actions.join("\n")).not.toContain(SECRET);

  // A person takes over: the box's wrapper refuses the agent, and their typing reaches scrcpy's control socket.
  d.control({ sessionId: id, control: "human", by: "human:desk" } as never);
  await until(() => existsSync(b.here(boxControlPath(THREAD))));
  d.input({ sessionId: id, input: { kind: "text", text: "hello" } } as never);
  await until(() => b.scrcpy.control().includes(Buffer.from("hello")));
  expect(h.reports.at(-1)).toMatchObject({ control: "human" });

  // Handed back: the agent's next command drives again.
  d.control({ sessionId: id, control: "agent", by: "human:desk" } as never);
  await until(() => !existsSync(b.here(boxControlPath(THREAD))));
  d.item(THREAD, command("agent-device snapshot"));
  expect(d.controlOf(THREAD)).toBe("agent");

  const running = b.pids();
  expect(running).toHaveLength(2);
  const ended = (await d.handle(THREAD, { cwd: "/work", call: { op: "session_end" } } as never)) as { sessionId: string; files: unknown[] };
  expect(ended).toMatchObject({ sessionId: id, kind: "android" });
  expect(recs.get(id)!.ended).toEqual({});
  const tools = recs.get(id)!.actions.map((l) => (JSON.parse(l) as { tool: string }).tool);
  expect(tools).toEqual(["session_start", "agent-device", "takeover", "handback", "agent-device", "session_end"]);
  // The part, its folder and the emulator went with the session.
  expect(b.parts()).toEqual([]);
  // Killed with everything in their process sessions: the stand-in emulator, the part, its server and decoder.
  const alive = (pid: number) => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  await until(() => running.every((pid) => !alive(pid)));
}, BOX_TEST_MS);

test("a holder that drops and a new one that adopts carry the session on, the person still driving", async () => {
  timing.pollMs = 10;
  const b = await standInBox();
  const { store, recs } = standInStore();
  const first = standInHost(b.box, store);
  const d1 = new AndroidSessions(first.host);
  const { sessionId: id } = (await d1.start(THREAD, "/work", "check the app")) as { sessionId: string };
  await until(() => (recs.get(id)?.frames.length ?? 0) > 0);
  d1.control({ sessionId: id, control: "human", by: "human:desk" } as never);
  await until(() => existsSync(b.here(boxControlPath(THREAD))));
  const snap: DeviceSnapshot = JSON.parse(JSON.stringify(d1.snapshot(THREAD)));
  expect(snap).toMatchObject({ v: 1, id, thread: THREAD, control: "human" });
  // No secret goes in what carries it.
  expect(JSON.stringify(snap)).not.toContain(SECRET);

  // The instance dies: its connections drop, nothing is ended or reported.
  const reportsBefore = first.reports.length;
  d1.letGo();
  b.dropLinks();
  expect(first.reports.length).toBe(reportsBefore);
  expect(b.parts()).toHaveLength(1);

  // Another instance takes it over while the person drives.
  const second = standInHost(b.box, store);
  const d2 = sessions(second.host);
  const framesBefore = recs.get(id)!.frames.length;
  expect(await d2.adopt(THREAD, snap)).toEqual({ adopted: true, sessionId: id });
  expect(recs.get(id)!.metas.at(-1)).toMatchObject({ sessionId: id, resumed: true });
  expect(d2.controlOf(THREAD)).toBe("human");
  expect(existsSync(b.here(boxControlPath(THREAD)))).toBe(true);
  expect(second.reports.at(-1)).toMatchObject({ sessionId: id, state: "live", control: "human" });
  await until(() => recs.get(id)!.frames.length > framesBefore);
  // The person's input still reaches the device through the new holder.
  d2.input({ sessionId: id, input: { kind: "text", text: "after-move" } } as never);
  await until(() => b.scrcpy.control().includes(Buffer.from("after-move")));
  // Its steps go on from where the last holder left them.
  d2.control({ sessionId: id, control: "agent", by: "human:desk" } as never);
  await d2.end(THREAD);
  const seqs = recs.get(id)!.actions.map((l) => (JSON.parse(l) as { seq: number }).seq);
  expect(seqs).toEqual(seqs.map((_, i) => i + 1));
}, BOX_TEST_MS);

test("a dropped link to the box is dialled again and the session goes on", async () => {
  timing.pollMs = 10;
  const b = await standInBox();
  const { store, recs } = standInStore();
  const h = standInHost(b.box, store);
  const d = sessions(h.host);
  const { sessionId: id } = (await d.start(THREAD, "/work", "p")) as { sessionId: string };
  await until(() => (recs.get(id)?.frames.length ?? 0) > 0);
  b.dropLinks();
  await until(() => recs.get(id)!.actions.some((l) => l.includes("device_reconnected")));
  const n = recs.get(id)!.frames.length;
  await until(() => recs.get(id)!.frames.length > n);
  expect(d.live(THREAD)).toEqual({ id, kind: "android" });
}, BOX_TEST_MS);

test("a connection that keeps dropping is dialled again later each time, capped, and never keeps a session from its idle end", async () => {
  timing.pollMs = 10;
  redialing.firstMs = 100;
  redialing.maxMs = 400;
  redialing.steadyMs = 60_000;
  expect([0, 1, 2, 3, 4, 40].map(backoff)).toEqual([100, 200, 400, 400, 400, 400]);
  const b = await standInBox();
  const { store, recs } = standInStore();
  const d = sessions(standInHost(b.box, store).host);
  const { sessionId: id } = (await d.start(THREAD, "/work", "p")) as { sessionId: string };
  await until(() => (recs.get(id)?.frames.length ?? 0) > 0);
  const idleFrom = Date.now();
  const reconnects = () => recs.get(id)!.actions.filter((l) => l.includes("device_reconnected")).length;
  const waited: number[] = [];
  for (let i = 0; i < 4; i++) {
    const t = Date.now();
    b.dropLinks();
    await until(() => reconnects() === i + 1);
    waited.push(Date.now() - t);
  }
  expect(waited[0]).toBeGreaterThanOrEqual(100);
  expect(waited[1]).toBeGreaterThanOrEqual(200);
  expect(waited[2]).toBeGreaterThanOrEqual(400);
  // Capped: the fourth waits no longer than the third's limit, and well under a doubling.
  expect(waited[3]).toBeGreaterThanOrEqual(400);
  expect(waited[3]).toBeLessThan(800 + 2_000);
  // The redials were no step of the agent's: the session is idle from before them.
  await d.housekeep(idleFrom + 30 * 60_000 + 50);
  expect(d.live(THREAD)).toBeUndefined();
}, BOX_TEST_MS);

test("a session whose box's part went before a new holder came ends plainly, and control goes back to the agent", async () => {
  timing.pollMs = 10;
  timing.graceMs = 300;
  timing.reachMs = 500;
  const b = await standInBox();
  const { store, recs } = standInStore();
  const d1 = new AndroidSessions(standInHost(b.box, store).host);
  const { sessionId: id } = (await d1.start(THREAD, "/work", "p")) as { sessionId: string };
  await until(() => (recs.get(id)?.frames.length ?? 0) > 0);
  d1.control({ sessionId: id, control: "human", by: "human:desk" } as never);
  await until(() => existsSync(b.here(boxControlPath(THREAD))));
  const snap = d1.snapshot(THREAD)!;
  d1.letGo();
  b.dropLinks();
  // The part's grace runs out with nobody dialling it.
  await Bun.sleep(900);
  const d2 = sessions(standInHost(b.box, store).host);
  const out = await d2.adopt(THREAD, snap);
  expect(out.adopted).toBe(false);
  expect(!out.adopted && out.note).toContain("the Android screen in the box went");
  expect(recs.get(id)!.ended?.note).toContain("while it moved to another server");
  expect(d2.live(THREAD)).toBeUndefined();
  // Never stuck with a person: the box's control file goes too.
  expect(existsSync(b.here(boxControlPath(THREAD)))).toBe(false);
}, BOX_TEST_MS);

test("a box that dies mid-session ends it plainly, keeping what was recorded", async () => {
  timing.pollMs = 10;
  timing.graceMs = 300;
  const b = await standInBox();
  const { store, recs } = standInStore();
  const d = sessions(standInHost(b.box, store).host);
  const { sessionId: id } = (await d.start(THREAD, "/work", "p")) as { sessionId: string };
  await until(() => (recs.get(id)?.frames.length ?? 0) > 0);
  b.gone();
  await until(() => recs.get(id)!.ended !== undefined);
  expect(recs.get(id)!.ended?.note).toContain("the Android screen in the box went");
  expect(recs.get(id)!.frames.length).toBeGreaterThan(0);
  expect(d.live(THREAD)).toBeUndefined();
}, BOX_TEST_MS);

test("a session nobody touched for the idle limit ends, but never while a person has it", async () => {
  timing.pollMs = 10;
  const b = await standInBox();
  const { store, recs } = standInStore();
  const d = sessions(standInHost(b.box, store).host);
  const { sessionId: id } = (await d.start(THREAD, "/work", "p")) as { sessionId: string };
  d.control({ sessionId: id, control: "human", by: "human:desk" } as never);
  await d.housekeep(Date.now() + 31 * 60_000);
  expect(d.live(THREAD)).toEqual({ id, kind: "android" });
  d.control({ sessionId: id, control: "agent", by: "human:desk" } as never);
  await d.housekeep(Date.now() + 31 * 60_000);
  expect(d.live(THREAD)).toBeUndefined();
  expect(recs.get(id)!.ended).toBeDefined();
}, BOX_TEST_MS);

test("a box that is starting, missing or slow to boot answers plainly, and a start that came back finds the boot done", async () => {
  timing.pollMs = 10;
  const { store } = standInStore();
  await expect(new AndroidSessions(standInHost(undefined, store).host).start(THREAD, "/w", "p")).rejects.toThrow("run only in an agent's box");
  const starting = sessions(standInHost("starting", store).host);
  await expect(starting.start(THREAD, "/w", "p")).rejects.toThrow("still starting");
  const b = await standInBox();
  // A boot that outlasts the call's wait says to come back; the next start opens on it.
  const slow: AndroidBox = { ...b.box, run: async (r) => (r.argv[2]?.includes("boot_completed") ? (await Bun.sleep(150), b.box.run(r)) : b.box.run(r)) };
  const d = sessions(standInHost(slow, store, { bootWaitMs: 50 }).host);
  await expect(d.start(THREAD, "/w", "p")).rejects.toThrow("starting in your sandbox");
  await Bun.sleep(300);
  const ok = (await d.start(THREAD, "/w", "p")) as { sessionId: string };
  expect(ok.sessionId).toStartWith("B");
  await d.end(THREAD);
}, BOX_TEST_MS);

test("the holder's side imports nothing that spawns, reads files or reaches past the box's own calls", () => {
  for (const entry of ["fleetd/src/node/device/devices.ts", "fleetd/src/node/place/box_emulator.ts"]) expect(findings(entry, readRepo, { allow: ["network"] })).toEqual([]);
}, BOX_TEST_MS);

test("the box fetches scrcpy's server, the decoder and agent-device by their pins and digests, and the agent's claude finds them", () => {
  const script = toolsScript();
  for (const p of CLIENT_PACKAGES().filter((p) => p.dest !== "sdk")) {
    expect(script).toContain(p.url);
    expect(script).toContain(`${p.sha256}  $R/dl/${p.url.split("/").at(-1)}`);
  }
  expect(script).toContain(AGENT_DEVICE_URL);
  expect(script).toContain(`${Buffer.from(AGENT_DEVICE_INTEGRITY.slice(7), "base64").toString("hex")}  $R/dl/agent-device.tgz" | sha512sum -c -`);
  const env = Object.fromEntries(boxAgentEnv(THREAD, "/usr/bin"));
  expect(env.PATH).toBe(`${BOX_ROOT}/agent-device/bin:/usr/bin`);
  expect(env.FLEETD_DEVICE_CONTROL).toBe(`${BOX_ROOT}/sessions/${THREAD}/device-control`);
  // An id that isn't safe in a path is hashed, never let out of the box's folder.
  expect(Object.fromEntries(boxAgentEnv("../../etc")).AGENT_DEVICE_HOME).toMatch(new RegExp(`^${BOX_ROOT}/sessions/[0-9a-f]{32}/agent-device$`));
}, BOX_TEST_MS);
