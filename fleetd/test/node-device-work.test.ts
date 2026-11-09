// node/device/work.ts: what a screen hosted for another machine runs, and its folder (crates/fleetd/src/node/device/
// remote_tests.rs, the screen's node's half, ported). A shell script stands in for agent-device.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openCall, openDone, parse, PIECE, sealCall, sealDone, Work } from "../src/node/device/work.ts";
import { tempHome } from "./helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});
const scratch = () => {
  const home = tempHome();
  cleanups.push(home.done);
  return home.dir;
};
const KEY = "H0123456789abcdef0123456789abcdef";

function refused(line: string[]): string {
  try {
    throw new Error(`${JSON.stringify(line)} was allowed: ${JSON.stringify(parse(line))}`);
  } catch (e) {
    if ((e as Error).message.includes("was allowed")) throw e;
    return (e as Error).message;
  }
}

function script(path: string, body: string): string {
  writeFileSync(path, `#!/bin/sh\n${body}`);
  chmodSync(path, 0o755);
  return path;
}

test("only commands that drive the screen run on another machine", () => {
  for (const line of [
    ["batch", "--steps", "[]"],
    ["replay", "flow.ad"],
    ["test", "suite"],
    ["mcp"],
    ["daemon", "stop"],
    ["proxy"],
    ["connect"],
    ["plugins", "install", "x"],
    ["metro", "reload"],
    ["devices"],
    ["boot"],
    ["shutdown"],
    ["clipboard", "read"],
    ["install-from-source", "https://example.com/app.zip"],
    ["sh", "-c", "id"],
  ]) {
    expect(refused(line)).toContain("doesn't run here");
  }
  // No flag picks another device, platform, session or config, or runs a script.
  for (const line of [
    ["open", "Settings", "--udid", "8A1B2C3D-0000-4000-8000-000000000002"],
    ["snapshot", "--platform", "macos"],
    ["snapshot", "--platform=macos"],
    ["press", "@e1", "--device", "iPhone 17"],
    ["press", "@e1", "--session", "other"],
    ["snapshot", "--config", "/Users/me/c.json"],
    ["open", "Settings", "--save-script", "x.ad"],
    ["open", "Settings", "--launch-console", "/Users/me/.zshrc"],
    ["close", "--shutdown"],
    ["fill", "@e1", "--text-stdin"],
  ]) {
    expect(refused(line)).toContain("doesn't run here");
  }
  expect(refused(["--config", "c.json", "snapshot"])).toContain("doesn't run here");
  expect(refused(["open", "/System/Applications/Calculator.app"])).toContain("names a file");
  expect(refused(["open", "Safari", "FILE:///etc/passwd"])).toContain("names a file");
  expect(refused(["open", "App", "--launch-url", "file:///Users/me"])).toContain("names a file");
  expect(refused(["settings", "permission", "grant", "accessibility"])).toContain("host Mac");
  expect(refused(["record", "contact-sheet", "v.mp4"])).toContain("record start");
  // A file a command writes is always named, so it can come back.
  expect(refused(["screenshot"])).toContain("file name");
  expect(refused(["record", "start"])).toContain("file name");
  expect(refused(["logs", "path"])).toContain("file name");
  expect(refused(["logs", "tail", "app.log"])).toContain("logs path <file>");
  expect(refused(["logs", "start", "--platform", "macos"])).toContain("doesn't run here");
  expect(refused(["snapshot", "-i=1"])).toContain("no value");
});

