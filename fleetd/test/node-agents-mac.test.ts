// node/agents_mac: the agents' Mac's setup checks and grants, as crates/fleetd/src/node/agents_mac/tests.rs and
// grants.rs's tests have them. The Mac is a stand-in Probe: nothing here runs a Mac's command or asks macOS anything.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AgentsMac,
  agentsMac,
  heartbeat,
  isAgentsMac,
  iosConfig,
  sessionCallAllowed,
  start as startMac,
  toolOnly,
  TOOL_ONLY,
} from "../src/node/agents_mac/index.ts";
import { blocksSimulators, COMMAND_TIMEOUT, HOMEBREW_INSTALL, pane, type Pods, type Probe, type Ran, ran as ranCommand, readMac, run } from "../src/node/agents_mac/checks.ts";
import { healthFile, type MacCheckId, toolsDir } from "../src/node/agents_mac/common.ts";
import {
  answer,
  askFile,
  askNode,
  asked,
  every,
  forgets,
  type Grants,
  grantsCommand,
  line,
  lost,
  noteSeen,
  overlay,
  parse,
  parseSeen,
  request,
  restartFor,
  seen,
  seenFile,
  takeUp,
} from "../src/node/agents_mac/grants.ts";
import { grant, keepAwake as keepAwakeCheck } from "../src/node/agents_mac/checks.ts";
import { health } from "../src/node/agents_mac/common.ts";
import { installNode, type ToolsState, versions } from "../src/node/agents_mac/tools.ts";
import { inApplications, locate } from "../src/node/agents_mac/xcode.ts";
import { VERSION } from "../src/shared/version.ts";
import { tempHome } from "./helpers.ts";
import { testNode } from "./node_helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
});
const scratch = () => {
  const h = tempHome();
  cleanups.push(h.done);
  return h.dir;
};

const ran = (code: number, out: string): Ran => ({ code, out });

/** A Mac set up as the guide says; each test changes what it needs. */
class Fake implements Probe {
  runs = new Map<string, Ran>([
    ["dseditgroup -o checkmember -m agents _developer", ran(0, "yes agents is a member of _developer\n")],
    ["DevToolsSecurity -status", ran(0, "Developer mode is currently enabled.\n")],
    ["xcode-select -p", ran(0, "/Applications/Xcode.app/Contents/Developer\n")],
    ["xcodebuild -license check", ran(0, "")],
    ["xcodebuild -checkFirstLaunchStatus", ran(0, "")],
    ["xcodebuild -version", ran(0, "Xcode 26.0\nBuild version 17A324\n")],
    ["xcrun simctl list runtimes", ran(0, "== Runtimes ==\niOS 26.0 (26.0 - 23A343) - com.apple.CoreSimulator.SimRuntime.iOS-26-0\n")],
  ]);
  xcodeList = ["/Applications/Xcode.app"];
  dirs = ["/Applications/Xcode.app/Contents/Developer"];
  ax: boolean | undefined = true;
  screen: boolean | undefined = true;
  console: string | undefined = "agents";
  held: string | undefined = undefined;
  toolsState: ToolsState = { kind: "ready", versions: versions() };
  podsSeen: Pods = { pod: ran(0, "1.16.2\n"), brew: "/opt/homebrew/bin/brew", brewAt: "/opt/homebrew/bin/brew" };
  user = () => "agents";
  run = (program: string, args: string[]) => this.runs.get([program, ...args].join(" ")) ?? { out: "" };
  xcodes = () => this.xcodeList;
  isDir = (p: string) => this.dirs.includes(p);
  accessibility = () => this.ax;
  screenRecording = () => this.screen;
  consoleUser = () => this.console;
  awake = () => this.held;
  tools = () => this.toolsState;
  pods = () => this.podsSeen;
}

/** A check's state, message, and its fix with its command after it. */
function verdict(fake: Fake, id: MacCheckId): [string, string, string | undefined] {
  const c = run(fake).checks.find((c) => c.id === id)!;
  const fix = c.fix === undefined ? undefined : c.command ? `${c.fix}: ${c.command}` : c.fix;
  return [c.state, c.message, fix];
}

const ALL = ["developer", "xcode", "ios_runtime", "accessibility", "screen_recording", "gui_session", "tools", "keep_awake"];

