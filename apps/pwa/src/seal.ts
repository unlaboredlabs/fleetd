import type sodium from "libsodium-wrappers";

type Sodium = typeof sodium;

/** Matches SECRET_MAX_BYTES in @fleetd/contracts (a test keeps them equal). */
export const SECRET_MAX_BYTES = 8192;

/**
 * libsodium is ~135 KB gzipped, more than the whole app, so it loads only when a secret is submitted and stays out
 * of the bundle every inbox visit pays for.
 */
export const loadSodium = async (): Promise<Sodium> => {
  const { default: lib } = await import("libsodium-wrappers");
  await lib.ready;
  return lib;
};

/**
 * Seals `plaintext` to the node's X25519 key with `crypto_box_seal` and returns standard base64, as secret_submit
 * takes it. Wipes `plaintext` either way, so the caller's copy of the value is gone once this returns.
 */
export const sealSecret = (lib: Sodium, boxPubKey: string, plaintext: Uint8Array): string => {
  try {
    if (plaintext.length === 0) throw new Error("The secret is empty.");
    if (plaintext.length > SECRET_MAX_BYTES) throw new Error(`The secret is over ${SECRET_MAX_BYTES} bytes.`);
    const publicKey = lib.from_base64(boxPubKey, lib.base64_variants.ORIGINAL);
    if (publicKey.length !== lib.crypto_box_PUBLICKEYBYTES) throw new Error("The machine's box key is not a 32-byte key.");
    return lib.to_base64(lib.crypto_box_seal(plaintext, publicKey), lib.base64_variants.ORIGINAL);
  } finally {
    lib.memzero(plaintext);
  }
};
