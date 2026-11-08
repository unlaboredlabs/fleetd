// libsodium's sealed boxes (`crypto_box_seal`), as the Rust hub and node make and open them (crates/fleetd/src/node/
// identity.rs, the `crypto_box` crate) and browsers do with libsodium-wrappers: an ephemeral X25519 key, the nonce
// BLAKE2b-24(ephemeral public ‖ recipient public), and XSalsa20-Poly1305 under HSalsa20 of the shared secret.
// `ephemeral public (32) ‖ tag (16) ‖ ciphertext`. X25519 is node:crypto's; the rest is here, in plain TypeScript.
import { createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** PKCS #8 and SPKI DER prefixes for a bare 32-byte X25519 key (OID 1.3.101.110). */
const PKCS8_X25519 = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20]);
const SPKI_X25519 = Uint8Array.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00]);

/** What sealing adds to the plaintext: the ephemeral public key and the tag. */
export const SEAL_OVERHEAD = 48;

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function privateKey(secret: Uint8Array) {
  if (secret.length !== 32) throw new Error("an X25519 secret key is 32 bytes");
  return createPrivateKey({ key: Buffer.from(concat(PKCS8_X25519, secret)), format: "der", type: "pkcs8" });
}

function publicKey(pub: Uint8Array) {
  if (pub.length !== 32) throw new Error("an X25519 public key is 32 bytes");
  return createPublicKey({ key: Buffer.from(concat(SPKI_X25519, pub)), format: "der", type: "spki" });
}

/** The raw 32-byte X25519 public key of a raw secret key. */
export function publicKeyOf(secret: Uint8Array): Uint8Array {
  return publicKey32(createPublicKey(privateKey(secret)));
}

function publicKey32(key: ReturnType<typeof createPublicKey>): Uint8Array {
  const der = key.export({ format: "der", type: "spki" });
  return new Uint8Array(der.subarray(der.length - 32));
}

// --- Salsa20 / HSalsa20 / XSalsa20 ---

const SIGMA = Uint32Array.from([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);

const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));
const u32 = (b: Uint8Array, i: number) => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;

/** The 20 Salsa rounds over `x` in place. */
function rounds(x: Uint32Array): void {
  for (let i = 0; i < 20; i += 2) {
    x[4]! ^= rotl((x[0]! + x[12]!) | 0, 7);
    x[8]! ^= rotl((x[4]! + x[0]!) | 0, 9);
    x[12]! ^= rotl((x[8]! + x[4]!) | 0, 13);
    x[0]! ^= rotl((x[12]! + x[8]!) | 0, 18);
    x[9]! ^= rotl((x[5]! + x[1]!) | 0, 7);
    x[13]! ^= rotl((x[9]! + x[5]!) | 0, 9);
    x[1]! ^= rotl((x[13]! + x[9]!) | 0, 13);
    x[5]! ^= rotl((x[1]! + x[13]!) | 0, 18);
    x[14]! ^= rotl((x[10]! + x[6]!) | 0, 7);
    x[2]! ^= rotl((x[14]! + x[10]!) | 0, 9);
    x[6]! ^= rotl((x[2]! + x[14]!) | 0, 13);
    x[10]! ^= rotl((x[6]! + x[2]!) | 0, 18);
    x[3]! ^= rotl((x[15]! + x[11]!) | 0, 7);
    x[7]! ^= rotl((x[3]! + x[15]!) | 0, 9);
    x[11]! ^= rotl((x[7]! + x[3]!) | 0, 13);
    x[15]! ^= rotl((x[11]! + x[7]!) | 0, 18);
    x[1]! ^= rotl((x[0]! + x[3]!) | 0, 7);
    x[2]! ^= rotl((x[1]! + x[0]!) | 0, 9);
    x[3]! ^= rotl((x[2]! + x[1]!) | 0, 13);
    x[0]! ^= rotl((x[3]! + x[2]!) | 0, 18);
    x[6]! ^= rotl((x[5]! + x[4]!) | 0, 7);
    x[7]! ^= rotl((x[6]! + x[5]!) | 0, 9);
    x[4]! ^= rotl((x[7]! + x[6]!) | 0, 13);
    x[5]! ^= rotl((x[4]! + x[7]!) | 0, 18);
    x[11]! ^= rotl((x[10]! + x[9]!) | 0, 7);
    x[8]! ^= rotl((x[11]! + x[10]!) | 0, 9);
    x[9]! ^= rotl((x[8]! + x[11]!) | 0, 13);
    x[10]! ^= rotl((x[9]! + x[8]!) | 0, 18);
    x[12]! ^= rotl((x[15]! + x[14]!) | 0, 7);
    x[13]! ^= rotl((x[12]! + x[15]!) | 0, 9);
    x[14]! ^= rotl((x[13]! + x[12]!) | 0, 13);
    x[15]! ^= rotl((x[14]! + x[13]!) | 0, 18);
  }
}