test("a Mac set up as the guide says passes every check, in the guide's order", () => {
  const h = run(new Fake());
  expect(h.user).toBe("agents");
  expect(h.checks.map((c) => c.id)).toEqual(ALL);
  for (const c of h.checks) {
    expect([c.id, c.state]).toEqual([c.id, "ok"]);
    expect(c.fix ?? c.command).toBeUndefined();
  }
});

test("the developer check needs Developer Mode on and the group", () => {
  const off = ran(0, "Developer mode is currently disabled.\n");
  let fake = new Fake();
  fake.runs.set("DevToolsSecurity -status", off);
  let [state, message, fix] = verdict(fake, "developer");
  expect(state).toBe("fail");
  expect(message.startsWith("Developer Mode is off")).toBe(true);
  expect(fix).toBe("In your own (admin) account's Terminal: sudo DevToolsSecurity -enable");
  fake = new Fake();
  fake.runs.set("dseditgroup -o checkmember -m agents _developer", ran(0, "no agents is NOT a member of _developer\n"));
  [state, , fix] = verdict(fake, "developer");
  expect(state).toBe("fail");
  expect(fix!.endsWith(": sudo dseditgroup -o edit -a agents -t user _developer")).toBe(true);
  fake.runs.set("DevToolsSecurity -status", off);
  expect(verdict(fake, "developer")[2]!.endsWith(": sudo DevToolsSecurity -enable && sudo dseditgroup -o edit -a agents -t user _developer")).toBe(true);
  fake.runs = new Map();
  expect(verdict(fake, "developer")[0]).toBe("unknown");
});

test("a failing developer check blocks simulators, and only it", () => {
  const home = scratch();
  expect(blocksSimulators(home)).toBeUndefined();
  writeFileSync(healthFile(home), JSON.stringify(run(new Fake())));
  expect(blocksSimulators(home)).toBeUndefined();
  const fake = new Fake();
  fake.runs.set("DevToolsSecurity -status", ran(0, "Developer mode is currently disabled.\n"));
  writeFileSync(healthFile(home), JSON.stringify(run(fake)));
  expect(blocksSimulators(home)?.command).toBe("sudo DevToolsSecurity -enable");
});

test("a missing or misplaced Xcode warns with its one fix and holds up only simulators", () => {
  const xcodeVerdict = (fake: Fake) => [...verdict(fake, "xcode"), verdict(fake, "ios_runtime")[0]] as const;
  const restPasses = (fake: Fake) => run(fake).checks.filter((c) => c.id !== "xcode" && c.id !== "ios_runtime").every((c) => c.state === "ok");
  const invalid = ran(1, "xcode-select: error: invalid developer directory '/Applications/Xcode.app'\n");

  const fake = new Fake();
  fake.xcodeList = [];
  fake.dirs = [];
  fake.runs.set("xcode-select -p", invalid);
  let [state, message, fix, sim] = xcodeVerdict(fake);
  expect([state, sim]).toEqual(["warn", "warn"]);
  expect(message).toBe("Xcode isn't installed. iOS simulators and builds wait for it; everything else works.");
  expect(fix!.startsWith("Install Xcode from the App Store")).toBe(true);
  expect(fix!.endsWith('open "macappstore://apps.apple.com/app/id497799835"')).toBe(true);
  expect(restPasses(fake)).toBe(true);

  fake.xcodeList = ["/Applications/Xcode-beta.app"];
  fake.runs.set("xcode-select -p", ran(0, "/Applications/Xcode.app/Contents/Developer\n"));
  [state, message, fix, sim] = xcodeVerdict(fake);
  expect([state, sim]).toEqual(["warn", "warn"]);
  expect(message).toBe(
    "Xcode-beta.app is in /Applications, but xcode-select points at /Applications/Xcode.app/Contents/Developer, which isn't there. iOS simulators and builds wait for it; everything else works.",
  );
  expect(fix!.endsWith(": sudo xcode-select -s /Applications/Xcode-beta.app/Contents/Developer")).toBe(true);
  fake.runs.set("xcode-select -p", invalid);
  [, message, fix] = xcodeVerdict(fake);
  expect(message.includes("no Xcode is selected") && !message.includes("error")).toBe(true);
  fake.xcodeList = ["/Applications/Xcode 26.app"];
  expect(xcodeVerdict(fake)[2]!.endsWith("sudo xcode-select -s '/Applications/Xcode 26.app/Contents/Developer'")).toBe(true);

  const tools = new Fake();
  tools.runs.set("xcode-select -p", ran(0, "/Library/Developer/CommandLineTools\n"));
  tools.dirs.push("/Library/Developer/CommandLineTools");
  [state, message, fix] = xcodeVerdict(tools);
  expect(state).toBe("warn");
  expect(message.startsWith("Xcode.app is in /Applications, but only the Command Line Tools are selected.")).toBe(true);
  expect(fix!.endsWith(": sudo xcode-select -s /Applications/Xcode.app/Contents/Developer")).toBe(true);

  const licence = new Fake();
  licence.runs.set("xcodebuild -license check", ran(69, ""));
  expect(xcodeVerdict(licence)[2]!.endsWith("sudo xcodebuild -license accept && sudo xcodebuild -runFirstLaunch")).toBe(true);
  licence.runs.set("xcodebuild -license check", ran(0, ""));
  licence.runs.set("xcodebuild -checkFirstLaunchStatus", ran(69, ""));
  expect(xcodeVerdict(licence)[2]!.endsWith(": sudo xcodebuild -runFirstLaunch")).toBe(true);
  expect(restPasses(licence)).toBe(true);
  expect(verdict(new Fake(), "xcode")[1]).toBe("Xcode 26.0 at /Applications/Xcode.app/Contents/Developer, licence accepted.");
  expect(locate(undefined, [], () => false)).toEqual({ kind: "missing" });
});

