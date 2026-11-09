// The vault's root key (src/hub/vault/keys.ts): made once beside the hub's home with safe permissions, never
// overwritten; kept in a file, the keychain or under a passphrase; rotated; and its recovery code round-trips.
import { expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { keyDir, keyFromRecoveryCode, recoveryCode, type Secrets, VaultKeyError, VaultKeys } from "../src/hub/vault/keys.ts";
import { tempHome } from "./helpers.ts";

const fakeKeychain = (): Secrets & { held: Map<string, string> } => {
  const held = new Map<string, string>();
  return {
    held,
    get: async ({ service, name }) => held.get(`${service}/${name}`) ?? null,
    set: async ({ service, name, value }) => void held.set(`${service}/${name}`, value),
    delete: async ({ service, name }) => held.delete(`${service}/${name}`),
  };
};

test("the key lives beside the hub's home, never in it", () => {
  expect(keyDir("/home/a/.fleetd/hub")).toBe("/home/a/.fleetd/vault");
});

test("the first start makes a key file 0600 in a 0700 folder, and a second start reads it, never overwriting", async () => {
  const home = tempHome();
  try {
    const dir = join(home.dir, "vault");
    const a = new VaultKeys(dir);
    await a.load(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(a.path).mode & 0o777).toBe(0o600);
    const before = readFileSync(a.path, "utf8");
    expect(JSON.parse(before).mode).toBe("file");
    const b = new VaultKeys(dir);
    await b.load(true);
    expect(readFileSync(a.path, "utf8")).toBe(before);
    expect(Buffer.from(b.active().key).equals(Buffer.from(a.active().key))).toBe(true);
    // Missing and not to be made: refused, not made.
    const none = new VaultKeys(join(home.dir, "elsewhere"));
    await expect(none.load(false)).rejects.toThrow(VaultKeyError);
    expect(existsSync(join(home.dir, "elsewhere", "root.key"))).toBe(false);
  } finally {
    home.done();
  }
});

test("a key file other users can read is refused", async () => {
  const home = tempHome();
  try {
    const dir = join(home.dir, "vault");
    await new VaultKeys(dir).load(true);
    chmodSync(join(dir, "root.key"), 0o644);
    const err = await new VaultKeys(dir).load(true).catch((e) => e as VaultKeyError);
    expect(err).toBeInstanceOf(VaultKeyError);
    expect((err as VaultKeyError).reason).toBe("vault_key_unsafe");
  } finally {
    home.done();
  }
});

test("passphrase mode: locked after a start until the right passphrase; the file holds no key in the clear", async () => {
  const home = tempHome();
  try {
    const dir = join(home.dir, "vault");
    const a = new VaultKeys(dir, { scryptN: 1024 });
    await a.load(true);
    const key = Buffer.from(a.active().key).toString("base64");
    await a.store("passphrase", "correct horse battery");
    expect(readFileSync(a.path, "utf8")).not.toContain(key);
    const b = new VaultKeys(dir, { scryptN: 1024 });
    await b.load(true);
    expect(b.locked).toBe(true);
    expect(() => b.active()).toThrow("locked");
    expect(b.unlock("wrong passphrase!!")).toBe(false);
    expect(b.locked).toBe(true);
    expect(b.unlock("correct horse battery")).toBe(true);
    expect(Buffer.from(b.active().key).toString("base64")).toBe(key);
    // While unlocked, a rotation writes the key set again without asking for the passphrase.
    const fresh = await b.add();
    const c = new VaultKeys(dir, { scryptN: 1024 });
    await c.load(true);
    expect(c.unlock("correct horse battery")).toBe(true);
    expect(c.active().id).toBe(fresh.id);
    expect(c.key("k1")).toBeDefined();
    await expect(b.store("passphrase", "short")).rejects.toThrow("12 characters");
  } finally {
    home.done();
  }
});

test("keyring mode keeps only a pointer in the file; leaving it removes the keychain's copy", async () => {
  const home = tempHome();
  try {
    const dir = join(home.dir, "vault");
    const keychain = fakeKeychain();
    const a = new VaultKeys(dir, { secrets: keychain });
    await a.load(true);
    const key = Buffer.from(a.active().key).toString("base64");
    await a.store("keyring");
    expect(readFileSync(a.path, "utf8")).not.toContain(key);
    expect(JSON.parse(readFileSync(a.path, "utf8")).mode).toBe("keyring");
    const b = new VaultKeys(dir, { secrets: keychain });
    await b.load(true);
    expect(Buffer.from(b.active().key).toString("base64")).toBe(key);
    await b.store("file");
    expect(keychain.held.size).toBe(0);
    expect(readFileSync(a.path, "utf8")).toContain(key);
    // A keychain that lost it: the key is missing, not made again.
    await b.store("keyring");
    keychain.held.clear();
    const err = await new VaultKeys(dir, { secrets: keychain }).load(true).catch((e) => e as VaultKeyError);
    expect((err as VaultKeyError).reason).toBe("vault_key_missing");
  } finally {
    home.done();
  }
});

test("rotation: a new active key, then the old ones dropped", async () => {
  const home = tempHome();
  try {
    const keys = new VaultKeys(join(home.dir, "vault"), { now: () => 1000 });
    await keys.load(true);
    const fresh = await keys.add();
    expect(fresh.id).toBe("k2");
    expect(keys.active().id).toBe("k2");
    expect(keys.all().map((k) => k.id)).toEqual(["k1", "k2"]);
    await keys.dropAllBut("k2");
    const again = new VaultKeys(join(home.dir, "vault"));
    await again.load(false);
    expect(again.all().map((k) => k.id)).toEqual(["k2"]);
  } finally {
    home.done();
  }
});

test("the recovery code round-trips, and a typo is caught", () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const code = recoveryCode(key);
  expect(code.replace(/-/g, "")).toHaveLength(52);
  expect(Buffer.from(keyFromRecoveryCode(code)!).equals(Buffer.from(key))).toBe(true);
  expect(Buffer.from(keyFromRecoveryCode(code.toLowerCase().replace(/-/g, " "))!).equals(Buffer.from(key))).toBe(true);
  const chars = code.replace(/-/g, "");
  let caught = 0;
  for (let i = 0; i < chars.length; i++) {
    const swapped = chars.slice(0, i) + (chars[i] === "A" ? "B" : "A") + chars.slice(i + 1);
    if (keyFromRecoveryCode(swapped) === undefined) caught++;
  }
  // A 4-bit checksum catches most single typos (15 in 16).
  expect(caught).toBeGreaterThan(chars.length * 0.8);
  expect(keyFromRecoveryCode("not a code")).toBeUndefined();
});
