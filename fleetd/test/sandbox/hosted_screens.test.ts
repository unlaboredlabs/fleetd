// A hosted agent's screens run in its own box (src/node/place/box_screens.ts), on any node and on the hub's runner,
// which has no machine to lend: the runner's node answers an agent's browser and Linux desktop starts, and each starts
// in the agent's box rather than on the node's machine. The boxes here are stand-ins: what reaches them is checked,
// and a real box's Chrome and Xvfb are the PR's proof on boat.dev.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { registerAreas } from "../../src/node/areas.ts";
import { broker } from "../../src/node/browser/index.ts";
import { desktops } from "../../src/node/desktop/index.ts";
import { router } from "../../src/node/device/router.ts";
import { devices } from "../../src/node/device/index.ts";
import { sdkAt } from "../../src/node/device/sdk.ts";
import type { BoxedEmulator } from "../../src/node/place/box_android.ts";
import { BoxDisplay, boxChrome, type ScreenBox, streamTransport, timing } from "../../src/node/place/box_screens.ts";
import { detach, sweep } from "../../src/node/place/box_chrome.ts";
import { testNode } from "../node_helpers.ts";

const cleanups: (() => void | Promise<void>)[] = [];
// A stand-in box answers no dial: give up on it at once.
timing.upMs = 300;
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const THREAD = "s-hosted";

/** A box that remembers what the node asked of it: its runs, its files and its dials, none of which connect. */
function standInBox() {
  const runs: string[] = [];
  const files = new Map<string, string>();
  const dials: number[] = [];
  const box: ScreenBox = {
    run: async (r) => {
      runs.push(r.argv.join(" "));
      return { exitCode: 0, outputTail: "", timedOut: false };
    },
    write: async (path, bytes) => void files.set(path, new TextDecoder().decode(bytes)),
    dial: async (_host, port) => {
      dials.push(port);
      throw new Error("ECONNREFUSED");
    },
  };
  return { box, runs, files, dials };
}

function runnerNode() {
  const t = testNode("hosted", { runner: true });
  cleanups.push(() => t.done());
  registerAreas(t.node);
  return t;
}

test("the hub's runner offers its agents a browser and a Linux desktop", () => {
  const t = runnerNode();
  const screens = router(t.node);
  expect(screens.browser).toBeDefined();
  expect(screens.desktops).toBeDefined();
});

test("a hosted agent's Android starts in its box: it says so while the box boots its emulator, then opens on it", async () => {
  const t = runnerNode();
  const d = devices(t.node)!;
  const { box } = standInBox();
  d.inBox = (thread) => (thread === THREAD ? (box as never) : undefined);
  broker(t.node).boxed = (thread) => (thread === THREAD ? { dial: box.dial, box } : undefined);
  d.boxClient = async (home) => sdkAt(home);
  let boot!: (v: BoxedEmulator) => void;
  const booted: unknown[] = [];
  d.boxEmulator = (given) => {
    booted.push(given);
    return new Promise((resolve) => (boot = resolve));
  };
  (d as unknown as { options: { boxWaitMs: number } }).options.boxWaitMs = 50;
  const start = () => t.local.call("session_start", { kind: "android", purpose: "try the app" }, THREAD);
  await expect(start()).rejects.toThrow("The Android emulator is starting in your sandbox");
  // A start that comes back meanwhile waits on the same boot, never a second.
  await expect(start()).rejects.toThrow("The Android emulator is starting in your sandbox");
  expect(booted).toEqual([box]);
  const released: string[] = [];
  boot({ lent: { emulator: { serial: "emulator-5554", pushed: false }, release: () => released.push("released") }, sdk: { ...sdkAt(t.node.home), adbPort: 1 } });
  const opened = (await start()) as { sessionId: string; serial: string };
  expect(opened.serial).toBe("emulator-5554");
  await t.local.call("session_end", {}, THREAD);
  expect(released).toEqual(["released"]);
});


