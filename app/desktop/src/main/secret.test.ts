import sodium from "libsodium-wrappers";
import { describe, expect, it } from "vitest";
import rust from "./secret.rust-seal.json";
import { SECRET_MAX_BYTES } from "../shared/contracts";
import { IPC } from "../shared/channels";
import { parseRequest } from "../shared/ipc";
import { seal, submitClaudeAccount, submitGoogleClient, submitGooglePubsub, submitHubLink, submitMcpServer, submitOnePassword, submitProjectEnv, submitSecret } from "./secret";

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
    expect(parseRequest(IPC.mcpServerSubmit, ["hub", request]).ok).toBe(true);
    expect(parseRequest(IPC.mcpServerSubmit, ["hub", { ...request, integration: { kind: "gmail" } }]).ok).toBe(false);
    expect((await submitMcpServer(request, call)).ok).toBe(true);
    const input = sent[1] as { integration?: unknown };
    expect(input.integration).toEqual({ kind: "notion" });
    expect(JSON.stringify(sent)).not.toContain("ntn_hunter2hunter2");
  });
});

describe("a pasted hub link key", () => {
  it("goes to hub_link_add sealed to the hub's own key, and only a link key goes at all", async () => {
    await sodium.ready;
    const [pk, sk] = [bytes(rust.publicKey), bytes(rust.secretKey)];
    const sent: unknown[] = [];
    const call = (tool: string, input: unknown) => {
      sent.push(tool, input);
      return Promise.resolve({ ok: true as const, output: {} });
    };
    const key = `flk_${"a".repeat(52)}`;
    const request = { navi: { machineId: "devbox", projectId: "ada" }, label: "acme", url: "https://acme.example", boxPubKey: rust.publicKey, key };
    expect(parseRequest(IPC.hubLinkSubmit, ["hub", request]).ok).toBe(true);
    expect(parseRequest(IPC.hubLinkSubmit, ["hub", { ...request, label: "x".repeat(41) }]).ok).toBe(false);
    expect((await submitHubLink(request, call)).ok).toBe(true);
    expect(sent[0]).toBe("hub_link_add");
    const input = sent[1] as { sealed: string; label: string; url: string };
    expect(JSON.stringify(input)).not.toContain(key);
    expect(input).toMatchObject({ navi: request.navi, label: "acme", url: "https://acme.example" });
    expect(sodium.to_string(sodium.crypto_box_seal_open(bytes(input.sealed), pk, sk))).toBe(key);

    sent.length = 0;
    const wrong = await submitHubLink({ ...request, key: "fld_not_a_link_key" }, call);
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error.fix).toContain("flk_");
    expect(sent).toEqual([]);
  });

  it("seals the hub's Google client secret to every machine, and sends the hub only the id and the boxes", async () => {
    await sodium.ready;
    const [pk, sk] = [bytes(rust.publicKey), bytes(rust.secretKey)];
    const sent: Array<{ tool: string; input: unknown }> = [];
    const call = (tool: string, input: unknown) => {
      sent.push({ tool, input });
      return Promise.resolve({ ok: true as const, output: {} });
    };
    const secret = "GOCSPX-never_in_a_hub_call_0123";
    const clientId = "418559210337-q8fj2v0c.apps.googleusercontent.com";
    const boxes = [
      { machineId: "devbox", boxPubKey: rust.publicKey },
      { machineId: "buildbox", boxPubKey: rust.publicKey },
    ];
    const request = { clientId, secret, boxes };
    expect(parseRequest(IPC.googleClientSubmit, ["hub", request]).ok).toBe(true);
    expect(parseRequest(IPC.googleClientSubmit, ["hub", { ...request, clientId: "not-a-client" }]).ok).toBe(false);
    expect(parseRequest(IPC.googleClientSubmit, ["hub", { ...request, boxes: [] }]).ok).toBe(false);
    expect((await submitGoogleClient(request, call)).ok).toBe(true);
    const [only] = sent;
    expect(only?.tool).toBe("google_client_set");
    expect(JSON.stringify(only?.input)).not.toContain(secret);
    const input = only?.input as { clientId: string; sealed: Array<{ machineId: string; sealed: string }> };
    expect(input.clientId).toBe(clientId);
    expect(input.sealed.map((x) => x.machineId)).toEqual(["devbox", "buildbox"]);
    for (const x of input.sealed) expect(sodium.to_string(sodium.crypto_box_seal_open(bytes(x.sealed), pk, sk))).toBe(secret);

    sent.length = 0;
    const spaced = await submitGoogleClient({ ...request, secret: "GOCSPX-a b" }, call);
    expect(spaced.ok).toBe(false);
    if (!spaced.ok) expect(spaced.error.fix).toBeTruthy();
    expect(sent).toEqual([]);
  });

  it("checks real-time mail's key is a service account's, seals it to the reading machine, and never sends it plain", async () => {
    await sodium.ready;
    const [pk, sk] = [bytes(rust.publicKey), bytes(rust.secretKey)];
    const sent: Array<{ tool: string; input: unknown }> = [];
    const call = (tool: string, input: unknown) => {
      sent.push({ tool, input });
      return Promise.resolve({ ok: true as const, output: {} });
    };
    const key = JSON.stringify({ type: "service_account", private_key: "-----BEGIN PRIVATE KEY-----never_in_a_hub_call", client_email: "fleetd-gmail-reader@fleetd-devbox.iam.gserviceaccount.com" });
    const request = {
      topic: "projects/fleetd-devbox/topics/fleetd-gmail",
      subscription: "projects/fleetd-devbox/subscriptions/fleetd-gmail-hub",
      machineId: "devbox",
      boxPubKey: rust.publicKey,
      key,
    };
    expect(parseRequest(IPC.googlePubsubSubmit, ["hub", request]).ok).toBe(true);
    expect(parseRequest(IPC.googlePubsubSubmit, ["hub", { ...request, topic: "fleetd-gmail" }]).ok).toBe(false);
    expect((await submitGooglePubsub(request, call)).ok).toBe(true);
    expect(sent[0]?.tool).toBe("google_pubsub_set");
    expect(JSON.stringify(sent[0]?.input)).not.toContain("never_in_a_hub_call");
    const input = sent[0]?.input as { pubsub: { topic: string; subscription: string; machineId: string; sealed: string } };
    expect(input.pubsub).toMatchObject({ topic: request.topic, subscription: request.subscription, machineId: "devbox" });
    expect(sodium.to_string(sodium.crypto_box_seal_open(bytes(input.pubsub.sealed), pk, sk))).toBe(key);

    sent.length = 0;
    for (const wrong of ["not json", JSON.stringify({ type: "authorized_user", client_id: "x" })]) {
      const out = await submitGooglePubsub({ ...request, key: wrong }, call);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error.fix).toContain("JSON");
    }
    expect(sent).toEqual([]);
  });
});

