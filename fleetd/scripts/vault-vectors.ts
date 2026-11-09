// The vault's envelope vectors (fleetd-contracts vault.rs, design `vault-design` §2), shared by both runtimes:
//   bun scripts/vault-vectors.ts           writes test/fixtures/vault/vault_vectors.json
//   bun scripts/vault-vectors.ts --check   writes nothing: fails when the file differs from what this makes, or when a
//                                          vector doesn't open, or a negative one does
//
// envelope = 0x01 ‖ len(keyId) ‖ keyId ‖ wrapNonce (12) ‖ AES-256-GCM(KEK, wrapNonce, DEK, dekAad) (48)
//            ‖ itemNonce (12) ‖ AES-256-GCM(DEK, itemNonce, utf8 JSON of the secret fields, itemAad) (n + 16)
// check  = nonce (12) ‖ AES-256-GCM(KEK, nonce, 16 zero bytes, checkAad) (32)
//
// Every key and nonce here is a fixed byte pattern, so the file is the same at each run; a hub makes them at random.
// The values are made up and look it: nothing here is anyone's.
import { createCipheriv, createDecipheriv } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const OUT = join(import.meta.dir, "../test/fixtures/vault/vault_vectors.json");

export const dekAad = (itemId: string, version: number) => `fleetd-vault/dek/1|${itemId}|${version}`;
export const itemAad = (itemId: string, kind: string, scopeKey: string, version: number) =>
  `fleetd-vault/item/1|${itemId}|${kind}|${scopeKey}|${version}`;
export const checkAad = (keyId: string) => `fleetd-vault/check/1|${keyId}`;

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const unb64 = (text: string) => new Uint8Array(Buffer.from(text, "base64"));
const pattern = (length: number, start: number) => new Uint8Array(length).map((_, i) => (start + i) & 0xff);

function gcmSeal(key: Uint8Array, nonce: Uint8Array, plain: Uint8Array, aad: string): Uint8Array {
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  return new Uint8Array(Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]));
}

function gcmOpen(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array, aad: string): Uint8Array {
  if (sealed.length < 16) throw new Error("too short");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  return new Uint8Array(Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]));
}

export type Item = { itemId: string; kind: string; scopeKey: string; version: number };

export function seal(
  kek: Uint8Array,
  keyId: string,
  item: Item,
  plain: Uint8Array,
  dek: Uint8Array,
  wrapNonce: Uint8Array,
  itemNonce: Uint8Array,
): Uint8Array {
  const id = Buffer.from(keyId, "utf8");
  const wrapped = gcmSeal(kek, wrapNonce, dek, dekAad(item.itemId, item.version));
  const body = gcmSeal(dek, itemNonce, plain, itemAad(item.itemId, item.kind, item.scopeKey, item.version));
  return new Uint8Array(Buffer.concat([Buffer.from([1, id.length]), id, wrapNonce, wrapped, itemNonce, body]));
}

/** The envelope's key id and plaintext; throws when it doesn't open under `kek` for `item`. */
export function open(kek: Uint8Array, item: Item, envelope: Uint8Array): { keyId: string; plain: Uint8Array } {
  if (envelope[0] !== 1) throw new Error("unknown envelope version");
  const idLength = envelope[1] ?? 0;
  let at = 2;
  const keyId = Buffer.from(envelope.subarray(at, (at += idLength))).toString("utf8");
  const wrapNonce = envelope.subarray(at, (at += 12));
  const wrapped = envelope.subarray(at, (at += 48));
  const itemNonce = envelope.subarray(at, (at += 12));
  if (at + 16 > envelope.length) throw new Error("too short");
  const dek = gcmOpen(kek, wrapNonce, wrapped, dekAad(item.itemId, item.version));
  try {
    const plain = gcmOpen(dek, itemNonce, envelope.subarray(at), itemAad(item.itemId, item.kind, item.scopeKey, item.version));
    return { keyId, plain };
  } finally {
    dek.fill(0);
  }
}

export const checkBlob = (kek: Uint8Array, keyId: string, nonce: Uint8Array) =>
  new Uint8Array(Buffer.concat([nonce, gcmSeal(kek, nonce, new Uint8Array(16), checkAad(keyId))]));

export function checkOpens(kek: Uint8Array, keyId: string, blob: Uint8Array): boolean {
  try {
    return gcmOpen(kek, blob.subarray(0, 12), blob.subarray(12), checkAad(keyId)).every((b) => b === 0);
  } catch {
    return false;
  }
}

type Vector = Item & { name: string; plain: unknown; dekAad: string; itemAad: string; sealed: string };
type Negative = Item & { name: string; why: string; rootKey: string; sealed: string };
export type Vectors = {
  about: string;
  rootKey: string;
  keyId: string;
  checkBlob: string;
  checkAad: string;
  vectors: Vector[];
  negatives: Negative[];
};

const ROOT = pattern(32, 0x00);
const WRONG = pattern(32, 0x80);
const KEY_ID = "k1";
const id = (n: number) => `V${n.toString(16).padStart(32, "0")}`;

