// The node's keys (crates/fleetd/src/node/identity.rs), as PKCS#8 PEM files: the ed25519 identity that signs the hub's
// challenge (`node-key.pem`) and the X25519 key secrets are sealed to (`node-box-key.pem`). Both are created mode 0600
// on first use, so the Rust node and this one read each other's.
import { createPrivateKey, createPublicKey, randomBytes, sign } from "node:crypto";
import { existsSync, openSync, readFileSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";
import { mkdirPrivate } from "./config.ts";
import { openSealed, publicKeyOf, seal } from "../shared/sealed_box.ts";

const KEY_FILE = "node-key.pem";
const BOX_KEY_FILE = "node-box-key.pem";
const ED25519_OID = 0x70;
const X25519_OID = 0x6e;

/** PKCS#8 v1 DER for a bare 32-byte key: SEQUENCE { INTEGER 0, SEQUENCE { OID }, OCTET STRING { OCTET STRING key } }. */
const prefix = (oidLast: number) =>
  Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, oidLast, 0x04, 0x22, 0x04, 0x20]);

function toPem(oidLast: number, key: Uint8Array): string {
  const der = Buffer.concat([prefix(oidLast), key]);
  const body = der.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${body.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

function fromPem(oidLast: number, pem: string): Uint8Array | undefined {
  const body = pem
    .split("\n")
    .filter((l) => !l.startsWith("-----"))
    .map((l) => l.trim())
    .join("");
  const der = Buffer.from(body, "base64");
  const want = prefix(oidLast);
  if (der.length !== 48 || !want.every((b, i) => der[i] === b)) return undefined;
  return new Uint8Array(der.subarray(16));
}

/** The key in `<home>/<file>`, or a fresh one written there (exclusive create, mode 0600). */
function loadOrCreate(home: string, file: string, oidLast: number): Uint8Array {
  const path = join(home, file);
  if (existsSync(path)) {
    const key = fromPem(oidLast, readFileSync(path, "utf8"));
    if (!key) throw new Error("not a PKCS#8 key of the expected type");
    return key;
  }
  mkdirPrivate(home);
  const key = new Uint8Array(randomBytes(32));
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, toPem(oidLast, key));
  } finally {
    closeSync(fd);
  }
  return key;
}

export class NodeIdentity {
  readonly #key: ReturnType<typeof createPrivateKey>;
  constructor(seed: Uint8Array) {
    this.#key = createPrivateKey({ key: Buffer.concat([prefix(ED25519_OID), seed]), format: "der", type: "pkcs8" });
  }
  /** Raw 32-byte ed25519 public key, base64. */
  pubKey(): string {
    const der = createPublicKey(this.#key).export({ format: "der", type: "spki" });
    return Buffer.from(der.subarray(der.length - 32)).toString("base64");
  }
  /** Signature over the nonce's UTF-8 bytes, base64. */
  sign(nonce: string): string {
    return sign(null, Buffer.from(nonce, "utf8"), this.#key).toString("base64");
  }
}

export const loadOrCreateIdentity = (home: string) => new NodeIdentity(loadOrCreate(home, KEY_FILE, ED25519_OID));

export class NodeBoxKey {
  readonly #secret: Uint8Array;
  constructor(secret: Uint8Array) {
    this.#secret = secret;
  }
  /** Raw 32-byte X25519 public key, standard base64: what the app seals this machine's secrets to. */
  publicKey(): string {
    return Buffer.from(publicKeyOf(this.#secret)).toString("base64");
  }
  /** Opens a libsodium sealed box; null when it was not sealed to this key or was tampered with. */
  open(sealed: Uint8Array): Uint8Array | null {
    return openSealed(this.#secret, sealed);
  }
  /** Seals `plain` to this key, as the app does. */
  seal(plain: Uint8Array): Uint8Array {
    return seal(publicKeyOf(this.#secret), plain);
  }
}

export const loadOrCreateBoxKey = (home: string) => new NodeBoxKey(loadOrCreate(home, BOX_KEY_FILE, X25519_OID));
