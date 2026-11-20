import { describe, expect, it } from "vitest";
import type { McpServer } from "../../../shared/contracts";
import { customRequest } from "./integrationsModel";
import { emptyDraft, requestOf } from "./mcpModel";
import { NAMED, nameFor, namedInput, namedOf, namedState, namedWord, serverOf, turnOnInput, unnamed } from "./namedServers";

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

  it("ships Paper alone, each record complete", () => {
    expect(NAMED.map((n) => n.id)).toEqual(["paper"]);
    expect(PAPER).toMatchObject({ label: "Paper", url: "https://mcp.paper.design", name: "paper", agents: true });
  });

  it("saves what the manual form saves for the same name, URL, no key and Agents get it too", () => {
    const manual = customRequest({ ...emptyDraft(), name: "paper", kind: "http", url: "https://mcp.paper.design" }, [], scope, [], true);
    expect(manual.ok).toBe(true);
    expect(requestOf(namedInput(PAPER, scope, []))).toEqual(manual.ok ? manual.request : null);
  });

  it("knows a server by its URL, whatever its case or trailing slash", () => {
    expect(namedOf(server("design", "https://MCP.paper.design/"))?.id).toBe("paper");
    expect(namedOf(server("paper", "https://mcp.paper.design/other"))).toBeUndefined();
    expect(namedOf({ ...server("x", ""), transport: { type: "stdio", command: "npx", args: [] } })).toBeUndefined();
  });

  it("picks the one by its name of two at its URL, and lists the rest as themselves", () => {
    const list = [server("design", "https://mcp.paper.design"), server("paper", "https://mcp.paper.design"), server("crm", "https://mcp.crm.example")];
    expect(serverOf(PAPER, list)?.name).toBe("paper");
    expect(unnamed(list).map((s) => s.name)).toEqual(["design", "crm"]);
  });

  it("takes the first free name after paper", () => {
    expect(nameFor(PAPER, [])).toBe("paper");
    expect(nameFor(PAPER, ["Paper", "paper-2"])).toBe("paper-3");
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
