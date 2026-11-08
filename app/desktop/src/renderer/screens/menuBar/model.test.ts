import { describe, expect, it } from "vitest";
import type { MacCheck } from "../../../shared/contracts";
import type { MacMenuBarRead } from "../../../shared/macMenuBar";
import { HUB_UPDATE_WHERE } from "../../../shared/macSetup";
import { DISK_COMMAND, gb, healthRows, menuBarView, screenView, since, type HubInput, type ScreenInput } from "./model";

const NOW = 1_800_000_000_000;
const STOREFRONT = "dcffccea-c5a7-40a6-940d-7f70239ffa22";
const ok = (id: string, message = `${id} is fine.`): MacCheck => ({ id, state: "ok", message });
const GREEN = ["standard_user", "developer", "xcode", "ios_runtime", "accessibility", "screen_recording", "gui_session", "keep_awake"].map((id) => ok(id));

const read = (over: Partial<MacMenuBarRead> = {}, checks: MacCheck[] = [...GREEN, ok("tools", "Node.js 22.12.0, agent-device 0.11.2 and agent-desktop 0.4.0 are in. CocoaPods 1.16.2.")]): MacMenuBarRead => ({
  found: { hubUrl: "http://devbox.example.ts.net:4790", hubName: "devbox", machineId: "mac", existing: true, here: { kind: "node", machineId: "mac", hub: "http://devbox.example.ts.net:4790" } },
  hubId: "h1",
  health: { health: { user: "ada", checks }, writtenAt: NOW - 5_000, checkedAt: NOW - 20_000, now: NOW, hubAnswers: true, hubBehind: null, macBehind: null },
  activity: { simulators: [], jobs: [] },
  disk: { freeBytes: 182e9, totalBytes: 994e9 },
  macBehind: null,
  ...over,
});

const screen = (over: Partial<ScreenInput> = {}): ScreenInput => ({
  id: "B7c1",
  project: { machineId: "devbox", projectId: STOREFRONT },
  projectTitle: "storefront",
  who: "Write locale tests",
  person: false,
  state: "running",
  ...over,
});
const hub = (over: Partial<HubInput> = {}): HubInput => ({
  screen: null,
  agents: new Map([
    ["T12", "Write locale tests"],
    ["T10", "Test export resume"],
  ]),
  projects: new Map([[STOREFRONT, "storefront"]]),
  ...over,
});

describe("what agents do on the Mac", () => {
  it("names each simulator's and build's agent and project from the hub, with how long", () => {
    const view = menuBarView(
      read({
        activity: {
          simulators: [{ agent: "T12", projectId: STOREFRONT, device: "iPhone 17 Pro", sinceMs: NOW - 6 * 60_000 }],
          jobs: [{ agent: "T10", projectId: STOREFRONT, job: 3, command: "xcodebuild test -scheme Storefront", startedMs: NOW - 2 * 60_000 - 40_000 }],
        },
      }),
      hub(),
      NOW,
    );
    expect(view.simulators).toEqual([{ key: "T12/iPhone 17 Pro", title: "iPhone 17 Pro", who: "Write locale tests · storefront", since: "6 min" }]);
    expect(view.builds).toEqual([{ key: "T10/3", title: "xcodebuild test -scheme Storefront", who: "Test export resume · storefront", since: "2 min", mono: true }]);
  });

  it("says the agent's id where the hub doesn't name it, or this app isn't signed in there", () => {
    const activity = { simulators: [{ agent: "T99", projectId: "p9", device: "iPhone 17", sinceMs: NOW }], jobs: [] };
    expect(menuBarView(read({ activity }), hub(), NOW).simulators[0]?.who).toBe("Agent T99");
    expect(menuBarView(read({ activity }), null, NOW).simulators[0]?.who).toBe("Agent T99");
    // An older node writes no activity: nothing runs, as far as the popover can say.
    expect(menuBarView(read({ activity: null }), hub(), NOW).builds).toEqual([]);
  });

  it("says who has the Mac's screen, and offers Take over, Hand back or Watch", () => {
    expect(screenView(read(), hub())).toEqual({ kind: "free" });
    expect(screenView(read(), null)).toEqual({ kind: "unknown", hubName: "devbox" });
    expect(screenView(read(), hub({ screen: screen() }))).toMatchObject({ kind: "held", line: "Write locale tests has it · storefront", action: "takeOver", tone: "quiet" });
    expect(screenView(read(), hub({ screen: screen({ state: "asking", asks: "the sign-in sends a code to a phone" }) }))).toMatchObject({
      line: "Write locale tests asks you to take over: the sign-in sends a code to a phone · storefront",
      action: "takeOver",
      tone: "warn",
    });
    expect(screenView(read(), hub({ screen: screen({ state: "yours" }) }))).toMatchObject({ line: "You have it, from Write locale tests · storefront", action: "handBack", tone: "ok" });
    expect(screenView(read(), hub({ screen: screen({ state: "handingBack" }) }))).toMatchObject({ action: null });
    expect(screenView(read(), hub({ screen: screen({ who: "Sam", person: true, state: "yours" }) }))).toMatchObject({ line: "Sam has it · storefront", action: "open" });
  });

  it("says how long in minutes, then hours", () => {
    expect([since(20_000), since(6 * 60_000), since(60 * 60_000), since(72 * 60_000)]).toEqual(["now", "6 min", "1 h", "1 h 12 min"]);
    expect([gb(182e9), gb(9.4e9)]).toEqual(["182 GB", "9.4 GB"]);
  });
});

