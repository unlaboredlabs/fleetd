import sodium from "libsodium-wrappers";
import { beforeAll, describe, expect, it } from "vitest";
import { IPC } from "../shared/channels";
import type { CallOutcome } from "../shared/hub";
import { parseRequest } from "../shared/ipc";
import { authorizer, copyVaultField, revealVaultItem, saveVaultItem, unlockVault, UNLOCKED_MS } from "./vault";

const ID = "V0123456789abcdef0123456789abcdef";
const CANARY = "canary-7Qx-not-a-real-secret";
let hubKeys: { publicKey: Uint8Array; privateKey: Uint8Array };

beforeAll(async () => {
  await sodium.ready;
  hubKeys = sodium.crypto_box_keypair();
});

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const openWithHub = (sealed: string): unknown => JSON.parse(sodium.to_string(sodium.crypto_box_seal_open(Buffer.from(sealed, "base64"), hubKeys.publicKey, hubKeys.privateKey)));

/** A hub that answers vault_status with its box key, seals reveals to the reply key, and records every input. */
const fakeHub = (stored: Record<string, string> = {}) => {
  const calls: Array<{ tool: string; input: unknown }> = [];
  const call = (tool: string, input: unknown): Promise<CallOutcome> => {
    calls.push({ tool, input });
    if (tool === "vault_status") return Promise.resolve({ ok: true, output: { hubBoxKey: b64(hubKeys.publicKey), locked: false } });
    if (tool === "vault_reveal") {
      const { fields, replyKey } = input as { fields: string[]; replyKey: string };
      const out = Object.fromEntries(fields.filter((f) => stored[f] !== undefined).map((f) => [f, stored[f]]));
      return Promise.resolve({ ok: true, output: { sealed: b64(sodium.crypto_box_seal(JSON.stringify(out), Buffer.from(replyKey, "base64"))) } });
    }
    return Promise.resolve({ ok: true, output: { item: { itemId: ID } } });
  };
  return { calls, call: call as never };
};

const clock = () => {
  let t = 1_000;
  return { now: () => t, tick: (ms: number) => (t += ms) };
};

describe("saving a vault item", () => {
  it("seals the typed fields to the hub's own key: no value leaves in the clear", async () => {
    const hub = fakeHub();
    const out = await saveVaultItem({ kind: "login", scope: "person", label: "Amazon", sites: ["amazon.com"], fields: { username: "sam", password: CANARY } }, hub.call);
    expect(out.ok).toBe(true);
    const save = hub.calls.find((c) => c.tool === "vault_save")?.input as Record<string, unknown>;
    expect(save).toMatchObject({ kind: "login", scope: "person", label: "Amazon", sites: ["amazon.com"] });
    expect(save).not.toHaveProperty("fields");
    expect(JSON.stringify(hub.calls)).not.toContain(CANARY);
    expect(openWithHub(save["sealed"] as string)).toEqual({ username: "sam", password: CANARY });
  });

  it("changes only the readable part when no field was typed, without asking for the key", async () => {
    const hub = fakeHub();
    await saveVaultItem({ itemId: ID, label: "Amazon (work)" }, hub.call);
    expect(hub.calls).toEqual([{ tool: "vault_save", input: { itemId: ID, label: "Amazon (work)" } }]);
  });

  it("seals the passphrase the same way to unlock", async () => {
    const hub = fakeHub();
    await unlockVault({ passphrase: CANARY }, hub.call);
    const unlock = hub.calls.find((c) => c.tool === "vault_unlock")?.input as { sealed: string };
    expect(JSON.stringify(hub.calls)).not.toContain(CANARY);
    expect(openWithHub(unlock.sealed)).toEqual({ passphrase: CANARY });
  });

  it("refuses at the IPC boundary what isn't a vault item's shape", () => {
    expect(parseRequest(IPC.vaultSave, ["hub", { kind: "login", fields: { password: "x" } }]).ok).toBe(true);
    expect(parseRequest(IPC.vaultSave, ["hub", { kind: "passport" }]).ok).toBe(false);
    expect(parseRequest(IPC.vaultSave, ["hub", { sealed: "abc" }]).ok).toBe(false);
    expect(parseRequest(IPC.vaultReveal, ["hub", { itemId: "nope", label: "x", fields: ["password"] }]).ok).toBe(false);
  });
});

describe("revealing and copying", () => {
  it("asks first: refused, the hub is never asked; passed, the fields open with a one-time key", async () => {
    const hub = fakeHub({ password: CANARY, username: "sam" });
    const c = clock();
    let asked = 0;
    let answer = false;
    const authorize = authorizer({ now: c.now, authorize: () => (asked++, Promise.resolve(answer)) });
    const refused = await revealVaultItem({ itemId: ID, label: "Amazon", fields: ["password"] }, hub.call, authorize, "hub");
    expect(refused).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(hub.calls).toEqual([]);
    answer = true;
    expect(await revealVaultItem({ itemId: ID, label: "Amazon", fields: ["password", "username"] }, hub.call, authorize, "hub")).toEqual({ ok: true, fields: { password: CANARY, username: "sam" } });
    const replyKey = (hub.calls[0]?.input as { replyKey: string }).replyKey;
    expect(Buffer.from(replyKey, "base64")).toHaveLength(32);
    expect(asked).toBe(2);
    // The same item within 30 s doesn't ask again; another item, or later, does.
    await revealVaultItem({ itemId: ID, label: "Amazon", fields: ["password"] }, hub.call, authorize, "hub");
    expect(asked).toBe(2);
    await revealVaultItem({ itemId: "V1123456789abcdef0123456789abcdef", label: "Other", fields: ["password"] }, hub.call, authorize, "hub");
    expect(asked).toBe(3);
    c.tick(UNLOCKED_MS + 1);
    await revealVaultItem({ itemId: ID, label: "Amazon", fields: ["password"] }, hub.call, authorize, "hub");
    expect(asked).toBe(4);
  });

  it("copies in main and empties the clipboard a minute later, unless something else was copied since", async () => {
    const hub = fakeHub({ password: CANARY, month: "04", year: "2028" });
    let clip = "";
    const later: Array<() => void> = [];
    const ports = { readClipboard: () => Promise.resolve(clip), writeClipboard: (t: string) => ((clip = t), Promise.resolve()), later: (fn: () => void) => void later.push(fn) };
    const authorize = authorizer({ now: () => 0, authorize: () => Promise.resolve(true) });
    expect(await copyVaultField({ itemId: ID, label: "Amazon's password", field: "password" }, hub.call, authorize, "hub", ports)).toEqual({ ok: true });
    expect(clip).toBe(CANARY);
    later.shift()?.();
    await Promise.resolve();
    expect(clip).toBe("");
    await copyVaultField({ itemId: ID, label: "Visa's expiry", field: "expiry" }, hub.call, authorize, "hub", ports);
    expect(clip).toBe("04/28");
    clip = "something else";
    later.shift()?.();
    await Promise.resolve();
    expect(clip).toBe("something else");
  });
});