describe("a Claude account's key or token", () => {
  const TOKEN = "sk-ant-oat01-devbox-token_AAAA";
  const KEY = "sk-ant-api03-devbox-key_BBBB";

  const run = async (request: unknown) => {
    const parsed = parseRequest(IPC.claudeAccountSubmit, ["hub", request]);
    if (!parsed.ok) throw new Error(`refused at the IPC boundary: ${parsed.reason}`);
    const sent: Array<{ tool: string; input: unknown }> = [];
    const out = await submitClaudeAccount(parsed.args[1], (tool, input) => {
      sent.push({ tool, input });
      return Promise.resolve({ ok: true, output: { me: {}, missingOn: ["buildbox"] } });
    });
    return { out, sent };
  };

  it("seals a person's token to every machine for claude_subscription_set, trimmed, and never sends it in the clear", async () => {
    await sodium.ready;
    const [pk, sk] = [bytes(rust.publicKey), bytes(rust.secretKey)];
    const boxes = [
      { machineId: "devbox", boxPubKey: rust.publicKey },
      { machineId: "buildbox", boxPubKey: rust.publicKey },
    ];
    const { out, sent } = await run({ account: "mine", token: `  "${TOKEN}"\n`, boxes });
    expect(out).toMatchObject({ ok: true, output: { missingOn: ["buildbox"] } });
    expect(sent.map((s) => s.tool)).toEqual(["claude_subscription_set"]);
    expect(JSON.stringify(sent)).not.toContain(TOKEN);
    const input = sent[0]?.input as { sealed: Array<{ machineId: string; sealed: string }> };
    expect(input.sealed.map((s) => s.machineId)).toEqual(["devbox", "buildbox"]);
    for (const s of input.sealed) expect(sodium.to_string(sodium.crypto_box_seal_open(bytes(s.sealed), pk, sk))).toBe(TOKEN);
  });

  it("refuses an API key as a token, a value with spaces in it, and no machine to seal to, before anything is sent", async () => {
    const boxes = [{ machineId: "devbox", boxPubKey: rust.publicKey }];
    for (const [request, message] of [
      [{ account: "mine", token: KEY, boxes }, "That's an API key, not a subscription token."],
      [{ account: "mine", token: "sk-ant-oat01 part two", boxes }, "That isn't a token: it has spaces or line breaks in it."],
      [{ account: "hub_api", key: `${KEY}\n${KEY}`, boxes }, "That isn't an API key: it has spaces or line breaks in it."],
      [{ account: "hub_api", key: KEY, boxes: [] }, "No machine takes secrets yet: no node has a box key."],
      [{ account: "hub_api", key: KEY, endpoint: "gateway.devbox.example", boxes }, "The endpoint isn't an http:// or https:// URL."],
    ] as const) {
      const { out, sent } = await run(request);
      expect(out).toMatchObject({ ok: false, error: { message } });
      expect(sent).toEqual([]);
    }
  });

  it("seals the hub's key with its endpoint, and an endpoint change alone keeps the saved key", async () => {
    const boxes = [{ machineId: "devbox", boxPubKey: rust.publicKey }];
    const set = await run({ account: "hub_api", key: KEY, endpoint: "https://gateway.devbox.example/", boxes });
    expect(set.sent[0]).toMatchObject({ tool: "claude_hub_api_set", input: { endpoint: "https://gateway.devbox.example", sealed: [{ machineId: "devbox" }] } });
    expect(JSON.stringify(set.sent)).not.toContain(KEY);
    const keep = await run({ account: "hub_api", endpoint: "https://gateway.devbox.example/v2", boxes });
    expect(keep.sent).toEqual([{ tool: "claude_hub_api_set", input: { sealed: [], endpoint: "https://gateway.devbox.example/v2" } }]);
  });
});

