// Hub › Machines › Screens' words: a kind's switch and its line from the machine's node, and the choices.
import { describe, expect, it } from "vitest";
import type { MachineRolesEntry } from "../../../shared/contracts";
import { daysChoices, elsewhereLine, fixOf, idleLine, lockedWhy, nodeWait, stateLine, switchOn } from "./screensModel";

const devbox: MachineRolesEntry = {
  machineId: "devbox",
  name: "devbox",
  online: true,
  roles: ["agents", "sessions"],
  maxSessions: 4,
  maxSessionsWhy: "set",
  sessionsLive: 0,
  hostsOthers: true,
  screenSettings: true,
  hosts: [
    { host: "browser", ready: true, detail: "Chrome at /usr/bin/google-chrome", on: true, idleMinutes: 45 },
    { host: "android", ready: false, detail: "Android screens are off in node.json", off: "off", on: false, idleMinutes: 45 },
    { host: "mac", ready: false, detail: "the Mac screen is a Mac's own", off: "unsupported", on: false },
    { host: "desktop", ready: false, detail: "turned on: it starts when this machine's node restarts", off: "restarting", on: true },
  ],
};
const check = (host: string) => devbox.hosts?.find((h) => h.host === host);

describe("a kind's switch", () => {
  it("is on as node.json has it, and says what stands in the way", () => {
    expect(switchOn(check("browser"))).toBe(true);
    expect(switchOn(check("android"))).toBe(false);
    expect(switchOn(check("desktop"))).toBe(true);
    expect(stateLine(check("browser"))).toBe("Ready");
    expect(stateLine(check("android"))).toBe("Off");
    expect(stateLine(check("desktop"))).toBe("Starts after the screens open now end");
    // The node's own words start as a sentence does.
    expect(stateLine({ host: "desktop", ready: false, detail: "desktop screens run on Linux", off: "unsupported" })).toBe("Desktop screens run on Linux");
    expect(stateLine({ host: "desktop", ready: false, detail: "no docker, podman or Xvfb", off: "missing" })).toBe("No docker, podman or Xvfb");
    // A node before switches: on where it can host.
    expect(switchOn({ host: "browser", ready: true, detail: "Chrome" })).toBe(true);
  });

  it("can't move where the machine can't run it, is offline, or its node is too old", () => {
    expect(lockedWhy(devbox, check("android"))).toBeNull();
    expect(lockedWhy(devbox, check("mac"))).toBe("the Mac screen is a Mac's own");
    expect(lockedWhy({ ...devbox, online: false }, check("android"))).toBe("Offline");
    expect(lockedWhy({ ...devbox, screenSettings: false }, check("android"))).toContain("too old");
    // Its node between two links, as after an update: restarting, never too old.
    const { screenSettings: _, ...restarting } = devbox;
    expect(lockedWhy(restarting, check("android"))).toBe("Restarting…");
    expect(nodeWait(restarting)).toBe("restarting");
    expect(nodeWait({ ...devbox, screenSettings: false })).toBe("old");
    expect(nodeWait({ ...restarting, online: false })).toBeNull();
    expect(nodeWait(devbox)).toBeNull();
  });

  it("says where the Mac's screen is, and how to get one, on a machine that isn't a Mac", () => {
    const line = "Only a Mac has this screen. Add one from Machines: the plus, then A Mac for agents.";
    expect(elsewhereLine(devbox, "mac", check("mac"))).toBe(line);
    // Any other kind, and the Mac itself, keep the node's words.
    expect(elsewhereLine(devbox, "android", check("android"))).toBeNull();
    expect(elsewhereLine(devbox, "desktop", { host: "desktop", ready: false, detail: "desktop screens run on Linux", off: "unsupported" })).toBeNull();
    expect(elsewhereLine({ mac: { on: false, ready: false } }, "mac", { host: "mac", ready: false, detail: "off", off: "off", on: false })).toBeNull();
    expect(elsewhereLine(devbox, "mac", undefined)).toBeNull();
  });
});

describe("a kind that can't run", () => {
  it("comes with the command that fixes it, only where something is missing or failed", () => {
    const missing = { host: "desktop", ready: false, detail: "no docker, podman or Xvfb", off: "missing", on: true, fix: "sudo apt-get install -y xvfb" } as const;
    expect(fixOf(devbox, missing)).toBe("sudo apt-get install -y xvfb");
    expect(fixOf(devbox, { ...missing, off: "failed" })).toBe("sudo apt-get install -y xvfb");
    // Off, installing, restarting or unsupported: the switch or the wait is the answer, not a command.
    expect(fixOf(devbox, { ...missing, off: "off" })).toBeNull();
    expect(fixOf(devbox, { ...missing, off: "installing" })).toBeNull();
    expect(fixOf(devbox, { ...missing, off: "unsupported" })).toBeNull();
    expect(fixOf(devbox, { ...missing, ready: true })).toBeNull();
    expect(fixOf({ ...devbox, online: false }, missing)).toBeNull();
    // A node before fixes says none.
    expect(fixOf(devbox, { host: "desktop", ready: false, detail: "no Xvfb", off: "missing" })).toBeNull();
  });
});

describe("the idle line and retention's choices", () => {
  it("say when an idle screen ends, as the node has it, with no timeout to pick", () => {
    expect(idleLine(devbox)).toBe("An idle screen ends after 45 minutes.");
    expect(idleLine({ ...devbox, hosts: [] })).toBe("An idle screen ends after 30 minutes.");
    expect(idleLine({ ...devbox, hosts: [{ host: "browser", ready: true, detail: "Chrome", idleMinutes: 120 }] })).toBe("An idle screen ends after 2 hours.");
    expect(idleLine({ ...devbox, mac: { on: true, ready: true }, hosts: [] })).toBe("An idle Mac screen ends after 5 minutes, so the next agent gets it.");
  });

  it("offer a few retention values, and the hub's own among them", () => {
    expect(daysChoices(30).map((c) => c.value)).toEqual(["7", "14", "30", "60", "90", "180", "365"]);
    expect(daysChoices(45).map((c) => c.value)).toEqual(["7", "14", "30", "45", "60", "90", "180", "365"]);
  });
});
