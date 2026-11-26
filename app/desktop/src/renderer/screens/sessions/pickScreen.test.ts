// The New screen picker's model: which machines can host each kind, a project's browser only on its own machine, the
// machine it starts on, and each machine's slots in words, a full one offering to wait.
import { describe, expect, it } from "vitest";
import type { BrowserSession, MachineRolesEntry, PrRow } from "../../../shared/contracts";
import {
  KINDS,
  adminNames,
  askLine,
  canOpen,
  fixLabel,
  fixPlace,
  hostsFor,
  idleFor,
  idleWords,
  kindLine,
  newScreenOf,
  openingLine,
  openWord,
  pickHost,
  pickModel,
  pickRuntime,
  prChoices,
  profileBusy,
  simModels,
  slotLine,
  startingLine,
  takesBuild,
  whyOff,
} from "./pickScreen";

const machine = (machineId: string, ready: readonly string[], more: Partial<MachineRolesEntry> = {}): MachineRolesEntry => ({
  machineId,
  name: machineId,
  online: true,
  roles: ["agents", "sessions"],
  maxSessions: 2,
  maxSessionsWhy: "set",
  sessionsLive: 0,
  hostsOthers: true,
  hosts: ["browser", "android", "desktop", "mac"].map((host) => ({ host, ready: ready.includes(host), detail: "as tested" })),
  ...more,
});

const MACHINES = [
  machine("devbox", ["browser", "desktop", "android"]),
  machine("mac", ["browser", "mac"], { sessionsLive: 2 }),
  machine("lab", ["browser"], { online: false }),
  machine("agents-only", ["browser", "mac"], { roles: ["agents"] }),
  machine("older", ["browser"], { hostsOthers: false }),
];

describe("hostsFor", () => {
  it("lists only machines that can host the kind, online first", () => {
    expect(hostsFor(MACHINES, "browser").map((h) => h.machineId)).toEqual(["devbox", "mac", "lab"]);
    expect(hostsFor(MACHINES, "mac").map((h) => h.machineId)).toEqual(["mac"]);
    expect(hostsFor(MACHINES, "linux_desktop").map((h) => h.machineId)).toEqual(["devbox"]);
    expect(canOpen(MACHINES, "android")).toBe(true);
    expect(canOpen([MACHINES[1] as MachineRolesEntry], "android")).toBe(false);
  });

  it("keeps a bot's browser on its own machine, and its devices anywhere", () => {
    expect(hostsFor(MACHINES, "browser", "mac").map((h) => h.machineId)).toEqual(["mac"]);
    expect(hostsFor(MACHINES, "linux_desktop", "mac").map((h) => h.machineId)).toEqual(["devbox"]);
  });
});

describe("the agents' Mac", () => {
  // An older hub or node of it still says a browser is ready there: it is offered for its own screen only.
  const studio = machine("studio", ["browser", "android", "desktop", "mac"], { roles: ["sessions"], mac: { on: true, ready: true } });

  it("hosts only its own screen", () => {
    const all = [MACHINES[0] as MachineRolesEntry, studio];
    expect(hostsFor(all, "browser").map((h) => h.machineId)).toEqual(["devbox"]);
    expect(hostsFor(all, "linux_desktop").map((h) => h.machineId)).toEqual(["devbox"]);
    expect(hostsFor(all, "mac").map((h) => h.machineId)).toEqual(["studio"]);
  });

  it("isn't why another kind can't open", () => {
    expect(whyOff([studio], "browser")).toEqual({ why: "Browser screens need a machine that hosts screens.", short: "No machine for it", fix: "add" });
    expect(whyOff([studio], "android")?.fix).toBe("add");
    expect(whyOff([studio], "mac")).toBeNull();
  });
});

