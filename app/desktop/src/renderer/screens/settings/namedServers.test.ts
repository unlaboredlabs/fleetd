import { describe, expect, it } from "vitest";
import type { McpServer } from "../../../shared/contracts";
import { emptyDraft, toInput } from "../connections/model";
import { accountLabel, accountsOf, accountState, NAMED, nameFor, namedInput, namedOf, namedState, namedWord, turnOnInput, unnamed } from "./namedServers";

const scope = { kind: "project" as const, machineId: "devbox", projectId: "ada" };
const PAPER = NAMED.find((n) => n.id === "paper");
if (PAPER === undefined) throw new Error("no Paper");

const server = (name: string, url: string, more: Partial<McpServer> = {}): McpServer => ({
  scope,
  name,
  enabled: true,
  roles: { lead: true, writers: true, reviewers: true },
  transport: { type: "http", url },
  headers: [],
  updatedAt: "2026-10-27T10:00:00.000Z",
  ...more,
});

describe("named MCP servers", () => {
  it("imports no package, so the phone reads it as it is", async () => {
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(new URL("./namedServers.ts", import.meta.url), "utf8");
    expect([...text.matchAll(/from "([^"]+)"/gu)].map((m) => m[1])).toEqual(["../../../shared/contracts"]);
  });

  it("ships Paper and Notion alone, each record complete", () => {
    expect(NAMED.map((n) => n.id)).toEqual(["paper", "notion"]);
    expect(PAPER).toMatchObject({ label: "Paper", url: "https://mcp.paper.design", name: "paper", agents: true });
    expect(NAMED[1]).toMatchObject({ label: "Notion", url: "https://mcp.notion.com/mcp", name: "notion", agents: true });
  });

  it("saves what the custom MCP form saves for the same name and URL, with no key, for every bot", () => {
    const manual = toInput({ ...emptyDraft(), url: "https://mcp.paper.design", named: true, name: "paper" }, null, []);
    expect(manual.ok).toBe(true);
    expect(namedInput(PAPER, { kind: "global" }, [])).toEqual(manual.ok ? manual.input : null);
  });

  it("knows a server by its URL, whatever its case or trailing slash", () => {
    expect(namedOf(server("design", "https://MCP.paper.design/"))?.id).toBe("paper");
    expect(namedOf(server("paper", "https://mcp.paper.design/other"))).toBeUndefined();
    expect(namedOf({ ...server("x", ""), transport: { type: "stdio", command: "npx", args: [] } })).toBeUndefined();
  });

  it("takes every server at its URL as an account, the one by its name first, and lists the rest as themselves", () => {
    const list = [server("paper-work", "https://mcp.paper.design"), server("design", "https://mcp.paper.design/"), server("paper", "https://mcp.paper.design"), server("crm", "https://mcp.crm.example")];
    expect(accountsOf(PAPER, list).map((s) => s.name)).toEqual(["paper", "design", "paper-work"]);
    expect(unnamed(list).map((s) => s.name)).toEqual(["crm"]);
    const [work, , own] = list;
    if (work === undefined || own === undefined) throw new Error("no servers");
    expect(accountLabel(PAPER, work, list)).toBe("paper-work");
    expect(accountLabel(PAPER, own, [own])).toBe("Paper");
    expect(accountLabel(PAPER, work, [work])).toBe("paper-work");
  });

  it("takes the first free name after paper, or the one the person gives another account", () => {
    expect(nameFor(PAPER, [])).toBe("paper");
    expect(nameFor(PAPER, ["Paper", "paper-2"])).toBe("paper-3");
    expect(namedInput(PAPER, { kind: "global" }, ["paper"])).toMatchObject({ name: "paper-2", transport: { type: "http", url: PAPER.url } });
    expect(namedInput(PAPER, { kind: "global" }, ["paper"], "paper-work")).toMatchObject({ name: "paper-work", transport: { type: "http", url: PAPER.url } });
  });

  it("says where each account stands on its own", () => {
    const one = server("paper", PAPER.url, { oauth: { status: "connected", issuer: "https://app.paper.design" } });
    const two = server("paper-2", PAPER.url, { oauth: { status: "signed_out", issuer: "https://app.paper.design", signingIn: true } });
    expect([one, two].map((s) => accountState(s).kind)).toEqual(["connected", "signing"]);
    expect(namedState(PAPER, [two, one]).kind).toBe("connected");
  });

  it("says where it stands", () => {
    const at = (more: Partial<McpServer>) => namedState(PAPER, [server("paper", PAPER.url, more)]);
    expect(namedState(PAPER, []).kind).toBe("add");
    expect(at({}).kind).toBe("signin");
    expect(at({ oauth: { status: "signed_out", issuer: "https://app.paper.design", signingIn: true } }).kind).toBe("signing");
    expect(at({ oauth: { status: "connected", issuer: "https://app.paper.design" } }).kind).toBe("connected");
    // Its token ended and can't be renewed: agents are turned away, so it says so rather than Connected.
    const stuck = at({ oauth: { status: "connected", issuer: "https://app.paper.design", problem: "fleetd can't renew its sign-in: down. It keeps trying." } });
    expect(stuck).toMatchObject({ kind: "signin", problem: "fleetd can't renew its sign-in: down. It keeps trying." });
    expect(namedWord(stuck)).toEqual({ text: "Sign in needed", tone: "danger" });
    expect(at({ enabled: false }).kind).toBe("off");
    // Added by hand with a key of its own: nothing to sign in to.
    expect(at({ headers: [{ name: "Authorization", kind: "secret", sealedOn: [] }] }).kind).toBe("connected");
    expect(namedWord(at({}))).toEqual({ text: "Sign in needed", tone: "danger" });
    expect(namedWord(namedState(PAPER, []))).toBeNull();
  });

  it("turns one back on as it was, its key kept", () => {
    const off = server("paper", PAPER.url, { enabled: false, roles: { lead: true, writers: false, reviewers: false }, headers: [{ name: "Authorization", kind: "secret", sealedOn: [] }] });
    expect(turnOnInput(off)).toMatchObject({ name: "paper", enabled: true, roles: { lead: true, writers: false, reviewers: false }, headers: [{ kind: "keep", name: "Authorization" }] });
  });
});
