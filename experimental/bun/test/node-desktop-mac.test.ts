// node/desktop/mac: the agents' Mac's screen without a Mac (crates/fleetd/src/node/desktop/mac/tests.rs): what macOS
// says about the console, the gate made of it, keys, agent-desktop's commands, and the lease end to end on a fake
// screen. Nothing here asks macOS anything or touches the agents' Mac.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Desktops, desktops, macScreen } from "../src/node/desktop/index.ts";
import { packed } from "../src/node/desktop/mac/capture.ts";
import { answer, command, install, launchedPid, split, COMMAND_TIMEOUT, OUTPUT_CHARS } from "../src/node/desktop/mac/agent_desktop.ts";
import { parse, state } from "../src/node/desktop/mac/console.ts";
import { blockedBy, MacLent, observes } from "../src/node/desktop/mac/index.ts";
import { COMMAND, ofSym, OPTION } from "../src/node/desktop/mac/keys.ts";
import { jpeg, type Raw, type Screen } from "../src/node/desktop/screen.ts";
import type { DesktopCall } from "../src/node/desktop/session.ts";
import { parseChord } from "../src/node/desktop/x11.ts";
import { tempHome } from "./helpers.ts";
import { testNode } from "./node_helpers.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
const scratch = () => {
  const h = tempHome();
  cleanups.push(h.done);
  return h.dir;
};

/** `ioreg -n Root -d1 -a` on a Mac with two sessions: the person's in the background, agents' on the screen. */
const IOREG = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
	<dict>
		<key>IOConsoleLocked</key>
		<false/>
		<key>IOConsoleUsers</key>
		<array>
			<dict>
				<key>kCGSSessionAuditIDKey</key>
				<integer>100008</integer>
				<key>kCGSSessionOnConsoleKey</key>
				<false/>
				<key>kCGSSessionUserIDKey</key>
				<integer>501</integer>
				<key>kCGSSessionUserNameKey</key>
				<string>ana</string>
				<key>kCGSessionLongUserNameKey</key>
				<string>Ana &amp; Co</string>
			</dict>
			<dict>
				<key>kCGSSessionOnConsoleKey</key>
				<true/>
				<key>kCGSSessionUserIDKey</key>
				<integer>502</integer>
				<key>kCGSSessionUserNameKey</key>
				<string>agents</string>
				<key>kSCSecuritySessionID</key>
				<integer>100011</integer>
				<key>kCGSSessionSystemSafeBoot</key>
				<false/>
			</dict>
		</array>
		<key>IORegistryEntryName</key>
		<string>Root</string>
		<key>IOKitBuildVersion</key>
		<data>RGFyd2lu</data>
	</dict>
