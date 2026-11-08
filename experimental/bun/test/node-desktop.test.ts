// node/desktop: Linux desktop sessions, against stand-ins only. The X server is test/fake_x.ts (in this process, or
// as the fake Xvfb a display starts), the container runtime a shell script; no real X server, window manager, xdotool
// or docker ever runs, and every socket and lock file is under $TMPDIR.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { broker, start as startBrowser } from "../src/node/browser/index.ts";
import { DOCKERFILE, image, Runtime } from "../src/node/desktop/container.ts";
import { xauth } from "../src/node/desktop/display.ts";
import {
  CAP_SESSION_DESKTOP,
  capabilities,
  Desktops,
  forgetRuntimeCheck,
  healthOf,
  hostCheck,
  start as startDesktop,
  worktreeMount,
} from "../src/node/desktop/index.ts";
import { bmp, jpeg } from "../src/node/desktop/screen.ts";
import { charKeysym, keysym, parseChord, X } from "../src/node/desktop/x11.ts";
import { router } from "../src/node/device/router.ts";
import { start as startRoute } from "../src/node/session_route/index.ts";
import { cookieOf, FakeX } from "./fake_x.ts";
import { tempHome } from "./helpers.ts";
import { testNode } from "./node_helpers.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const scratch = () => {
  const home = tempHome();
  cleanups.push(home.done);
  return home.dir;
};

const until = async (what: string, ok: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
};

async function fakeX(dir: string, opts: { damage?: boolean } = {}) {
  const cookie = crypto.getRandomValues(new Uint8Array(16));
  const server = new FakeX(cookie, 64, 40, opts.damage ?? true);
  const socket = join(dir, "X5");
  await server.listen(socket);
  cleanups.push(() => server.close());
  return { server, socket, cookie };
}

test("keys go by their xdotool names, browser names or characters", () => {
  expect(keysym("Return")).toBe(0xff0d);
  expect(keysym("enter")).toBe(0xff0d);
  expect(keysym("ArrowLeft")).toBe(0xff51);
  expect(keysym("F5")).toBe(0xffc2);
  expect(keysym("F25")).toBeUndefined();
  expect(keysym("a")).toBe(0x61);
  expect(keysym("é")).toBe(0xe9);
  expect(keysym("nope")).toBeUndefined();
  expect(charKeysym("\n")).toBe(0xff0d);
  expect(charKeysym("€")).toBe(0x0100_0000 | 0x20ac);
  expect(parseChord("ctrl+shift+t")).toEqual([0xffe3, 0xffe1, 0x74]);
  expect(parseChord("+")).toEqual([0x2b]);
  expect(() => parseChord("ctrl+")).toThrow("names an empty key");
  expect(() => parseChord("hyper+x")).toThrow("is not a key name");
});

test("the cookie file names the cookie for any display", () => {
  const cookie = new Uint8Array(16).fill(7);
  const file = xauth(cookie);
  expect([...file.subarray(0, 2)]).toEqual([0xff, 0xff]);
  expect(Buffer.from(file).includes(Buffer.from("MIT-MAGIC-COOKIE-1"))).toBe(true);
  expect([...cookieOf(file)]).toEqual([...cookie]);
});

test("the pinned image is the Rust node's, so either node uses the image the other built", () => {
  const rust = readFileSync(join(import.meta.dir, "../../../crates/fleetd/src/node/desktop/container.rs"), "utf8");
  const pinned = /pub const DOCKERFILE: &str = r#"([\s\S]*?)"#;/.exec(rust)?.[1];
  expect(DOCKERFILE).toBe(pinned!);
  expect(image()).toMatch(/^localhost\/fleetd-desktop:[0-9a-f]{12}$/);
  expect(DOCKERFILE).toContain("@sha256:");
});

