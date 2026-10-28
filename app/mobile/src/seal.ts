// This phone's notification key and libsodium's sealed box (docs/design/push.md, D218), in plain JavaScript: tweetnacl
// for X25519 and XSalsa20-Poly1305, noble's BLAKE2b for the nonce. The hub seals with crypto_box_seal; this is
// crypto_box_seal_open. The iOS extension does the same in Swift (plugins/notification-service/Sealed.swift).
import { blake2b } from "@noble/hashes/blake2.js";
import nacl from "tweetnacl";

export interface KeyPair {
  readonly publicKey: Uint8Array;
  readonly secretKey: Uint8Array;
}

/** An X25519 key pair from 32 random bytes, as crypto_box_keypair makes one. */
export const keyPairOf = (secretKey: Uint8Array): KeyPair => nacl.box.keyPair.fromSecretKey(secretKey);

export const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
};

export const fromBase64 = (text: string): Uint8Array | null => {
  try {
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
};

/** BLAKE2b-192(ephemeral key ‖ recipient key): the sealed box's nonce. */
const nonceOf = (ephemeral: Uint8Array, recipient: Uint8Array): Uint8Array => {
  const both = new Uint8Array(64);
  both.set(ephemeral);
  both.set(recipient, 32);
  return blake2b(both, { dkLen: nacl.box.nonceLength });
};

/** crypto_box_seal_open: the plaintext, or null when it isn't a box sealed to this key. */
export const openSealed = (sealed: Uint8Array, keys: KeyPair): Uint8Array | null => {
  if (sealed.length < 32 + nacl.box.overheadLength) return null;
  const ephemeral = sealed.subarray(0, 32);
  return nacl.box.open(sealed.subarray(32), nonceOf(ephemeral, keys.publicKey), ephemeral, keys.secretKey);
};

/** crypto_box_seal, for tests: the hub's side. */
export const seal = (plain: Uint8Array, recipient: Uint8Array, ephemeral: KeyPair = nacl.box.keyPair()): Uint8Array => {
  const box = nacl.box(plain, nonceOf(ephemeral.publicKey, recipient), recipient, ephemeral.secretKey);
  const out = new Uint8Array(32 + box.length);
  out.set(ephemeral.publicKey);
  out.set(box, 32);
  return out;
};

/** Strict UTF-8, or null: Hermes may have no TextDecoder. */
export const utf8 = (bytes: Uint8Array): string | null => {
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i]!;
    const n = b < 0x80 ? 0 : b >> 5 === 6 ? 1 : b >> 4 === 14 ? 2 : b >> 3 === 30 ? 3 : -1;
    if (n < 0 || i + n >= bytes.length) return null;
    let cp = n === 0 ? b : b & (0x3f >> n);
    for (let k = 1; k <= n; k++) {
      const c = bytes[i + k]!;
      if (c >> 6 !== 2) return null;
      cp = (cp << 6) | (c & 0x3f);
    }
    if ((n === 1 && cp < 0x80) || (n === 2 && cp < 0x800) || (n === 3 && cp < 0x10000) || cp > 0x10ffff || (cp >= 0xd800 && cp < 0xe000)) return null;
    out += String.fromCodePoint(cp);
    i += n + 1;
  }
  return out;
};