test("an agent that ends while its box's emulator boots lets it go, and continued in a new box boots one there", async () => {
  const t = runnerNode();
  const d = devices(t.node)!;
  const first = standInBox();
  const second = standInBox();
  let own = first.box;
  d.inBox = (thread) => (thread === THREAD ? (own as never) : undefined);
  broker(t.node).boxed = (thread) => (thread === THREAD ? { dial: own.dial, box: own } : undefined);
  d.boxClient = async (home) => sdkAt(home);
  const released: string[] = [];
  const booted: unknown[] = [];
  d.boxEmulator = async (given) => {
    booted.push(given);
    await Bun.sleep(20);
    const which = given === first.box ? "first" : "second";
    return { lent: { emulator: { serial: `emulator-${which}`, pushed: false }, release: () => released.push(which) }, sdk: { ...sdkAt(t.node.home), adbPort: 1 } };
  };
  (d as unknown as { options: { boxWaitMs: number } }).options.boxWaitMs = 0;
  const start = () => t.local.call("session_start", { kind: "android", purpose: "try the app" }, THREAD);
  // The call gives up before the boot answers; the boot then finishes with no start to take it.
  await expect(start()).rejects.toThrow("The Android emulator is starting in your sandbox");
  await Bun.sleep(50);
  // The agent's claude ends: the booted emulator and its ports go.
  router(t.node).ended(THREAD);
  await Bun.sleep(10);
  expect(released).toEqual(["first"]);
  // Continued, in a new box: a boot of its own there, never the old box's emulator.
  own = second.box;
  (d as unknown as { options: { boxWaitMs: number } }).options.boxWaitMs = 1_000;
  const opened = (await start()) as { serial: string };
  expect(opened.serial).toBe("emulator-second");
  expect(booted).toEqual([first.box, second.box]);
});


test("a hosted agent's browser starts in its box, not on the node's machine", async () => {
  const t = runnerNode();
  const b = broker(t.node);
  const { box } = standInBox();
  const asked: ScreenBox[] = [];
  b.boxed = (thread) => (thread === THREAD ? { box } : undefined);
  b.inBox = async (given) => {
    asked.push(given);
    throw new Error("no Chrome in the stand-in");
  };
  const answer = t.local.call("session_start", { purpose: "check the page" }, THREAD);
  await expect(answer).rejects.toThrow("The browser didn't start: no Chrome in the stand-in");
  expect(asked).toEqual([box]);
});

test("a hosted agent's Linux desktop starts in its box, and says so while the box is made", async () => {
  const t = runnerNode();
  const d = desktops(t.node);
  const { box } = standInBox();
  let own: ScreenBox | "starting" = "starting";
  d.inBox = (thread) => (thread === THREAD ? own : undefined);
  broker(t.node).boxed = (thread) => (thread === THREAD ? (own === "starting" ? "starting" : { dial: box.dial, box }) : undefined);
  const started: ScreenBox[] = [];
  d.boxDisplay = async (given) => {
    started.push(given);
    throw new Error("no Xvfb in the stand-in");
  };
  await expect(d.sessionStart(THREAD, "/w", "look at the app")).rejects.toThrow("Your sandbox is still starting.");
  own = box;
  await expect(t.local.call("session_start", { kind: "linux_desktop", purpose: "look at the app" }, THREAD)).rejects.toThrow("The desktop did not start: no Xvfb in the stand-in");
  expect(started).toEqual([box]);
});

test("Chrome in a box runs from its own folder, on the box's loopback, and is swept when it doesn't answer", async () => {
  const { box, runs, files, dials } = standInBox();
  const failed = await boxChrome(box, ["--lang=en"]).catch((e: Error) => e.message);
  expect(failed).toContain("Chrome didn't start in the agent's box: nothing answered in the box");
  const launcher = await waitFor(() => [...files].find(([p]) => p.endsWith("/chrome.sh")));
  const [path, text] = launcher;
  const dir = path.slice(0, -"/chrome.sh".length);
  expect(dir).toMatch(/^\/tmp\/fleetd-browser-[0-9a-f]{12}$/);
  expect(text).toContain("--remote-debugging-pipe");
  expect(text).toContain("--no-sandbox");
  expect(text).toContain(`'--user-data-dir=${dir}/profile'`);
  expect(text).toContain("'--lang=en'");
  // Its pipe is the folder's two FIFOs, which the launcher holds open across connections, handed to each in turn.
  expect(text).toContain(`3<'${dir}/in' 4>'${dir}/out'`);
  const start = files.get(`${dir}/start.sh`) ?? "";
  expect(start).toContain(`exec 5<>'${dir}/in' 6<>'${dir}/out'`);
  expect(start).toMatch(/socat .*TCP-LISTEN:(\d+),bind=127\.0\.0\.1,reuseaddr,accept-timeout=\d+ OPEN:'\/tmp\/fleetd-browser-[0-9a-f]{12}\/out',rdonly!!OPEN:/);
  const port = Number(/TCP-LISTEN:(\d+)/.exec(start)![1]);
  await waitFor(() => (dials.length > 0 ? true : undefined));
  expect(dials[0]).toBe(port);
  expect(runs.some((r) => r.includes(`setsid sh '${dir}/start.sh'`))).toBe(true);
  expect(runs.at(-1)).toContain(`rm -rf '${dir}'`);
});

