// The New screen picker's model: which machines can host each kind, a Navi's browser only on its own machine, the
// machine it starts on, and each machine's slots in words, a full one offering to wait.
import { describe, expect, it } from "vitest";
import type { BrowserSession, MachineRolesEntry, PrRow } from "../../../shared/contracts";
import { adminNames, askLine, canOpen, fixLabel, fixReveal, hostsFor, idleFor, idleWords, newScreenOf, openingLine, openWord, pickHost, prChoices, slotLine, startingLine, takesBuild, whyOff } from "./pickScreen";

const machine = (machineId: string, ready: readonly string[], more: Partial<MachineRolesEntry> = {}): MachineRolesEntry => ({
  machineId,
  name: machineId,
  online: true,
  roles: ["agents", "sessions"],
  maxSessions: 2,
  maxSessionsWhy: "set",
  sessionsLive: 0,
  hostsOthers: true,
  hosts: ["browser", "android", "ios", "desktop"].map((host) => ({ host, ready: ready.includes(host), detail: "as tested" })),
  ...more,
});

const MACHINES = [
  machine("devbox", ["browser", "desktop", "android"]),
  machine("mac", ["browser", "ios"], { sessionsLive: 2 }),
  machine("lab", ["browser"], { online: false }),
  machine("agents-only", ["browser", "ios"], { roles: ["agents"] }),
  machine("older", ["browser"], { hostsOthers: false }),
];

describe("hostsFor", () => {
  it("lists only machines that can host the kind, online first", () => {
    expect(hostsFor(MACHINES, "browser").map((h) => h.machineId)).toEqual(["devbox", "mac", "lab"]);
    expect(hostsFor(MACHINES, "ios").map((h) => h.machineId)).toEqual(["mac"]);
    expect(hostsFor(MACHINES, "linux_desktop").map((h) => h.machineId)).toEqual(["devbox"]);
    expect(canOpen(MACHINES, "android")).toBe(true);
    expect(canOpen([MACHINES[1] as MachineRolesEntry], "android")).toBe(false);
  });

  it("keeps a Navi's browser on its own machine, and its devices anywhere", () => {
    expect(hostsFor(MACHINES, "browser", "mac").map((h) => h.machineId)).toEqual(["mac"]);
    expect(hostsFor(MACHINES, "linux_desktop", "mac").map((h) => h.machineId)).toEqual(["devbox"]);
  });
});

describe("a machine's slots", () => {
  it("starts on the picked machine, else the first online one with a free slot", () => {
    const hosts = hostsFor(MACHINES, "browser");
    expect(pickHost(hosts, null)?.machineId).toBe("devbox");
    expect(pickHost(hosts, "mac")?.machineId).toBe("mac");
    expect(pickHost(hosts, "lab")?.machineId).toBe("devbox");
  });

  it("says a full machine is full and offers to wait", () => {
    expect(hostsFor(MACHINES, "browser").map(slotLine)).toEqual(["0 of 2 screens in use", "Full: 2 of 2 screens in use. You can wait for the next one.", "Offline"]);
    const [devbox, mac] = hostsFor(MACHINES, "browser");
    expect(openWord(devbox)).toBe("Open screen");
    expect(openWord(mac)).toBe("Wait for a slot");
  });
});

describe("prChoices", () => {
  const row = (number: number, state: string) => ({ repo: "acme/app", number, title: `PR ${String(number)}`, state }) as PrRow;
  it("offers open and draft PRs, as listed, for phone screens only", () => {
    expect(prChoices([row(3, "open"), row(2, "merged"), row(1, "draft")]).map((c) => [c.value, c.label])).toEqual([
      ["acme/app#3", "#3 PR 3"],
      ["acme/app#1", "#1 PR 1"],
    ]);
    expect(["browser", "ios", "android", "linux_desktop"].filter((k) => takesBuild(k as never))).toEqual(["ios", "android"]);
  });
});

