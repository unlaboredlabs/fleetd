// A Navi's integrations page, as pure functions: which of its MCP servers is Google, Notion or a custom one; the
// requests that connect each (main seals the key or token to Navi's machine, mcp_server_set saves it); what a
// connection test found, by the hub's tool policy; and a failed test in words a person can act on. Google goes through
// the person's own xaq, which holds the Google sign-in; Notion through its official server with their own token.
import type { IntegrationKind, McpScope, McpServer, McpTestResult, McpToolInfo, ProjectSummary } from "../../../shared/contracts";
import type { McpServerRequest } from "../../../shared/ipc";
import { toRequest, type Draft } from "./mcpModel";

/** The project kind of a Navi: only a Navi's settings offer integrations, and the hub refuses them anywhere else. */
export const NAVI_KIND = "assistant";

export const isNavi = (p: ProjectSummary | undefined): boolean => (p as { kind?: unknown } | undefined)?.kind === NAVI_KIND;

export const DOCS = "https://fleetd.sh/docs/integrations/";
export const XAQ_DOCS = "https://www.npmjs.com/package/xaq-cli";

/** xaq's own address on the machine it runs on, by default. */
export const XAQ_DEFAULT = "http://127.0.0.1:8425";

/** The names the connect screen saves them under; a custom server takes the person's. */
export const SERVER_NAME: Readonly<Record<"google" | "notion", string>> = { google: "google", notion: "notion" };

/** Integrations get only the lead's role: Navi's lead is the one whose every write asks first. */
const LEAD_ONLY = { lead: true, writers: false, reviewers: false } as const;

export interface Connections {
  readonly google: McpServer | undefined;
  readonly notion: McpServer | undefined;
  readonly custom: ReadonlyArray<McpServer>;
}

/** A Navi's own MCP servers, by what they are to it. */
export const connectionsOf = (servers: ReadonlyArray<McpServer>): Connections => {
  const of = (kind: IntegrationKind) => servers.filter((s) => s.integration?.kind === kind);
  return { google: of("google")[0], notion: of("notion")[0], custom: of("custom") };
};

/** xaq's address as typed: `http://127.0.0.1:8425`, with or without `/mcp`, gives the base and the MCP endpoint. */
export const xaqAddress = (typed: string): { ok: true; base: string; mcp: string } | { ok: false; problem: string } => {
  const raw = typed.trim();
  if (raw === "") return { ok: false, problem: "Give xaq's address." };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(raw) ? raw : `http://${raw}`);
  } catch {
    return { ok: false, problem: "That isn't an address: try http://127.0.0.1:8425." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, problem: "xaq's address starts with http:// or https://." };
  const path = url.pathname.replace(/\/+$/u, "").replace(/\/mcp$/u, "");
  const base = `${url.origin}${path}`;
  return { ok: true, base, mcp: `${base}/mcp` };
};

/** The redirect URI to paste into Google Cloud for xaq at `base`: xaq's setup shows the same one. */
export const xaqRedirectUri = (base: string): string => `${base.replace("://127.0.0.1", "://localhost")}/oauth/callback`;

type Built = { ok: true; request: McpServerRequest } | { ok: false; problem: string };

const needBoxes = (boxes: McpServerRequest["boxes"]): string | null =>
  boxes.length === 0 ? "Navi's machine takes no secrets yet: its node has no box key. Update fleetd there first." : null;

/** Google through xaq: its MCP endpoint, and the agent key as a sealed `Authorization: Bearer` header. */
export const googleRequest = (address: string, key: string, scope: McpScope, boxes: McpServerRequest["boxes"]): Built => {
  const at = xaqAddress(address);
  if (!at.ok) return at;
  const token = key.trim().replace(/^Bearer\s+/iu, "");
  if (token === "") return { ok: false, problem: "Paste the agent key xaq made for Navi." };
  if (!token.startsWith("aib_")) return { ok: false, problem: "An xaq agent key starts with aib_: copy it from xaq's Agents page." };
  if (/\s/u.test(token)) return { ok: false, problem: "The key has a space or a line break in it: copy it again." };
  const missing = needBoxes(boxes);
  if (missing !== null) return { ok: false, problem: missing };
  return {
    ok: true,
    request: {
      scope,
      name: SERVER_NAME.google,
      enabled: true,
      roles: LEAD_ONLY,
      transport: { type: "http", url: at.mcp },
      env: [],
      headers: [{ kind: "secret", name: "Authorization", value: `Bearer ${token}` }],
      boxes: [...boxes],
      integration: { kind: "google" },
    },
  };
};

