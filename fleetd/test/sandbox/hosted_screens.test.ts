// A hosted agent's screens run in its own box (src/node/place/box_screens.ts), on any node and on the hub's runner,
// which has no machine to lend: the runner's node answers an agent's browser and Linux desktop starts, and each starts
// in the agent's box rather than on the node's machine. The boxes here are stand-ins: what reaches them is checked,
// and a real box's Chrome and Xvfb are the PR's proof on boat.dev.
import { afterEach, expect, test } from "bun:test";
import { Duplex } from "node:stream";
import { registerAreas } from "../../src/node/areas.ts";
import { broker } from "../../src/node/browser/index.ts";
import { desktops } from "../../src/node/desktop/index.ts";
import { router } from "../../src/node/device/router.ts";
import { useRunner } from "../../src/node/place/index.ts";
import { BoxDisplay, boxChrome, type ScreenBox, streamTransport, timing } from "../../src/node/place/box_screens.ts";
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

test("an agent of the hub's runner asking for Android hears plainly that hosted sandboxes don't run it yet", async () => {
  const t = runnerNode();
  useRunner(() => "boat");
  cleanups.push(() => useRunner(undefined));
  await expect(t.local.call("session_start", { kind: "android", purpose: "try the app" }, THREAD)).rejects.toThrow("Android screens don't run in hosted sandboxes yet");
});

test("a hosted agent's browser starts in its box, not on the node's machine", async () => {
  const t = runnerNode();
  const b = broker(t.node);
  const { box } = standInBox();
  const asked: ScreenBox[] = [];
  b.boxed = (thread) => (thread === THREAD ? { dial: (h, p) => box.dial(h, p), box } : undefined);
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
  expect(text).toContain("3<&0 4>&1");
  const start = files.get(`${dir}/start.sh`) ?? "";
  expect(start).toMatch(/^socat TCP-LISTEN:(\d+),bind=127\.0\.0\.1,reuseaddr EXEC:\/tmp\/fleetd-browser-[0-9a-f]{12}\/chrome\.sh\n$/);
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
  expect(runs.at(-1)).toContain(`kill -KILL -- "-$(cat "$f")"`);
  expect(runs.at(-1)).toContain(`rm -rf '${dir}'`);
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
