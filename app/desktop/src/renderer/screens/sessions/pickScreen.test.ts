// The New screen picker's model: which machines can host each kind, a Navi's browser only on its own machine, the
// machine it starts on, and each machine's slots in words, a full one offering to wait.
import { describe, expect, it } from "vitest";
import type { MachineRolesEntry, PrRow } from "../../../shared/contracts";
import { canOpen, hostsFor, openingLine, openWord, pickHost, prChoices, slotLine, takesBuild, takesPr } from "./pickScreen";

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

describe("takesPr and openingLine", () => {
  it("offers a PR for phone screens and a project's browser, never a Navi's or a desktop", () => {
    expect(takesPr("ios", false) && takesPr("android", true) && takesPr("browser", false)).toBe(true);
    expect(takesPr("browser", true) || takesPr("linux_desktop", false)).toBe(false);
  });
  it("says where an open with a build is", () => {
    expect(openingLine("starting", 12, "mac")).toBe("Reading #12’s build and starting the screen on mac…");
    expect(openingLine("installing", 12, "mac")).toBe("Installing #12’s build on mac…");
    expect(openingLine(undefined, 12, "mac")).toBe("Handing it to you…");
  });
});
