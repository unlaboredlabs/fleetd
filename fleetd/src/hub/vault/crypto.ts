// The vault's envelope (vault-design §2): AES-256-GCM only, from node:crypto. Each item version gets a fresh data key
// (DEK) that encrypts its secret fields once; the root key (KEK) wraps that DEK. Both encryptions bind the row they
// belong to through their AAD, so a blob moved into another row, scope or kind never opens.
//
//   0x01 ‖ len(keyId) ‖ keyId ‖ wrapNonce (12) ‖ GCM(KEK, wrapNonce, DEK, aad₁) (48)
//        ‖ itemNonce (12) ‖ GCM(DEK, itemNonce, utf8 JSON, aad₂) (n + 16)
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const ENVELOPE_VERSION = 1;
const NONCE = 12;
const TAG = 16;
const KEY = 32;

/** Who an item's ciphertext belongs to: every field ends up in its AAD. */
export type Binding = { itemId: string; kind: string; scopeKey: string; version: number };

const dekAad = (b: Pick<Binding, "itemId" | "version">) => Buffer.from(`fleetd-vault/dek/1|${b.itemId}|${b.version}`);
const itemAad = (b: Binding) => Buffer.from(`fleetd-vault/item/1|${b.itemId}|${b.kind}|${b.scopeKey}|${b.version}`);
const checkAad = (keyId: string) => Buffer.from(`fleetd-vault/check/1|${keyId}`);

/** A fresh random 32-byte key. */
export const newKey = (): Uint8Array => new Uint8Array(randomBytes(KEY));

export function gcmSeal(key: Uint8Array, plain: Uint8Array, aad: Uint8Array, nonce: Uint8Array = randomBytes(NONCE)): Uint8Array {
  if (key.length !== KEY) throw new Error("vault: a key is 32 bytes");
  const c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(aad);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return new Uint8Array(Buffer.concat([nonce, body, c.getAuthTag()]));
}

/** null when the key, the AAD or any byte is wrong. */
export function gcmOpen(key: Uint8Array, boxed: Uint8Array, aad: Uint8Array): Uint8Array | null {
  if (key.length !== KEY || boxed.length < NONCE + TAG) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", key, boxed.subarray(0, NONCE));
    d.setAAD(aad);
    d.setAuthTag(boxed.subarray(boxed.length - TAG));
    return new Uint8Array(Buffer.concat([d.update(boxed.subarray(NONCE, boxed.length - TAG)), d.final()]));
  } catch {
    return null;
  }
}

/** The blob in `vault_keys.check_blob`: tells a wrong key apart from a damaged item. */
export const checkBlob = (kek: Uint8Array, keyId: string) => gcmSeal(kek, new Uint8Array(16), checkAad(keyId));

export function checkOpens(kek: Uint8Array, keyId: string, blob: Uint8Array): boolean {
  const out = gcmOpen(kek, blob, checkAad(keyId));
  return out !== null && out.length === 16 && out.every((b) => b === 0);
}

type Parts = { keyId: string; wrapped: Uint8Array; body: Uint8Array };

function split(sealed: Uint8Array): Parts | null {
  if (sealed.length < 2 || sealed[0] !== ENVELOPE_VERSION) return null;
  const n = sealed[1]!;
  const at = 2 + n;
  const wrapEnd = at + NONCE + KEY + TAG;
  if (n === 0 || sealed.length < wrapEnd + NONCE + TAG) return null;
  return {
    keyId: Buffer.from(sealed.subarray(2, at)).toString("utf8"),
    wrapped: sealed.subarray(at, wrapEnd),
    body: sealed.subarray(wrapEnd),
  };
}

function join(keyId: string, wrapped: Uint8Array, body: Uint8Array): Uint8Array {
  const id = Buffer.from(keyId, "utf8");
  if (id.length === 0 || id.length > 255) throw new Error("vault: a key id is 1 to 255 bytes");
  return new Uint8Array(Buffer.concat([Buffer.from([ENVELOPE_VERSION, id.length]), id, wrapped, body]));
}

/** The key id an envelope was wrapped under; undefined for no envelope. */
export const keyIdOf = (sealed: Uint8Array) => split(sealed)?.keyId;

/** Seals `plain` (the item's secret fields as JSON) for the row `b`, under the root key `kek` named `keyId`. */
export function sealItem(kek: Uint8Array, keyId: string, b: Binding, plain: Uint8Array): Uint8Array {
  const dek = newKey();
  try {
    return join(keyId, gcmSeal(kek, dek, dekAad(b)), gcmSeal(dek, plain, itemAad(b)));
  } finally {
    dek.fill(0);
  }
}

/** Opens an item's envelope; null for a wrong key, another row's blob or any damage. */
export function openItem(kek: Uint8Array, b: Binding, sealed: Uint8Array): Uint8Array | null {
  const parts = split(sealed);
  if (!parts) return null;
  const dek = gcmOpen(kek, parts.wrapped, dekAad(b));
  if (!dek) return null;
  try {
    return dek.length === KEY ? gcmOpen(dek, parts.body, itemAad(b)) : null;
  } finally {
    dek.fill(0);
  }
}

/**
 * The same item under another root key (rotation): only its DEK is unwrapped and wrapped again; the item's own
 * ciphertext stays as it is. null when `oldKek` doesn't open it.
 */
export function rewrap(oldKek: Uint8Array, newKek: Uint8Array, newKeyId: string, b: Pick<Binding, "itemId" | "version">, sealed: Uint8Array): Uint8Array | null {
  const parts = split(sealed);
  if (!parts) return null;
  const dek = gcmOpen(oldKek, parts.wrapped, dekAad(b));
  if (!dek) return null;
  try {
    return join(newKeyId, gcmSeal(newKek, dek, dekAad(b)), parts.body);
  } finally {
    dek.fill(0);
  }
}
