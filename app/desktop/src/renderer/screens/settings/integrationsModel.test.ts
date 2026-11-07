import { describe, expect, it } from "vitest";
import type { McpServer } from "../../../shared/contracts";
import { emptyDraft } from "./mcpModel";
import { byPolicy, connectionsOf, customRequest, emptyNote, markOf, policyLine, signInLine, signInOutcome, statusOf, testProblem } from "./integrationsModel";

const scope = { kind: "project" as const, machineId: "devbox", projectId: "ada" };
const boxes = [{ machineId: "devbox", boxPubKey: "Az+6kf/abi0V7SO+sn4h++sIgyPoNDAneLBDFaJf3TA=" }];

describe("a project's integrations model", () => {
  it("saves a server for the lead only, with the tools marked as reading", () => {
    const draft = { ...emptyDraft(), name: "crm", kind: "http" as const, url: "https://mcp.example.com/mcp" };
    const built = customRequest(draft, ["list_contacts"], scope, boxes);
    expect(built.ok && built.request.integration).toEqual({ readTools: ["list_contacts"] });
    expect(built.ok && built.request.roles).toEqual({ lead: true, writers: false, reviewers: false });
    const none = customRequest(draft, [], scope, boxes);
    expect(none.ok && none.request.integration).toEqual({});
  });
  it("finds the servers connected as integrations, whatever an older app marked them", () => {
    const s = (name: string, integration?: object) => ({ name, ...(integration === undefined ? {} : { integration }) }) as unknown as McpServer;
    const c = connectionsOf([s("plain"), s("crm", {}), s("docs", { kind: "custom", readTools: ["search"] })]);
    expect(c.map((x) => x.name)).toEqual(["crm", "docs"]);
  });
  it("says what a test found by policy, and where a failure happened", () => {
    const p = byPolicy([{ name: "a", policy: "read" }, { name: "b" }, { name: "c", policy: "blocked" }]);
    expect(policyLine(p)).toBe("1 tool runs without asking · 1 asks you each time · 1 is never allowed");
    expect(testProblem("boom", "devbox")).toBe("Failed on devbox: boom");
    expect(testProblem("HTTP 403 Forbidden.", "devbox")).toBe("Failed on devbox: HTTP 403 Forbidden. Check the key: the server refused it.");
    expect(emptyNote({ tools: [] })).toBe("The server answered but lists no tools.");
    expect(emptyNote({ tools: [{ name: "a" }] })).toBeNull();
  });

  it("says a server that wants a sign-in as the hub does, with no key to check", () => {
    expect(testProblem("mail asks you to sign in with your own account, not a key.", "devbox", true)).toBe("mail asks you to sign in with your own account, not a key.");
  });

  it("reads an OAuth server's sign-in for its row", () => {
    const server = { scope, name: "mail", enabled: true, roles: { lead: true, writers: false, reviewers: false }, transport: { type: "http", url: "https://m.example/mcp" }, updatedAt: "2026-11-03T10:00:00.000Z" } satisfies McpServer;
    const issuer = "https://auth.example.com";
    expect(statusOf(server)).toEqual({ text: "Connected", tone: "quiet" });
    expect(statusOf({ ...server, oauth: { status: "signed_out", issuer } })).toEqual({ text: "Signed out", tone: "danger" });
    expect(statusOf({ ...server, oauth: { status: "signed_out", issuer, signingIn: true } }).text).toBe("Signing in…");
    expect(signInLine({ status: "connected", issuer, clientId: "mine" }).text).toBe(
      "Signed in with `auth.example.com`, with your own app. fleetd renews the sign-in by itself, and it never goes in the chat.",
    );
    // A renewal failing past the token's end is said on a server still signed in.
    expect(signInLine({ status: "connected", issuer, problem: "fleetd can't renew its sign-in." })).toEqual({ text: "fleetd can't renew its sign-in.", tone: "danger" });
  });

  it("follows a sign-in in the browser until the hub has moved on from where it was opened", () => {
    const issuer = "https://auth.example.com";
    const before = { status: "signed_out" as const, issuer, problem: "auth.example.com ended the sign-in." };
    const mark = markOf(before);
    // The answer still shows the server as it was: not done yet.
    expect(signInOutcome(before, mark)).toEqual({ kind: "waiting", mark });
    const waiting = signInOutcome({ status: "signed_out", issuer, signingIn: true }, mark);
    expect(waiting).toEqual({ kind: "waiting", mark: { ...mark, seen: true } });
    if (waiting.kind !== "waiting") throw new Error("not waiting");
    expect(signInOutcome({ status: "connected", issuer, signedInAt: "2026-11-03T10:00:00.000Z" }, waiting.mark)).toEqual({ kind: "connected" });
    expect(signInOutcome({ status: "signed_out", issuer, problem: "no" }, waiting.mark)).toEqual({ kind: "failed", problem: "no" });
    // Done before the app saw it waiting: a new sign-in time says so too.
    expect(signInOutcome({ status: "connected", issuer, signedInAt: "2026-11-03T10:00:00.000Z" }, mark)).toEqual({ kind: "connected" });
  });
});