test("the Xcodes in /Applications are found by name, Xcode.app first", () => {
  const dir = scratch();
  for (const name of ["Xcode-beta.app", "Xcode.app", "Xcode 26.app"]) mkdirSync(join(dir, name, "Contents/Developer"), { recursive: true });
  mkdirSync(join(dir, "Xcode-empty.app"));
  mkdirSync(join(dir, "Safari.app/Contents/Developer"), { recursive: true });
  expect(inApplications(dir)).toEqual(["Xcode.app", "Xcode 26.app", "Xcode-beta.app"].map((n) => join(dir, n)));
  expect(inApplications(join(dir, "gone"))).toEqual([]);
});

test("an unavailable runtime is no runtime; a missing grant deep links its pane", () => {
  const fake = new Fake();
  expect(verdict(fake, "ios_runtime")[1]).toBe("iOS 26.0 (26.0");
  fake.runs.set("xcrun simctl list runtimes", ran(0, "== Runtimes ==\niOS 18.0 (18.0 - 22A3354) - x (unavailable, runtime missing)\n"));
  const [state, , fix] = verdict(fake, "ios_runtime");
  expect(state).toBe("fail");
  expect(fix!.endsWith("xcodebuild -downloadPlatform iOS")).toBe(true);
  const grants = new Fake();
  grants.ax = false;
  grants.screen = undefined;
  const [g, , gfix] = verdict(grants, "accessibility");
  expect(g).toBe("fail");
  expect(gfix!.startsWith("In Terminal at the Mac")).toBe(true);
  expect(gfix!.endsWith("fleetd node grants --ask accessibility")).toBe(true);
  expect(verdict(grants, "screen_recording")[0]).toBe("unknown");
  expect(pane("screen_recording").endsWith("Privacy_ScreenCapture")).toBe(true);
});

test("a GUI session behind someone else warns; installing tools are unknown and a failed hold fails", () => {
  const fake = new Fake();
  fake.console = "ada";
  expect(verdict(fake, "gui_session")[0]).toBe("warn");
  expect(verdict(fake, "gui_session")[1].startsWith("background: ada is at the Mac's screen")).toBe(true);
  fake.console = "root";
  expect(verdict(fake, "gui_session")[1].startsWith("background: the login window")).toBe(true);
  const t = new Fake();
  t.toolsState = { kind: "installing" };
  t.held = "IOKit's power assertions are not available";
  expect(verdict(t, "tools")[0]).toBe("unknown");
  expect(verdict(t, "keep_awake")[0]).toBe("fail");
});

