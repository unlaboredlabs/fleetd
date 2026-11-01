// The desktop modules the phone runs, as Hermes runs them: its Array has no toSorted, so a call to it throws in render
// and the app exits (the New Screen sheet did, W272).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hostsFor, whyOff, type MachineRolesEntry } from "./desktop";

const machine = (name: string, ready: boolean, more: Partial<MachineRolesEntry> = {}): MachineRolesEntry => ({
  machineId: name,
  name,
  online: true,
  roles: ["agents", "sessions"],
  maxSessions: 2,
  maxSessionsWhy: "set",
  sessionsLive: 0,
  hostsOthers: true,
  hosts: [{ host: "ios", ready, detail: "as tested", ...(ready ? {} : { off: "off" as const }) }],
  ...more,
});

describe("on Hermes", () => {
  const toSorted = Object.getOwnPropertyDescriptor(Array.prototype, "toSorted");
  beforeAll(() => {
    // @ts-expect-error: Hermes has none.
    delete Array.prototype.toSorted;
  });
  afterAll(() => {
    if (toSorted !== undefined) Object.defineProperty(Array.prototype, "toSorted", toSorted);
  });

  it("the New Screen sheet's machines and reasons still sort", () => {
    expect([].toSorted).toBeUndefined();
    const hosts = hostsFor([machine("mac-b", true), machine("mac-a", true), machine("lab", true, { online: false })], "ios");
    expect(hosts.map((h) => h.name)).toEqual(["mac-a", "mac-b", "lab"]);
    const off = whyOff([machine("mac-b", false, { screenSettings: true }), machine("lab", false, { online: false }), machine("mac-a", false, { screenSettings: true })], "ios");
    expect(off).toMatchObject({ fix: "turn_on", machine: { name: "mac-a" } });
  });
});
