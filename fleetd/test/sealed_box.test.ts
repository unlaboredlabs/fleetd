import { expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  blake2b,
  loadOrCreateBoxKey,
  openSealed,
  pemOf,
  poly1305,
  publicKeyOf,
  seal,
  secretFromPem,
} from "../src/shared/sealed_box.ts";
import { tempHome } from "./helpers.ts";

/** The Rust node's vectors: a key written by node:crypto, a value sealed by libsodium-wrappers. */
const vectors = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/interop.json"), "utf8")) as {
  boxKeyPem: string;
  boxPubKey: string;
  value: string;
  sealed: string;
};
/** A 1000-byte box native libsodium sealed (`crypto_box_seal`), so 16 Salsa20 blocks and 63 Poly1305 ones. */
const longVector = JSON.parse(readFileSync(join(import.meta.dir, "sealed_box_libsodium.json"), "utf8")) as {
  secret: string;
  publicKey: string;
  sealed: string;
};
const b64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const text = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** Poly1305 as the spec writes it, on BigInt: slow and plainly right, what the fast one is checked against. */
function poly1305Reference(key: Uint8Array, msg: Uint8Array): Uint8Array {
  const le = (b: Uint8Array) => b.reduceRight((n, x) => (n << 8n) | BigInt(x), 0n);
  const p = (1n << 130n) - 5n;
  const r = le(key.subarray(0, 16)) & 0x0ffffffc0ffffffc0ffffffc0fffffffn;
  let h = 0n;
  for (let i = 0; i < msg.length; i += 16) {
    const chunk = msg.subarray(i, i + 16);
    h = ((h + le(chunk) + (1n << BigInt(8 * chunk.length))) * r) % p;
  }
  let tag = (h + le(key.subarray(16, 32))) & ((1n << 128n) - 1n);
  return Uint8Array.from({ length: 16 }, () => {
    const b = Number(tag & 0xffn);
    tag >>= 8n;
    return b;
  });
}

/** Random bytes of any length (getRandomValues takes 64 KB at most). */
function random(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let at = 0; at < n; at += 65536) crypto.getRandomValues(out.subarray(at, at + 65536));
  return out;
}
const randomInt = (below: number) => Math.floor(Math.random() * below);

test("BLAKE2b matches RFC 7693's vector, and its own length is in the parameter block", () => {
  expect(Buffer.from(blake2b(text("abc"), 64)).toString("hex")).toBe(
    "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923",
  );
  expect(Buffer.from(blake2b(new Uint8Array(0), 32)).toString("hex")).toBe(
    "0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8",
  );
});

test("BLAKE2b matches the native BLAKE2b-512 and -256 at random lengths, across block edges", () => {
  for (const n of [127, 128, 129, 255, 256, 257, ...Array.from({ length: 30 }, () => randomInt(2000))]) {
    const data = random(n);
    expect(hex(blake2b(data, 64))).toBe(new Bun.CryptoHasher("blake2b512").update(data).digest("hex"));
    expect(hex(blake2b(data, 32))).toBe(new Bun.CryptoHasher("blake2b256").update(data).digest("hex"));
  }
});

test("Poly1305 matches RFC 8439's vector and the spec's arithmetic at random and extreme inputs", () => {
  const key = Buffer.from("85d6be7857556d337f4452fe42d506a80103808afb0db2fd4abff6af4149f51b", "hex");
  expect(hex(poly1305(key, text("Cryptographic Forum Research Group")))).toBe("a8061dc1305136c6c22b8baf0c0127a9");
  // Appendix A.3's #5 to #9, built to land on the final reduction's edge cases.
  const unhex = (s: string) => Buffer.from(s, "hex");
  const r = (b: string) => b + "00".repeat(15);
  for (const [k, m, tag] of [
    [r("02") + "00".repeat(16), "ff".repeat(16), r("03")],
    [r("02") + "ff".repeat(16), r("02"), r("03")],
    [r("01") + "00".repeat(16), "ff".repeat(16) + "f0" + "ff".repeat(15) + r("11"), r("05")],
    [r("01") + "00".repeat(16), "ff".repeat(16) + "fb" + "fe".repeat(15) + "01".repeat(16), "00".repeat(16)],
    [r("02") + "00".repeat(16), "fd" + "ff".repeat(15), "fa" + "ff".repeat(15)],
  ]) {
    expect(hex(poly1305(unhex(k!), unhex(m!)))).toBe(tag!);
  }
  // All-ones keys and messages push h right up against 2^130 - 5, where the final reduction must pick h - p.
  const ones = (n: number) => new Uint8Array(n).fill(0xff);
  const cases: [Uint8Array, Uint8Array][] = [
    [ones(32), ones(1024)],
    [ones(32), ones(17)],
    [ones(32), new Uint8Array(0)],
    [new Uint8Array(32), ones(64)],
  ];
  for (let i = 0; i < 200; i++) cases.push([random(32), random(randomInt(i < 100 ? 100 : 5000))]);
  for (const [k, m] of cases) expect(hex(poly1305(k, m))).toBe(hex(poly1305Reference(k, m)));
});

