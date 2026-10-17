import { SECRET_MAX_BYTES as CONTRACT_MAX, SealedSecret } from "@fleetd/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { loadSodium, SECRET_MAX_BYTES, sealSecret } from "./seal.ts";

const lib = await loadSodium();
const { publicKey, privateKey } = lib.crypto_box_keypair();
const boxPubKey = lib.to_base64(publicKey, lib.base64_variants.ORIGINAL);

describe("sealSecret", () => {
  it("seals so only the node's private key opens it, as base64 secret_submit accepts", () => {
    const plaintext = new TextEncoder().encode("sk_test_51abc");
    const sealed = sealSecret(lib, boxPubKey, plaintext);
    expect(Schema.is(SealedSecret)(sealed)).toBe(true);
    const opened = lib.crypto_box_seal_open(Buffer.from(sealed, "base64"), publicKey, privateKey);
    expect(new TextDecoder().decode(opened)).toBe("sk_test_51abc");
  });

  it("wipes the plaintext bytes, sealed or refused", () => {
    const plaintext = new TextEncoder().encode("hunter2");
    sealSecret(lib, boxPubKey, plaintext);
    expect(plaintext.every((byte) => byte === 0)).toBe(true);
    const refused = new Uint8Array(SECRET_MAX_BYTES + 1).fill(1);
    expect(() => sealSecret(lib, boxPubKey, refused)).toThrow(/over 8192 bytes/u);
    expect(refused.every((byte) => byte === 0)).toBe(true);
  });

  it("refuses an empty value and a key that isn't 32 bytes", () => {
    expect(() => sealSecret(lib, boxPubKey, new Uint8Array())).toThrow(/empty/u);
    expect(() => sealSecret(lib, Buffer.alloc(16).toString("base64"), new Uint8Array([1]))).toThrow(/32-byte/u);
  });

  it("keeps the size limit in step with the contracts", () => {
    expect(SECRET_MAX_BYTES).toBe(CONTRACT_MAX);
  });
});