/** The Salsa20 input block: key, 16 bytes of nonce or counter. */
function block(key: Uint8Array, input16: Uint8Array): Uint32Array {
  const s = new Uint32Array(16);
  s[0] = SIGMA[0]!;
  s[5] = SIGMA[1]!;
  s[10] = SIGMA[2]!;
  s[15] = SIGMA[3]!;
  for (let i = 0; i < 4; i++) {
    s[1 + i] = u32(key, i * 4);
    s[11 + i] = u32(key, 16 + i * 4);
    s[6 + i] = u32(input16, i * 4);
  }
  return s;
}

/** HSalsa20: a 32-byte subkey of `key` and a 16-byte input. */
function hsalsa20(key: Uint8Array, input16: Uint8Array): Uint8Array {
  const x = block(key, input16);
  rounds(x);
  const out = new Uint8Array(32);
  const view = new DataView(out.buffer);
  [0, 5, 10, 15, 6, 7, 8, 9].forEach((w, i) => view.setUint32(i * 4, x[w]!, true));
  return out;
}

/** `data` XOR XSalsa20's keystream under `key` and the 24-byte `nonce`, from keystream byte `skip`. */
function xsalsa20Xor(key: Uint8Array, nonce: Uint8Array, data: Uint8Array, skip: number): Uint8Array {
  const sub = hsalsa20(key, nonce.subarray(0, 16));
  const input = new Uint8Array(16);
  input.set(nonce.subarray(16, 24), 0);
  const out = new Uint8Array(data.length);
  const ks = new Uint8Array(64);
  const view = new DataView(ks.buffer);
  let counter = 0;
  for (let at = -skip; at < data.length; at += 64, counter++) {
    new DataView(input.buffer).setUint32(8, counter >>> 0, true);
    new DataView(input.buffer).setUint32(12, Math.floor(counter / 2 ** 32), true);
    const s = block(sub, input);
    const x = s.slice();
    rounds(x);
    for (let i = 0; i < 16; i++) view.setUint32(i * 4, (x[i]! + s[i]!) >>> 0, true);
    for (let i = 0; i < 64; i++) {
      const j = at + i;
      if (j >= 0 && j < data.length) out[j] = data[j]! ^ ks[i]!;
    }
  }
  return out;
}

// --- Poly1305 ---

const P1305 = (1n << 130n) - 5n;

function leNum(b: Uint8Array): bigint {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]!);
  return n;
}

function poly1305(key: Uint8Array, msg: Uint8Array): Uint8Array {
  const r = leNum(key.subarray(0, 16)) & 0x0ffffffc0ffffffc0ffffffc0fffffffn;
  const s = leNum(key.subarray(16, 32));
  let h = 0n;
  for (let i = 0; i < msg.length; i += 16) {
    const chunk = msg.subarray(i, i + 16);
    h = ((h + leNum(chunk) + (1n << BigInt(8 * chunk.length))) * r) % P1305;
  }
  let tag = (h + s) & ((1n << 128n) - 1n);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = Number(tag & 0xffn);
    tag >>= 8n;
  }
  return out;
}

// --- BLAKE2b ---

