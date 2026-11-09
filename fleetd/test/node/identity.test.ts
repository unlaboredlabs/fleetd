import { expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicKey, verify } from "node:crypto";
import { loadOrCreateBoxKey, loadOrCreateIdentity } from "../../src/node/identity.ts";
import { blake2b, openSealed, publicKeyOf, seal } from "../../src/shared/sealed_box.ts";
import { tempHome } from "../helpers.ts";

const vectors = JSON.parse(
  readFileSync(join(import.meta.dir, "../fixtures/interop.json"), "utf8"),
) as { boxKeyPem: string; boxPubKey: string; value: string; sealed: string };

test("the hello's signature verifies over the nonce and nothing else, and the key file is 0600", () => {
  const home = tempHome();
  try {
    const id = loadOrCreateIdentity(home.dir);
    expect(loadOrCreateIdentity(home.dir).pubKey()).toBe(id.pubKey());
    expect(statSync(join(home.dir, "node-key.pem")).mode & 0o777).toBe(0o600);
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(id.pubKey(), "base64")]);
    const pub = createPublicKey({ key: spki, format: "der", type: "spki" });
    const sig = Buffer.from(id.sign("nonce-1"), "base64");
    expect(verify(null, Buffer.from("nonce-1"), pub, sig)).toBe(true);
    expect(verify(null, Buffer.from("nonce-2"), pub, sig)).toBe(false);
  } finally {
    home.done();
  }
});

test("a box libsodium sealed to a key node:crypto wrote opens, and nothing else does", () => {
  const home = tempHome();
  try {
    writeFileSync(join(home.dir, "node-box-key.pem"), vectors.boxKeyPem);
    const key = loadOrCreateBoxKey(home.dir);
    expect(key.publicKey()).toBe(vectors.boxPubKey);
    const sealed = Buffer.from(vectors.sealed, "base64");
    expect(Buffer.from(key.open(sealed)!).toString()).toBe(vectors.value);
    const tampered = Buffer.from(sealed);
    tampered[40] = tampered[40]! ^ 1;
    expect(key.open(tampered)).toBeNull();
    const other = tempHome();
    try {
      expect(loadOrCreateBoxKey(other.dir).open(sealed)).toBeNull();
    } finally {
      other.done();
    }
  } finally {
    home.done();
  }
});

test("what this node seals opens, at every length across a block", () => {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  for (const n of [0, 1, 15, 16, 17, 63, 64, 65, 200, 5000]) {
    const plain = crypto.getRandomValues(new Uint8Array(n));
    const sealed = seal(publicKeyOf(secret), plain);
    expect(sealed.length).toBe(n + 48);
    expect(Buffer.from(openSealed(secret, sealed)!).equals(Buffer.from(plain))).toBe(true);
  }
});

test("BLAKE2b matches RFC 7693's vector", () => {
  // BLAKE2b-512("abc").
  expect(Buffer.from(blake2b(new TextEncoder().encode("abc"), 64)).toString("hex")).toBe(
    "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923",
  );
});