describe("an iPhone (D652)", () => {
  const runtime = (v: string) => ({ id: `iOS-${v}`, name: `iOS ${v}` });
  const ipad = { id: "iPad-Pro", name: "iPad Pro 13-inch (M5)", family: "ipad", runtimes: [runtime("27.2")] };
  const duo = { id: "iPhone-Duo", name: "iPhone Duo", family: "foldable", runtimes: [{ id: "iOS-27-2-duo", name: "iOS 27.2" }] };
  const iphone = { id: "iPhone-17", name: "iPhone 17", family: "iphone", runtimes: [runtime("27.2"), runtime("26.4")] };
  const sims = { live: 2, max: 2, models: [ipad, duo, iphone] };
  const studio = machine("studio", ["mac"], {
    roles: ["sessions"],
    mac: { on: true, ready: true },
    sessionsLive: 0,
    maxSessions: 1,
    hosts: [
      { host: "mac", ready: true, detail: "as tested" },
      { host: "ios", ready: true, detail: "as tested", sims },
    ],
  });

  it("opens only on the agents' Mac, its slots the Mac's simulator budget", () => {
    // An older Mac of a person's that still says iOS is ready is no agents' Mac.
    const old = machine("old-mac", ["browser"], { hosts: [{ host: "ios", ready: true, detail: "as tested" }] });
    expect(hostsFor([MACHINES[0] as MachineRolesEntry, old, studio], "ios").map((h) => h.machineId)).toEqual(["studio"]);
    const [host] = hostsFor([studio], "ios");
    expect(host === undefined ? undefined : slotLine(host)).toBe("Full · 2 of 2 in use");
    expect(openWord(host)).toBe("Wait for a slot");
    // The Mac's own screen keeps its own slots.
    expect(hostsFor([studio], "mac").map(slotLine)).toEqual(["0 of 1 in use"]);
  });

  it("opens on a Mac that runs agents too, which lends its own simulators", () => {
    const laptop = machine("laptop", ["browser"], { sims: { max: 2 }, hosts: [{ host: "browser", ready: true, detail: "as tested" }, { host: "ios", ready: true, detail: "as tested", sims }] });
    expect(hostsFor([laptop], "ios").map(slotLine)).toEqual(["Full · 2 of 2 in use"]);
    expect(hostsFor([laptop], "browser").map((h) => h.machineId)).toEqual(["laptop"]);
  });

  it("says why without an agents' Mac, or with one too old to start them", () => {
    expect(whyOff(MACHINES, "ios")).toEqual({ why: "iPhone simulators need a Mac: one that runs agents, or one joined as the agents’ Mac.", short: "Needs a Mac", fix: "add" });
    const older = machine("studio", ["mac"], { mac: { on: true, ready: true } });
    expect(whyOff([older], "ios")).toMatchObject({ short: "Needs an update", fix: "update" });
    expect(askLine({ why: "", short: "", fix: "add" }, "ios", ["Sam"])).toBe("Ask Sam to add a Mac.");
  });

  it("lists iPhones, then foldables, then iPads, and starts on the first", () => {
    const models = simModels([studio], "studio");
    expect(models.map((m) => m.name)).toEqual(["iPhone 17", "iPhone Duo", "iPad Pro 13-inch (M5)"]);
    expect(pickModel(models, null)?.name).toBe("iPhone 17");
    expect(pickModel(models, "iPhone-Duo")?.name).toBe("iPhone Duo");
    expect(pickModel(models, "gone")?.name).toBe("iPhone 17");
    expect(simModels([studio], "devbox")).toEqual([]);
    expect(simModels([MACHINES[0] as MachineRolesEntry], "devbox")).toEqual([]);
  });

  it("starts on the model's newest OS, and keeps the one picked while the model runs it", () => {
    expect(pickRuntime(iphone, null)?.name).toBe("iOS 27.2");
    expect(pickRuntime(iphone, "iOS-26.4")?.name).toBe("iOS 26.4");
    // The Duo runs only its own: an OS picked for another model gives way to it.
    expect(pickRuntime(duo, "iOS-26.4")?.id).toBe("iOS-27-2-duo");
    expect(pickRuntime(undefined, null)).toBeUndefined();
  });

  it("says what is starting", () => {
    expect(startingLine("ios")).toBe("Starting the simulator…");
    expect(takesBuild("ios")).toBe(false);
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
    expect(hostsFor(MACHINES, "browser").map(slotLine)).toEqual(["0 of 2 in use", "Full · 2 of 2 in use", "Offline"]);
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
    expect(["browser", "android", "linux_desktop", "mac"].filter((k) => takesBuild(k as never))).toEqual(["android"]);
  });
});

describe("openingLine", () => {
  it("says where an open with a build is", () => {
    expect(openingLine("starting", 12, "mac")).toBe("Reading #12’s build and starting the screen on mac…");
    expect(openingLine("installing", 12, "mac")).toBe("Installing #12’s build on mac…");
    expect(openingLine(undefined, 12, "mac")).toBe("Handing it to you…");
  });

  it("says where an iPhone the hub starts is", () => {
    expect(openingLine("starting", undefined, "studio")).toBe("Starting the iPhone on studio…");
    expect(openingLine("waiting", undefined, "studio")).toBe("Waiting for a free simulator on studio, ahead of agents…");
    expect(openingLine("failed", undefined, "studio")).toBe("It didn’t open.");
    expect(openingLine(undefined, undefined, "studio")).toBe("Handing it to you…");
  });
});

