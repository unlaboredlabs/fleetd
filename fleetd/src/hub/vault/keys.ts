// The vault's root key (vault-design §2): 32 random bytes kept outside the hub's home, so they never sit beside
// hub.sqlite or a copy of it. `<dirname(hub home)>/vault/root.key` (0600 in a 0700 dir) holds them, in one of three
// modes:
// - `file` (the default): the keys themselves. The Rust hub reads this one too.
// - `keyring`: a pointer; the keys live in the OS keychain (`Bun.secrets`).
// - `passphrase`: the keys wrapped under scrypt(passphrase) with AES-256-GCM. After each start the vault is locked
//   until an owner or admin unlocks it.
// Every mode holds a key set: the active key, and during a rotation the one it replaces (`retired`).
import { createHash, scryptSync, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gcmOpen, gcmSeal, newKey } from "./crypto.ts";

export type KeyMode = "file" | "keyring" | "passphrase";
export type RootKey = { id: string; key: Uint8Array; created: number; retired?: number };

type KeyJson = { id: string; key: string; created: number; retired?: number };
type FileShape =
  | { v: 1; mode: "file"; keys: KeyJson[] }
  | { v: 1; mode: "keyring"; service: string; account: string }
  | { v: 1; mode: "passphrase"; kdf: Kdf; wrapped: string };
type Kdf = { alg: "scrypt"; N: number; r: number; p: number; salt: string };

/** The OS keychain, as `Bun.secrets` offers it; tests give their own. */
export type Secrets = {
  get(o: { service: string; name: string }): Promise<string | null>;
  set(o: { service: string; name: string; value: string }): Promise<void>;
  delete(o: { service: string; name: string }): Promise<boolean>;
};

export const KEYRING_SERVICE = "fleetd-vault";
/** scrypt's cost for the passphrase mode (RFC 7914): 128 MiB of memory per try. */
export const SCRYPT_N = 131072;
const PASSPHRASE_AAD = Buffer.from("fleetd-vault/passphrase/1");

/** Where the root key lives for a hub whose home is `home`: beside it, never in it. */
export const keyDir = (home: string) => join(dirname(home), "vault");

export class VaultKeyError extends Error {
  constructor(
    readonly reason: "vault_locked" | "vault_key_missing" | "vault_key_unsafe" | "vault_key_bad",
    message: string,
  ) {
    super(message);
    this.name = "VaultKeyError";
  }
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

function keysOf(json: unknown): RootKey[] {
  if (!Array.isArray(json)) throw new VaultKeyError("vault_key_bad", "the vault key file holds no keys");
  return json.map((k: KeyJson) => {
    const key = unb64(String(k?.key ?? ""));
    if (typeof k?.id !== "string" || k.id === "" || key.length !== 32) {
      throw new VaultKeyError("vault_key_bad", "the vault key file holds a key that isn't 32 bytes");
    }
    return { id: k.id, key, created: Number(k.created) || 0, ...(k.retired !== undefined ? { retired: Number(k.retired) } : {}) };
  });
}

const keysJson = (keys: RootKey[]): KeyJson[] =>
  keys.map((k) => ({ id: k.id, key: b64(k.key), created: k.created, ...(k.retired !== undefined ? { retired: k.retired } : {}) }));

function derive(passphrase: string, kdf: Kdf): Uint8Array {
  return new Uint8Array(
    scryptSync(passphrase.normalize("NFC"), unb64(kdf.salt), 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * kdf.N * kdf.r + 1024 * 1024 }),
  );
}

// --- recovery code: the active key as 52 base32 characters, the last 4 bits a checksum ---

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function recoveryCode(key: Uint8Array): string {
  const check = createHash("sha256").update(key).digest()[0]! >> 4;
  let bits = "";
  for (const byte of key) bits += byte.toString(2).padStart(8, "0");
  bits += check.toString(2).padStart(4, "0");
  let out = "";
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out.match(/.{1,4}/g)!.join("-");
}