test("Chrome's pipe over a stream: NUL-framed both ways, closed with the stream", async () => {
  const sent: string[] = [];
  const s = new Duplex({
    read() {},
    write(chunk, _enc, done) {
      sent.push(String(chunk));
      done();
    },
  });
  const t = streamTransport(s);
  const got: string[] = [];
  let closed = false;
  t.onMessage((m) => got.push(m));
  t.onClose(() => (closed = true));
  expect(t.send('{"id":1}')).toBe(true);
  expect(sent).toEqual(['{"id":1}\0']);
  s.push(Buffer.from('{"id":1,"result":{}}\0{"method":"x"'));
  s.push(Buffer.from(',"params":{}}\0'));
  await Bun.sleep(0);
  expect(got).toEqual(['{"id":1,"result":{}}', '{"method":"x","params":{}}']);
  s.destroy();
  await Bun.sleep(0);
  expect(closed).toBe(true);
  expect(t.send("{}")).toBe(false);
});

test("a desktop in a box is swept with everything launched on it", async () => {
  const { box, runs, files } = standInBox();
  await expect(BoxDisplay.start(box)).rejects.toThrow("the desktop didn't start in the agent's box");
  const start = [...files].find(([p]) => p.endsWith("/start.sh"));
  expect(start).toBeDefined();
  const [path, text] = start!;
  const dir = path.slice(0, -"/start.sh".length);
  expect(text).toMatch(/Xvfb :\d+ -screen 0 1280x800x24 -nolisten tcp -noreset -auth/);
  expect(text).toContain("openbox");
  expect(text).toMatch(/socat TCP-LISTEN:\d+,bind=127\.0\.0\.1,fork,reuseaddr UNIX-CONNECT:\/tmp\/\.X11-unix\/X\d+/);
  // Every process session it started is killed, then its folder goes.
  expect(runs.at(-1)).toContain(`pkill -KILL -s "$p"`);
  expect(runs.at(-1)).toContain(`rm -rf '${dir}'`);
});

test("a box's sweep kills each process session it started, under dash's sh too", async () => {
  // Ubuntu's sh is dash, whose `kill` takes no negative id: the sweep kills each session by its id. Run for real here,
  // under dash where this machine has one.
  const sh = Bun.which("dash") ?? Bun.which("sh");
  if (!sh || !Bun.which("setsid") || !Bun.which("pkill") || !Bun.which("pgrep")) return;
  const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "box-sweep-"));
  const box: ScreenBox = {
    run: async (r) => {
      const argv = r.argv[0] === "sh" ? [sh, ...r.argv.slice(1)] : r.argv;
      const p = Bun.spawnSync(argv, { cwd: r.cwd, env: { ...process.env, ...r.env }, stdout: "pipe", stderr: "pipe" });
      return { exitCode: p.exitCode, outputTail: `${p.stdout}${p.stderr}`, timedOut: false };
    },
    write: async (path, bytes, mode) => {
      writeFileSync(path, bytes);
      if (mode) chmodSync(path, mode);
    },
    dial: async () => {
      throw new Error("no dial here");
    },
  };
  const inSession = (sid: string) => `${Bun.spawnSync(["pgrep", "-s", sid], { stdout: "pipe" }).stdout}`.trim().split("\n").filter(Boolean);
  let sid = "";
  try {
    // What runs in the session doesn't name the folder, so only the kill by session reaches it.
    writeFileSync(join(dir, "start.sh"), "exec sleep 300\n");
    await detach(box, join(dir, "start.sh"), join(dir, "session.pid"));
    await waitFor(() => (existsSync(join(dir, "session.pid")) && readFileSync(join(dir, "session.pid"), "utf8").trim() ? true : undefined));
    sid = readFileSync(join(dir, "session.pid"), "utf8").trim();
    await waitFor(() => (inSession(sid).length > 0 ? true : undefined));
    await sweep(box, dir);
    await waitFor(() => (inSession(sid).length === 0 ? true : undefined), 3_000);
    expect(existsSync(dir)).toBe(false);
  } finally {
    // Only what this test started: the processes of its own session.
    if (sid) for (const pid of inSession(sid)) process.kill(Number(pid), "SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

async function waitFor<T>(fn: () => T | undefined, ms = 5_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error("timed out");
    await Bun.sleep(10);
  }
}
