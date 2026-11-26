// The desktop modules the phone runs, as Hermes runs them: its Array has no toSorted, so a call to it throws in render
// and the app exits (the New Screen sheet did, W272). And the guard that keeps the next one out: the app is typed
// against ES2022's built-ins and the few newer ones Hermes has (hermes.d.ts), so CI's typecheck refuses the rest.
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  hosts: [{ host: "android", ready, detail: "as tested", ...(ready ? {} : { off: "off" as const }) }],
  ...more,
});

describe("on Hermes", () => {
  const toSorted = Object.getOwnPropertyDescriptor(Array.prototype, "toSorted");
  beforeAll(() => {
    // Hermes has none, nor do the app's types (tsconfig.json's lib).
    delete (Array.prototype as { toSorted?: unknown }).toSorted;
  });
  afterAll(() => {
    if (toSorted !== undefined) Object.defineProperty(Array.prototype, "toSorted", toSorted);
  });

  it("the New Screen sheet's machines and reasons still sort", () => {
    expect((Array.prototype as { toSorted?: unknown }).toSorted).toBeUndefined();
    const hosts = hostsFor([machine("mac-b", true), machine("mac-a", true), machine("lab", true, { online: false })], "android");
    expect(hosts.map((h) => h.name)).toEqual(["mac-a", "mac-b", "lab"]);
    const off = whyOff([machine("mac-b", false), machine("lab", false, { online: false }), machine("mac-a", false)], "android");
    expect(off).toMatchObject({ fix: "update", machine: { name: "mac-a" } });
  });
});

describe("The app's types", () => {
  const read = (path: string) => readFileSync(join(import.meta.dirname, path), "utf8");

  it("stop at the built-ins Hermes has: ES2022's, not expo's ESNext", () => {
    const lib = /"lib":\s*\[([^\]]*)\]/u.exec(read("../tsconfig.json"))?.[1];
    expect(lib?.split(",").map((l) => l.trim().replace(/"/gu, ""))).toEqual(["DOM", "ES2022"]);
  });

  it("add past ES2022 only what Hermes has", () => {
    const added = [...read("hermes.d.ts").matchAll(/^\s+(\w+)[<(]/gmu)].map((m) => m[1]);
    expect([...new Set(added)]).toEqual(["findLast", "findLastIndex"]);
  });
});
