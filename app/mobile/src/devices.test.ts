import { describe, expect, it } from "vitest";
import type { AgentKeyInfo } from "./desktop";
import { myDevices, sameHub, signOutWords } from "./devices";

const key = (keyId: string, personId: string, more: Partial<AgentKeyInfo> = {}): AgentKeyInfo => ({
  keyId,
  name: `Device ${keyId}`,
  prefix: `fd_${keyId}`,
  kind: "human",
  grants: [],
  createdAt: `2026-11-0${keyId.slice(1)}T10:00:00.000Z`,
  person: { personId, name: personId },
  ...more,
});
const when = (iso: string) => iso.slice(5, 10);

describe("myDevices", () => {
  it("lists the person's own devices newest first, this phone marked, revoked ones and others' left out", () => {
    const devices = [key("k1", "ada"), key("k2", "bob"), key("k3", "ada", { lastUsedAt: "2026-11-05T09:00:00.000Z" }), key("k4", "ada", { revokedAt: "2026-11-06T00:00:00.000Z" }), key("k5", "ada")];
    expect(myDevices(devices, "ada", "k3", when)).toEqual([
      { keyId: "k5", name: "Device k5", detail: "Signed in 11-05", here: false },
      { keyId: "k3", name: "Device k3", detail: "Signed in 11-03 · last used 11-05", here: true },
      { keyId: "k1", name: "Device k1", detail: "Signed in 11-01", here: false },
    ]);
    // The hub's own order is left as it was.
    expect(devices.map((d) => d.keyId)).toEqual(["k1", "k2", "k3", "k4", "k5"]);
  });

  it("is empty for a caller the hub names no person for", () => {
    expect(myDevices([key("k1", "ada")], undefined, "k1", when)).toEqual([]);
  });
});

describe("the Devices list's words", () => {
  it("asks before signing a device out, naming the hub", () => {
    expect(signOutWords("MacBook", "acme")).toEqual({ title: "Sign Out MacBook?", message: "It stops working on acme at once. To use it again, sign in or pair it again." });
  });

  it("knows a notification's hub as the one shown, a trailing slash aside", () => {
    expect(sameHub("https://acme.fleetd.test/", "https://acme.fleetd.test")).toBe(true);
    expect(sameHub("https://acme.fleetd.test", "https://other.fleetd.test")).toBe(false);
  });
});