/** The key a recovery code holds; undefined for a mistyped one. Spaces, dashes and case don't matter. */
export function keyFromRecoveryCode(code: string): Uint8Array | undefined {
  const clean = code.toUpperCase().replace(/[\s-]/g, "").replace(/0/g, "O").replace(/1/g, "I");
  if (clean.length !== 52 || [...clean].some((c) => !B32.includes(c))) return undefined;
  let bits = "";
  for (const c of clean) bits += B32.indexOf(c).toString(2).padStart(5, "0");
  const key = new Uint8Array(32);
  for (let i = 0; i < 32; i++) key[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  const check = parseInt(bits.slice(256, 260), 2);
  return createHash("sha256").update(key).digest()[0]! >> 4 === check ? key : undefined;
}

/**
 * The hub's root keys: read once at start, held in memory for the hub's life. A missing file is made in `file` mode
 * on the first start (`wx`, never overwriting). A passphrase key set stays locked until `unlock`.
 */
export class VaultKeys {
  private keys: RootKey[] = [];
  private shape: FileShape | undefined;
  /** The passphrase-derived key while unlocked, so a rotation can write the key set again without asking. */
  private wrap: { kdf: Kdf; key: Uint8Array } | undefined;
  readonly path: string;

  constructor(
    readonly dir: string,
    private readonly opts: { secrets?: Secrets; account?: string; scryptN?: number; now?: () => number } = {},
  ) {
    this.path = join(dir, "root.key");
  }

  private now = () => (this.opts.now ?? Date.now)();
  private secrets(): Secrets {
    const s = this.opts.secrets ?? (globalThis as { Bun?: { secrets?: Secrets } }).Bun?.secrets;
    if (!s) throw new VaultKeyError("vault_locked", "this system offers no keychain to the vault");
    return s;
  }

  get mode(): KeyMode | undefined {
    return this.shape?.mode;
  }

  get locked(): boolean {
    return this.keys.length === 0;
  }

  /** The key new writes use: the newest not retired. */
  active(): RootKey {
    const live = this.keys.filter((k) => k.retired === undefined).sort((a, b) => b.created - a.created)[0];
    if (live) return live;
    if (this.shape?.mode === "passphrase") throw new VaultKeyError("vault_locked", "the vault is locked");
    throw new VaultKeyError("vault_key_missing", "the vault key is missing");
  }

  key(id: string): Uint8Array | undefined {
    return this.keys.find((k) => k.id === id)?.key;
  }

  all(): RootKey[] {
    return [...this.keys];
  }

  /** Problems with the file's or its directory's permissions; empty when safe. */
  unsafe(): string[] {
    const out: string[] = [];
    if (existsSync(this.dir) && (statSync(this.dir).mode & 0o077) !== 0) out.push(`${this.dir} is open to other users (want 0700)`);
    if (existsSync(this.path) && (statSync(this.path).mode & 0o077) !== 0) out.push(`${this.path} is open to other users (want 0600)`);
    return out;
  }

  /**
   * Reads the file, making a fresh `file`-mode key when there is none and `create` is set (the first start of the
   * vault release). Keyring keys are read now; passphrase keys wait for `unlock`.
   */
  async load(create: boolean): Promise<void> {
    if (!existsSync(this.path)) {
      if (!create) throw new VaultKeyError("vault_key_missing", `no vault key at ${this.path}`);
      const first: RootKey = { id: "k1", key: newKey(), created: this.now() };
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      chmodSync(this.dir, 0o700);
      const shape: FileShape = { v: 1, mode: "file", keys: keysJson([first]) };
      writeFileSync(this.path, `${JSON.stringify(shape)}\n`, { mode: 0o600, flag: "wx" });
    }
    const unsafe = this.unsafe();
    if (unsafe.length > 0) throw new VaultKeyError("vault_key_unsafe", unsafe.join("; "));
    let shape: FileShape;
    try {
      shape = JSON.parse(readFileSync(this.path, "utf8")) as FileShape;
    } catch {
      throw new VaultKeyError("vault_key_bad", `${this.path} isn't a vault key file`);
    }
    this.shape = shape;
    if (shape.mode === "file") this.keys = keysOf(shape.keys);
    else if (shape.mode === "keyring") {
      const held = await this.secrets().get({ service: shape.service, name: shape.account });
      if (held === null) throw new VaultKeyError("vault_key_missing", "the vault key isn't in the keychain");
      this.keys = keysOf(JSON.parse(held));
    } else if (shape.mode === "passphrase") this.keys = [];
    else throw new VaultKeyError("vault_key_bad", `${this.path} has an unknown mode`);
  }

  /** Opens a passphrase key set; false for a wrong passphrase. */
  unlock(passphrase: string): boolean {
    const shape = this.shape;
    if (shape?.mode !== "passphrase") return !this.locked;
    const kek = derive(passphrase, shape.kdf);
    try {
      const plain = gcmOpen(kek, unb64(shape.wrapped), PASSPHRASE_AAD);
      if (!plain) return false;
      this.keys = keysOf(JSON.parse(Buffer.from(plain).toString("utf8")));
      plain.fill(0);
      this.wrap = { kdf: shape.kdf, key: kek.slice() };
      return true;
    } finally {
      kek.fill(0);
    }
  }

  /** Writes the key set in `mode` (a passphrase for `passphrase`), replacing the file in one rename. */
  async store(mode: KeyMode, passphrase?: string): Promise<void> {
    if (this.locked) this.active();
    let shape: FileShape;
    const json = JSON.stringify(keysJson(this.keys));
    if (mode === "file") shape = { v: 1, mode: "file", keys: keysJson(this.keys) };
    else if (mode === "keyring") {
      const account = this.opts.account ?? "keys";
      await this.secrets().set({ service: KEYRING_SERVICE, name: account, value: json });
      shape = { v: 1, mode: "keyring", service: KEYRING_SERVICE, account };
    } else if (passphrase === undefined && this.wrap) {
      shape = { v: 1, mode: "passphrase", kdf: this.wrap.kdf, wrapped: b64(gcmSeal(this.wrap.key, Buffer.from(json), PASSPHRASE_AAD)) };
    } else {
      if (!passphrase || passphrase.length < 12) throw new VaultKeyError("vault_key_bad", "a vault passphrase is at least 12 characters");
      const kdf: Kdf = { alg: "scrypt", N: this.opts.scryptN ?? SCRYPT_N, r: 8, p: 1, salt: b64(randomBytes(16)) };
      const kek = derive(passphrase, kdf);
      shape = { v: 1, mode: "passphrase", kdf, wrapped: b64(gcmSeal(kek, Buffer.from(json), PASSPHRASE_AAD)) };
      this.wrap?.key.fill(0);
      this.wrap = { kdf, key: kek };
    }
    if (mode !== "passphrase" && this.wrap) {
      this.wrap.key.fill(0);
      this.wrap = undefined;
    }
    const before = this.shape;
    this.write(shape);
    this.shape = shape;
    // Leaving the keychain: its copy goes once the file no longer points at it.
    if (before?.mode === "keyring" && mode !== "keyring") {
      await this.secrets()
        .delete({ service: before.service, name: before.account })
        .catch(() => false);
    }
  }

  private write(shape: FileShape): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(shape)}\n`, { mode: 0o600, flag: "w" });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }

  /** Writes the key set again in its current mode (a passphrase mode needs `passphrase`). */
  private async save(passphrase?: string): Promise<void> {
    const mode = this.shape?.mode ?? "file";
    if (mode === "passphrase" && passphrase === undefined && !this.wrap) {
      throw new VaultKeyError("vault_key_bad", "changing a passphrase-kept vault key needs its passphrase");
    }
    await this.store(mode, passphrase);
  }

  /** Adds a fresh key that becomes the active one; the old ones stay until `retire`. */
  async add(passphrase?: string): Promise<RootKey> {
    const n = Math.max(0, ...this.keys.map((k) => Number(/^k(\d+)$/.exec(k.id)?.[1] ?? 0))) + 1;
    const fresh: RootKey = { id: `k${n}`, key: newKey(), created: Math.max(this.now(), ...this.keys.map((k) => k.created + 1)) };
    this.keys.push(fresh);
    try {
      await this.save(passphrase);
    } catch (e) {
      this.keys.pop();
      throw e;
    }
    return fresh;
  }

  /** Drops every key but `keep` once nothing is sealed under them. */
  async dropAllBut(keep: string, passphrase?: string): Promise<void> {
    const before = this.keys;
    this.keys = before.filter((k) => k.id === keep);
    try {
      await this.save(passphrase);
    } catch (e) {
      this.keys = before;
      throw e;
    }
    for (const k of before) if (k.id !== keep) k.key.fill(0);
  }

  /** Takes a key back from its recovery code, as key `id` (the one whose check blob it opened). */
  async restore(id: string, key: Uint8Array, created: number): Promise<void> {
    this.keys = [{ id, key, created }];
    this.shape = undefined;
    await this.store("file");
  }
}