describe("startingLine", () => {
  it("names what is starting", () => {
    expect(startingLine("browser")).toBe("Starting the browser…");
    expect(startingLine("mac")).toBe("Opening the Mac’s screen…");
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

describe("the browser tile's profile", () => {
  const row = (sessionId: string, more: Partial<BrowserSession> = {}): BrowserSession => ({
    sessionId,
    control: "agent",
    projectRef: { machineId: "devbox", projectId: "p" },
    purpose: "Lead's browser",
    startedAt: "2026-10-31T11:00:10.000Z",
    state: "live",
    threadId: "t",
    ...more,
  });
  const browser = KINDS.find((k) => k.kind === "browser");
  const android = KINDS.find((k) => k.kind === "android");
  if (browser === undefined || android === undefined) throw new Error("no browser or android kind");

  it("says saved sign-ins while the bot's profile is free", () => {
    expect(profileBusy([], "devbox")).toBe(false);
    expect(kindLine(browser, profileBusy([], "devbox"))).toBe("Saved sign-ins");
  });

  it("says a fresh profile while the lead's browser or a person's screen holds it on the bot's machine", () => {
    expect(profileBusy([row("B1")], "devbox")).toBe(true);
    expect(profileBusy([row("B1", { openedBy: { personId: "u1", name: "Sam" }, machineId: "devbox" })], "devbox")).toBe(true);
    expect(kindLine(browser, true)).toBe("Fresh profile");
    // Other kinds keep their own line.
    expect(kindLine(android, true)).toBe(android.line);
  });

  it("ignores an agent's browser, an ended one, another kind and another machine's", () => {
    expect(profileBusy([row("B1", { taskId: "T1" })], "devbox")).toBe(false);
    expect(profileBusy([row("B1", { state: "uploading" })], "devbox")).toBe(false);
    expect(profileBusy([row("B1", { kind: "android" })], "devbox")).toBe(false);
    expect(profileBusy([row("B1", { openedBy: { personId: "u1", name: "Sam" }, machineId: "mac" })], "devbox")).toBe(false);
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
    hosts: ["browser", "android", "desktop", "mac"].map((host) => {
      const why = offs[host];
      return why === undefined ? { host, ready: true, detail: "ready" } : { host, ready: false, detail: `${host} ${why} on the node`, off: why };
    }),
    ...more,
  });

  it("says nothing of a kind a machine can host", () => {
    expect(whyOff([off("devbox", {})], "android")).toBeNull();
  });

  it("offers no Turn on: a kind an older node turned off in its node.json comes on with its update", () => {
    const reason = whyOff([off("devbox", { desktop: "off" }), off("lab", { desktop: "missing" })], "linux_desktop");
    expect(reason).toEqual({ why: "Linux desktops are off on devbox until its fleetd is updated.", short: "Needs an update", fix: "update", machine: { machineId: "devbox", name: "devbox" } });
    expect(fixLabel(must(reason).fix)).toBe("Open updates");
    expect(fixPlace("update")).toEqual({ tab: "hub.updates", reveal: null });
    expect(fixPlace("roles")).toEqual({ tab: "hub.machines", reveal: "hub.roles" });
    expect(askLine(must(reason), "linux_desktop", ["Ana", "Bo"])).toBe("Ask Ana or Bo to update fleetd on devbox.");
  });

  it("says what a machine is missing in its node's words, with no switch to turn", () => {
    const reason = whyOff([off("devbox", { android: "missing" })], "android");
    expect(reason).toEqual({ why: "devbox: android missing on the node.", short: "Not set up", fix: "none", machine: { machineId: "devbox", name: "devbox" } });
  });

  it("says the agents' Mac needs a Mac joined as the agents' Mac, not a Linux machine", () => {
    const reason = whyOff([off("devbox", { mac: "unsupported" })], "mac");
    expect(reason).toEqual({ why: "The agents’ Mac screen needs a Mac joined as the agents’ Mac.", short: "Needs a Mac", fix: "add" });
    expect(askLine(must(reason), "mac", ["Ana"])).toBe("Ask Ana to add a Mac set aside for agents.");
    expect(askLine(must(reason), "android", ["Ana"])).toBe("Ask Ana to add a Linux machine.");
    expect(askLine(must(reason), "mac", [])).toBe("Ask a workspace admin to add a Mac set aside for agents.");
    expect(fixLabel("add")).toBe("Add machine");
  });

  it("offers no iOS screen: the agents' Mac is the one Apple kind", () => {
    expect(KINDS.map((k) => k.kind)).toEqual(["browser", "ios", "android", "linux_desktop", "mac"]);
    expect(KINDS.find((k) => k.kind === "mac")?.label).toBe("Agents’ Mac");
  });

  it("prefers the nearest fix: a machine installing before one that's offline, before a Mac", () => {
    const machines = [off("mac", { android: "unsupported" }), off("lab-old", { android: "off" }, { online: false }), off("lab", { android: "installing" })];
    const reason = whyOff(machines, "android");
    expect(reason?.why).toBe("lab is installing what Android emulators need.");
    expect(reason?.fix).toBe("none");
    expect(askLine(must(reason), "android", ["Ana"])).toBeNull();
    expect(fixLabel("none")).toBeNull();
    expect(whyOff(machines.slice(0, 2), "android")).toMatchObject({ why: "lab-old is offline.", short: "Offline" });
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
    expect(whyOff([], "browser")).toMatchObject({ why: "No machine has joined this workspace yet.", fix: "add" });
  });

  it("keeps a bot's browser to its own machine's reason", () => {
    expect(whyOff([off("devbox", {}), off("home", { browser: "off" })], "browser", "home")?.why).toBe("Browser screens are off on home until its fleetd is updated.");
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