test("a command reads as the screen's node runs it", () => {
  const parsed = parse(["screenshot", "--out=shots/a.png", "--pixel-density", "3"]);
  expect(parsed.args).toEqual(["screenshot", "--out", "shots/a.png", "--pixel-density", "3"]);
  expect(parsed.roles).toEqual(["plain", "plain", "out", "plain", "plain"]);
  expect(parse(["swipe", "10", "-20", "30", "40"]).roles.every((r) => r === "plain")).toBe(true);
  expect(parse(["install", "build/app.zip"]).roles).toEqual(["plain", "in"]);
  expect(parse(["reinstall", "sh.fleetd.app", "app.zip"]).roles).toEqual(["plain", "plain", "in"]);
  expect(parse(["push", "sh.fleetd.app", '{"aps":{}}']).roles).toEqual(["plain", "plain", "plain"]);
  expect(parse(["push", "sh.fleetd.app", "payload.json"]).roles[2]).toBe("in_or_json");
  for (const line of [
    ["open", "com.apple.Preferences", "--foreground"],
    ["open", "Expo Go", "exp://127.0.0.1:8081"],
    ["snapshot", "-i"],
    ["press", "@e3", "--settle"],
    ["fill", "@e7", "Ada Lovelace", "--settle"],
    ["record", "stop"],
    ["settings", "appearance", "dark"],
    ["help", "workflow"],
    ["logs", "clear", "--restart"],
    ["logs", "mark", "before", "New Screen"],
    ["logs", "doctor"],
    ["--help"],
    [],
  ]) {
    expect(() => parse(line)).not.toThrow();
  }
});

test("a step opens only with its session's key, under its own count and way", () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const call = sealCall(key, 3, { step: "run", args: ["home"] });
  expect(JSON.stringify(call)).not.toContain("home");
  if (call.step !== "sealed") throw new Error("sealed");
  expect(openCall(key, 3, call.dataB64)).toEqual({ step: "run", args: ["home"] });
  expect(openCall(key, 4, call.dataB64)).toBeUndefined();
  expect(openCall(crypto.getRandomValues(new Uint8Array(32)), 3, call.dataB64)).toBeUndefined();
  // Sealed inside a seal is no step; an answer isn't a call.
  const nested = sealCall(key, 5, call);
  if (nested.step !== "sealed") throw new Error("sealed");
  expect(openCall(key, 5, nested.dataB64)).toBeUndefined();
  const done = sealDone(key, 3, { step: "put", bytes: 9 });
  expect(openDone(key, 3, done)).toEqual({ step: "put", bytes: 9 });
  if (done.step !== "sealed") throw new Error("sealed");
  expect(openCall(key, 3, done.dataB64)).toBeUndefined();
});

test("a file goes in and a file comes back on the screen's node", async () => {
  const dir = scratch();
  const work = new Work(dir, KEY);
  const program = script(
    join(dir, "agent-device"),
    'echo "ran $* in $(pwd) as ${AGENT_DEVICE_HOME:-nobody} ${AGENT_DEVICE_PLATFORM:-}"\n' +
      'if [ "$1" = install ]; then cat "$2" > out/9-copy.bin; fi\n' +
      `if [ "$1" = screenshot ]; then printf 'png' > "$2"; echo "saved $2" >&2; fi\n` +
      "exit 3\n",
  );
  const app = Buffer.alloc(PIECE + 10, 7);
  const first = app.subarray(0, PIECE).toString("base64");
  expect(work.put("1-app.zip", 0, first)).toEqual({ step: "put", bytes: PIECE });
  // Pieces go in order, under plain names only.
  expect(() => work.put("1-app.zip", 0, first)).toThrow("not 0");
  expect(() => work.put("../app.zip", 0, first)).toThrow("not a plain file name");
  expect(() => work.put(".agent-device.json", 0, first)).toThrow("not a plain file name");
  work.put("1-app.zip", PIECE, app.subarray(PIECE).toString("base64"));
  const install = ["install", "in/1-app.zip"];
  work.check(install);
  for (const bad of [
    ["install", "in/2-other.zip"],
    ["install", "/Users/me/App.zip"],
    ["install", "in/../../secret"],
    ["screenshot", "/Users/me/.zshrc"],
    ["screenshot", "shot.png"],
    ["screenshot", "--out=out/1.png"],
  ]) {
    expect(() => work.check(bad)).toThrow();
  }
  const ran = await work.run(program, [["AGENT_DEVICE_HOME", "/n/sessions/H/agent-device"]], install);
  expect(ran.exitCode).toBe(3);
  expect(ran.stdout.trim()).toBe(`ran install in/1-app.zip in ${work.dir} as /n/sessions/H/agent-device`);
  expect(ran.files).toEqual([{ name: "9-copy.bin", bytes: app.length }]);
  expect(existsSync(join(work.dir, "in"))).toBe(false);
  const back: Buffer[] = [];
  for (let got = 0, total = 1; got < total; ) {
    const piece = work.get("9-copy.bin", got) as { dataB64: string; total: number };
    back.push(Buffer.from(piece.dataB64, "base64"));
    got += back.at(-1)!.length;
    total = piece.total;
  }
  expect(Buffer.concat(back).equals(app)).toBe(true);
  expect(() => work.get("9-copy.bin", 0)).toThrow("No file");
  // Its folder's own path stays on its machine.
  const shot = await work.run(program, [], ["screenshot", "out/3-home.png"]);
  expect(shot.stderr.trim()).toBe("saved out/3-home.png");
  work.remove();
  expect(existsSync(work.dir)).toBe(false);
});

