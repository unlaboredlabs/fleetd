// Connections (D653), on the typical hub as Sam (its owner). connections-empty: nothing connected, Tailscale off.
// connections-some: Paper and Tailscale connected, Notion not yet; four custom MCPs: linear (OAuth, storefront
// only), github (a command, its token from the vault), docs on the tailnet (a header from the vault) and sentry, off.
// connections-failing: the same, github's Test failing. connections-oauth: Notion's Connect waiting on its sign-in,
// and linear signed out. connections-tailnet: a custom MCP on the tailnet added and tested through Tailscale;
// connections-tailnet-off the same URL while Tailscale isn't connected. connections-member: the same as some, as Bob.
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import type { JsonObject } from "../kit/json.ts";
import { AGENT } from "../agents/route.ts";
import { answerHub, bob, sam } from "../admin/index.ts";

const TEAM = { kind: "global" };
const AT = "2026-11-22T09:00:00.000Z";
const STOREFRONT = { machineId: AGENT.machineId, projectId: AGENT.projectId };
const EVERY = { lead: true, writers: true, reviewers: true };
// What a fixture may hold of a tailnet (fixtures/kit/leaks.ts refuses its names and addresses): a MagicDNS short
// name. The QA steps type a full tailnet URL into the form, and a Test through Tailscale marks the row.
const TAILNET_URL = "http://docs:8080/mcp";

const server = (name: string, transport: JsonObject, more: JsonObject = {}): JsonObject => ({
  scope: TEAM,
  name,
  enabled: true,
  roles: EVERY,
  transport,
  headers: [],
  updatedAt: AT,
  ...more,
});
const signedIn = (issuer: string): JsonObject => ({ status: "connected", issuer, signedInAt: AT });

