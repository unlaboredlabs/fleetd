// The vault's envelope (src/hub/vault/crypto.ts): the shared vectors open, a ciphertext opens only in its own row,
// and a rotation rewraps the data key without touching the item's ciphertext.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkBlob, checkOpens, keyIdOf, newKey, openItem, rewrap, sealItem } from "../src/hub/vault/crypto.ts";

type Vectors = {
  rootKey: string;
  keyId: string;
  checkBlob: string;
  vectors: { name: string; itemId: string; kind: string; scopeKey: string; version: number; plain: unknown; sealed: string }[];
};

const vectors = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/vault/vault_vectors.json"), "utf8")) as Vectors;
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const json = (b: Uint8Array | null) => (b === null ? null : JSON.parse(Buffer.from(b).toString("utf8")));

test("the shared vectors open with their root key, and their check blob checks", () => {
  const kek = unb64(vectors.rootKey);
  expect(checkOpens(kek, vectors.keyId, unb64(vectors.checkBlob))).toBe(true);
  expect(checkOpens(newKey(), vectors.keyId, unb64(vectors.checkBlob))).toBe(false);
  for (const v of vectors.vectors) {
    const b = { itemId: v.itemId, kind: v.kind, scopeKey: v.scopeKey, version: v.version };
    expect(json(openItem(kek, b, unb64(v.sealed)))).toEqual(v.plain);
    expect(keyIdOf(unb64(v.sealed))).toBe(vectors.keyId);
  }
});

test("a sealed item opens only in its own row: another item, kind, scope or version fails", () => {
  const kek = newKey();
  const b = { itemId: "V0123456789abcdef0123456789abcdef", kind: "card", scopeKey: "person:p_aaaaaaaa", version: 2 };
  const sealed = sealItem(kek, "k1", b, Buffer.from('{"number":"4242424242424242"}'));
  expect(json(openItem(kek, b, sealed))).toEqual({ number: "4242424242424242" });
  for (const other of [
    { ...b, itemId: "V0123456789abcdef0123456789abcdee" },
    { ...b, kind: "login" },
    { ...b, scopeKey: "person:p_bbbbbbbb" },
    { ...b, scopeKey: "hub" },
    { ...b, version: 3 },
  ]) {
    expect(openItem(kek, other, sealed)).toBeNull();
  }
  expect(openItem(newKey(), b, sealed)).toBeNull();
  // Any flipped byte, in the wrapped key or the body's tag, refuses.
  for (const at of [5, 20, sealed.length - 1, sealed.length - 30]) {
    const bad = sealed.slice();
    bad[at]! ^= 1;
    expect(openItem(kek, b, bad)).toBeNull();
  }
  // Each seal uses a fresh data key and nonces.
  expect(Buffer.from(sealItem(kek, "k1", b, Buffer.from("{}"))).equals(Buffer.from(sealItem(kek, "k1", b, Buffer.from("{}"))))).toBe(false);
});

test("a rotation rewraps the data key under the new root key and leaves the item's ciphertext as it was", () => {
  const old = newKey();
  const fresh = newKey();
  const b = { itemId: "V0123456789abcdef0123456789abcdef", kind: "env", scopeKey: "project:devbox/p1", version: 1 };
  const sealed = sealItem(old, "k1", b, Buffer.from('{"value":"x"}'));
  const moved = rewrap(old, fresh, "k2", b, sealed)!;
  expect(keyIdOf(moved)).toBe("k2");
  expect(json(openItem(fresh, b, moved))).toEqual({ value: "x" });
  expect(openItem(old, b, moved)).toBeNull();
  // The body (nonce, ciphertext, tag) is byte for byte the same.
  expect(Buffer.from(moved.slice(moved.length - 41)).equals(Buffer.from(sealed.slice(sealed.length - 41)))).toBe(true);
  expect(rewrap(newKey(), fresh, "k2", b, sealed)).toBeNull();
  expect(checkOpens(fresh, "k2", checkBlob(fresh, "k2"))).toBe(true);
  expect(checkOpens(fresh, "k1", checkBlob(fresh, "k2"))).toBe(false);
});
