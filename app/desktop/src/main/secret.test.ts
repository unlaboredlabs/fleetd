import sodium from "libsodium-wrappers";
import { describe, expect, it } from "vitest";
import rust from "./secret.rust-seal.json";
import { SECRET_MAX_BYTES } from "../shared/contracts";
import { IPC } from "../shared/channels";
import { parseRequest } from "../shared/ipc";
import { seal, submitMcpServer, submitProjectEnv, submitSecret } from "./secret";

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
    const fromPage = (value: string) => parseRequest(IPC.secretSubmit, ["hub", { requestId: "Q7", boxPubKey: rust.publicKey, value }]);
    const submit = async (value: string) => {
      const parsed = fromPage(value);
      if (!parsed.ok) throw new Error("refused at the IPC boundary");
      let sealed = "";
      const out = await submitSecret(parsed.args[1], (_tool, input) => {
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

  it("sends a project's plain values as typed and its secrets only sealed, and takes a secret of several lines but not a NUL", async () => {
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
    const nul = await submitProjectEnv({ ...request, set: [{ kind: "secret", name: "K", value: "a\0b" }] }, call);
    expect(nul.ok).toBe(false);
    const noKey = await submitProjectEnv({ ...request, boxPubKey: undefined, set: [{ kind: "secret", name: "K", value: "v" }] }, call);
    expect(noKey.ok).toBe(false);
    expect(sent).toEqual([]);

    // A certificate chain: sealed with every newline in it.
    const chain = "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIU\n-----END CERTIFICATE-----\n";
    expect((await submitProjectEnv({ ...request, set: [{ kind: "secret", name: "TLS_CHAIN", value: chain }] }, call)).ok).toBe(true);
    const sealed = (sent[1] as { set: Array<{ sealed?: string }> }).set[0]?.sealed ?? "";
    expect(sodium.to_string(sodium.crypto_box_seal_open(bytes(sealed), pk, sk))).toBe(chain);
  });

  it("seals an MCP server's secret to every machine given, sends plain and kept values as they are, and checks the request", async () => {
    await sodium.ready;
    const [pk, sk] = [bytes(rust.publicKey), bytes(rust.secretKey)];
    const other = sodium.crypto_box_keypair();
    const otherKey = Buffer.from(other.publicKey).toString("base64");
    const sent: unknown[] = [];
    const call = (tool: string, input: unknown) => {
      sent.push(tool, input);
      return Promise.resolve({ ok: true as const, output: {} });
    };
    const request = {
      scope: { kind: "global" as const },
      name: "github",
      enabled: true,
      roles: { lead: true, writers: true, reviewers: false },
      transport: { type: "http" as const, url: "https://api.example.com/mcp" },
      env: [],
      headers: [
        { kind: "secret" as const, name: "Authorization", value: "Bearer ghp_hunter2" },
        { kind: "plain" as const, name: "X-Team", value: "core" },
        { kind: "keep" as const, name: "X-Old" },
      ],
      boxes: [
        { machineId: "devbox", boxPubKey: rust.publicKey },
        { machineId: "laptop", boxPubKey: otherKey },
      ],
    };
    expect(parseRequest(IPC.mcpServerSubmit, ["hub", request]).ok).toBe(true);
    expect(parseRequest(IPC.mcpServerSubmit, ["hub", { ...request, name: "a b" }]).ok).toBe(false);
    expect((await submitMcpServer(request, call)).ok).toBe(true);
    expect(sent[0]).toBe("mcp_server_set");
    const input = sent[1] as { headers: Array<{ kind: string; sealed?: Array<{ machineId: string; sealed: string }> }> };
    expect(JSON.stringify(input)).not.toContain("ghp_hunter2");
    const [secret, plain, keep] = input.headers;
    expect(secret?.sealed?.map((s) => s.machineId)).toEqual(["devbox", "laptop"]);
    expect(sodium.to_string(sodium.crypto_box_seal_open(bytes(secret?.sealed?.[0]?.sealed ?? ""), pk, sk))).toBe("Bearer ghp_hunter2");
    expect(sodium.to_string(sodium.crypto_box_seal_open(bytes(secret?.sealed?.[1]?.sealed ?? ""), other.publicKey, other.privateKey))).toBe("Bearer ghp_hunter2");
    expect(plain).toEqual({ kind: "plain", name: "X-Team", value: "core" });
    expect(keep).toEqual({ kind: "keep", name: "X-Old" });

    sent.length = 0;
    expect((await submitMcpServer({ ...request, boxes: [] }, call)).ok).toBe(false);
    expect(sent).toEqual([]);
  });
  it("sends a Navi's integration with its server, the token sealed and nowhere in the clear", async () => {
    await sodium.ready;
    const sent: unknown[] = [];
    const call = (tool: string, input: unknown) => {
      sent.push(tool, input);
      return Promise.resolve({ ok: true as const, output: {} });
    };
    const request = {
      scope: { kind: "project" as const, machineId: "devbox", projectId: "navi" },
      name: "notion",
      enabled: true,
      roles: { lead: true, writers: false, reviewers: false },
      transport: { type: "stdio" as const, command: "npx", args: ["-y", "@notionhq/notion-mcp-server"] },
      env: [{ kind: "secret" as const, name: "NOTION_TOKEN", value: "ntn_hunter2hunter2" }],
      headers: [],
      boxes: [{ machineId: "devbox", boxPubKey: rust.publicKey }],
      integration: { kind: "notion" as const },
    };
    expect(parseRequest(IPC.mcpServerSubmit, [request]).ok).toBe(true);
    expect(parseRequest(IPC.mcpServerSubmit, [{ ...request, integration: { kind: "gmail" } }]).ok).toBe(false);
    expect((await submitMcpServer(request, call)).ok).toBe(true);
    const input = sent[1] as { integration?: unknown };
    expect(input.integration).toEqual({ kind: "notion" });
    expect(JSON.stringify(sent)).not.toContain("ntn_hunter2hunter2");
  });
});
