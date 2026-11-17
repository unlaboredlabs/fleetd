import { describe, expect, it } from "vitest";
import { NAMED, namedState, type McpServer } from "../../desktop";
import type { Hub } from "./api";
import { connect, disconnect, readServers, rowOf, signInPage, test, TEST_MS, testLine, turnOn } from "./namedApi";

const REF = { machineId: "devbox", projectId: "ada" };
const scope = { kind: "project" as const, ...REF };
const PAPER = NAMED[0];
if (PAPER === undefined) throw new Error("no Paper");

const paper = (more: Partial<McpServer> = {}): McpServer => ({
  scope,
  name: "paper",
  enabled: true,
  roles: { lead: true, writers: true, reviewers: true },
  transport: { type: "http", url: "https://mcp.paper.design" },
  headers: [],
  updatedAt: "2026-10-28T10:00:00Z",
  ...more,
});

/** A hub that answers each tool from `answers`, and keeps what it was asked. */
const stub = (answers: Record<string, unknown>) => {
  const calls: Array<{ tool: string; input: unknown; ms: number | undefined }> = [];
  const hub = {
    call: (tool: string, input: unknown, ms?: number) => {
      calls.push({ tool, input, ms });
      return Promise.resolve({ ok: true, output: answers[tool] });
    },
  } as unknown as Hub;
  return { hub, calls };
};

describe("a project's named services on the phone", () => {
  it("connects Paper as the desktop's manual form saves it: name, URL, no key, its agents too", async () => {
    const { hub, calls } = stub({ mcp_server_set: { server: paper() } });
    const out = await connect(hub, PAPER, REF, []);
    expect(out).toEqual({ ok: true, value: paper() });
    expect(calls).toEqual([
      {
        tool: "mcp_server_set",
        input: { scope, name: "paper", enabled: true, roles: { lead: true, writers: true, reviewers: true }, transport: { type: "http", url: "https://mcp.paper.design" }, env: [], headers: [] },
        ms: undefined,
      },
    ]);
  });

  it("takes paper-2 where paper is another server", async () => {
    const { hub, calls } = stub({ mcp_server_set: { server: paper({ name: "paper-2" }) } });
    await connect(hub, PAPER, REF, [paper({ transport: { type: "http", url: "https://mcp.crm.example" } })]);
    expect((calls[0]?.input as { name: string }).name).toBe("paper-2");
  });

  it("opens the sign-in page the hub gives, with the hub's own address to come back to", async () => {
    const { hub, calls } = stub({ mcp_oauth_start: { authorizeUrl: "https://app.paper.design/authorize?state=s1", redirectUri: "https://devbox.example.ts.net/oauth/callback" } });
    expect(await signInPage(hub, paper(), "Paper")).toEqual({ ok: true, value: "https://app.paper.design/authorize?state=s1" });
    expect(calls[0]?.input).toEqual({ scope, name: "paper" });
  });

  it("says where to go when the service wants an OAuth app of the person's own", async () => {
    const { hub } = stub({ mcp_oauth_start: { redirectUri: "https://devbox.example.ts.net/oauth/callback", needsClient: { issuer: "https://app.paper.design", boxPubKey: "k" } } });
    const out = await signInPage(hub, paper(), "Paper");
    expect(out.ok).toBe(false);
    expect(out.ok ? "" : out.error.message).toContain("desktop app");
  });

  it("reads, tests, turns on and disconnects by the server's own scope and name", async () => {
    const { hub, calls } = stub({
      mcp_servers_get: { global: [], project: [paper()], userServers: true },
      mcp_server_test: { machineId: "devbox", result: { tools: [{ name: "get_basic_info" }] } },
      mcp_server_set: { server: paper() },
      mcp_server_remove: { ok: true },
    });
    expect(await readServers(hub, REF)).toEqual({ ok: true, value: [paper()] });
    expect(await test(hub, paper())).toEqual({ ok: true, value: { machineId: "devbox", result: { tools: [{ name: "get_basic_info" }] } } });
    await turnOn(hub, paper({ enabled: false }));
    expect(await disconnect(hub, paper())).toEqual({ ok: true, value: null });
    expect(calls.map((c) => c.tool)).toEqual(["mcp_servers_get", "mcp_server_test", "mcp_server_set", "mcp_server_remove"]);
    expect(calls[0]?.input).toEqual({ project: REF });
    expect(calls[1]?.ms).toBe(TEST_MS);
    expect((calls[2]?.input as { enabled: boolean }).enabled).toBe(true);
  });

  it("shows Connect, Sign In, Connected and Off, and what a tap does", () => {
    expect(rowOf(namedState(PAPER, []))).toEqual({ value: "Connect", tone: "accent", press: "connect" });
    expect(rowOf(namedState(PAPER, [paper()]))).toEqual({ value: "Sign In", tone: "danger", press: "signin" });
    expect(rowOf(namedState(PAPER, [paper({ oauth: { status: "connected", issuer: "https://app.paper.design" } })]))).toEqual({ value: "Connected", tone: "quiet", press: "sheet" });
    expect(rowOf(namedState(PAPER, [paper({ enabled: false })]))).toEqual({ value: "Off", tone: "quiet", press: "sheet" });
  });

  it("says what a test found", () => {
    expect(testLine({ machineId: "devbox", result: { tools: [{ name: "a" }, { name: "b" }] } }, "devbox")).toEqual({ text: "Works on devbox: 2 tools.", signIn: false });
    expect(testLine({ machineId: "devbox", result: { signIn: true, error: "401" } }, "devbox")).toEqual({ text: "Sign in needed.", signIn: true });
    expect(testLine({ machineId: "devbox", result: { error: "timed out" } }, "devbox").text).toBe("Failed on devbox: timed out");
  });
});