const IV = BigUint64Array.from([
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
]);
const SIGMA2B = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
] as const;
const M64 = (1n << 64n) - 1n;
const rotr64 = (x: bigint, n: bigint) => ((x >> n) | (x << (64n - n))) & M64;

/** Unkeyed BLAKE2b with an `outLen`-byte digest (the parameter block's own, not a cut of BLAKE2b-512). */
export function blake2b(data: Uint8Array, outLen: number): Uint8Array {
  const h = IV.slice();
  h[0] = h[0]! ^ 0x01010000n ^ BigInt(outLen);
  const blocks = Math.max(1, Math.ceil(data.length / 128));
  for (let b = 0; b < blocks; b++) {
    const chunk = new Uint8Array(128);
    chunk.set(data.subarray(b * 128, b * 128 + 128));
    const last = b === blocks - 1;
    const t = BigInt(last ? data.length : (b + 1) * 128);
    const m = new BigUint64Array(16);
    const view = new DataView(chunk.buffer);
    for (let i = 0; i < 16; i++) m[i] = view.getBigUint64(i * 8, true);
    const v = new BigUint64Array(16);
    v.set(h, 0);
    v.set(IV, 8);
    v[12] = v[12]! ^ (t & M64);
    v[13] = v[13]! ^ (t >> 64n);
    if (last) v[14] = v[14]! ^ M64;
    const g = (a: number, bb: number, c: number, d: number, x: bigint, y: bigint) => {
      v[a] = (v[a]! + v[bb]! + x) & M64;
      v[d] = rotr64(v[d]! ^ v[a]!, 32n);
      v[c] = (v[c]! + v[d]!) & M64;
      v[bb] = rotr64(v[bb]! ^ v[c]!, 24n);
      v[a] = (v[a]! + v[bb]! + y) & M64;
      v[d] = rotr64(v[d]! ^ v[a]!, 16n);
      v[c] = (v[c]! + v[d]!) & M64;
      v[bb] = rotr64(v[bb]! ^ v[c]!, 63n);
    };
    for (let r = 0; r < 12; r++) {
      const s = SIGMA2B[r % 10]!;
      g(0, 4, 8, 12, m[s[0]]!, m[s[1]]!);
      g(1, 5, 9, 13, m[s[2]]!, m[s[3]]!);
      g(2, 6, 10, 14, m[s[4]]!, m[s[5]]!);
      g(3, 7, 11, 15, m[s[6]]!, m[s[7]]!);
      g(0, 5, 10, 15, m[s[8]]!, m[s[9]]!);
      g(1, 6, 11, 12, m[s[10]]!, m[s[11]]!);
      g(2, 7, 8, 13, m[s[12]]!, m[s[13]]!);
      g(3, 4, 9, 14, m[s[14]]!, m[s[15]]!);
    }
    for (let i = 0; i < 8; i++) h[i] = h[i]! ^ v[i]! ^ v[i + 8]!;
  }
  const out = new Uint8Array(64);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) view.setBigUint64(i * 8, h[i]!, true);
  return out.slice(0, outLen);
}

// --- crypto_box ---

/** crypto_box_beforenm: HSalsa20 of the X25519 shared secret; null for a low-order key (an all-zero secret). */
function beforenm(secret: Uint8Array, pub: Uint8Array): Uint8Array | null {
  const shared = new Uint8Array(diffieHellman({ privateKey: privateKey(secret), publicKey: publicKey(pub) }));
  if (shared.every((b) => b === 0)) return null;
  return hsalsa20(shared, new Uint8Array(16));
}

function sealNonce(ephemeral: Uint8Array, recipient: Uint8Array): Uint8Array {
  return blake2b(concat(ephemeral, recipient), 24);
}