describe("a person's 1Password token", () => {
  it("seals it to every machine for onepassword_set, trimmed, and refuses anything but one ops_ line before sending", async () => {
    await sodium.ready;
    const [pk, sk] = [bytes(rust.publicKey), bytes(rust.secretKey)];
    const TOKEN = "ops_devbox-service-account_CCCC";
    const boxes = [
      { machineId: "devbox", boxPubKey: rust.publicKey },
      { machineId: "buildbox", boxPubKey: rust.publicKey },
    ];
    const sent: Array<{ tool: string; input: unknown }> = [];
    const call = (tool: "onepassword_set", input: unknown) => {
      sent.push({ tool, input });
      return Promise.resolve({ ok: true as const, output: { token: {} } });
    };
    const parsed = parseRequest(IPC.onePasswordSubmit, ["hub", { token: ` "${TOKEN}"\n`, boxes }]);
    if (!parsed.ok) throw new Error(`refused at the IPC boundary: ${parsed.reason}`);
    expect((await submitOnePassword(parsed.args[1], call)).ok).toBe(true);
    expect(sent.map((c) => c.tool)).toEqual(["onepassword_set"]);
    expect(JSON.stringify(sent[0]?.input)).not.toContain(TOKEN);
    const input = sent[0]?.input as { sealed: Array<{ machineId: string; sealed: string }> };
    expect(input.sealed.map((b) => b.machineId)).toEqual(["devbox", "buildbox"]);
    for (const box of input.sealed) expect(sodium.to_string(sodium.crypto_box_seal_open(bytes(box.sealed), pk, sk))).toBe(TOKEN);

    sent.length = 0;
    for (const wrong of ["hunter2", "ops_one two", "eyJhbGciOi"]) {
      const out = await submitOnePassword({ token: wrong, boxes }, call);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error.message).toContain("ops_");
    }
    const none = await submitOnePassword({ token: TOKEN, boxes: [] }, call);
    expect(none.ok).toBe(false);
    expect(sent).toEqual([]);
  });
});