test("opens a box libsodium sealed to a key the Rust node reads", () => {
  const secret = secretFromPem(vectors.boxKeyPem)!;
  expect(Buffer.from(publicKeyOf(secret)).toString("base64")).toBe(vectors.boxPubKey);
  expect(pemOf(secret)).toBe(vectors.boxKeyPem);
  const opened = openSealed(secret, b64(vectors.sealed));
  expect(new TextDecoder().decode(opened!)).toBe(vectors.value);

  const tampered = b64(vectors.sealed);
  tampered[40]! ^= 1;
  expect(openSealed(secret, tampered)).toBeNull();
  const other = crypto.getRandomValues(new Uint8Array(32));
  expect(openSealed(other, b64(vectors.sealed))).toBeNull();
  expect(openSealed(secret, new Uint8Array(10))).toBeNull();
});

test("seals what it opens, any length, 48 bytes over", () => {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  for (const n of [0, 1, 15, 16, 17, 31, 32, 33, 63, 64, 65, 200, 5000]) {
    const plain = crypto.getRandomValues(new Uint8Array(n));
    const sealed = seal(publicKeyOf(secret), plain);
    expect(sealed.length).toBe(n + 48);
    expect(openSealed(secret, sealed)).toEqual(plain);
  }
});

test("opens a many-block box native libsodium sealed, and only untampered", () => {
  const secret = b64(longVector.secret);
  expect(Buffer.from(publicKeyOf(secret)).toString("base64")).toBe(longVector.publicKey);
  const opened = openSealed(secret, b64(longVector.sealed))!;
  expect(opened).toEqual(Uint8Array.from({ length: 1000 }, (_, i) => (i * 31 + 7) & 255));
  for (const at of [48, 500, 1047]) {
    const tampered = b64(longVector.sealed);
    tampered[at]! ^= 0x80;
    expect(openSealed(secret, tampered)).toBeNull();
  }
});

test("round-trips at random sizes, aligned or not, and refuses any flipped bit", () => {
  const secret = random(32);
  const pub = publicKeyOf(secret);
  const sizes = [...Array.from({ length: 40 }, () => randomInt(70_000)), 3 * 1024 * 1024 + randomInt(64)];
  for (const n of sizes) {
    // A buffer that starts off a 4-byte boundary takes the bytewise path rather than the word one.
    const shift = randomInt(4);
    const plain = random(n + shift).subarray(shift);
    const sealed = seal(pub, plain);
    expect(sealed.length).toBe(n + 48);
    const copy = new Uint8Array(sealed.length + shift);
    copy.set(sealed, shift);
    expect(openSealed(secret, copy.subarray(shift))).toEqual(plain);
    const at = randomInt(sealed.length);
    sealed[at]! ^= 1 << randomInt(8);
    expect(openSealed(secret, sealed)).toBeNull();
  }
});

test("a box key file is made once, mode 0600, and read back", () => {
  const home = tempHome();
  try {
    const key = loadOrCreateBoxKey(home.dir);
    expect(loadOrCreateBoxKey(home.dir)).toEqual(key);
    expect(statSync(join(home.dir, "node-box-key.pem")).mode & 0o777).toBe(0o600);
  } finally {
    home.done();
  }
});
