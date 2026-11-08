// libsodium's sealed boxes (`crypto_box_seal`), as the Rust hub and node make and open them (crates/fleetd/src/node/
// identity.rs, the `crypto_box` crate) and browsers do with libsodium-wrappers: an ephemeral X25519 key, the nonce
// BLAKE2b-24(ephemeral public ‖ recipient public), and XSalsa20-Poly1305 under HSalsa20 of the shared secret.
// `ephemeral public (32) ‖ tag (16) ‖ ciphertext`. X25519 is node:crypto's; the rest is here, in plain TypeScript on
// 32-bit integers and typed arrays (no BigInt), a few hundred MB/s: scripts/bench-sealed-box.ts times it beside libsodium.
import { createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, type KeyObject, timingSafeEqual } from "node:crypto";
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

function privateKey(secret: Uint8Array): KeyObject {
  if (secret.length !== 32) throw new Error("an X25519 secret key is 32 bytes");
  return createPrivateKey({ key: Buffer.from(concat(PKCS8_X25519, secret)), format: "der", type: "pkcs8" });
}

function publicKey(pub: Uint8Array): KeyObject {
  if (pub.length !== 32) throw new Error("an X25519 public key is 32 bytes");
  return createPublicKey({ key: Buffer.from(concat(SPKI_X25519, pub)), format: "der", type: "spki" });
}

/** The raw 32-byte X25519 public key of a raw secret key. */
export function publicKeyOf(secret: Uint8Array): Uint8Array {
  return publicKey32(createPublicKey(privateKey(secret)));
}

function publicKey32(key: KeyObject): Uint8Array {
  const der = key.export({ format: "der", type: "spki" });
  return new Uint8Array(der.subarray(der.length - 32));
}

// --- Salsa20 / HSalsa20 / XSalsa20 ---

