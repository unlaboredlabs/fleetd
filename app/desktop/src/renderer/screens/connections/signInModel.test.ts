import { describe, expect, it } from "vitest";
import { hostOf, markOf, requestOf, signInOutcome } from "./signInModel";

describe("a sign-in to an MCP server", () => {
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

  it("names a host, and a save with vault items and bots as main's request, nothing to seal", () => {
    expect(hostOf("https://mcp.notion.com/mcp")).toBe("mcp.notion.com");
    expect(hostOf("nope")).toBe("nope");
    expect(
      requestOf({
        scope: { kind: "global" },
        name: "linear",
        enabled: true,
        roles: { lead: true, writers: true, reviewers: true },
        transport: { type: "http", url: "https://mcp.linear.app/mcp" },
        headers: [
          { kind: "vault", name: "Authorization", itemId: "V1", prefix: "Bearer " },
          { kind: "keep", name: "X-Team" },
        ],
        projects: [{ machineId: "devbox", projectId: "ada" }],
      }),
    ).toEqual({
      scope: { kind: "global" },
      name: "linear",
      enabled: true,
      roles: { lead: true, writers: true, reviewers: true },
      transport: { type: "http", url: "https://mcp.linear.app/mcp" },
      env: [],
      headers: [
        { kind: "vault", name: "Authorization", itemId: "V1", prefix: "Bearer " },
        { kind: "keep", name: "X-Team" },
      ],
      boxes: [],
      projects: [{ machineId: "devbox", projectId: "ada" }],
    });
  });
});
