import { describe, expect, it } from "vitest";
import type { McpServer } from "../../../shared/contracts";
import { emptyDraft } from "./mcpModel";
import { byPolicy, connectionsOf, customRequest, isNavi, notionRequest, policyLine, testProblem } from "./integrationsModel";

const scope = { kind: "project" as const, machineId: "devbox", projectId: "navi" };
const boxes = [{ machineId: "devbox", boxPubKey: "Az+6kf/abi0V7SO+sn4h++sIgyPoNDAneLBDFaJf3TA=" }];

describe("a Navi's integrations model", () => {
  it("takes a Notion secret, and refuses what isn't one", () => {
    expect(notionRequest("secret_old", scope, boxes).ok).toBe(true);
    expect(notionRequest("hunter2", scope, boxes).ok).toBe(false);
    expect(notionRequest("ntn_x1", scope, []).ok).toBe(false);
  });
  it("keeps Navi's own connection names off custom servers", () => {
    for (const name of ["google", "notion"]) expect(customRequest({ ...emptyDraft(), name, kind: "http", url: "https://mcp.example.com/mcp" }, [], scope, boxes).ok).toBe(false);
  });
  it("finds each connection by what it is, not by its name", () => {
    const s = (name: string, kind?: "google" | "notion" | "custom") => ({ name, ...(kind === undefined ? {} : { integration: { kind } }) }) as unknown as McpServer;
    const c = connectionsOf([s("mail", "google"), s("notion"), s("crm", "custom")]);
    expect(c.notion).toBeUndefined();
    expect(c.custom.map((x) => x.name)).toEqual(["crm"]);
    expect(isNavi({ kind: "assistant" } as never)).toBe(true);
    expect(isNavi({} as never)).toBe(false);
  });
  it("says what a test found by policy, and a failure in the integration's words", () => {
    const p = byPolicy([{ name: "a", policy: "read" }, { name: "b" }, { name: "c", policy: "blocked" }]);
    expect(policyLine(p)).toBe("1 tool reads freely · 1 asks you each time · 1 is never allowed");
    expect(testProblem("notion", "HTTP 401 Unauthorized", "devbox")).toContain("Notion refused the token");
    expect(testProblem("notion", "spawn npx ENOENT", "devbox")).toContain("comes with Node.js");
    expect(testProblem("custom", "boom", "devbox")).toBe("Failed on devbox: boom");
  });
});