describe("openingLine", () => {
  it("says where an open with a build is", () => {
    expect(openingLine("starting", 12, "mac")).toBe("Reading #12’s build and starting the screen on mac…");
    expect(openingLine("installing", 12, "mac")).toBe("Installing #12’s build on mac…");
    expect(openingLine(undefined, 12, "mac")).toBe("Handing it to you…");
  });
});

describe("startingLine", () => {
  it("names what is starting", () => {
    expect(startingLine("browser")).toBe("Starting the browser…");
    expect(startingLine("ios")).toBe("Starting the simulator…");
    expect(startingLine("android")).toBe("Starting the emulator…");
    expect(startingLine("linux_desktop")).toBe("Starting the desktop…");
  });
});

describe("newScreenOf", () => {
  const row = (sessionId: string, more: Partial<BrowserSession> = {}): BrowserSession => ({
    sessionId,
    control: "human",
    projectRef: { machineId: "devbox", projectId: "p" },
    purpose: "Your screen",
    startedAt: "2026-10-31T11:00:10.000Z",
    state: "live",
    threadId: "t",
    openedBy: { personId: "u1", name: "Sam" },
    ...more,
  });

  it("finds the person's new live screen of the kind, one the list didn't have", () => {
    const rows = [row("B3"), row("B2", { kind: "android" }), row("B1")];
    expect(newScreenOf(rows, "browser", new Set(["B1"]))?.sessionId).toBe("B3");
    expect(newScreenOf(rows, "android", new Set(["B1"]))?.sessionId).toBe("B2");
    expect(newScreenOf(rows, "browser", new Set(["B1", "B3"]))).toBeUndefined();
  });

  it("skips an agent's screen and one that has ended", () => {
    const { openedBy: _person, ...agents } = row("B3");
    expect(newScreenOf([agents, row("B2", { state: "uploading" })], "browser", new Set())).toBeUndefined();
  });
});

/** A reason the test expects there to be. */
const must = <T,>(x: T | null | undefined): T => {
  if (x === null || x === undefined) throw new Error("expected a reason");
  return x;
};

