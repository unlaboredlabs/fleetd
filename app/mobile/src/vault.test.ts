// The vault over a fake secure store: each hub paired gets its own notification key pair, and Disconnect leaves none.
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0,
  getItemAsync: async (k: string, o?: { keychainService?: string }) => store.get(`${o?.keychainService ?? ""}/${k}`) ?? null,
  setItemAsync: async (k: string, v: string, o?: { keychainService?: string }) => void store.set(`${o?.keychainService ?? ""}/${k}`, v),
  deleteItemAsync: async (k: string, o?: { keychainService?: string }) => void store.delete(`${o?.keychainService ?? ""}/${k}`),
}));
vi.mock("expo-crypto", () => ({ getRandomBytes: (n: number) => new Uint8Array(randomBytes(n)) }));

const { forgetPaired, forgetPush, loadPaired, loadPushDevice, loadPushKeys, pairWith, pushKeys, savePushDevice } = await import("./vault");
const { toBase64 } = await import("./seal");

beforeEach(() => store.clear());

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