const CASES: (Item & { name: string; plain: unknown })[] = [
  {
    name: "login",
    itemId: id(1),
    kind: "login",
    scopeKey: "person:p_abcdefgh",
    version: 1,
    plain: { username: "user@example.test", password: "example-password-not-real", totp: "EXAMPLESEEDNOTREAL" },
  },
  {
    name: "card",
    itemId: id(2),
    kind: "card",
    scopeKey: "hub",
    version: 3,
    plain: { number: "0000000000000000", month: "01", year: "2099", cvc: "000", name: "Example Person" },
  },
  {
    name: "address",
    itemId: id(3),
    kind: "address",
    scopeKey: "project:devbox/p1",
    version: 1,
    plain: { name: "Example Person", line1: "1 Example Street", city: "Springfield", postalCode: "00000", country: "DE" },
  },
  {
    name: "env",
    itemId: id(4),
    kind: "env",
    scopeKey: "order:devbox/p1/W7",
    version: 2,
    plain: { value: "example-token-not-real\nwith a second line, ünïcode and \"quotes\"" },
  },
];

function sealCase(c: Item & { plain: unknown }, n: number): string {
  const plain = new TextEncoder().encode(JSON.stringify(c.plain));
  return b64(seal(ROOT, KEY_ID, c, plain, pattern(32, 0x40 + n), pattern(12, 0xa0 + n), pattern(12, 0xc0 + n)));
}

export function make(): Vectors {
  const vectors = CASES.map((c, n) => ({
    ...c,
    dekAad: dekAad(c.itemId, c.version),
    itemAad: itemAad(c.itemId, c.kind, c.scopeKey, c.version),
    sealed: sealCase(c, n),
  }));
  const login = vectors[0]!;
  const tampered = unb64(login.sealed);
  tampered[tampered.length - 1]! ^= 0x01;
  const wrappedTampered = unb64(login.sealed);
  wrappedTampered[2 + KEY_ID.length + 12]! ^= 0x01;
  const base = { itemId: login.itemId, kind: login.kind, scopeKey: login.scopeKey, version: login.version };
  const negatives: Negative[] = [
    { ...base, name: "wrong root key", why: "the data key doesn't unwrap", rootKey: b64(WRONG), sealed: login.sealed },
    { ...base, name: "tampered tag", why: "the item's tag fails", rootKey: b64(ROOT), sealed: b64(tampered) },
    { ...base, name: "tampered wrap", why: "the data key's tag fails", rootKey: b64(ROOT), sealed: b64(wrappedTampered) },
    { ...base, name: "swapped item", why: "another item's id", rootKey: b64(ROOT), sealed: login.sealed, itemId: id(9) },
    { ...base, name: "swapped scope", why: "another person's scope", rootKey: b64(ROOT), sealed: login.sealed, scopeKey: "person:p_zzzzzzzz" },
    { ...base, name: "swapped kind", why: "another kind", rootKey: b64(ROOT), sealed: login.sealed, kind: "card" },
    { ...base, name: "older version", why: "another version", rootKey: b64(ROOT), sealed: login.sealed, version: 2 },
  ];
  return {
    about: "fleetd vault envelope vectors: fleetd/scripts/vault-vectors.ts writes them; every value is made up",
    rootKey: b64(ROOT),
    keyId: KEY_ID,
    checkBlob: b64(checkBlob(ROOT, KEY_ID, pattern(12, 0xe0))),
    checkAad: checkAad(KEY_ID),
    vectors,
    negatives,
  };
}

/** Every problem with `v`: a vector that doesn't open to its plain JSON, a negative that opens, a bad check blob. */
export function verify(v: Vectors): string[] {
  const problems: string[] = [];
  const root = unb64(v.rootKey);
  if (!checkOpens(root, v.keyId, unb64(v.checkBlob))) problems.push("the check blob doesn't open");
  if (checkOpens(WRONG, v.keyId, unb64(v.checkBlob))) problems.push("the check blob opens under a wrong key");
  for (const vector of v.vectors) {
    try {
      const opened = open(root, vector, unb64(vector.sealed));
      if (opened.keyId !== v.keyId) problems.push(`${vector.name}: key id ${opened.keyId}`);
      if (JSON.stringify(JSON.parse(new TextDecoder().decode(opened.plain))) !== JSON.stringify(vector.plain)) {
        problems.push(`${vector.name}: opens to other JSON`);
      }
    } catch (e) {
      problems.push(`${vector.name}: doesn't open (${(e as Error).message})`);
    }
  }
  for (const negative of v.negatives) {
    let opened = true;
    try {
      open(unb64(negative.rootKey), negative, unb64(negative.sealed));
    } catch {
      opened = false;
    }
    if (opened) problems.push(`${negative.name}: opens`);
  }
  return problems;
}

if (import.meta.main) {
  const made = `${JSON.stringify(make(), null, 2)}\n`;
  const problems = verify(JSON.parse(made) as Vectors);
  if (process.argv.includes("--check")) {
    let kept = "";
    try {
      kept = readFileSync(OUT, "utf8");
    } catch {}
    if (kept !== made) problems.push(`${OUT} is out of date: run bun scripts/vault-vectors.ts`);
    else problems.push(...verify(JSON.parse(kept) as Vectors).map((p) => `kept: ${p}`));
  } else if (problems.length === 0) {
    writeFileSync(OUT, made);
    console.log(`wrote ${OUT}`);
  }
  for (const p of problems) console.error(p);
  process.exit(problems.length ? 1 : 0);
}
