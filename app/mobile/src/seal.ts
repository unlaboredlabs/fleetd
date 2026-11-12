// This phone's notification key and libsodium's sealed box (D218), in plain JavaScript: tweetnacl
// for X25519 and XSalsa20-Poly1305, noble's BLAKE2b for the nonce. The hub seals with crypto_box_seal; this is
// crypto_box_seal_open. The iOS extension does the same in Swift (plugins/notification-service/Sealed.swift).
import { blake2b } from "@noble/hashes/blake2.js";
import nacl from "tweetnacl";

export { fromBase64, toBase64, utf8, utf8Encode } from "./bytes";

export interface KeyPair {
  readonly publicKey: Uint8Array;
  readonly secretKey: Uint8Array;
}

/** An X25519 key pair from 32 random bytes, as crypto_box_keypair makes one. */
export const keyPairOf = (secretKey: Uint8Array): KeyPair => nacl.box.keyPair.fromSecretKey(secretKey);

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

/** crypto_box_seal: the hub's side for tests, and the app's for a value on its way to the hub (`ephemeral` then from expo-crypto). */
export const seal = (plain: Uint8Array, recipient: Uint8Array, ephemeral: KeyPair = nacl.box.keyPair()): Uint8Array => {
  const box = nacl.box(plain, nonceOf(ephemeral.publicKey, recipient), recipient, ephemeral.secretKey);
  const out = new Uint8Array(32 + box.length);
  out.set(ephemeral.publicKey);
  out.set(box, 32);
  return out;
};
