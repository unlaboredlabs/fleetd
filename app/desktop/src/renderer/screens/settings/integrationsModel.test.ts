import { describe, expect, it } from "vitest";
import type { McpServer } from "../../../shared/contracts";
import { emptyDraft } from "./mcpModel";
import { byPolicy, connectionsOf, customRequest, emptyNote, isNavi, policyLine, testProblem } from "./integrationsModel";

const scope = { kind: "project" as const, machineId: "devbox", projectId: "navi" };
const boxes = [{ machineId: "devbox", boxPubKey: "Az+6kf/abi0V7SO+sn4h++sIgyPoNDAneLBDFaJf3TA=" }];

describe("a Navi's integrations model", () => {
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
    expect(isNavi({ kind: "assistant" } as never)).toBe(true);
    expect(isNavi({} as never)).toBe(false);
  });
  it("says what a test found by policy, and where a failure happened", () => {
    const p = byPolicy([{ name: "a", policy: "read" }, { name: "b" }, { name: "c", policy: "blocked" }]);
    expect(policyLine(p)).toBe("1 tool reads freely · 1 asks you each time · 1 is never allowed");
    expect(testProblem("boom", "devbox")).toBe("Failed on devbox: boom");
    expect(emptyNote({ tools: [] })).toBe("The server answered but lists no tools.");
    expect(emptyNote({ tools: [{ name: "a" }] })).toBeNull();
  });
});