/** Seals `plain` to the raw X25519 `publicKey`: only its secret key's holder opens it. */
export function seal(publicKey: Uint8Array, plain: Uint8Array): Uint8Array {
  const pair = generateKeyPairSync("x25519");
  const esk = (() => {
    const der = pair.privateKey.export({ format: "der", type: "pkcs8" });
    return new Uint8Array(der.subarray(der.length - 32));
  })();
  const epk = publicKey32(pair.publicKey);
  const k = beforenm(esk, publicKey);
  esk.fill(0);
  if (!k) throw new Error("that public key can't be sealed to");
  const nonce = sealNonce(epk, publicKey);
  const polyKey = xsalsa20Xor(k, nonce, new Uint8Array(32), 0);
  const cipher = xsalsa20Xor(k, nonce, plain, 32);
  return concat(epk, poly1305(polyKey, cipher), cipher);
}

/** Opens a sealed box with the raw X25519 `secret`; null when it wasn't sealed to that key or was tampered with. */
export function openSealed(secret: Uint8Array, sealed: Uint8Array): Uint8Array | null {
  if (sealed.length < SEAL_OVERHEAD) return null;
  const epk = sealed.subarray(0, 32);
  const tag = sealed.subarray(32, 48);
  const cipher = sealed.subarray(48);
  let k: Uint8Array | null;
  try {
    k = beforenm(secret, epk);
  } catch {
    return null;
  }
  if (!k) return null;
  const nonce = sealNonce(epk, publicKeyOf(secret));
  const polyKey = xsalsa20Xor(k, nonce, new Uint8Array(32), 0);
  if (!timingSafeEqual(poly1305(polyKey, cipher), tag)) return null;
  return xsalsa20Xor(k, nonce, cipher, 32);
}

// --- crypto_secretbox ---

/** NaCl's secretbox (XSalsa20-Poly1305) under a 32-byte `key` and 24-byte `nonce`: the tag, then the ciphertext. */
export function secretbox(key: Uint8Array, nonce: Uint8Array, plain: Uint8Array): Uint8Array {
  const polyKey = xsalsa20Xor(key, nonce, new Uint8Array(32), 0);
  const cipher = xsalsa20Xor(key, nonce, plain, 32);
  return concat(poly1305(polyKey, cipher), cipher);
}

/** Opens a `secretbox`; null when it was sealed under another key or nonce, or tampered with. */
export function secretboxOpen(key: Uint8Array, nonce: Uint8Array, boxed: Uint8Array): Uint8Array | null {
  if (boxed.length < 16) return null;
  const polyKey = xsalsa20Xor(key, nonce, new Uint8Array(32), 0);
  const cipher = boxed.subarray(16);
  if (!timingSafeEqual(poly1305(polyKey, cipher), boxed.subarray(0, 16))) return null;
  return xsalsa20Xor(key, nonce, cipher, 32);
}

// --- key files ---

/** The raw key of a PKCS #8 PEM X25519 key file, as the Rust node and hub write one; null for anything else. */
export function secretFromPem(pem: string): Uint8Array | null {
  const body = pem
    .split("\n")
    .filter((l) => !l.startsWith("-----"))
    .map((l) => l.trim())
    .join("");
  const der = new Uint8Array(Buffer.from(body, "base64"));
  if (der.length !== 48 || !PKCS8_X25519.every((b, i) => der[i] === b)) return null;
  return der.slice(16);
}

/** A raw X25519 key as the PKCS #8 PEM the Rust code writes: 64-character lines, a trailing newline. */
export function pemOf(secret: Uint8Array): string {
  const body = Buffer.from(concat(PKCS8_X25519, secret)).toString("base64");
  return `-----BEGIN PRIVATE KEY-----\n${body.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

/** The box key in `<home>/node-box-key.pem` (the hub's and a node's), or a fresh one written there with mode 0600. */
export function loadOrCreateBoxKey(home: string): Uint8Array {
  const path = join(home, "node-box-key.pem");
  if (existsSync(path)) {
    const key = secretFromPem(readFileSync(path, "utf8"));
    if (!key) throw new Error(`${path}: not a PKCS#8 key of the expected type`);
    return key;
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const key = crypto.getRandomValues(new Uint8Array(32));
  writeFileSync(path, pemOf(key), { mode: 0o600, flag: "wx" });
  return key;
}