</array>
</plist>
`;

test("ioreg says which session has the screen", () => {
  const users = parse(IOREG);
  expect(users).toEqual([
    { uid: 501, name: "ana", onConsole: false, locked: false },
    { uid: 502, name: "agents", onConsole: true, locked: false },
  ]);
  expect(state(502, users)).toEqual({ kind: "on_screen" });
  expect(state(501, users)).toEqual({ kind: "background", who: "agents" });
  expect(state(503, users)).toEqual({ kind: "not_logged_in" });
  const locked = IOREG.replace("<key>kSCSecuritySessionID</key>", "<key>CGSSessionScreenIsLocked</key>\n<true/>\n<key>kSCSecuritySessionID</key>");
  expect(state(502, parse(locked))).toEqual({ kind: "locked" });
  // At the login window after a restart, nobody is logged in.
  expect(parse("<plist><array><dict><key>IORegistryEntryName</key><string>Root</string></dict></array></plist>")).toEqual([]);
  expect(() => parse("ioreg: no such entry")).toThrow("no property list");
});

test("the gate says exactly why, and how to fix it", () => {
  const on = { kind: "on_screen" } as const;
  expect(blockedBy("agents", on, true, true)).toBeUndefined();
  // An admin's own account lends its screen too.
  expect(blockedBy("ana", on, true, true)).toBeUndefined();
  const away = blockedBy("agents", { kind: "background", who: "ana" }, true, true)!;
  expect(away.message).toContain("ana has the Mac's screen");
  expect(away.message).toContain("black frames");
  const locked = blockedBy("agents", { kind: "locked" }, true, true)!;
  expect(locked.message).toContain("Require password: Never");
  expect(blockedBy("agents", { kind: "not_logged_in" }, true, true)!.message).toContain("log in as agents");
  const capture = blockedBy("agents", on, false, true)!;
  expect(capture.message).toContain("Screen Recording");
  expect(capture.fix).toContain("Privacy_ScreenCapture");
  expect(capture.fix).toContain("launchctl kickstart -k");
  expect(blockedBy("agents", on, true, false)!.fix).toContain("Privacy_Accessibility");
});

test("a capture's rows come out packed BGRA, whatever their stride and byte order", () => {
  // Two pixels a row, rows padded to 12 bytes.
  const rows = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 0, 0, 0, 0, 9, 10, 11, 12, 13, 14, 15, 16, 0, 0, 0, 0]);
  expect([...packed(rows, 2, 2, 12, true)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  // ARGB in memory: each pixel's bytes reversed.
  expect([...packed(rows, 2, 2, 12, false)]).toEqual([4, 3, 2, 1, 8, 7, 6, 5, 12, 11, 10, 9, 16, 15, 14, 13]);
  const tight = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const out = packed(tight, 1, 2, 4, true);
  expect([...out]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  expect(out.buffer).not.toBe(tight.buffer);
});

test("keys go by their Mac keycodes", () => {
  expect(ofSym(0x61)).toEqual({ code: 0x00, shift: false }); // a
  expect(ofSym(0x41)).toEqual({ code: 0x00, shift: true }); // A
  expect(ofSym(0x40)).toEqual({ code: 0x13, shift: true }); // @
  expect(ofSym(0xff0d)).toEqual({ code: 0x24, shift: false }); // Return
  expect(ofSym(0xff08)).toEqual({ code: 0x33, shift: false }); // BackSpace is the Mac's Delete
  expect(ofSym(0xffbe)).toEqual({ code: 0x7a, shift: false }); // F1
  expect(ofSym(0xffeb)).toEqual({ modifier: 0x37, flag: COMMAND });
  expect(ofSym(0xffe9)).toEqual({ modifier: 0x3a, flag: OPTION });
  expect(ofSym(0xe9)).toEqual({ text: "é" });
  expect(ofSym(0x0100_4e2d)).toEqual({ text: "中" });
  expect(ofSym(0xff67)).toEqual({ text: "" }); // Menu: nothing to press
  expect(parseChord("cmd+s")).toEqual([0xffeb, 0x73]);
  expect(parseChord("command+option+Escape")).toEqual([0xffeb, 0xffe9, 0xff1b]);
});

test("agent-desktop's commands are checked before they run", () => {
  expect(split(`snapshot --app "Visual Studio Code" -i 'a b' c\\ d`)).toEqual(["snapshot", "--app", "Visual Studio Code", "-i", "a b", "c d"]);
  expect(() => split("type 'open")).toThrow("doesn't close");
  const snapshot = command("snapshot --app Finder -i");
  expect(snapshot.observing && !snapshot.cdp).toBe(true);
  expect(command("click @s8f3k2p9:e12").observing).toBe(false);
  expect(command("permissions --request").observing).toBe(false);
  expect(command("permissions").observing).toBe(true);
  expect(command("launch Slack --cdp").cdp).toBe(true);
  expect(() => command("--headed click @e1")).toThrow("command first");
  expect(() => command("launch Slack --cdp -- --remote-debugging-address=0.0.0.0")).toThrow("loopback");
  expect(() => command(`batch '[{"command":"launch","cdp":0}]'`)).toThrow("not in a batch");
  expect(() => command("")).toThrow("needs its arguments");
  const launched = `{"version":"2.6","ok":true,"command":"launch","data":{"app":"Slack","pid":4242,
    "cdp":{"port":9333,"http_endpoint":"http://127.0.0.1:9333","websocket_url":"ws://127.0.0.1:9333/x"}}}`;
  expect(launchedPid(launched)).toBe(4242);
  expect(launchedPid(`{"ok":true,"data":{"pid":7}}`)).toBeUndefined();
  const long = "x".repeat(OUTPUT_CHARS + 10);
  expect(answer(long, "", 0)).toContain("[cut at");
  expect(answer("", "bad ref", 1)).toBe("bad ref");
  expect(answer("", "", 0)).toBe("agent-desktop printed nothing.");
  expect(COMMAND_TIMEOUT).toBeLessThan(45_000);
  expect(answer("", "", undefined)).toContain("stopped after 40 s");
});

const call = (action: string, text?: string): DesktopCall => ({ action, ...(text ? { text } : {}) });

test("only reading actions observe", () => {
  expect(observes(call("screenshot"))).toBe(true);
  expect(observes(call("cursor_position"))).toBe(true);
  expect(observes(call("agent_desktop", "snapshot -i"))).toBe(true);
  expect(observes(call("agent_desktop", "click @e1"))).toBe(false);
  expect(observes(call("left_click"))).toBe(false);
  expect(observes(call("type", "hi"))).toBe(false);
  expect(observes(call("agent_desktop", "launch Slack --cdp"))).toBe(false);
});

test("agent-desktop's archive is checked by digest before it is unpacked", async () => {
  const home = scratch();
  const fake = (async () => new Response("not it")) as unknown as typeof fetch;
  await expect(install(home, fake, "arm64")).rejects.toThrow("is not the pinned one");
});

/** A Mac screen that keeps what it was asked to do. */
class FakeScreen implements Screen {
  readonly did: string[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  size = (): [number, number] => [4, 4];
  changed = () => true;
  grabRaw = async (): Promise<Raw> => ({ data: new Uint8Array(64), width: 4, height: 4 });
  encode = (raw: Raw) => jpeg(raw.data, raw.width, raw.height);
  grab = async () => ({ jpeg: await this.encode(await this.grabRaw()), width: 4, height: 4 });
  sync = async () => {};
  moveTo = async (x: number, y: number) => void this.did.push(`move ${x},${y}`);
  button = async () => {};
  click = async (x: number, y: number, button: number, count: number) => void this.did.push(`click ${x},${y} ${button}x${count}`);
  drag = async () => {};
  scroll = async () => {};
  pointer = async (): Promise<[number, number]> => [3, 4];
  keySym = async () => {};
  chord = async (c: string) => void this.did.push(`key ${c}`);
  typeText = async (t: string) => void this.did.push(`type ${t}`);
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }
  close() {}
}

test("one session holds the Mac's screen, others observe, and a person takes it", async () => {
  const t = testNode("mac");
  cleanups.push(t.done);
  const reports: Record<string, unknown>[] = [];
  t.link.answer = async (op, args) => {
    if (op === "browser_session") reports.push(args);
    if (op === "browser_recording_part") return { bytes: Number(args.offset) + Buffer.from(String(args.dataB64), "base64").length };
    return {};
  };
  const d = desktops(t.node, new Desktops(t.node, { enabled: false }, { enabled: true }));
  cleanups.push(() => d.shutdown());
  let gate: { message: string } | undefined;
  d.macGate = () => gate;
  const screen = new FakeScreen();
  const open = (thread: string, purpose: string) => d.openMac(thread, "/work/app", purpose, screen, new Error("not on a Mac"));

  const first = await open("th-a", "Check the export dialog");
  expect(first.desktop).toBe("mac");
  expect(first.heldBy).toBeUndefined();
  const second = await open("th-b", "Read the settings");
  expect(String(second.heldBy)).toContain("Check the export dialog");
  expect(d.live("th-b")).toEqual({ id: String(second.sessionId), kind: "mac" });
  expect(macScreen(t.node).heldBy()).toContain("Check the export dialog");

  // The observer reads the screen, and agent-desktop's reading commands get past the lease.
  expect((await d.act("th-b", call("screenshot"))).jpegB64).toBeString();
  await expect(d.act("th-b", call("agent_desktop", "snapshot -i"))).rejects.toThrow("isn't installed");
  // Acting is the holder's.
  const refused = d.act("th-b", call("left_click"));
  await expect(refused).rejects.toThrow("someone else's");
  await expect(d.act("th-b", call("left_click"))).rejects.toThrow("Check the export dialog");
  await d.act("th-a", call("left_click"));
  expect(screen.did).toEqual(["click 3,4 1x1"]);

  // A person takes the observer's session over: the lease is theirs, and the agent that held it only observes.
  d.control({ sessionId: String(second.sessionId), control: "human", by: "Ana" });
  const a = d.session("th-a")!;
  const b = d.session("th-b")!;
  expect(a.observing() && !b.observing()).toBe(true);
  await expect(d.act("th-a", call("type", "hi"))).rejects.toThrow("a person has taken it over");

  // The person's session ends: the lease is free, and the next action takes it, unless the screen locked meanwhile.
  await d.sessionEnd("th-b");
  gate = { message: "the Mac's screen is locked" };
  await expect(d.act("th-a", call("type", "hi"))).rejects.toThrow("locked");
  gate = undefined;
  await d.act("th-a", call("type", "hi"));
  expect(a.observing()).toBe(false);
  expect(screen.did.at(-1)).toBe("type hi");
  expect(a.steps.map((s) => s.tool)).toEqual(expect.arrayContaining(["lease_lost", "lease_taken"]));
  const ended = await d.sessionEnd("th-a");
  expect(ended.kind).toBe("mac");
  expect(d.heldBy()).toBeUndefined();
  expect(reports.some((r) => r.kind === "mac" && r.state === "uploading")).toBe(true);
  for (let i = 0; i < 200 && !reports.some((r) => r.kind === "mac" && r.state === "recorded"); i++) await Bun.sleep(10);
  expect(reports.some((r) => r.kind === "mac" && r.state === "recorded" && (r.files as unknown[]).length > 0)).toBe(true);
});

test("a Mac screen start off a Mac, or with nothing in the way checked, says why", async () => {
  const t = testNode("devbox", { mac: { enabled: true } });
  cleanups.push(t.done);
  const d = desktops(t.node, new Desktops(t.node, { enabled: false }));
  cleanups.push(() => d.shutdown());
  if (process.platform !== "darwin") {
    await expect(d.macStart("t", "/w", "x")).rejects.toThrow("lends no Mac screen");
    expect(macScreen(t.node).enabled).toBe(false);
    expect(macScreen(t.node).blocked()?.message).toBe("the Mac screen is a Mac's own");
  }
});

test("a Mac session's agent-desktop runs in its own home, and the app it launched with --cdp closes with it", async () => {
  const dir = scratch();
  const bin = join(dir, "agent-desktop");
  // A stand-in: says where it ran, and for `launch --cdp` starts an app and answers its pid.
  writeFileSync(
    bin,
    `#!/bin/sh
