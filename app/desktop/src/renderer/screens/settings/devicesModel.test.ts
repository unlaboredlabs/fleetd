import { describe, expect, it } from "vitest";
import type { AgentKeyInfo } from "../../../shared/contracts";
import { codeLife, pairedSince, qrPath, yourDevices } from "./devicesModel";

const key = (keyId: string, personId?: string, revokedAt?: string): AgentKeyInfo => ({
  keyId,
  name: keyId,
  prefix: keyId,
  kind: "human",
  grants: [],
  createdAt: "2026-10-19T10:00:00.000Z",
  ...(personId === undefined ? {} : { person: { personId, name: personId } }),
  ...(revokedAt === undefined ? {} : { revokedAt }),
});

describe("your devices", () => {
  it("are the caller's own, not revoked; none for a key with no person", () => {
    const devices = [key("a", "p_me"), key("b", "p_other"), key("c", "p_me", "2026-10-19T11:00:00.000Z"), key("d")];
    expect(yourDevices({ people: [], devices, invites: [], me: "p_me" }).map((d) => d.keyId)).toEqual(["a"]);
    expect(yourDevices({ people: [], devices, invites: [] })).toEqual([]);
    expect(yourDevices(undefined)).toEqual([]);
  });

  it("the one that paired is the newest not there when the code was made", () => {
    const before = new Set(["a"]);
    expect(pairedSince([key("a")], before)).toBeUndefined();
    expect(pairedSince([key("a"), key("b"), key("c")], before)?.keyId).toBe("c");
  });
});

describe("a pairing code's life", () => {
  const end = Date.parse("2026-10-19T10:15:00.000Z");
  it("counts the minutes left, rounding up, and ends at its expiry", () => {
    expect(codeLife("2026-10-19T10:15:00.000Z", end - 15 * 60_000)).toMatch(/^Works once, for 15 more minutes \(until \d\d:\d\d\)\.$/);
    expect(codeLife("2026-10-19T10:15:00.000Z", end - 30_000)).toMatch(/for 1 more minute \(/);
    expect(codeLife("2026-10-19T10:15:00.000Z", end)).toBeNull();
    expect(codeLife("not a time", end)).toBeNull();
  });
});

describe("the QR", () => {
  it("is square with a 4-module quiet zone, and its finder patterns sit in the corners", () => {
    const { size, path } = qrPath("fleetd://pair?hub=http%3A%2F%2F100.101.102.103%3A4790&code=ABCD-EFGH");
    // Version 4 at level L holds this link: 33 modules, and 8 of quiet zone.
    expect(size).toBe(41);
    const dark = new Set([...path.matchAll(/M(\d+) (\d+)/g)].map((m) => `${m[1] ?? ""},${m[2] ?? ""}`));
    for (let i = 0; i < size; i++) {
      for (const [x, y] of [[i, 0], [0, i], [i, 3], [3, i], [i, size - 1], [size - 1, i]] as const) expect(dark.has(`${String(x)},${String(y)}`)).toBe(false);
    }
    // The top-left finder: a 7×7 ring from (4, 4).
    for (let i = 0; i < 7; i++) {
      expect(dark.has(`${String(4 + i)},4`)).toBe(true);
      expect(dark.has(`4,${String(4 + i)}`)).toBe(true);
    }
  });
});