/** Notion's official server, started on Navi's machine, with the integration token as a sealed `NOTION_TOKEN`. */
export const notionRequest = (token: string, scope: McpScope, boxes: McpServerRequest["boxes"]): Built => {
  const t = token.trim();
  if (t === "") return { ok: false, problem: "Paste your integration's secret." };
  if (!t.startsWith("ntn_") && !t.startsWith("secret_")) return { ok: false, problem: "A Notion integration secret starts with ntn_ (secret_ on older ones)." };
  if (/\s/u.test(t)) return { ok: false, problem: "The secret has a space or a line break in it: copy it again." };
  const missing = needBoxes(boxes);
  if (missing !== null) return { ok: false, problem: missing };
  return {
    ok: true,
    request: {
      scope,
      name: SERVER_NAME.notion,
      enabled: true,
      roles: LEAD_ONLY,
      transport: { type: "stdio", command: "npx", args: ["-y", "@notionhq/notion-mcp-server"] },
      env: [{ kind: "secret", name: "NOTION_TOKEN", value: t }],
      headers: [],
      boxes: [...boxes],
      integration: { kind: "notion" },
    },
  };
};

/** Any other server, for Navi's lead only, with the tools the person marked as only reading. */
export const customRequest = (draft: Draft, readTools: ReadonlyArray<string>, scope: McpScope, boxes: McpServerRequest["boxes"]): Built => {
  if ([SERVER_NAME.google, SERVER_NAME.notion].includes(draft.name.trim())) return { ok: false, problem: `${draft.name.trim()} is the name of Navi's own connection: pick another.` };
  const built = toRequest({ ...draft, roles: LEAD_ONLY, enabled: true }, scope, boxes);
  if (!built.ok) return built;
  return { ok: true, request: { ...built.request, integration: { kind: "custom", ...(readTools.length === 0 ? {} : { readTools: [...readTools] }) } } };
};

export interface ByPolicy {
  readonly read: ReadonlyArray<string>;
  readonly ask: ReadonlyArray<string>;
  readonly blocked: ReadonlyArray<string>;
}

/** A test's tools by what the hub does with them; one the hub didn't mark asks. */
export const byPolicy = (tools: ReadonlyArray<McpToolInfo>): ByPolicy => ({
  read: tools.filter((t) => t.policy === "read").map((t) => t.name),
  ask: tools.filter((t) => t.policy === "ask" || t.policy === undefined).map((t) => t.name),
  blocked: tools.filter((t) => t.policy === "blocked").map((t) => t.name),
});

const count = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

/** "26 read freely · 12 ask you each time", and the blocked ones when there are any. */
export const policyLine = (p: ByPolicy): string =>
  [
    `${count(p.read.length, "tool reads", "tools read")} freely`,
    `${count(p.ask.length, "asks", "ask")} you each time`,
    ...(p.blocked.length > 0 ? [`${count(p.blocked.length, "is", "are")} never allowed`] : []),
  ].join(" · ");

/** A custom server's tools offered as only reading: those its server marks so, never a blocked one. */
export const suggestedReads = (tools: ReadonlyArray<McpToolInfo>): string[] => tools.filter((t) => t.readOnly === true && t.policy !== "blocked").map((t) => t.name);

/** A failed test, said for the integration: xaq not running, a refused key or token, no Node on the machine. */
export const testProblem = (kind: IntegrationKind, error: string, machine: string, url?: string): string => {
  const unreachable = /refused|ECONNREFUSED|couldn't connect|could not connect|unreachable|no answer|timed out|ENOTFOUND|EHOSTUNREACH/iu.test(error);
  const denied = /\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid[_ ]token|invalid key/iu.test(error);
  if (kind === "google") {
    if (unreachable) return `xaq isn't answering at ${url ?? "that address"} from ${machine}. Start it there with npx xaq-cli (or check its service), then test again. Not set up yet? Follow the steps above.`;
    if (denied) return "xaq refused the key. In xaq, open Agents, pick Navi's agent and make a new key, then connect again with it.";
  }
  if (kind === "notion") {
    if (/npx|ENOENT|not found|command not found/iu.test(error) && !denied) return `Notion's server didn't start on ${machine}: it runs with npx, which comes with Node.js. Install Node.js there, then test again.`;
    if (denied) return "Notion refused the token. In Notion, open Settings › Connections › Develop or manage integrations, copy the integration's secret again, and connect with it.";
  }
  return `Failed on ${machine}: ${error}`;
};

/** A test that reached the server but whose tools the hub's table doesn't know: an xaq that lists none means no grant. */
export const emptyNote = (kind: IntegrationKind, result: McpTestResult): string | null =>
  (result.tools ?? []).length > 0
    ? null
    : kind === "google"
      ? "xaq answered but lists no tools for this key: in xaq, give Navi's agent a grant on your Gmail account (and Google Workspace for Drive)."
      : kind === "notion"
        ? "Notion's server answered but lists no tools."
        : "The server answered but lists no tools.";