const SIGMA = Uint32Array.from([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);

const LITTLE_ENDIAN = new Uint8Array(Uint32Array.of(1).buffer)[0] === 1;

const u32 = (b: Uint8Array, i: number) => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;

/**
 * The Salsa20 core over the 16-word input `s`, into `out`: with `feed`, the 20 rounds plus the input (a Salsa20 block);
 * without, the rounds alone (HSalsa20 reads words of that). Locals throughout, no allocation: it runs once per 64 bytes.
 */
function core(s: Uint32Array, out: Int32Array, feed: boolean): void {
  let x0 = s[0]! | 0, x1 = s[1]! | 0, x2 = s[2]! | 0, x3 = s[3]! | 0, x4 = s[4]! | 0, x5 = s[5]! | 0;
  let x6 = s[6]! | 0, x7 = s[7]! | 0, x8 = s[8]! | 0, x9 = s[9]! | 0, x10 = s[10]! | 0, x11 = s[11]! | 0;
  let x12 = s[12]! | 0, x13 = s[13]! | 0, x14 = s[14]! | 0, x15 = s[15]! | 0;
  let u: number;
  for (let i = 0; i < 20; i += 2) {
    u = (x0 + x12) | 0; x4 ^= (u << 7) | (u >>> 25);
    u = (x4 + x0) | 0; x8 ^= (u << 9) | (u >>> 23);
    u = (x8 + x4) | 0; x12 ^= (u << 13) | (u >>> 19);
    u = (x12 + x8) | 0; x0 ^= (u << 18) | (u >>> 14);
    u = (x5 + x1) | 0; x9 ^= (u << 7) | (u >>> 25);
    u = (x9 + x5) | 0; x13 ^= (u << 9) | (u >>> 23);
    u = (x13 + x9) | 0; x1 ^= (u << 13) | (u >>> 19);
    u = (x1 + x13) | 0; x5 ^= (u << 18) | (u >>> 14);
    u = (x10 + x6) | 0; x14 ^= (u << 7) | (u >>> 25);
    u = (x14 + x10) | 0; x2 ^= (u << 9) | (u >>> 23);
    u = (x2 + x14) | 0; x6 ^= (u << 13) | (u >>> 19);
    u = (x6 + x2) | 0; x10 ^= (u << 18) | (u >>> 14);
    u = (x15 + x11) | 0; x3 ^= (u << 7) | (u >>> 25);
    u = (x3 + x15) | 0; x7 ^= (u << 9) | (u >>> 23);
    u = (x7 + x3) | 0; x11 ^= (u << 13) | (u >>> 19);
    u = (x11 + x7) | 0; x15 ^= (u << 18) | (u >>> 14);
    u = (x0 + x3) | 0; x1 ^= (u << 7) | (u >>> 25);
    u = (x1 + x0) | 0; x2 ^= (u << 9) | (u >>> 23);
    u = (x2 + x1) | 0; x3 ^= (u << 13) | (u >>> 19);
    u = (x3 + x2) | 0; x0 ^= (u << 18) | (u >>> 14);
    u = (x5 + x4) | 0; x6 ^= (u << 7) | (u >>> 25);
    u = (x6 + x5) | 0; x7 ^= (u << 9) | (u >>> 23);
    u = (x7 + x6) | 0; x4 ^= (u << 13) | (u >>> 19);
    u = (x4 + x7) | 0; x5 ^= (u << 18) | (u >>> 14);
    u = (x10 + x9) | 0; x11 ^= (u << 7) | (u >>> 25);
    u = (x11 + x10) | 0; x8 ^= (u << 9) | (u >>> 23);
    u = (x8 + x11) | 0; x9 ^= (u << 13) | (u >>> 19);
    u = (x9 + x8) | 0; x10 ^= (u << 18) | (u >>> 14);
    u = (x15 + x14) | 0; x12 ^= (u << 7) | (u >>> 25);
    u = (x12 + x15) | 0; x13 ^= (u << 9) | (u >>> 23);
    u = (x13 + x12) | 0; x14 ^= (u << 13) | (u >>> 19);
    u = (x14 + x13) | 0; x15 ^= (u << 18) | (u >>> 14);
  }
  if (feed) {
    x0 = (x0 + s[0]!) | 0; x1 = (x1 + s[1]!) | 0; x2 = (x2 + s[2]!) | 0; x3 = (x3 + s[3]!) | 0;
    x4 = (x4 + s[4]!) | 0; x5 = (x5 + s[5]!) | 0; x6 = (x6 + s[6]!) | 0; x7 = (x7 + s[7]!) | 0;
    x8 = (x8 + s[8]!) | 0; x9 = (x9 + s[9]!) | 0; x10 = (x10 + s[10]!) | 0; x11 = (x11 + s[11]!) | 0;
    x12 = (x12 + s[12]!) | 0; x13 = (x13 + s[13]!) | 0; x14 = (x14 + s[14]!) | 0; x15 = (x15 + s[15]!) | 0;
  }
  out[0] = x0; out[1] = x1; out[2] = x2; out[3] = x3; out[4] = x4; out[5] = x5; out[6] = x6; out[7] = x7;
  out[8] = x8; out[9] = x9; out[10] = x10; out[11] = x11; out[12] = x12; out[13] = x13; out[14] = x14; out[15] = x15;
}

/** The Salsa20 input block: key, 16 bytes of nonce or nonce and counter. */
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
  const x = new Int32Array(16);
  core(block(key, input16), x, false);
  const out = new Uint8Array(32);
  const view = new DataView(out.buffer);
  [0, 5, 10, 15, 6, 7, 8, 9].forEach((w, i) => view.setUint32(i * 4, x[w]!, true));
  return out;
}

/**
 * XSalsa20 under `key` and the 24-byte `nonce`, as crypto_secretbox uses it: the keystream's first 32 bytes are the
 * Poly1305 key, returned, and `data` XOR the keystream from byte 32 on goes to `out` (which may be `data` itself).
 */
function xsalsa20(key: Uint8Array, nonce: Uint8Array, data: Uint8Array, out: Uint8Array): Uint8Array {
  const s = block(hsalsa20(key, nonce.subarray(0, 16)), new Uint8Array(16));
  s[6] = u32(nonce, 16);
  s[7] = u32(nonce, 20);
  const x = new Int32Array(16);
  core(s, x, true);
  const polyKey = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    const w = x[i]!;
    polyKey[i * 4] = w;
    polyKey[i * 4 + 1] = w >>> 8;
    polyKey[i * 4 + 2] = w >>> 16;
    polyKey[i * 4 + 3] = w >>> 24;
  }
  const n = data.length;
  let at = 0;
  for (let w = 8; w < 16; w++) {
    const k = x[w]!;
    for (let b = 0; b < 32 && at < n; b += 8, at++) out[at] = data[at]! ^ (k >>> b);
  }
  // Whole blocks a word at a time where both sides are 4-byte aligned (a little-endian host's words are the stream's).
  const from = at;
  const aligned = LITTLE_ENDIAN && (data.byteOffset + from) % 4 === 0 && (out.byteOffset + from) % 4 === 0;
  const dw = aligned ? new Int32Array(data.buffer, data.byteOffset + from, (n - from) >>> 2) : null;
  const ow = aligned ? new Int32Array(out.buffer, out.byteOffset + from, (n - from) >>> 2) : null;
  for (let counter = 1; at < n; counter++) {
    s[8] = counter;
    s[9] = Math.floor(counter / 2 ** 32);
    core(s, x, true);
    if (dw && ow && n - at >= 64) {
      for (let w = 0, i = (at - from) >>> 2; w < 16; w++, i++) ow[i] = dw[i]! ^ x[w]!;
      at += 64;
      continue;
    }
    for (let w = 0; w < 16; w++) {
      const k = x[w]!;
      for (let b = 0; b < 32 && at < n; b += 8, at++) out[at] = data[at]! ^ (k >>> b);
    }
  }
  return polyKey;
}

