// The New screen picker's model: which machines can host each kind, a Navi's browser only on its own machine, the
// machine it starts on, and each machine's slots in words, a full one offering to wait.
import { describe, expect, it } from "vitest";
import type { MachineRolesEntry } from "../../../shared/contracts";
import { canOpen, hostsFor, openWord, pickHost, slotLine } from "./pickScreen";

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