describe("the Mac's health", () => {
  const words = (rows: ReturnType<typeof healthRows>) => rows.map((r) => [r.id, r.tone, r.word]);

  it("is five rows, each a word, while all is well", () => {
    expect(words(healthRows(read(), NOW))).toEqual([
      ["node", "ok", "Running"],
      ["permissions", "ok", "Allowed"],
      ["xcode", "ok", "Ready"],
      ["cocoapods", "ok", "1.16.2"],
      ["disk", "ok", "182 GB free"],
    ]);
    expect(healthRows(read(), NOW).every((r) => r.fix === undefined && r.detail === undefined)).toBe(true);
  });

  it("offers Restart for a node that stopped writing its checks, and says what to check for a hub it can't reach", () => {
    const stale = read({ health: { ...read().health, writtenAt: NOW - 200_000, checkedAt: NOW - 200_000 } });
    expect(healthRows(stale, NOW)[0]).toMatchObject({ id: "node", tone: "fail", word: "Not running", fix: { kind: "restart" } });
    const none = read({ health: { ...read().health, health: null, writtenAt: null, checkedAt: null } });
    expect(healthRows(none, NOW)[0]?.fix).toEqual({ kind: "restart" });
    const away = read({ health: { ...read().health, hubAnswers: false } });
    expect(healthRows(away, NOW)[0]).toMatchObject({ word: "Can't reach devbox", fix: { kind: "say", text: "Check that Tailscale is connected on this Mac and that devbox is up." } });
  });

  it("has the node ask for a grant that is off, a lost one too", () => {
    const lost: MacCheck = { id: "screen_recording", state: "fail", message: "macOS stopped counting fleetd's Screen Recording with the update.", fix: "turn fleetd off and on again", command: "fleetd node grants --ask screen_recording" };
    const rows = healthRows(read({}, [...GREEN.filter((c) => c.id !== "screen_recording"), lost]), NOW);
    expect(rows[1]).toEqual({ id: "permissions", title: "Permissions", tone: "fail", word: "Screen Recording off", detail: lost.message, fix: { kind: "grant", pane: "screen_recording" } });
    const both = healthRows(read({}, [...GREEN.filter((c) => c.id !== "screen_recording" && c.id !== "accessibility"), { ...lost, id: "accessibility" }, lost]), NOW);
    expect(both[1]).toMatchObject({ word: "Both off", fix: { kind: "grant", pane: "accessibility" } });
  });

  it("opens the App Store for a missing Xcode, gives the command that selects another, and the runtime's own words once Xcode is green", () => {
    const missing: MacCheck = { id: "xcode", state: "warn", message: "Xcode isn't installed.", fix: "Install Xcode from the App Store", command: 'open "macappstore://apps.apple.com/app/id497799835"' };
    expect(healthRows(read({}, [...GREEN.filter((c) => c.id !== "xcode"), missing]), NOW)[2]).toMatchObject({ tone: "warn", word: "Not ready", detail: "Xcode isn't installed.", fix: { kind: "open", pane: "app_store" } });
    const select: MacCheck = { id: "xcode", state: "warn", message: "Xcode-beta.app isn't selected.", fix: "In your own (admin) account's Terminal", command: "sudo xcode-select -s /Applications/Xcode-beta.app/Contents/Developer" };
    expect(healthRows(read({}, [...GREEN.filter((c) => c.id !== "xcode"), select]), NOW)[2]?.fix).toEqual({ kind: "command", where: "In your own (admin) account's Terminal", command: select.command });
    const runtime: MacCheck = { id: "ios_runtime", state: "fail", message: "No iOS runtime is installed.", fix: "Install one in Xcode › Settings › Components" };
    expect(healthRows(read({}, [...GREEN.filter((c) => c.id !== "ios_runtime"), runtime]), NOW)[2]).toMatchObject({ title: "Xcode", detail: runtime.message, fix: { kind: "say", text: runtime.fix } });
  });

  it("gives the command that installs CocoaPods, and says the tools are installing while they are", () => {
    const pods: MacCheck = { id: "tools", state: "warn", message: "CocoaPods isn't installed.", fix: "In your own (admin) account's Terminal", command: "/opt/homebrew/bin/brew install cocoapods" };
    expect(healthRows(read({}, [...GREEN, pods]), NOW)[3]).toMatchObject({ id: "cocoapods", word: "Not ready", fix: { kind: "command", command: pods.command } });
    expect(healthRows(read({}, [...GREEN, { id: "tools", state: "unknown", message: "Installing the pinned tools." }]), NOW)[3]).toMatchObject({ tone: "quiet", word: "Installing…" });
  });

  it("warns on a disk filling up and fails on a full one, with the command that frees the most", () => {
    expect(healthRows(read({ disk: { freeBytes: 24e9, totalBytes: 494e9 } }), NOW)[4]).toMatchObject({ tone: "warn", word: "24 GB free", fix: { kind: "command", command: DISK_COMMAND } });
    expect(healthRows(read({ disk: { freeBytes: 9.4e9, totalBytes: 494e9 } }), NOW)[4]).toMatchObject({ tone: "fail", word: "9.4 GB free" });
    expect(healthRows(read({ disk: null }), NOW)[4]).toMatchObject({ tone: "quiet", word: "Unknown" });
  });

  it("shows any other setup check only while it isn't green", () => {
    const away: MacCheck = { id: "gui_session", state: "fail", message: "Nobody is logged in at the Mac's screen.", fix: "Log in as ada at the Mac" };
    const rows = healthRows(read({}, [...GREEN.filter((c) => c.id !== "gui_session"), away]), NOW);
    expect(rows.at(-1)).toMatchObject({ id: "gui_session", title: "Login on screen", tone: "fail", fix: { kind: "say", text: away.fix } });
    expect(healthRows(read(), NOW).map((r) => r.id)).not.toContain("gui_session");
  });
});

describe("Update", () => {
  it("shows only while this Mac is behind its hub: an admin's button, else who can and where", () => {
    expect(menuBarView(read(), hub(), NOW).update).toBeNull();
    const behind = (who: "admin" | "member" | "unknown") => menuBarView(read({ macBehind: { macVersion: "0.9.0", hubVersion: "0.9.2", who } }), hub(), NOW).update;
    expect(behind("admin")).toEqual({ line: "This Mac runs fleetd 0.9.0; devbox runs 0.9.2. Update brings every machine level with the hub.", admin: true });
    expect(behind("member")).toMatchObject({ admin: false, where: `Ask an admin of devbox: ${HUB_UPDATE_WHERE}` });
    expect(behind("unknown")).toMatchObject({ admin: false, where: HUB_UPDATE_WHERE });
  });
});
