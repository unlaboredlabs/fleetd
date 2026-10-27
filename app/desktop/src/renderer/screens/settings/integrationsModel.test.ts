import { describe, expect, it } from "vitest";
import type { McpServer } from "../../../shared/contracts";
import { byPolicy, connectionsOf, googleRequest, isNavi, notionRequest, policyLine, testProblem, xaqAddress, xaqRedirectUri } from "./integrationsModel";

const scope = { kind: "project" as const, machineId: "devbox", projectId: "navi" };
const boxes = [{ machineId: "devbox", boxPubKey: "Az+6kf/abi0V7SO+sn4h++sIgyPoNDAneLBDFaJf3TA=" }];

describe("a Navi's integrations model", () => {
  it("reads xaq's address with or without /mcp, a scheme or a trailing slash", () => {
    for (const typed of ["http://127.0.0.1:8425", "127.0.0.1:8425", "http://127.0.0.1:8425/", "http://127.0.0.1:8425/mcp"]) {
      expect(xaqAddress(typed)).toEqual({ ok: true, base: "http://127.0.0.1:8425", mcp: "http://127.0.0.1:8425/mcp" });
    }
    expect(xaqAddress("ftp://x").ok).toBe(false);
    expect(xaqRedirectUri("http://127.0.0.1:8425")).toBe("http://localhost:8425/oauth/callback");
    expect(xaqRedirectUri("https://mail.example.com")).toBe("https://mail.example.com/oauth/callback");
  });
  it("takes a key with or without Bearer, and refuses what isn't one", () => {
    const a = googleRequest("127.0.0.1:8425", "Bearer aib_x1", scope, boxes);
    expect(a.ok && a.request.headers).toEqual([{ kind: "secret", name: "Authorization", value: "Bearer aib_x1" }]);
    expect(googleRequest("127.0.0.1:8425", "aib_x1", scope, []).ok).toBe(false);
    expect(notionRequest("secret_old", scope, boxes).ok).toBe(true);
    expect(notionRequest("hunter2", scope, boxes).ok).toBe(false);
  });
  it("finds each connection by what it is, not by its name", () => {
    const s = (name: string, kind?: "google" | "notion" | "custom") => ({ name, ...(kind === undefined ? {} : { integration: { kind } }) }) as unknown as McpServer;
    const c = connectionsOf([s("mail", "google"), s("notion"), s("crm", "custom")]);
    expect(c.google?.name).toBe("mail");
    expect(c.notion).toBeUndefined();
    expect(c.custom.map((x) => x.name)).toEqual(["crm"]);
    expect(isNavi({ kind: "assistant" } as never)).toBe(true);
    expect(isNavi({} as never)).toBe(false);
  });
  it("says what a test found by policy, and a failure in the integration's words", () => {
    const p = byPolicy([{ name: "a", policy: "read" }, { name: "b" }, { name: "c", policy: "blocked" }]);
    expect(policyLine(p)).toBe("1 tool reads freely · 1 asks you each time · 1 is never allowed");
    expect(testProblem("google", "HTTP 401 Unauthorized", "devbox")).toContain("xaq refused the key");
    expect(testProblem("notion", "spawn npx ENOENT", "devbox")).toContain("comes with Node.js");
    expect(testProblem("custom", "boom", "devbox")).toBe("Failed on devbox: boom");
  });
});
