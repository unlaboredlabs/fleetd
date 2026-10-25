import sodium from "libsodium-wrappers";
import { describe, expect, it } from "vitest";
import rust from "./secret.rust-seal.json";
import { SECRET_MAX_BYTES } from "../shared/contracts";
import { IPC } from "../shared/channels";
import { parseRequest } from "../shared/ipc";
import { seal, submitProjectEnv, submitSecret } from "./secret";

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

  it("takes a 64 KB value from the page to the hub, and refuses one byte more with why", async () => {
    const fromPage = (value: string) => parseRequest(IPC.secretSubmit, [{ requestId: "Q7", boxPubKey: rust.publicKey, value }]);
    const submit = async (value: string) => {
      const parsed = fromPage(value);
      if (!parsed.ok) throw new Error("refused at the IPC boundary");
      let sealed = "";
      const out = await submitSecret(parsed.args[0], (_tool, input) => {
        sealed = input.sealed;
        return Promise.resolve({ ok: true, output: { requestId: "Q7", fingerprint: "ab12cd34" } });
      });
      return { out, sealed };
    };
    const full = await submit("k".repeat(SECRET_MAX_BYTES));
    expect(full.out).toEqual({ ok: true, fingerprint: "ab12cd34" });
    expect(bytes(full.sealed).length).toBe(48 + SECRET_MAX_BYTES);
    expect(fromPage("k".repeat(SECRET_MAX_BYTES + 1)).ok).toBe(false);
    // Within the string bound, past the byte cap: main says so.
    const wide = await submit("é".repeat(SECRET_MAX_BYTES / 2 + 1));
    expect(wide.out).toMatchObject({ ok: false, error: { message: `The secret is over ${SECRET_MAX_BYTES} bytes.` } });
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

  it("sends a project's plain values as typed and its secrets only sealed, and refuses a two-line secret", async () => {
    await sodium.ready;
    const [pk, sk] = [bytes(rust.publicKey), bytes(rust.secretKey)];
    const sent: unknown[] = [];
    const call = (tool: string, input: unknown) => {
      sent.push(tool, input);
      return Promise.resolve({ ok: true as const, output: { env: [] } });
    };
    const request = {
      machineId: "devbox",
      projectId: "p1",
      boxPubKey: rust.publicKey,
      set: [
        { kind: "plain" as const, name: "API_URL", value: "https://staging.example" },
        { kind: "secret" as const, name: "STRIPE_KEY", value: "sk_test_hunter2" },
      ],
      remove: ["OLD"],
    };
    expect((await submitProjectEnv(request, call)).ok).toBe(true);
    expect(sent[0]).toBe("project_env_set");
    const input = sent[1] as { set: Array<{ kind: string; value?: string; sealed?: string }>; remove: string[] };
    expect(JSON.stringify(input)).not.toContain("sk_test_hunter2");
    expect(input.set[0]).toEqual({ kind: "plain", name: "API_URL", value: "https://staging.example" });
    expect(input.remove).toEqual(["OLD"]);
    expect(sodium.to_string(sodium.crypto_box_seal_open(bytes(input.set[1]?.sealed ?? ""), pk, sk))).toBe("sk_test_hunter2");

    sent.length = 0;
    const twoLines = await submitProjectEnv({ ...request, set: [{ kind: "secret", name: "K", value: "a\nb" }] }, call);
    expect(twoLines.ok).toBe(false);
    const noKey = await submitProjectEnv({ ...request, boxPubKey: undefined, set: [{ kind: "secret", name: "K", value: "v" }] }, call);
    expect(noKey.ok).toBe(false);
    expect(sent).toEqual([]);
  });
});