// --- Poly1305 ---

/**
 * One 16-byte block `m[p..p+16]` into the Poly1305 state `h`, under `r` (r's ten 13-bit limbs, then 5 × each), as
 * poly1305-donna-16 does it: every partial sum fits 32 bits. Its own small function, so the JIT compiles it as one.
 */
function polyBlock(h: Uint16Array, r: Uint16Array, m: Uint8Array, p: number, hibit: number): void {
  const r0 = r[0]!, r1 = r[1]!, r2 = r[2]!, r3 = r[3]!, r4 = r[4]!, r5 = r[5]!, r6 = r[6]!, r7 = r[7]!, r8 = r[8]!;
  const r9 = r[9]!, s1 = r[11]!, s2 = r[12]!, s3 = r[13]!, s4 = r[14]!, s5 = r[15]!, s6 = r[16]!, s7 = r[17]!;
  const s8 = r[18]!, s9 = r[19]!;
  const t0 = m[p]! | (m[p + 1]! << 8), t1 = m[p + 2]! | (m[p + 3]! << 8);
  const t2 = m[p + 4]! | (m[p + 5]! << 8), t3 = m[p + 6]! | (m[p + 7]! << 8);
  const t4 = m[p + 8]! | (m[p + 9]! << 8), t5 = m[p + 10]! | (m[p + 11]! << 8);
  const t6 = m[p + 12]! | (m[p + 13]! << 8), t7 = m[p + 14]! | (m[p + 15]! << 8);
  const h0 = h[0]! + (t0 & 0x1fff);
  const h1 = h[1]! + (((t0 >>> 13) | (t1 << 3)) & 0x1fff);
  const h2 = h[2]! + (((t1 >>> 10) | (t2 << 6)) & 0x1fff);
  const h3 = h[3]! + (((t2 >>> 7) | (t3 << 9)) & 0x1fff);
  const h4 = h[4]! + (((t3 >>> 4) | (t4 << 12)) & 0x1fff);
  const h5 = h[5]! + ((t4 >>> 1) & 0x1fff);
  const h6 = h[6]! + (((t4 >>> 14) | (t5 << 2)) & 0x1fff);
  const h7 = h[7]! + (((t5 >>> 11) | (t6 << 5)) & 0x1fff);
  const h8 = h[8]! + (((t6 >>> 8) | (t7 << 8)) & 0x1fff);
  const h9 = h[9]! + ((t7 >>> 5) | hibit);

  // h *= r: each limb's ten products in two halves, carried between, so no sum passes 2^32.
  let c: number;
  let d0 = h0 * r0 + h1 * s9 + h2 * s8 + h3 * s7 + h4 * s6;
  c = d0 >>> 13; d0 &= 0x1fff;
  d0 += h5 * s5 + h6 * s4 + h7 * s3 + h8 * s2 + h9 * s1;
  c += d0 >>> 13; d0 &= 0x1fff;
  let d1 = c + h0 * r1 + h1 * r0 + h2 * s9 + h3 * s8 + h4 * s7;
  c = d1 >>> 13; d1 &= 0x1fff;
  d1 += h5 * s6 + h6 * s5 + h7 * s4 + h8 * s3 + h9 * s2;
  c += d1 >>> 13; d1 &= 0x1fff;
  let d2 = c + h0 * r2 + h1 * r1 + h2 * r0 + h3 * s9 + h4 * s8;
  c = d2 >>> 13; d2 &= 0x1fff;
  d2 += h5 * s7 + h6 * s6 + h7 * s5 + h8 * s4 + h9 * s3;
  c += d2 >>> 13; d2 &= 0x1fff;
  let d3 = c + h0 * r3 + h1 * r2 + h2 * r1 + h3 * r0 + h4 * s9;
  c = d3 >>> 13; d3 &= 0x1fff;
  d3 += h5 * s8 + h6 * s7 + h7 * s6 + h8 * s5 + h9 * s4;
  c += d3 >>> 13; d3 &= 0x1fff;
  let d4 = c + h0 * r4 + h1 * r3 + h2 * r2 + h3 * r1 + h4 * r0;
  c = d4 >>> 13; d4 &= 0x1fff;
  d4 += h5 * s9 + h6 * s8 + h7 * s7 + h8 * s6 + h9 * s5;
  c += d4 >>> 13; d4 &= 0x1fff;
  let d5 = c + h0 * r5 + h1 * r4 + h2 * r3 + h3 * r2 + h4 * r1;
  c = d5 >>> 13; d5 &= 0x1fff;
  d5 += h5 * r0 + h6 * s9 + h7 * s8 + h8 * s7 + h9 * s6;
  c += d5 >>> 13; d5 &= 0x1fff;
  let d6 = c + h0 * r6 + h1 * r5 + h2 * r4 + h3 * r3 + h4 * r2;
  c = d6 >>> 13; d6 &= 0x1fff;
  d6 += h5 * r1 + h6 * r0 + h7 * s9 + h8 * s8 + h9 * s7;
  c += d6 >>> 13; d6 &= 0x1fff;
  let d7 = c + h0 * r7 + h1 * r6 + h2 * r5 + h3 * r4 + h4 * r3;
  c = d7 >>> 13; d7 &= 0x1fff;
  d7 += h5 * r2 + h6 * r1 + h7 * r0 + h8 * s9 + h9 * s8;
  c += d7 >>> 13; d7 &= 0x1fff;
  let d8 = c + h0 * r8 + h1 * r7 + h2 * r6 + h3 * r5 + h4 * r4;
  c = d8 >>> 13; d8 &= 0x1fff;
  d8 += h5 * r3 + h6 * r2 + h7 * r1 + h8 * r0 + h9 * s9;
  c += d8 >>> 13; d8 &= 0x1fff;
  let d9 = c + h0 * r9 + h1 * r8 + h2 * r7 + h3 * r6 + h4 * r5;
  c = d9 >>> 13; d9 &= 0x1fff;
  d9 += h5 * r4 + h6 * r3 + h7 * r2 + h8 * r1 + h9 * r0;
  c += d9 >>> 13; d9 &= 0x1fff;
  // 2^130 ≡ 5 (mod p): the carry out of limb 9 comes back in at limb 0, times 5.
  c = (c * 5 + d0) | 0;
  h[0] = c & 0x1fff;
  h[1] = d1 + (c >>> 13);
  h[2] = d2; h[3] = d3; h[4] = d4; h[5] = d5; h[6] = d6; h[7] = d7; h[8] = d8; h[9] = d9;
}