describe("why a kind can't open", () => {
  /** A machine whose node says, for each kind, what it can't host and why. */
  const off = (machineId: string, offs: Partial<Record<string, string>>, more: Partial<MachineRolesEntry> = {}): MachineRolesEntry => ({
    ...machine(machineId, []),
    screenSettings: true,
    hosts: ["browser", "android", "ios", "desktop"].map((host) => {
      const why = offs[host];
      return why === undefined ? { host, ready: true, detail: "ready", on: true } : { host, ready: false, detail: `${host} ${why} on the node`, off: why, on: why !== "off" };
    }),
    ...more,
  });

  it("says nothing of a kind a machine can host", () => {
    expect(whyOff([off("devbox", {})], "android")).toBeNull();
  });

  it("offers an admin's Turn on where it is only switched off, on that machine", () => {
    const reason = whyOff([off("devbox", { android: "off" }), off("lab", { android: "missing" })], "android");
    expect(reason).toEqual({ why: "Android emulators are turned off on devbox.", short: "Turned off", fix: "turn_on", machine: { machineId: "devbox", name: "devbox" } });
    expect(fixLabel("turn_on")).toBe("Turn on");
    expect(askLine(must(reason), "android", ["Ana"])).toBe("Ask Ana to turn them on in Settings › Hub › Machines › Screens.");
  });

  it("sends an older node's switch to an update, since the hub can't reach it", () => {
    const reason = whyOff([off("devbox", { linux_desktop: "off", desktop: "off" }, { screenSettings: false })], "linux_desktop");
    expect(reason?.fix).toBe("update");
    expect(reason?.why).toBe("Linux desktops are turned off on devbox, and its fleetd is too old to turn them on from here.");
    expect(fixReveal("update")).toBe("hub.updates");
    expect(askLine(must(reason), "linux_desktop", ["Ana", "Bo"])).toBe("Ask Ana or Bo to update fleetd on devbox.");
  });

  it("never calls a node restarting after an update too old", () => {
    const reason = whyOff([off("devbox", { android: "off" }, { screenSettings: undefined })], "android");
    expect(reason).toEqual({
      why: "Android emulators are turned off on devbox, and its node is restarting: turn them on once it links again.",
      short: "Turned off",
      fix: "none",
      machine: { machineId: "devbox", name: "devbox" },
    });
  });

  it("says a Mac is needed where no machine can ever run iOS", () => {
    const reason = whyOff([off("devbox", { ios: "unsupported" }), off("lab", { ios: "unsupported" })], "ios");
    expect(reason).toEqual({ why: "iOS simulators need a Mac with Xcode, and no Mac here hosts screens.", short: "Needs a Mac", fix: "add" });
    expect(askLine(must(reason), "ios", [])).toBe("Ask a hub admin to add a Mac.");
    expect(fixLabel("add")).toBe("Add machine");
  });

  it("prefers the nearest fix: a Mac installing before one that's offline, before a Linux box", () => {
    const machines = [off("devbox", { ios: "unsupported" }), off("mac-old", { ios: "off" }, { online: false }), off("mac", { ios: "installing" })];
    const reason = whyOff(machines, "ios");
    expect(reason?.why).toBe("mac is installing what iOS simulators need.");
    expect(reason?.fix).toBe("none");
    expect(askLine(must(reason), "ios", ["Ana"])).toBeNull();
    expect(fixLabel("none")).toBeNull();
    expect(whyOff(machines.slice(0, 2), "ios")).toMatchObject({ why: "mac-old is offline.", short: "Offline" });
  });

  it("says a kind turned on waits for its node's restart", () => {
    expect(whyOff([off("devbox", { android: "restarting" })], "android")?.short).toBe("Starting up");
  });

  it("gives the node's own words for what is missing or failed", () => {
    const reason = whyOff([off("devbox", { android: "missing" })], "android");
    expect(reason?.why).toBe("devbox: android missing on the node.");
    expect(reason?.short).toBe("Not set up");
    expect(whyOff([off("devbox", { android: "failed" })], "android")?.short).toBe("Setup failed");
  });

  it("names an older node and a machine whose role is agents only", () => {
    expect(whyOff([off("devbox", {}, { hosts: [] })], "browser")).toMatchObject({ fix: "update", short: "Needs an update" });
    expect(whyOff([off("devbox", {}, { roles: ["agents"] })], "browser")).toMatchObject({ why: "devbox doesn’t host screens: its role is agents only.", fix: "roles" });
    expect(whyOff([], "browser")).toMatchObject({ why: "No machine has joined this hub yet.", fix: "add" });
  });

  it("keeps a Navi's browser to its own machine's reason", () => {
    expect(whyOff([off("devbox", {}), off("home", { browser: "off" })], "browser", "home")?.why).toBe("Browser screens are turned off on home.");
  });

  it("asks the hub's owners and admins, never members or people removed", () => {
    expect(
      adminNames([
        { name: "Ana", role: "owner" },
        { name: "Bo", role: "admin" },
        { name: "Cy", role: "member" },
        { name: "Di", role: "admin", removedAt: "2026-10-01T00:00:00.000Z" },
      ]),
    ).toEqual(["Ana", "Bo"]);
  });
});

describe("when a person's screen ends", () => {
  it("says the machine's own idle timeout, and no number from a node that doesn't report one", () => {
    const m = { ...machine("devbox", ["browser"]), hosts: [{ host: "browser", ready: true, detail: "ready", idleMinutes: 45 }] };
    expect(idleWords(idleFor([m], "devbox", "browser"))).toBe("after 45 minutes idle");
    expect(idleWords(idleFor([machine("devbox", ["browser"])], "devbox", "browser"))).toBe("once it sits idle");
    expect(idleWords(idleFor([m], "mac", "browser"))).toBe("once it sits idle");
  });
});
