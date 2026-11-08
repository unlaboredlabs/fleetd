import { expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { blake2b, loadOrCreateBoxKey, openSealed, pemOf, publicKeyOf, seal, secretFromPem } from "../src/shared/sealed_box.ts";
import { tempHome } from "./helpers.ts";

/** The Rust node's vectors: a key written by node:crypto, a value sealed by libsodium-wrappers. */
const vectors = JSON.parse(readFileSync(join(import.meta.dir, "../../../crates/fleetd/src/node/testdata/interop.json"), "utf8")) as {
  boxKeyPem: string;
  boxPubKey: string;
  value: string;
  sealed: string;
};
const b64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const text = (s: string) => new TextEncoder().encode(s);

test("BLAKE2b matches RFC 7693's vector, and its own length is in the parameter block", () => {
  expect(Buffer.from(blake2b(text("abc"), 64)).toString("hex")).toBe(
    "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923",
  );
  expect(Buffer.from(blake2b(new Uint8Array(0), 32)).toString("hex")).toBe(
    "0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8",
  );
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