if [ "$1" = launch ]; then sleep 30 >/dev/null 2>&1 & echo "{\\"ok\\":true,\\"data\\":{\\"pid\\":$!,\\"cdp\\":{\\"port\\":9333}}}"; exit 0; fi
echo "home=$AGENT_DESKTOP_HOME args=$*"
`,
  );
  chmodSync(bin, 0o755);
  const lent = new MacLent(join(dir, "session"), bin);
  expect(await lent.agentDesktop("snapshot --app Finder -i")).toBe(`home=${join(dir, "session", "agent-desktop")} args=snapshot --app Finder -i`);
  const launched = JSON.parse(await lent.agentDesktop("launch Slack --cdp")) as { data: { pid: number } };
  const pid = launched.data.pid;
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  expect(alive()).toBe(true);
  const started = await lent.launch("echo started; exit 2");
  expect(started.exited).toEqual({ code: 2, output: "started" });
  await lent.drop();
  for (let i = 0; i < 100 && alive(); i++) await Bun.sleep(20);
  // The pid is a zombie of the shell's until reaped by init: gone from ps, or no longer `sleep`.
  const stat = existsSync(`/proc/${pid}/stat`) ? readFileSync(`/proc/${pid}/stat`, "utf8") : "";
  expect(stat === "" || stat.includes(") Z")).toBe(true);
  expect(existsSync(join(dir, "session"))).toBe(false);
});
