// A Navi's Integrations and Approvals (Settings → Projects → the Navi). integrations-none: the typical hub's first
// project marked as a Navi (kind assistant), nothing connected yet. integrations-connected: two MCP servers connected,
// each key sealed on devbox, and Test connection answering with each tool by the hub's policy. integrations-approvals: its
// approvals with the checker on, and what ran without asking (the checker's go with its reason, YOLO's run, a first
// visit), each linking to its line. integrations-adding: nothing connected yet, and a test of xaq (a URL server with a
// key) answering with four tools to pick from. The approval cards an integration raises are in inline-items (a
// message to send, a page to delete).
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { arr } from "../kit/stress.ts";
import { asText, isObject, type JsonObject } from "../kit/json.ts";
import { profilesList } from "../settings/profiles.ts";

const AT = "2026-10-27T09:00:00.000Z";

/** Marks the first project a Navi and returns its ref. */
const navi = (f: Fixture): { machineId: string; projectId: string } => {
  const projects = arr(f.snapshot?.["projects"]).filter(isObject);
  const first = projects[0];
  if (first === undefined) throw new Error("navi fixtures: the base has no project");
  first["kind"] = "assistant";
  first["title"] = "Home";
  const ref = { machineId: asText(first["machineId"]), projectId: asText(first["projectId"]) };
  f.answer("navi_purchases", ref, { purchases: [] });
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
  f.answer("navi_approvals", ref, { approvals: CHECKER, log: [] });
  f.answer("profiles_list", {}, profilesList());
  return ref;
};

const CHECKER = { mode: "checker", model: "claude-sonnet-5-5", effort: "medium", defaults: true };

/** What ran without asking, newest first, as navi_approvals answers it. */
const LOG: JsonObject[] = [
  {
    at: "2026-10-31T16:42:00.000Z",
    by: "checker",
    tool: "mcp__fleetd__confirm_step",
    what: 'Click "Complete reservation" on `lupa.example`',
    reason: "you asked to book Lupa for two on Saturday at 8",
    messageId: "m412",
  },
  {
    at: "2026-10-31T14:05:00.000Z",
    by: "checker",
    tool: "mcp__gmail__send_message",
    what: "`send_message` on `gmail`, to sam@example.com",
    reason: "you asked to tell Sam that Saturday works",
    messageId: "m398",
  },
  {
    at: "2026-10-31T11:20:00.000Z",
    by: "checker",
    tool: "WebFetch",
    what: "Fetch `dentist-lisboa.example`",
    reason: "you asked for the dentist's opening hours, and this is its own site",
    messageId: "m377",
  },
  {
    at: "2026-10-30T18:02:00.000Z",
    by: "yolo",
    tool: "mcp__linear__create_issue",
    what: "`create_issue` on `linear`",
    messageId: "m350",
  },
];

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

/** A Navi's Payments: the card it pays with, the Credit Card items the person's 1Password reads, and its purchases. */
const payments = (base: Fixture): Fixture => {
  const f = Fixture.from(base, "integrations-payments", "A Navi's Payments: it pays with Visa from 1Password, and its purchases: a hotel waiting, a train ticket filled, a flight not bought.");
  const ref = navi(f);
  f.answer("mcp_servers_get", { project: ref }, { global: [], project: [], userServers: true });
  const card = { ref: "op://Personal/Visa" };
  const entry = (requestId: string, state: string, shop: [string, string], amount: string, asked: string, extra: JsonObject = {}): JsonObject => ({
    requestId,
    state,
    askedAt: asked,
    purchase: {
      shop: { name: shop[0], domain: shop[1] },
      total: { amount, currency: "EUR" },
      items: [{ name: shop[0], quantity: 1, amount }],
      card,
      sessionId: `B0000000000000000000000000000${requestId.slice(1).padStart(4, "0")}`,
    },
    ...extra,
  });
  f.answer("navi_purchases", ref, {
    card,
    purchases: [
      entry("Q22", "open", ["Hotel Devbox", "hotel-devbox.example"], "264.40", "2026-10-31T08:58:00.000Z"),
      entry("Q21", "ran", ["Rail Example", "tickets.rail.example"], "38.50", "2026-10-31T08:39:00.000Z", { answeredAt: "2026-10-31T08:40:02.000Z", answeredBy: "human:desk" }),
      entry("Q17", "denied", ["Air Example", "book.air.example"], "412.00", "2026-10-29T17:12:00.000Z", { answeredAt: "2026-10-29T17:20:00.000Z", answeredBy: "human:desk" }),
    ],
  });
  f.answer("onepassword_cards", {}, {
    machineId: ref.machineId,
    cards: [
      { ref: "op://Personal/Visa", title: "Visa", vault: "Personal" },
      { ref: "op://Shared/Company Amex", title: "Company Amex", vault: "Shared" },
    ],
  });
  return f;
};

const approvals = (base: Fixture): Fixture => {
  const f = Fixture.from(base, "integrations-approvals", "A Navi's approvals with the checker on, and four actions that ran without asking.");
  const ref = navi(f);
  f.answer("mcp_servers_get", { project: ref }, { global: [], project: [docs(ref)], userServers: true });
  f.answer("navi_approvals", ref, { approvals: CHECKER, log: LOG });
  return f;
};

export default defineGroup({
  fixtures: (base) => [empty(base("typical")), connected(base("typical")), adding(base("typical")), payments(base("typical")), approvals(base("typical"))],
});