test("the app log comes back from the screen's node, and only one in the node's own home", async () => {
  const dir = scratch();
  const home = join(dir, "node");
  const work = new Work(home, KEY);
  const session = join(home, "sessions", KEY, "agent-device/state/sessions/default");
  mkdirSync(session, { recursive: true });
  writeFileSync(join(session, "app.log"), "Fatal error: the sheet crashed\n");
  writeFileSync(join(dir, "app.log"), "the Mac's own\n");
  const program = script(
    join(dir, "agent-device"),
    '[ "$*" = "logs path" ] || [ "$*" = "logs path --json" ] || { echo "ran $*"; exit 2; }\n' +
      'if [ -n "$WHERE" ]; then log="$WHERE"; else log="$AGENT_DEVICE_HOME/state/sessions/default/app.log"; fi\n' +
      `if [ "$3" = --json ]; then printf '{"success":true,"data":{"path":"%s"}}\\n' "$log"; else echo "$log"; fi\n` +
      "echo 'active=true backend=ios-simulator' >&2\n",
  );
  const adHome = join(home, "sessions", KEY, "agent-device");
  const env = (where?: string): [string, string][] => [["AGENT_DEVICE_HOME", adHome], ...(where ? [["WHERE", where] as [string, string]] : [])];
  const line = ["logs", "path", "out/1-app.log"];
  work.check(line);
  const ran = await work.run(program, env(), line);
  expect([ran.exitCode, ran.stdout.trim()]).toEqual([0, "out/1-app.log"]);
  expect(ran.files).toEqual([{ name: "1-app.log", bytes: 31 }]);
  const got = work.get("1-app.log", 0) as { dataB64: string };
  expect(Buffer.from(got.dataB64, "base64").toString()).toBe("Fatal error: the sheet crashed\n");
  const json = await work.run(program, env(), ["logs", "path", "--json", "out/2-app.log"]);
  expect(json.exitCode).toBe(0);
  expect(json.stdout).toContain('"path":"out/2-app.log"');
  // A log outside the node's home, or none yet, doesn't come back.
  for (const where of [join(dir, "app.log"), join(session, "missing/app.log")]) {
    const r = await work.run(program, env(where), ["logs", "path", "out/3-app.log"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("no app log to send back");
    expect(r.files.filter((f) => f.name === "3-app.log")).toEqual([]);
  }
});

test("a command that runs too long is stopped", async () => {
  const dir = scratch();
  const program = script(join(dir, "agent-device"), "exec sleep 30\n");
  const ran = await new Work(dir, KEY).run(program, [], ["snapshot"], 200);
  expect(ran.exitCode).toBe(124);
});