/** Poly1305 of `msg` under the one-time 32-byte `key`: libsodium's crypto_onetimeauth, on 13-bit limbs. */
export function poly1305(key: Uint8Array, msg: Uint8Array): Uint8Array {
  const k = (i: number) => key[i]! | (key[i + 1]! << 8);
  const t0 = k(0), t1 = k(2), t2 = k(4), t3 = k(6), t4 = k(8), t5 = k(10), t6 = k(12), t7 = k(14);
  // r, clamped as the spec says (the masks), then 5 × each limb.
  const r = new Uint16Array(20);
  r[0] = t0 & 0x1fff;
  r[1] = ((t0 >>> 13) | (t1 << 3)) & 0x1fff;
  r[2] = ((t1 >>> 10) | (t2 << 6)) & 0x1f03;
  r[3] = ((t2 >>> 7) | (t3 << 9)) & 0x1fff;
  r[4] = ((t3 >>> 4) | (t4 << 12)) & 0x00ff;
  r[5] = (t4 >>> 1) & 0x1ffe;
  r[6] = ((t4 >>> 14) | (t5 << 2)) & 0x1fff;
  r[7] = ((t5 >>> 11) | (t6 << 5)) & 0x1f81;
  r[8] = ((t6 >>> 8) | (t7 << 8)) & 0x1fff;
  r[9] = (t7 >>> 5) & 0x007f;
  for (let i = 0; i < 10; i++) r[10 + i] = 5 * r[i]!;

  const h = new Uint16Array(10);
  const whole = msg.length & ~15;
  for (let at = 0; at < whole; at += 16) polyBlock(h, r, msg, at, 1 << 11);
  if (whole < msg.length) {
    const last = new Uint8Array(16);
    last.set(msg.subarray(whole));
    last[msg.length - whole] = 1;
    polyBlock(h, r, last, 0, 0);
  }

  // Carry h fully, then take h - p when h ≥ p (in constant time, as libsodium does).
  let c = h[1]! >>> 13;
  h[1]! &= 0x1fff;
  for (let i = 2; i < 10; i++) {
    h[i]! += c;
    c = h[i]! >>> 13;
    h[i]! &= 0x1fff;
  }
  h[0]! += c * 5;
  c = h[0]! >>> 13;
  h[0]! &= 0x1fff;
  h[1]! += c;
  c = h[1]! >>> 13;
  h[1]! &= 0x1fff;
  h[2]! += c;
  const g = new Uint16Array(10);
  g[0] = h[0]! + 5;
  c = g[0] >>> 13;
  g[0] &= 0x1fff;
  for (let i = 1; i < 10; i++) {
    g[i] = h[i]! + c;
    c = g[i]! >>> 13;
    g[i]! &= 0x1fff;
  }
  // c is h + 5's carry out of bit 130: 1 exactly when h ≥ p, and then h - p is g's low 130 bits.
  const mask = -c;
  for (let i = 0; i < 10; i++) h[i] = (h[i]! & ~mask) | (g[i]! & mask);

  // Back to eight 16-bit words, plus the pad (key bytes 16..32) mod 2^128.
  const w = [
    h[0]! | (h[1]! << 13),
    (h[1]! >>> 3) | (h[2]! << 10),
    (h[2]! >>> 6) | (h[3]! << 7),
    (h[3]! >>> 9) | (h[4]! << 4),
    (h[4]! >>> 12) | (h[5]! << 1) | (h[6]! << 14),
    (h[6]! >>> 2) | (h[7]! << 11),
    (h[7]! >>> 5) | (h[8]! << 8),
    (h[8]! >>> 8) | (h[9]! << 5),
  ];
  const tag = new Uint8Array(16);
  let f = 0;
  for (let i = 0; i < 8; i++) {
    f = (w[i]! & 0xffff) + k(16 + 2 * i) + (f >>> 16);
    tag[2 * i] = f;
    tag[2 * i + 1] = f >>> 8;
  }
  return tag;
}

