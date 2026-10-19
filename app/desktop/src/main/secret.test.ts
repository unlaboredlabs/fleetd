import sodium from "libsodium-wrappers";
import { describe, expect, it } from "vitest";
import rust from "./secret.rust-seal.json";
import { SECRET_MAX_BYTES, seal, submitSecret } from "./secret";

const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));

describe("sealing a secret ask's value", () => {
  it("speaks the Rust format: opens what Rust's crypto_box sealed, and seals what that key opens", async () => {
    await sodium.ready;
    const [pk, sk] = [bytes(rust.publicKey), bytes(rust.secretKey)];
    expect(sodium.to_string(sodium.crypto_box_seal_open(bytes(rust.sealed), pk, sk))).toBe(rust.message);
    const ours = await seal(rust.publicKey, rust.message);
    if (!ours.ok) throw new Error(ours.error.message);
    const box = bytes(ours.sealed);
    // Ephemeral public key (32) + MAC (16) + the message, as libsodium and seal.rs lay it out.
    expect(box.length).toBe(48 + new TextEncoder().encode(rust.message).length);
    expect(sodium.to_string(sodium.crypto_box_seal_open(box, pk, sk))).toBe(rust.message);
    const other = sodium.crypto_box_keypair();
    expect(() => sodium.crypto_box_seal_open(box, other.publicKey, other.privateKey)).toThrow();
  });

  it("refuses empty and oversized values and bad keys, each with a fix", async () => {
    for (const [key, value] of [
      [rust.publicKey, ""],
      [rust.publicKey, "x".repeat(SECRET_MAX_BYTES + 1)],
      ["AAAA", "x"],
      ["not base64!", "x"],
    ] as const) {
      const out = await seal(key, value);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error.fix).toBeTruthy();
    }
    expect((await seal(rust.publicKey, "x".repeat(SECRET_MAX_BYTES))).ok).toBe(true);
  });

  it("submits only the sealed box and returns only the fingerprint", async () => {
    const sent: unknown[] = [];
    const out = await submitSecret({ requestId: "Q7", boxPubKey: rust.publicKey, value: "hunter2" }, (tool, input) => {
      sent.push(tool, input);
      return Promise.resolve({ ok: true, output: { requestId: "Q7", fingerprint: "ab12cd34" } });
    });
    expect(out).toEqual({ ok: true, fingerprint: "ab12cd34" });
    expect(sent[0]).toBe("secret_submit");
    expect(JSON.stringify(sent[1])).not.toContain("hunter2");
  });
});