test("a container sees only the session's own worktree, read-only", () => {
  const home = scratch();
  const runtime = Runtime.find("/usr/bin/podman", home)!;
  expect(runtime.podman).toBe(true);
  const args = runtime.runArgs("fleetd-desktop-x", "img", "/d/x11", "/d/xauth", "/w/repo");
  expect(args.slice(0, 6)).toEqual(["run", "-d", "--rm", "--init", "--name", "fleetd-desktop-x"]);
  expect(args).toContain("/w/repo:/w/repo:ro");
  expect(args).toContain("/d/xauth:/fleetd/xauth:ro");
  expect(args).toContain("--userns=keep-id");
  expect(args.at(-1)).toBe("img");
  expect(args).toContain(`fleetd.desktop=${runtime.label}`);
  const worktree = join(home, "repo");
  mkdirSync(worktree);
  expect(worktreeMount("container", false, worktree)).toBe(worktree);
  expect(worktreeMount("xvfb", false, worktree)).toBeUndefined();
  expect(worktreeMount("container", true, worktree)).toBeUndefined();
  expect(worktreeMount("container", false, "/")).toBeUndefined();
  expect(worktreeMount("container", false, join(home, "gone"))).toBeUndefined();
});

test("a screen's pixels go to a JPEG by Bun's own encoder, red as red", async () => {
  const red = new Uint8Array(16 * 8 * 4);
  for (let i = 0; i < red.length; i += 4) red[i + 2] = 255;
  expect(bmp(red, 16, 8).length).toBe(54 + red.length);
  const out = await jpeg(red, 16, 8);
  expect([...out.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  const meta = await new Bun.Image(out).metadata();
  expect([meta.width, meta.height, meta.format]).toEqual([16, 8, "jpeg"]);
});

test("the node's X connection reads the screen and types, clicks and scrolls through XTEST", async () => {
  const dir = scratch();
  const { server, socket, cookie } = await fakeX(dir);
  await expect(X.connect(socket, new Uint8Array(16))).rejects.toThrow("refused the connection");
  const x = await X.connect(socket, cookie);
  cleanups.push(() => x.close());
  expect(x.size()).toEqual([64, 40]);
  expect(x.changed()).toBe(true);
  expect(x.changed()).toBe(false);
  server.paint(10, 20, 30);
  await until("damage", () => x.changed());
  const shot = await x.grab();
  expect([shot.width, shot.height]).toEqual([64, 40]);
  expect([...shot.jpeg.subarray(0, 2)]).toEqual([0xff, 0xd8]);

  await x.click(10, 12, 1, 2);
  expect(server.inputs).toEqual([
    { type: 6, detail: 0, x: 10, y: 12 },
    { type: 4, detail: 1, x: 0, y: 0 },
    { type: 5, detail: 1, x: 0, y: 0 },
    { type: 4, detail: 1, x: 0, y: 0 },
    { type: 5, detail: 1, x: 0, y: 0 },
  ]);
  expect(await x.pointer()).toEqual([10, 12]);
  server.inputs.length = 0;
  // Off the screen: clamped to its edge.
  await x.scroll(500, -3, 0, -2);
  expect(server.inputs.map((i) => [i.type, i.detail])).toEqual([[6, 0], [4, 4], [5, 4], [4, 4], [5, 4]]);
  expect(server.pointer).toEqual([63, 0]);

  server.inputs.length = 0;
  await x.typeText("aB!");
  const shift = server.codeOf(0xffe1)!;
  const a = server.codeOf(0x61)!;
  const b = server.codeOf(0x62)!;
  // `!` isn't on the keyboard: bound to a free keycode while typed.
  const bang = server.codeOf(0x21)!;
  expect(bang).toBeGreaterThan(200);
  expect(server.inputs.map((i) => [i.type, i.detail])).toEqual([
    [2, a], [3, a],
    [2, shift], [2, b], [3, b], [3, shift],
    [2, bang], [3, bang],
  ]);
  server.inputs.length = 0;
  await x.chord("ctrl+a");
  const ctrl = server.codeOf(0xffe3)!;
  expect(server.inputs.map((i) => [i.type, i.detail])).toEqual([[2, ctrl], [2, a], [3, a], [3, ctrl]]);
  await expect(x.chord("hyper+x")).rejects.toThrow("is not a key name");
});

test("without DAMAGE the screen counts as changed at every look", async () => {
  const dir = scratch();
  const { socket, cookie } = await fakeX(dir, { damage: false });
  const x = await X.connect(socket, cookie);
  cleanups.push(() => x.close());
  expect(x.changed()).toBe(true);
  expect(x.changed()).toBe(true);
});

/** A fake `docker` that answers `info` as given, and a fake Xvfb starting test/fake_x.ts. */
function fakes(dir: string, dockerInfo: "ok" | "fail") {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const docker = join(bin, "docker");
  writeFileSync(
    docker,
    `#!/bin/sh\ncase "$1" in info) ${dockerInfo === "ok" ? "echo ok; exit 0" : 'echo "Cannot connect to the Docker daemon" >&2; exit 1'};; *) exit 1;; esac\n`,
  );
  chmodSync(docker, 0o755);
  const xvfb = join(bin, "Xvfb");
  writeFileSync(xvfb, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fake_x.ts")}" "$@"\n`);
  chmodSync(xvfb, 0o755);
  const x11 = join(dir, "x11");
  const locks = join(dir, "locks");
  mkdirSync(x11, { recursive: true });
  mkdirSync(locks, { recursive: true });
  process.env.FAKE_X11_DIR = x11;
  process.env.FAKE_X_LOCK_DIR = locks;
  return { docker, xvfb, x11, locks };
}

test("health says what desktop sessions run in, and why not", async () => {
  if (process.platform !== "linux") return;
  const dir = scratch();
  const { docker, xvfb } = fakes(dir, "fail");
  forgetRuntimeCheck();
  const both = await healthOf(dir, { runtime: docker, xvfb });
  expect(both).toMatchObject({ state: "ready", backend: "xvfb" });
  expect(both!.message).toContain("not in containers: `docker info` failed: Cannot connect");
  forgetRuntimeCheck();
  // Nothing works: said only where node.json asks for them.
  expect(await healthOf(dir, { runtime: docker, backend: "container" })).toBeUndefined();
  forgetRuntimeCheck();
  const asked = await healthOf(dir, { runtime: docker, backend: "container", enabled: true });
  expect(asked).toMatchObject({ state: "unavailable", backend: "container" });
  expect(asked!.fix).toContain("xvfb");
  expect(await healthOf(dir, { enabled: false, xvfb })).toBeUndefined();
  const off = await hostCheck(dir, { enabled: false });
  expect(off).toMatchObject({ host: "desktop", ready: false, off: "off", on: false, idleMinutes: 30 });
  const ok = fakes(dir, "ok");
  forgetRuntimeCheck();
  expect(await healthOf(dir, { runtime: ok.docker })).toMatchObject({ state: "ready", backend: "container" });
});

test("the heartbeat's load.desktop says what desktop sessions run in, as Rust's node/load.rs does", async () => {
  if (process.platform !== "linux") return;
  const dir = scratch();
  const { xvfb, x11, locks } = fakes(dir, "fail");
  const t = testNode("devbox", { desktop: { backend: "xvfb", xvfb, x11Dir: x11, lockDir: locks, windowManagers: [], pool: 0 } });
  cleanups.push(t.done);
  forgetRuntimeCheck();
  const d = startDesktop(t.node);
  cleanups.push(() => d.shutdown());
  const hb = { load: { cpus: 4, load1: 0, limits: [] }, steps: [] as unknown[], busy: { threads: 0, screens: 0, uploads: 0, hosted: 0 } };
  await t.node.area("hb").fill(hb as never);
  expect((hb.load as { desktop?: unknown }).desktop).toMatchObject({ state: "ready", backend: "xvfb" });
});

test("an agent opens a desktop, screenshots, clicks, types and launches on it, a person takes over, and it ends", async () => {
  if (process.platform !== "linux") return;
  const dir = scratch();
  const { xvfb, x11, locks } = fakes(dir, "fail");
  const t = testNode("devbox", {
    desktop: { backend: "xvfb", xvfb, x11Dir: x11, lockDir: locks, windowManagers: [], pool: 0 },
  });
  cleanups.push(t.done);
  const reports: Record<string, unknown>[] = [];
  t.link.answer = async (op, args) => {
    if (op === "session_route") return { runner: "devbox", here: true };
    if (op === "browser_session") reports.push(args);
    return {};
  };
  startBrowser(t.node);
  startRoute(t.node);
  const d = startDesktop(t.node);
  cleanups.push(() => broker(t.node).shutdown());
  cleanups.push(() => d.shutdown());
  expect(router(t.node).desktops).toBe(d);
  // An Xvfb is there: the hello lists desktop sessions before the first one prepares them, and the node links anew.
  let relinks = 0;
  t.node.area("caps").onChanged(() => relinks++);
  expect(await capabilities(t.node)).toEqual([CAP_SESSION_DESKTOP]);
  await d.refreshCaps();
  expect(t.node.area("caps").list()).toContain(CAP_SESSION_DESKTOP);
  expect(relinks).toBeLessThanOrEqual(1);

  // The session starts in the agent's own working directory, as its call's frame names it: its apps start there.
  const worktree = join(dir, "worktree");
  mkdirSync(worktree, { recursive: true });
  const local = (op: string, call: Record<string, unknown>) =>
    t.node.area("local").answer("thread-1", { id: op, cwd: worktree, call: { ...call, op } }) as Promise<{ result?: Record<string, unknown> }>;
  const started = (await local("session_start", { kind: "linux_desktop", purpose: "check the app" })).result!;
  expect(started).toMatchObject({ op: "session_start", desktop: "xvfb" });
  const id = String(started.sessionId);
  expect(id).toMatch(/^B[0-9a-f]{32}$/);
  expect(reports.at(-1)).toMatchObject({ sessionId: id, kind: "linux_desktop", state: "live", threadId: "thread-1" });
  expect(router(t.node).live("thread-1")).toBe(true);
  expect(await capabilities(t.node)).toEqual([CAP_SESSION_DESKTOP]);
  // Another start of the same agent's is refused.
  await expect(t.local.call("session_start", { kind: "linux_desktop", purpose: "again" }, "thread-1")).rejects.toThrow("is open");

  const shot = (await t.local.call("desktop", { action: "screenshot" }, "thread-1")) as Record<string, unknown>;
  expect(shot).toMatchObject({ op: "desktop", message: "The screen, 1280x800.", width: 1280, height: 800 });
  expect(Buffer.from(String(shot.jpegB64), "base64").subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  expect(await t.local.call("desktop", { action: "left_click", coordinate: [5, 6] }, "thread-1")).toMatchObject({ message: "left_click at (5, 6)." });
  expect(await t.local.call("desktop", { action: "cursor_position" }, "thread-1")).toMatchObject({ message: "The mouse is at (5, 6)." });
  expect(await t.local.call("desktop", { action: "type", text: "hi" }, "thread-1")).toMatchObject({ message: "Typed 2 characters." });
  await expect(t.local.call("desktop", { action: "mouse_move" }, "thread-1")).rejects.toThrow("mouse_move needs coordinate");
  const launched = (await t.local.call("desktop", { action: "launch", text: "echo $DISPLAY on $HOME; exit 3" }, "thread-1")) as { message: string };
  expect(launched.message).toMatch(/exited at once with code 3: :\d+ on .*\/home/);
  expect((await local("desktop", { action: "launch", text: "pwd; exit 4" })).result?.message).toBe(`\`pwd; exit 4\` exited at once with code 4: ${worktree}`);
  const running = (await t.local.call("desktop", { action: "launch", text: "sleep 30" }, "thread-1")) as { message: string };
  expect(running.message).toMatch(/^Started `sleep 30` \(pid \d+\)/);

  // The hub watches: the newest frame goes at once, as a browser's do.
  t.link.deliver({ t: "browser_watch", sessionId: id, on: true });
  await until("a frame", () => t.link.sent.some((f) => f.t === "browser_frame" && f.sessionId === id));
  const frame = t.link.sent.find((f) => f.t === "browser_frame")!;
  expect(frame).toMatchObject({ width: 1280, height: 800, control: "agent" });

  // A person takes over: the agent is refused, and their input lands on the screen.
  t.link.deliver({ t: "browser_control", sessionId: id, control: "human", by: "ada" });
  await expect(t.local.call("desktop", { action: "screenshot" }, "thread-1")).rejects.toThrow("A person has control");
  expect(reports.at(-1)).toMatchObject({ control: "human" });
  t.link.deliver({ t: "browser_control", sessionId: id, control: "agent", by: "ada" });
  expect(d.session("thread-1")!.control()).toBe("handing_back");
  await t.local.call("desktop", { action: "wait", duration: 1 }, "thread-1");
  expect(d.session("thread-1")!.control()).toBe("agent");
  expect(d.steps()[0]!.step).toMatchObject({ tool: "desktop", ok: true });
  const tools = d.session("thread-1")!.steps.map((s) => s.tool);
  expect(tools).toEqual(expect.arrayContaining(["session_start", "takeover", "handback", "agent_resumed", "desktop"]));

  const root = join(t.node.home, "desktop", "displays");
  expect(readdirSync(root).length).toBe(1);
  const ended = (await t.local.call("session_end", {}, "thread-1")) as Record<string, unknown>;
  expect(ended).toMatchObject({ op: "session_end", sessionId: id, kind: "linux_desktop", files: [] });
  expect(reports.at(-1)).toMatchObject({ sessionId: id, state: "recorded" });
  // The display goes with everything on it: its folder, its X server's socket and lock.
  expect(readdirSync(root)).toEqual([]);
  expect(readdirSync(x11)).toEqual([]);
  expect(readdirSync(locks)).toEqual([]);
  await expect(t.local.call("desktop", { action: "screenshot" }, "thread-1")).rejects.toThrow("No desktop session is open");
  // A real Xvfb and the processes launched on it: a loaded machine (CI, or a busy devbox) takes longer than bun's 5 s
  // default.
}, 30_000);

test("a start on a machine that can't prepare says why at once, and the hub's session_end ends a desktop", async () => {
  if (process.platform !== "linux") return;
  const dir = scratch();
  const { docker } = fakes(dir, "fail");
  forgetRuntimeCheck();
  const t = testNode("devbox", { desktop: { backend: "container", runtime: docker, pool: 0 } });
  cleanups.push(t.done);
  t.link.answer = async (op) => (op === "session_route" ? { runner: "devbox", here: true } : {});
  startBrowser(t.node);
  startRoute(t.node);
  const d = startDesktop(t.node);
  cleanups.push(() => broker(t.node).shutdown());
  cleanups.push(() => d.shutdown());
  await expect(t.local.call("session_start", { kind: "linux_desktop", purpose: "x" }, "t")).rejects.toThrow(
    "This machine can't host desktop sessions: `docker info` failed: Cannot connect",
  );
  expect(existsSync(join(t.node.home, "desktop", "state.json"))).toBe(true);
  expect(await capabilities(t.node)).toEqual([]);
  await d.refreshCaps();
  expect(t.node.area("caps").list()).not.toContain(CAP_SESSION_DESKTOP);
  expect(await hostCheck(t.node.home, d.config)).toMatchObject({ ready: false, off: "missing" });
  // A desktop the hub says ends goes; any other id is left.
  expect(d.endScreen("t", "Bnope")).toBe(false);
  expect(new Desktops(t.node, { enabled: false }).count()).toBe(0);
});