// --- BLAKE2b ---

// 64-bit words as (low, high) pairs of 32-bit halves: word i is at [2i] and [2i + 1].
const IV = Uint32Array.from([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a,
  0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
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

/** v[a] += v[b] + (lo, hi), mod 2^64 (word offsets, as pair indices). */
function add64(v: Uint32Array, a: number, b: number, lo: number, hi: number): void {
  const l = v[a]! + v[b]! + lo;
  v[a] = l;
  v[a + 1] = v[a + 1]! + v[b + 1]! + hi + Math.floor(l / 2 ** 32);
}

/** BLAKE2b's G on words a, b, c, d of `v` with message words x and y of `m`. */
function g2b(v: Uint32Array, m: Uint32Array, a: number, b: number, c: number, d: number, x: number, y: number): void {
  a *= 2; b *= 2; c *= 2; d *= 2; x *= 2; y *= 2;
  let lo: number, hi: number;
  add64(v, a, b, m[x]!, m[x + 1]!);
  lo = v[d]! ^ v[a]!; hi = v[d + 1]! ^ v[a + 1]!;
  v[d] = hi; v[d + 1] = lo; // rotr 32
  add64(v, c, d, 0, 0);
  lo = v[b]! ^ v[c]!; hi = v[b + 1]! ^ v[c + 1]!;
  v[b] = (lo >>> 24) | (hi << 8); v[b + 1] = (hi >>> 24) | (lo << 8); // rotr 24
  add64(v, a, b, m[y]!, m[y + 1]!);
  lo = v[d]! ^ v[a]!; hi = v[d + 1]! ^ v[a + 1]!;
  v[d] = (lo >>> 16) | (hi << 16); v[d + 1] = (hi >>> 16) | (lo << 16); // rotr 16
  add64(v, c, d, 0, 0);
  lo = v[b]! ^ v[c]!; hi = v[b + 1]! ^ v[c + 1]!;
  v[b] = (hi >>> 31) | (lo << 1); v[b + 1] = (lo >>> 31) | (hi << 1); // rotr 63
}

/** Unkeyed BLAKE2b with an `outLen`-byte digest (the parameter block's own, not a cut of BLAKE2b-512). */
export function blake2b(data: Uint8Array, outLen: number): Uint8Array {
  const h = IV.slice();
  h[0] = h[0]! ^ 0x01010000 ^ outLen;
  const v = new Uint32Array(32);
  const m = new Uint32Array(32);
  const chunk = new Uint8Array(m.buffer);
  const blocks = Math.max(1, Math.ceil(data.length / 128));
  for (let b = 0; b < blocks; b++) {
    const last = b === blocks - 1;
    chunk.fill(0);
    chunk.set(data.subarray(b * 128, b * 128 + 128));
    if (!LITTLE_ENDIAN) for (let i = 0; i < 32; i++) m[i] = u32(chunk, i * 4);
    const t = last ? data.length : (b + 1) * 128;
    v.set(h, 0);
    v.set(IV, 16);
    v[24] = v[24]! ^ t;
    v[25] = v[25]! ^ Math.floor(t / 2 ** 32);
    if (last) {
      v[28] = ~v[28]!;
      v[29] = ~v[29]!;
    }
    for (let r = 0; r < 12; r++) {
      const s = SIGMA2B[r % 10]!;
      g2b(v, m, 0, 4, 8, 12, s[0], s[1]);
      g2b(v, m, 1, 5, 9, 13, s[2], s[3]);
      g2b(v, m, 2, 6, 10, 14, s[4], s[5]);
      g2b(v, m, 3, 7, 11, 15, s[6], s[7]);
      g2b(v, m, 0, 5, 10, 15, s[8], s[9]);
      g2b(v, m, 1, 6, 11, 12, s[10], s[11]);
      g2b(v, m, 2, 7, 8, 13, s[12], s[13]);
      g2b(v, m, 3, 4, 9, 14, s[14], s[15]);
    }
    for (let i = 0; i < 16; i++) h[i] = h[i]! ^ v[i]! ^ v[i + 16]!;
  }
  const out = new Uint8Array(64);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 16; i++) view.setUint32(i * 4, h[i]!, true);
  return out.slice(0, outLen);
}

// --- crypto_box ---

/** crypto_box_beforenm: HSalsa20 of the X25519 shared secret; null for a low-order key (an all-zero secret). */
function beforenm(own: KeyObject, pub: Uint8Array): Uint8Array | null {
  const shared = new Uint8Array(diffieHellman({ privateKey: own, publicKey: publicKey(pub) }));
  if (shared.every((b) => b === 0)) return null;
  return hsalsa20(shared, new Uint8Array(16));
}

function sealNonce(ephemeral: Uint8Array, recipient: Uint8Array): Uint8Array {
  return blake2b(concat(ephemeral, recipient), 24);
}

/** Seals `plain` to the raw X25519 `publicKey`: only its secret key's holder opens it. */
export function seal(publicKey: Uint8Array, plain: Uint8Array): Uint8Array {
  const pair = generateKeyPairSync("x25519");
  const epk = publicKey32(pair.publicKey);
  const k = beforenm(pair.privateKey, publicKey);
  if (!k) throw new Error("that public key can't be sealed to");
  const nonce = sealNonce(epk, publicKey);
  const out = new Uint8Array(SEAL_OVERHEAD + plain.length);
  out.set(epk);
  const cipher = out.subarray(SEAL_OVERHEAD);
  out.set(poly1305(xsalsa20(k, nonce, plain, cipher), cipher), 32);
  return out;
}

/** Opens a sealed box with the raw X25519 `secret`; null when it wasn't sealed to that key or was tampered with. */
export function openSealed(secret: Uint8Array, sealed: Uint8Array): Uint8Array | null {
  if (sealed.length < SEAL_OVERHEAD) return null;
  const epk = sealed.subarray(0, 32);
  const tag = sealed.subarray(32, 48);
  const cipher = sealed.subarray(48);
  let own: KeyObject, k: Uint8Array | null;
  try {
    own = privateKey(secret);
    k = beforenm(own, epk);
  } catch {
    return null;
  }
  if (!k) return null;
  const nonce = sealNonce(epk, publicKey32(createPublicKey(own)));
  // The tag covers the ciphertext, so decrypting first (which yields the Poly1305 key) is safe: a bad tag wipes it all.
  const plain = new Uint8Array(cipher.length);
  if (timingSafeEqual(poly1305(xsalsa20(k, nonce, cipher, plain), cipher), tag)) return plain;
  plain.fill(0);
  return null;
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
