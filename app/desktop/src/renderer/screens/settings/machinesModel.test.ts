import { describe, expect, it } from "vitest";
import type { MachineRolesEntry } from "../../../shared/contracts";
import { capChoices, choiceOf, hostsNote, rolesOf, sessionsLine } from "./machinesModel";

const devbox: MachineRolesEntry = {
  machineId: "devbox",
  name: "devbox",
  online: true,
  roles: ["agents", "sessions"],
  maxSessions: 4,
  maxSessionsWhy: "auto: 8 CPUs, 16 GB",
  sessionsLive: 2,
  hosts: [
    { host: "browser", ready: true, detail: "Chrome at /usr/bin/google-chrome" },
    { host: "android", ready: false, detail: "no Android SDK (set ANDROID_HOME)" },
    { host: "desktop", ready: true, detail: "Xvfb at /usr/bin/Xvfb" },
  ],
  hostsOthers: true,
};

describe("machine roles", () => {
  it("reads roles as one choice and back", () => {
    expect(choiceOf(["agents", "sessions"])).toBe("both");
    expect(choiceOf(["sessions"])).toBe("sessions");
    expect(choiceOf(["agents"])).toBe("agents");
    expect(rolesOf("both")).toEqual(["agents", "sessions"]);
    expect(rolesOf("sessions")).toEqual(["sessions"]);
  });

  it("says a machine's session slots and where its cap comes from", () => {
    expect(sessionsLine(devbox)).toBe("2 of 4 screens now (auto: 8 CPUs, 16 GB)");
    expect(sessionsLine({ ...devbox, maxSessions: 1, maxSessionsSet: 1, maxSessionsWhy: "set", sessionsLive: 0 })).toBe("0 of 1 screen now (you set it)");
  });

  it("offers auto with what it fits, then 1 to 16, keeping a larger setting", () => {
    const auto = capChoices(devbox);
    expect(auto[0]).toEqual({ value: "auto", label: "Auto (4)" });
    expect(auto).toHaveLength(17);
    const set = capChoices({ ...devbox, maxSessions: 40, maxSessionsSet: 40, maxSessionsWhy: "set" });
    expect(set[0]?.label).toBe("Auto");
    expect(set.at(-1)).toEqual({ value: "40", label: "40" });
  });


  it("notes a machine that can't take others' sessions yet", () => {
    expect(hostsNote(devbox)).toBeNull();
    expect(hostsNote({ ...devbox, roles: ["agents"], hosts: [] })).toBeNull();
    expect(hostsNote({ ...devbox, hosts: [] })).toBe("Hasn't said what it can host yet.");
    expect(hostsNote({ ...devbox, hosts: [], online: false })).toBe("Offline: what it can host shows once it is back.");
    expect(hostsNote({ ...devbox, hostsOthers: false, hostsOthersNote: "Its fleetd is older: it hosts only its own agents' screens until it is updated." })).toContain("older");
    // No key to seal to says so, not "older".
    const noKey = "It gave the hub no key to seal a screen's secrets to: it hosts only its own agents' screens until its node links again.";
    expect(hostsNote({ ...devbox, hostsOthers: false, hostsOthersNote: noKey })).toBe(noKey);
  });
});