test("the tools check runs pod and says how to install CocoaPods", () => {
  expect(verdict(new Fake(), "tools")[1].endsWith(" CocoaPods 1.16.2.")).toBe(true);
  const fake = new Fake();
  fake.podsSeen = { ...fake.podsSeen, pod: ran(0, "WARNING: CocoaPods requires your terminal to be using UTF-8 encoding.\n1.16.2\n") };
  expect(verdict(fake, "tools")[1].endsWith(" CocoaPods 1.16.2.")).toBe(true);
  fake.podsSeen = { brew: "/opt/homebrew/bin/brew", brewAt: "/opt/homebrew/bin/brew" };
  const [state, message, fix] = verdict(fake, "tools");
  expect(state).toBe("warn");
  expect(message.endsWith("CocoaPods isn't installed, so pod install and expo prebuild --platform ios don't run; everything else works.")).toBe(true);
  expect(fix).toBe("In your own (admin) account's Terminal: /opt/homebrew/bin/brew install cocoapods");
  fake.podsSeen = { brewAt: "/usr/local/bin/brew" };
  expect(verdict(fake, "tools")[2]!.endsWith(`: ${HOMEBREW_INSTALL} && /usr/local/bin/brew install cocoapods`)).toBe(true);
  fake.podsSeen = { pod: ran(1, "\n/opt/homebrew/bin/pod: bad interpreter\n"), brewAt: "/usr/local/bin/brew" };
  expect(verdict(fake, "tools")[1]).toContain("CocoaPods doesn't run (/opt/homebrew/bin/pod: bad interpreter)");
  fake.toolsState = { kind: "failed", why: "offline" };
  expect(verdict(fake, "tools")[0]).toBe("fail");
});

test("the Mac lists no call that carries a secret, a claude or a Navi, and its tool only while it is on", () => {
  const all = ["self_update", "session_ios", "claude_accounts", "onepassword", "mcp_servers", "assistant", "order_env", "claude_login", "link_deflate"];
  expect(toolOnly(all, false)).toEqual(["agents_mac", "self_update", "session_ios", "link_deflate"]);
  expect(toolOnly(["self_update", "mac_tool"], true)).toEqual(["agents_mac", "self_update", "mac_tool"]);
  expect(toolOnly(["self_update"], true)).toEqual(["agents_mac", "self_update", "mac_tool"]);
  expect(toolOnly(["self_update", "mac_tool"], false)).toEqual(["agents_mac", "self_update"]);
  expect(sessionCallAllowed({ op: "runner_info" })).toBe(true);
  expect(sessionCallAllowed({ op: "project_remove" })).toBe(true);
  for (const op of ["project_upsert", "repo_scan", "claude_models"]) expect(sessionCallAllowed({ op })).toBe(false);
  expect(TOOL_ONLY).toContain("is a tool for agents on other machines");
});

test("only agentsMac makes the node the agents' Mac, and the Mac ignores a legacy iOS off", () => {
  expect(isAgentsMac({})).toBe(false);
  expect(isAgentsMac({ agentsMac: false })).toBe(false);
  expect(isAgentsMac({ agentsMac: true })).toBe(true);
  const off = { enabled: false, deviceType: "iPhone 17 Pro" };
  expect(iosConfig(off, true)).toEqual({ enabled: true, deviceType: "iPhone 17 Pro" });
  expect(iosConfig(undefined, true).enabled).toBe(true);
  expect(iosConfig(off, false).enabled).toBe(false);
  expect(iosConfig(undefined, false).enabled).toBeUndefined();
});

const g = (accessibility: boolean | undefined, screenRecording: boolean | undefined): Grants => ({ accessibility, screenRecording });
const [yes, no] = [true, false];

test("grants: asked often only while one is missing, and the line reads back", () => {
  expect(every(g(yes, yes))).toBe(30_000);
  expect(every(g(yes, no))).toBe(2_000);
  expect(every(undefined)).toBe(2_000);
  for (const grants of [g(yes, no), g(undefined, yes), g(no, undefined)]) expect(parse(line(grants))).toEqual(grants);
  expect(parse("accessibility maybe screen_recording yes")).toBeUndefined();
  expect(parse("")).toBeUndefined();
});

test("grants: the checks say what a fresh process has, and a lost grant says the update took it", () => {
  const h = health("ada", [grant("accessibility", true), grant("screen_recording", false), keepAwakeCheck(undefined)]);
  expect(overlay(h, { grants: g(yes, yes), lost: [] }).checks.map((c) => [c.id, c.state])).toEqual([
    ["accessibility", "ok"],
    ["screen_recording", "ok"],
    ["keep_awake", "ok"],
  ]);
  const lostOne = overlay(health("ada", [grant("accessibility", true), grant("screen_recording", true)]), {
    grants: g(yes, no),
    lost: ["screen_recording"],
  }).checks[1]!;
  expect(lostOne.state).toBe("fail");
  expect(lostOne.message).toContain("update");
  expect(lostOne.command).toContain("--ask screen_recording");
});

