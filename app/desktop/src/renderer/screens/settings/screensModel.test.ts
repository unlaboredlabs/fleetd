// Hub › Machines › Screens' words: no switch per kind, a line only for a kind that needs someone, and the choices.
import { describe, expect, it } from "vitest";
import type { MachineRolesEntry } from "../../../shared/contracts";
import { daysChoices, idleLine, needsLines } from "./screensModel";

const devbox: MachineRolesEntry = {
  machineId: "devbox",
  name: "devbox",
  online: true,
  roles: ["agents", "sessions"],
  maxSessions: 4,
  maxSessionsWhy: "set",
  sessionsLive: 0,
  hostsOthers: true,
  hosts: [
    { host: "browser", ready: true, detail: "Chrome at /usr/bin/google-chrome", idleMinutes: 45 },
    { host: "android", ready: false, detail: "Installing the Android emulator for screens", off: "installing", idleMinutes: 45 },
    { host: "desktop", ready: true, detail: "Desktop screens run on Xvfb" },
    { host: "mac", ready: false, detail: "the Mac screen is the agents' Mac's own", off: "unsupported" },
  ],
};

describe("a kind that needs someone", () => {
  it("says nothing while every kind it can run is ready or installing, nor for one it can't run at all", () => {
    expect(needsLines(devbox)).toEqual([]);
  });

  it("says what stands in the way, as a sentence, with the command that fixes it where one does", () => {
    const hosts = [
      { host: "desktop", ready: false, detail: "no docker, podman or Xvfb", off: "missing", fix: "sudo apt-get install -y xvfb" },
      { host: "android", ready: false, detail: "no /dev/kvm: this user can't open it", off: "missing", fix: "sudo usermod -aG kvm $USER" },
      { host: "browser", ready: false, detail: "Installing the browser failed", off: "failed" },
    ];
    expect(needsLines({ ...devbox, hosts })).toEqual([
      { host: "browser", label: "Browser", line: "Installing the browser failed.", fix: null },
      { host: "android", label: "Android", line: "No /dev/kvm: this user can't open it.", fix: "sudo usermod -aG kvm $USER" },
      { host: "desktop", label: "Linux desktop", line: "No docker, podman or Xvfb.", fix: "sudo apt-get install -y xvfb" },
    ]);
  });

  it("says a kind an older node turned off in its node.json comes on with its update", () => {
    const hosts = [{ host: "android", ready: false, detail: "Android screens are off in node.json", off: "off" }];
    expect(needsLines({ ...devbox, hosts })).toEqual([{ host: "android", label: "Android", line: "Off until devbox’s fleetd is updated.", fix: null }]);
  });

  it("says only of its own screen on the agents' Mac, whatever an older node of it reports", () => {
    const hosts = [
      { host: "browser", ready: false, detail: "Installing the browser failed", off: "failed" },
      { host: "mac", ready: false, detail: "the Mac's screen is locked: unlock it at the Mac", off: "missing", fix: "open 'x-apple.systempreferences:…'" },
    ];
    expect(needsLines({ ...devbox, mac: { on: true, ready: false }, hosts })).toEqual([
      { host: "mac", label: "Agents’ Mac", line: "The Mac's screen is locked: unlock it at the Mac.", fix: "open 'x-apple.systempreferences:…'" },
    ]);
  });

  it("says nothing while the machine is offline", () => {
    expect(needsLines({ ...devbox, online: false, hosts: [{ host: "desktop", ready: false, detail: "no Xvfb", off: "missing" }] })).toEqual([]);
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
