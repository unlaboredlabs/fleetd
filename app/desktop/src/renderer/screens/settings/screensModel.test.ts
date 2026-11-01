// Hub › Machines › Screens' words: a kind's switch and its line from the machine's node, and the choices.
import { describe, expect, it } from "vitest";
import type { MachineRolesEntry } from "../../../shared/contracts";
import { daysChoices, idleChoices, idleOf, lockedWhy, stateLine, switchOn } from "./screensModel";

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
    { host: "ios", ready: false, detail: "iOS simulators need macOS", off: "unsupported", on: false },
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
    expect(stateLine(check("desktop"))).toBe("Starts when its node restarts, once the screens live there end");
    // A node before switches: on where it can host.
    expect(switchOn({ host: "browser", ready: true, detail: "Chrome" })).toBe(true);
  });

  it("can't move where the machine can't run it, is offline, or its node is too old", () => {
    expect(lockedWhy(devbox, check("android"))).toBeNull();
    expect(lockedWhy(devbox, check("ios"))).toBe("iOS simulators need macOS");
    expect(lockedWhy({ ...devbox, online: false }, check("android"))).toBe("Offline");
    expect(lockedWhy({ ...devbox, screenSettings: false }, check("android"))).toContain("too old");
  });
});

describe("the choices", () => {
  it("offer a few values, and the machine's own among them", () => {
    expect(idleOf(devbox)).toBe(45);
    expect(idleChoices(45).map((c) => c.label)).toEqual(["10 min", "15 min", "30 min", "45 min", "1 h", "2 h", "4 h"]);
    expect(daysChoices(30).map((c) => c.value)).toEqual(["7", "14", "30", "60", "90", "180", "365"]);
  });
});