test("grants: on before an update and off after is lost, and stays lost until it is back", () => {
  const seenAt = (v: string, grants: Grants): [string, Grants] => [v, grants];
  expect(lost(g(yes, no), seenAt("0.4.0", g(yes, yes)), "0.4.1")).toEqual(["screen_recording"]);
  expect(lost(g(no, no), seenAt("0.4.0", g(yes, yes)), "0.4.1")).toEqual(["accessibility", "screen_recording"]);
  expect(lost(g(yes, no), seenAt("0.4.0", g(yes, no)), "0.4.1")).toEqual([]);
  expect(lost(g(yes, no), seenAt("0.4.1", g(yes, yes)), "0.4.1")).toEqual([]);
  expect(lost(g(no, no), undefined, "0.4.1")).toEqual([]);
  expect(lost(g(undefined, undefined), seenAt("0.4.0", g(yes, yes)), "0.4.1")).toEqual([]);
  expect(parseSeen(`0.4.0\n${line(g(yes, no))}`)).toEqual(["0.4.0", g(yes, no)]);
  expect(parseSeen("0.4.0")).toBeUndefined();

  const home = scratch();
  mkdirSync(toolsDir(home), { recursive: true });
  writeFileSync(seenFile(home), `0.0.0-old\n${line(g(yes, yes))}`);
  const now = g(yes, no);
  const first = lost(now, seen(home), VERSION);
  expect(first).toEqual(["screen_recording"]);
  noteSeen(home, now, first);
  expect(lost(now, seen(home), VERSION)).toEqual(first);
  noteSeen(home, g(yes, yes), []);
  expect(seen(home)).toEqual([VERSION, g(yes, yes)]);
});

test("grants: the ask names a grant, and the node takes it", () => {
  const home = scratch();
  request(home, "screen_recording");
  expect(asked(readFileSync(askFile(home), "utf8"))).toBe("screen_recording");
  expect(asked("accessibility\n")).toBe("accessibility");
  expect(asked("xcode")).toBeUndefined();
  const askedFor: MacCheckId[] = [];
  answer(home, (id) => askedFor.push(id));
  expect(askedFor).toEqual(["screen_recording"]);
  expect(existsSync(askFile(home))).toBe(false);
});

test("grants: a restart once for a grant the running node lacks, forgotten once it goes", async () => {
  const l = restartFor(g(yes, no), g(yes, yes), undefined)!;
  expect(l).toBe("accessibility yes screen_recording yes");
  expect(restartFor(g(yes, yes), g(yes, yes), l)).toBeUndefined();
  expect(restartFor(g(yes, no), g(yes, yes), l)).toBeUndefined();
  expect(restartFor(g(no, no), g(yes, no), "accessibility no screen_recording no")).toBeDefined();
  expect(restartFor(g(no, no), g(no, no), undefined)).toBeUndefined();
  expect(restartFor(g(yes, yes), g(no, yes), undefined)).toBeUndefined();
  expect(restartFor(g(undefined, undefined), g(undefined, undefined), undefined)).toBeUndefined();
  expect(forgets(g(yes, no), l)).toBe(true);
  expect(forgets(g(yes, yes), l)).toBe(false);
  expect(forgets(g(yes, no), undefined)).toBe(false);

  // Off macOS this process has no grant to read: a fresh one with Screen Recording restarts the node, once. On a Mac it
  // reads its own, and whether it restarts hangs on what the runner was granted: the restarts below are Linux's.
  if (process.platform === "darwin") return;
  const home = scratch();
  let restarts = 0;
  const found = await takeUp(home, () => g(yes, yes), () => restarts++);
  expect(found).toEqual({ grants: g(yes, yes), lost: [] });
  expect(restarts).toBe(1);
  await takeUp(home, () => g(yes, yes), () => restarts++);
  expect(restarts).toBe(1);
  // Another answer is another restart (this process holds none of them), and so is the first one again.
  await takeUp(home, () => g(yes, no), () => restarts++);
  expect(restarts).toBe(2);
  await takeUp(home, () => g(yes, yes), () => restarts++);
  expect(restarts).toBe(3);
  expect(await takeUp(home, () => undefined, () => restarts++)).toBeUndefined();
});

