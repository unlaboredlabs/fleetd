// A Navi's Integrations (Settings → Projects → the Navi). integrations-none: the typical hub's first project
// marked as a Navi (kind assistant), nothing connected yet. integrations-connected: Notion and a custom server
// connected, each key sealed on devbox, and Test connection answering with each tool by the hub's policy. The approval
// cards an integration raises are in inline-items (an email to send, a Notion page to trash).
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
  integration: { kind: "custom", readTools: ["list_issues", "get_issue"] },
  updatedAt: AT,
});

const notion = (ref: { machineId: string; projectId: string }): JsonObject => ({
  scope: { kind: "project", ...ref },
  name: "notion",
  enabled: true,
  roles: { lead: true, writers: false, reviewers: false },
  transport: { type: "stdio", command: "npx", args: ["-y", "@notionhq/notion-mcp-server"] },
  env: [{ name: "NOTION_TOKEN", kind: "secret", sealedOn: sealed(ref.machineId) }],
  integration: { kind: "notion" },
  updatedAt: AT,
});

const tools = (read: string[], ask: string[]) => [...read.map((name) => ({ name, policy: "read" })), ...ask.map((name) => ({ name, policy: "ask" }))];

const LINEAR_TOOLS = [...tools(["list_issues", "get_issue"], ["create_issue", "update_issue", "delete_issue"])];
const NOTION_TOOLS = tools(
  ["API-post-search", "API-retrieve-a-page", "API-get-block-children", "API-query-data-source", "API-retrieve-a-comment"],
  ["API-post-page", "API-patch-page", "API-patch-block-children", "API-delete-a-block", "API-create-a-comment"],
);

const empty = (base: Fixture): Fixture => {
  const f = Fixture.from(base, "integrations-none", "A Navi's Integrations with nothing connected yet: Notion, and Add an MCP server.");
  const ref = navi(f);
  f.answer("mcp_servers_get", { project: ref }, { global: [], project: [], userServers: true });
  return f;
};

const connected = (base: Fixture): Fixture => {
  const f = Fixture.from(base, "integrations-connected", "A Navi with Notion and a custom server connected, each key sealed on its machine; Test connection lists each tool by policy.");
  const ref = navi(f);
  f.answer("mcp_servers_get", { project: ref }, { global: [], project: [notion(ref), custom(ref)], userServers: true });
  const scope = { kind: "project", ...ref };
  f.answer("mcp_server_test", { scope, name: "linear" }, { machineId: ref.machineId, result: { server: "Linear 1.4.0", tools: LINEAR_TOOLS } });
  f.answer("mcp_server_test", { scope, name: "notion" }, { machineId: ref.machineId, result: { server: "Notion API 2.0.0", tools: NOTION_TOOLS } });
  return f;
};

export default defineGroup({
  fixtures: (base) => [empty(base("typical")), connected(base("typical"))],
});
