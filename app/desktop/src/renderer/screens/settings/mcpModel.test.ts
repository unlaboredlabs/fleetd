import { describe, expect, it } from "vitest";
import type { McpServer } from "../../../shared/contracts";
import { draftOf, emptyDraft, globalsFor, missingOn, nameProblem, rolesText, toRequest, transportText, valuesText } from "./mcpModel";

const AT = "2026-10-19T10:00:00.000Z";
const KEY = "Az+6kf/abi0V7SO+sn4h++sIgyPoNDAneLBDFaJf3TA=";

const github: McpServer = {
  scope: { kind: "global" },
  name: "github",
  enabled: true,
  roles: { lead: true, writers: true, reviewers: false },
  transport: { type: "http", url: "https://api.example.com/mcp" },
  headers: [
    { name: "Authorization", kind: "secret", sealedOn: [{ machineId: "devbox", fingerprint: "5ec2e7a1" }] },
    { name: "X-Team", kind: "plain", value: "core" },
  ],
  updatedAt: AT,
};

describe("MCP servers' model", () => {
  it("says who gets a server, how it is reached, and its values without a secret's", () => {
    expect(rolesText(github.roles)).toBe("Lead and writers");
    expect(rolesText({ lead: true, writers: true, reviewers: true })).toBe("Lead, writers and reviewers");
    expect(rolesText({ lead: false, writers: false, reviewers: true })).toBe("Reviewers");
    expect(rolesText({ lead: false, writers: false, reviewers: false })).toBe("No one");
    expect(transportText(github)).toBe("HTTP https://api.example.com/mcp");
    expect(transportText({ ...github, transport: { type: "stdio", command: "npx", args: ["-y", "@acme/mcp"] } })).toBe("npx -y @acme/mcp");
    expect(valuesText(github)).toBe("Authorization=secret · X-Team=core");
  });

  it("names the machines a secret isn't on, and the global servers a project replaces", () => {
    expect(missingOn(github, ["devbox", "laptop"])).toEqual(["laptop"]);
    const own = { ...github, scope: { kind: "project" as const, machineId: "devbox", projectId: "p1" } };
    expect(globalsFor([github, { ...github, name: "docs" }], [own])).toEqual([
      { server: github, replaced: true },
      { server: { ...github, name: "docs" }, replaced: false },
    ]);
  });

  it("keeps a saved secret left blank, seals a typed one to every machine, and refuses what the hub would", () => {
    const draft = draftOf(github);
    const boxes = [{ machineId: "devbox", boxPubKey: KEY }];
    const kept = toRequest(draft, { kind: "global" }, boxes);
    expect(kept).toEqual({
      ok: true,
      request: {
        scope: { kind: "global" },
        name: "github",
        enabled: true,
        roles: github.roles,
        transport: { type: "http", url: "https://api.example.com/mcp" },
        env: [],
        headers: [
          { kind: "keep", name: "Authorization" },
          { kind: "plain", name: "X-Team", value: "core" },
        ],
        boxes: [],
      },
    });
    const typed = toRequest({ ...draft, values: draft.values.map((v) => (v.secret ? { ...v, value: "Bearer new" } : v)) }, { kind: "global" }, boxes);
    expect(typed.ok && typed.request.headers[0]).toEqual({ kind: "secret", name: "Authorization", value: "Bearer new" });
    expect(typed.ok && typed.request.boxes).toEqual(boxes);

    const stdio = { ...emptyDraft(), name: "db", command: "db-mcp", args: "--read-only\n\n --port=5 ", values: [{ name: "DB_PASSWORD", secret: true, value: "pw", saved: false }] };
    const out = toRequest(stdio, { kind: "project", machineId: "devbox", projectId: "p1" }, boxes);
    expect(out.ok && out.request.transport).toEqual({ type: "stdio", command: "db-mcp", args: ["--read-only", "--port=5"] });
    expect(out.ok && out.request.env).toEqual([{ kind: "secret", name: "DB_PASSWORD", value: "pw" }]);

    for (const [bad, problem] of [
      [{ ...stdio, name: "fleetd" }, "fleetd's own"],
      [{ ...stdio, command: "" }, "command"],
      [{ ...stdio, values: [{ name: "A-B", secret: false, value: "x", saved: false }] }, "environment variable name"],
      [{ ...stdio, values: [{ name: "K", secret: true, value: "", saved: false }] }, "Type K's secret value"],
      [{ ...draft, url: "ftp://x" }, "http or https"],
      [{ ...draft, values: [{ name: "X-A", secret: false, value: "a\nb", saved: false }] }, "line break"],
    ] as const) {
      const r = toRequest(bad, { kind: "global" }, boxes);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.problem).toContain(problem);
    }
    expect(toRequest(stdio, { kind: "global" }, []).ok).toBe(false);
    expect(nameProblem("github", ["github"])).toContain("already there");
    expect(nameProblem("a b", [])).toContain("Letters");
  });
});