const paper = server("paper", { type: "http", url: "https://mcp.paper.design" }, { oauth: signedIn("https://app.paper.design") });
const linear = server("linear", { type: "http", url: "https://mcp.linear.app/mcp" }, { oauth: signedIn("https://mcp.linear.app"), projects: [STOREFRONT] });
const github = server(
  "github",
  { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
  { env: [{ kind: "vault", name: "GITHUB_PERSONAL_ACCESS_TOKEN", itemId: id(1), label: "GitHub (bot)", sealedOn: [] }] },
);
const docs = server("docs", { type: "http", url: TAILNET_URL }, { headers: [{ kind: "vault", name: "Authorization", itemId: id(10), prefix: "Bearer ", label: "DOCS_TOKEN", sealedOn: [] }] });

function id(n: number): string {
  return `V${n.toString(16).padStart(32, "0")}`;
}

const TAILNET_ON = { status: "connected", tailnet: "acme.com", device: "fleetd-devbox" };
const TAILNET_OFF = { status: "off" };

/** The team vault's logins and variables, which a header or env picks from. */
const items = (f: Fixture): JsonObject[] => {
  const item = (n: number, over: JsonObject): JsonObject => ({ itemId: id(n), canEdit: true, canReveal: true, createdMs: Date.parse(f.now) - 9 * 86_400_000, updatedMs: Date.parse(f.now) - 86_400_000, updatedBy: "human:laptop", version: 1, ...over });
  return [
    item(1, { kind: "login", scope: "hub", label: "GitHub (bot)", meta: { source: { kind: "typed" }, sites: ["github.com"], fields: ["username", "password"] } }),
    item(2, { kind: "login", scope: "hub", label: "Linear", meta: { source: { kind: "typed" }, sites: ["linear.app"], fields: ["username", "password"] } }),
    item(10, { kind: "env", scope: "hub", label: "DOCS_TOKEN", envName: "DOCS_TOKEN", meta: { source: { kind: "typed" }, secret: true, bytes: 40 } }),
  ];
};

const connections = (base: Fixture, name: string, note: string, opts: { team: JsonObject[]; tailnet: JsonObject; me?: JsonObject }): Fixture => {
  const f = Fixture.from(base, name, note);
  const admin = (opts.me ?? sam) === sam;
  answerHub(f, opts.me ?? sam, admin);
  f.answer("mcp_servers_get", undefined, { global: opts.team, project: [], userServers: true });
  f.answer("tailnet_get", undefined, opts.tailnet);
  f.answer("vault_list", {}, { items: items(f) });
  f.answer("mcp_server_test", { scope: TEAM, name: "paper" }, { machineId: "devbox", result: { server: "Paper MCP 0.4.0", tools: [{ name: "get_basic_info" }, { name: "write_html" }, { name: "get_screenshot" }] } });
  f.answer("mcp_server_test", { scope: TEAM, name: "github" }, { machineId: "devbox", result: { server: "github-mcp 0.6.2", tools: Array.from({ length: 26 }, (_, i) => ({ name: `tool_${String(i)}` })) } });
  f.answer("mcp_server_test", { scope: TEAM, name: "docs" }, { machineId: "devbox", result: { server: "docs 1.0.0", via: "tailnet", tools: [{ name: "search" }, { name: "read_page" }] } });
  return f;
};

// A custom MCP turned off: its switch says so, and nothing else on its row.
const sentry = server("sentry", { type: "http", url: "https://mcp.sentry.dev/mcp" }, { enabled: false, oauth: signedIn("https://sentry.io") });
const SOME = [paper, linear, github, docs, sentry];

export default defineGroup({
  fixtures: (base) => {
    const typical = base("typical");
    const failing = connections(typical, "connections-failing", "Connections with github's Test failing: why, in one line on its row.", { team: SOME, tailnet: TAILNET_ON });
    failing.answer("mcp_server_test", { scope: TEAM, name: "github" }, {
      machineId: "devbox",
      result: { error: "npx exited with code 1: GITHUB_PERSONAL_ACCESS_TOKEN was refused (401 Bad credentials)" },
    });

    const oauth = connections(typical, "connections-oauth", "Connections with Notion's Connect waiting on its sign-in in the browser, and linear signed out.", {
      team: [paper, { ...linear, oauth: { status: "signed_out", issuer: "https://mcp.linear.app", problem: "mcp.linear.app ended the sign-in. Sign in again." } }],
      tailnet: TAILNET_ON,
    });
    const notion = server("notion", { type: "http", url: "https://mcp.notion.com/mcp" }, { oauth: { status: "signed_out", issuer: "https://mcp.notion.com" } });
    oauth.answer("mcp_server_set", { scope: TEAM, name: "notion" }, { server: notion });
    oauth.answer("mcp_oauth_start", { scope: TEAM, name: "notion" }, {
      authorizeUrl: "https://mcp.notion.com/authorize?client_id=fleetd-devbox&state=qa",
      redirectUri: "https://devbox.example.com/oauth/callback",
      scope: TEAM,
    });

    const added = (f: Fixture): Fixture => {
      const saved = server("docs", { type: "http", url: TAILNET_URL });
      f.answer("mcp_server_set", { scope: TEAM, name: "docs" }, { server: saved });
      return f;
    };
    const some = connections(typical, "connections-some", "Connections with Paper and Tailscale connected and three custom MCPs, one on the tailnet.", { team: SOME, tailnet: TAILNET_ON });
    // ...and one more on the tailnet to add from the form: saved, then tested through Tailscale.
    some.answer("mcp_server_set", { scope: TEAM, name: "wiki" }, { server: server("wiki", { type: "http", url: "http://wiki:8080/mcp" }) });
    some.answer("mcp_server_test", { scope: TEAM, name: "wiki" }, { machineId: "devbox", result: { server: "wiki 2.1.0", via: "tailnet", tools: [{ name: "search" }, { name: "page" }, { name: "recent" }] } });
    return [
      connections(typical, "connections-empty", "Connections with nothing connected: Paper, Notion and Tailscale to connect, and Add a custom MCP.", { team: [], tailnet: TAILNET_OFF }),
      some,
      failing,
      oauth,
      added(connections(typical, "connections-tailnet", "A custom MCP on the tailnet, added and tested through the Tailscale connection.", { team: [paper], tailnet: TAILNET_ON })),
      added(connections(typical, "connections-tailnet-off", "A custom MCP on the tailnet while Tailscale isn't connected: the form says so, with Connect Tailscale.", { team: [paper], tailnet: TAILNET_OFF })),
      connections(typical, "connections-member", "Connections as Bob, a member: the same list, Tailscale an admin's to connect.", { team: SOME, tailnet: TAILNET_OFF, me: bob }),
    ];
  },
});
