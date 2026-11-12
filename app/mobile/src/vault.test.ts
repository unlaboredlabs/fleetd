// The vault over a fake secure store: each hub paired gets its own notification key pair, and Disconnect leaves none.
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
/** How each item was last written: its keychainAccessible. */
const access = new Map<string, number | undefined>();
vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0,
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  getItemAsync: async (k: string, o?: { keychainService?: string }) => store.get(`${o?.keychainService ?? ""}/${k}`) ?? null,
  setItemAsync: async (k: string, v: string, o?: { keychainService?: string; keychainAccessible?: number }) => {
    store.set(`${o?.keychainService ?? ""}/${k}`, v);
    access.set(`${o?.keychainService ?? ""}/${k}`, o?.keychainAccessible);
  },
  deleteItemAsync: async (k: string, o?: { keychainService?: string }) => void store.delete(`${o?.keychainService ?? ""}/${k}`),
}));
vi.mock("expo-crypto", () => ({ getRandomBytes: (n: number) => new Uint8Array(randomBytes(n)) }));

const { forgetPaired, forgetPush, loadAccount, loadHubs, loadPaired, loadPushDevice, loadPushKeys, pairWith, pushKeys, saveAccount, saveHubs, saveMuted, savePushDevice } = await import("./vault");
const { toBase64 } = await import("./seal");

beforeEach(() => {
  store.clear();
  access.clear();
});

describe("the hub's key", () => {
  it("stays on this phone, and opens after first unlock so an automation on a locked phone reads it", async () => {
    await pairWith({ hub: "http://devbox:4790", key: "fleetd_a", hubName: "devbox" });
    expect(access.get("/fleetd.hub")).toBe(0);
  });

  it("moves there from an older version's keychain item as it is read", async () => {
    store.set("/fleetd.hub", JSON.stringify({ hub: "http://devbox:4790", key: "fleetd_a", hubName: "devbox" }));
    expect((await loadPaired())?.key).toBe("fleetd_a");
    expect(access.get("/fleetd.hub")).toBe(0);
    expect(store.get("/fleetd.hub")).toContain("fleetd_a");
  });
});

describe("the notification key pair", () => {
  it("is a new one for each hub paired, the last hub's gone", async () => {
    await pairWith({ hub: "http://devbox:4790", key: "fleetd_a", hubName: "devbox" });
    const first = toBase64((await pushKeys()).publicKey);
    await savePushDevice("pd_AAAAAAAA");
    // The same pair while paired with that hub.
    expect(toBase64((await pushKeys()).publicKey)).toBe(first);

    await pairWith({ hub: "https://hub.example.com", key: "fleetd_b", hubName: "work" });
    const second = await loadPushKeys();
    expect(second).not.toBeNull();
    expect(toBase64(second!.publicKey)).not.toBe(first);
    expect(await loadPushDevice()).toBeNull();
    expect((await loadPaired())?.hub).toBe("https://hub.example.com");

    await Promise.all([forgetPaired(), forgetPush()]);
    expect(await loadPushKeys()).toBeNull();
    expect(await loadPaired()).toBeNull();
  });
});

describe("the muted chats", () => {
  it("are a JSON array beside the notification key, where the extension reads them", async () => {
    await saveMuted(["devbox/ada", "devbox/shop"]);
    expect(store.get("fleetd.push/fleetd.muted-chats")).toBe('["devbox/ada","devbox/shop"]');
    await saveMuted([]);
    expect(store.get("fleetd.push/fleetd.muted-chats")).toBe("[]");
  });
});

describe("the hubs kept, and the fleetd account", () => {
  const own = { hub: "http://devbox:4790", key: "fleetd_a", hubName: "devbox" };
  const team = { hub: "https://acme.fleetd.dev", key: "fleetd_b", hubName: "acme", cloud: true as const };

  it("keeps every team's key as the shown hub's is kept: after first unlock, this phone only", async () => {
    await saveHubs([own, team]);
    await saveAccount({ email: "ada@example.com", sessionId: "session_1" });
    expect(access.get("/fleetd.hubs")).toBe(0);
    expect(access.get("/fleetd.account")).toBe(0);
    expect(await loadHubs(own)).toEqual([own, team]);
    // A team joined by invitation stays marked across launches.
    const joined = { hub: "https://side.fleetd.dev", key: "fleetd_c", hubName: "side", cloud: true as const, invited: true as const };
    await saveHubs([own, team, joined]);
    expect(await loadHubs(own)).toEqual([own, team, joined]);
    expect(await loadAccount()).toEqual({ email: "ada@example.com", sessionId: "session_1" });
    // Only the email and the session id: nothing else of WorkOS.
    expect(Object.keys(JSON.parse(store.get("/fleetd.account")!) as object).sort()).toEqual(["email", "sessionId"]);
  });

  it("a hub paired before the list was kept is its only hub", async () => {
    expect(await loadHubs(own)).toEqual([own]);
    expect(await loadHubs(null)).toEqual([]);
  });

  it("signed out and with nothing left, keeps nothing", async () => {
    await saveHubs([team]);
    await saveAccount({ email: "ada@example.com", sessionId: "session_1" });
    await saveHubs([]);
    await saveAccount(null);
    expect(store.has("/fleetd.hubs")).toBe(false);
    expect(await loadAccount()).toBeNull();
  });
});
