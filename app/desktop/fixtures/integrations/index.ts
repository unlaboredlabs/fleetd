// A Navi's Integrations (Settings → Projects → the Navi). integrations-none: the typical hub's first project
// marked as a Navi (kind assistant), nothing connected yet. integrations-connected: two MCP servers connected, each
// key sealed on devbox, and Test connection answering with each tool by the hub's policy. The approval cards an
// integration raises are in inline-items (a message to send, a page to delete). integrations-adding: nothing connected
// yet, and a test of xaq (a URL server with a key) answering with four tools to pick from.
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { arr } from "../kit/stress.ts";
import { asText, isObject, type JsonObject } from "../kit/json.ts";

const AT = "2026-10-27T09:00:00.000Z";

/** Marks the first project a Navi and returns its ref. */
const navi = (f: Fixture): { machineId: string; projectId: string } => {
  const projects = arr(f.snapshot?.["projects"]).filter(isObject);
  const first = projects[0];
  if (first === undefined) throw new Error("navi fixtures: the base has no project");
  first["kind"] = "assistant";
  first["title"] = "Home";
  const ref = { machineId: asText(first["machineId"]), projectId: asText(first["projectId"]) };
  f.answer("project_settings_get", ref, {
    settings: {
      ...ref,
      title: "Home",
      workspaceRoot: "/home/dev/navi/home",
      keepWorktrees: false,
      setup: { commands: [], timeoutSec: 600, runAnyway: false, inputs: [] },
      env: [],
      worktrees: { dir: `/home/dev/.fleetd/node/worktrees/${ref.projectId}`, baseBranch: "main", worktrees: [] },
    },
  });
  return ref;
};

const sealed = (machineId: string) => [{ machineId, fingerprint: "5ec2e7a1" }];

const custom = (ref: { machineId: string; projectId: string }): JsonObject => ({
  scope: { kind: "project", ...ref },
  name: "linear",
  enabled: true,
  roles: { lead: true, writers: false, reviewers: false },
  transport: { type: "http", url: "https://mcp.linear.app/mcp" },
  headers: [{ name: "Authorization", kind: "secret", sealedOn: sealed(ref.machineId) }],
  integration: { readTools: ["list_issues", "get_issue"] },
  updatedAt: AT,
});

const docs = (ref: { machineId: string; projectId: string }): JsonObject => ({
  scope: { kind: "project", ...ref },
  name: "docs",
  enabled: true,
  roles: { lead: true, writers: false, reviewers: false },
  transport: { type: "stdio", command: "npx", args: ["-y", "@acme/docs-mcp"] },
  env: [{ name: "DOCS_TOKEN", kind: "secret", sealedOn: sealed(ref.machineId) }],
  integration: { readTools: ["search_pages", "get_page"] },
  updatedAt: AT,
});

const tools = (read: string[], ask: string[]) => [...read.map((name) => ({ name, policy: "read" })), ...ask.map((name) => ({ name, policy: "ask" }))];

const LINEAR_TOOLS = [...tools(["list_issues", "get_issue"], ["create_issue", "update_issue", "delete_issue"])];
const DOCS_TOOLS = tools(["search_pages", "get_page"], ["create_page", "update_page", "delete_page"]);

const empty = (base: Fixture): Fixture => {
  const f = Fixture.from(base, "integrations-none", "A Navi's Integrations with nothing connected yet: Add an MCP server.");
  const ref = navi(f);
  f.answer("mcp_servers_get", { project: ref }, { global: [], project: [], userServers: true });
  return f;
};

const connected = (base: Fixture): Fixture => {
  const f = Fixture.from(base, "integrations-connected", "A Navi with two MCP servers connected, each key sealed on its machine; Test connection lists each tool by policy.");
  const ref = navi(f);
  f.answer("mcp_servers_get", { project: ref }, { global: [], project: [docs(ref), custom(ref)], userServers: true });
  const scope = { kind: "project", ...ref };
  f.answer("mcp_server_test", { scope, name: "linear" }, { machineId: ref.machineId, result: { server: "Linear 1.4.0", tools: LINEAR_TOOLS } });
  f.answer("mcp_server_test", { scope, name: "docs" }, { machineId: ref.machineId, result: { server: "Docs 2.0.0", tools: DOCS_TOOLS } });
  return f;
};

const XAQ_TOOLS = [
  { name: "search_notes", readOnly: true, policy: "ask" },
  { name: "read_note", readOnly: true, policy: "ask" },
  { name: "create_note", policy: "ask" },
  { name: "delete_note", policy: "ask" },
];

const adding = (base: Fixture): Fixture => {
  const f = Fixture.from(base, "integrations-adding", "A Navi adding a URL MCP server with a key (xaq): its test lists four tools to pick from.");
  const ref = navi(f);
  f.answer("mcp_servers_get", { project: ref }, { global: [], project: [], userServers: true });
  f.answer("mcp_server_test", { scope: { kind: "project", ...ref }, name: "xaq" }, { machineId: ref.machineId, result: { server: "xaq 0.3.0", tools: XAQ_TOOLS } });
  return f;
};

export default defineGroup({
  fixtures: (base) => [empty(base("typical")), connected(base("typical")), adding(base("typical"))],
});