test("`fleetd node grants` prints this process's grants, and --ask waits for the node to ask", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const home = scratch();
  expect(await grantsCommand({ home }, (s) => out.push(s), (s) => err.push(s))).toBe(0);
  expect(out.join("")).toBe(process.platform === "darwin" ? out.join("") : "accessibility unknown screen_recording unknown\n");
  expect(await grantsCommand({ home, ask: "xcode" }, (s) => out.push(s), (s) => err.push(s))).toBe(2);
  expect(await grantsCommand({ home, ask: "accessibility", wait: "soon" }, (s) => out.push(s), (s) => err.push(s))).toBe(2);
  // No node running: nobody takes the ask.
  expect(await grantsCommand({ home, ask: "accessibility", wait: "0" }, (s) => out.push(s), (s) => err.push(s))).toBe(1);
  expect(err.at(-1)).toContain("the node didn't ask macOS for Accessibility: it isn't running");
  // A node that takes it within the wait.
  const asking = askNode(home, "screen_recording", 5_000);
  await Bun.sleep(50);
  answer(home, () => {});
  expect(await asking).toBe(true);
});

test("the Mac's pinned Node.js is checked by digest before it is unpacked", async () => {
  const home = scratch();
  const fetcher = (async () => new Response("not node")) as unknown as typeof fetch;
  await expect(installNode(home, fetcher, "arm64")).rejects.toThrow("is not the pinned one");
  const down = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
  await expect(installNode(home, down, "arm64")).rejects.toThrow("cannot download Node.js: HTTP status 503");
});

test("an agents' Mac's node checks its setup and puts it in each heartbeat; any other node has none", async () => {
  const plain = testNode("devbox");
  cleanups.push(plain.done);
  expect(startMac(plain.node)).toBeUndefined();
  const t = testNode("mac", { agentsMac: true });
  cleanups.push(t.done);
  const mac = agentsMac(t.node)!;
  expect(mac.tool).toBe(process.platform === "darwin");
  // Its loop isn't started here (its commands are a Mac's): the heartbeat carries what it last published.
  mac.publish(run(new Fake()));
  heartbeat(t.node, mac);
  const hb = { load: { cpus: 1, load1: 0 }, steps: [], busy: { threads: 0, screens: 0, uploads: 0, hosted: 0 } };
  await t.node.area("hb").fill(hb as never);
  expect((hb.load as { mac?: { user: string } }).mac?.user).toBe("agents");
  expect(JSON.parse(readFileSync(healthFile(t.node.home), "utf8")).checks.length).toBe(8);
});

test("the agents' Mac's hello says so, and lists its tool only while it is on", () => {
  const t = testNode("mac", { agentsMac: true });
  cleanups.push(t.done);
  // Its loop isn't started here (its commands are a Mac's).
  const mac = new AgentsMac(t.node.home, true);
  mac.start = async () => {};
  startMac(t.node, mac);
  expect(t.node.area("caps").list()).toEqual(["agents_mac", "mac_tool"]);
});

test("the Mac's commands run off the event loop and are stopped when they hang", async () => {
  const stopped = await ranCommand("sleep", ["5"], undefined, 100);
  expect(stopped.code).toBeUndefined();
  expect(stopped.out).toContain("stopped after");
  expect((await ranCommand("fleetd-no-such-program", [])).code).toBeUndefined();
  // Off a Mac its commands are missing; on one (mac.yml) they run, xcodebuild's among them: either way the checks
  // read, and the loop ticks on meanwhile.
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  const h = run(await readMac(undefined, { kind: "installing" }));
  clearInterval(timer);
  expect(h.checks.map((c) => c.id)).toEqual(ALL);
  expect(ticks).toBeGreaterThan(0);
  // readMac's three rounds of commands, each within its own limit.
}, 3 * COMMAND_TIMEOUT + 10_000);

test("`fleetd node grants` is the CLI's", async () => {
  const home = scratch();
  const cli = (args: string[]) =>
    Bun.spawn([process.execPath, join(import.meta.dir, "../src/main.ts"), "node", "grants", ...args], {
      env: { ...process.env, FLEETD_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
  const plain = cli([]);
  const [out, code] = await Promise.all([new Response(plain.stdout).text(), plain.exited]);
  expect(code).toBe(0);
  expect(parse(out.trim())).toBeDefined();
  const asking = cli(["--ask", "accessibility", "--wait", "0", "--home", home]);
  const [err, failed] = await Promise.all([new Response(asking.stderr).text(), asking.exited]);
  expect(failed).toBe(1);
  expect(err).toContain("the node didn't ask macOS for Accessibility");
});
