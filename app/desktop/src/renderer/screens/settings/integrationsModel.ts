// A Navi's integrations page, as pure functions: which of its MCP servers are its integrations; the request that
// connects one (main seals the key to Navi's machine, mcp_server_set saves it); what a connection test found, by the
// hub's tool policy; and a failed test in words a person can act on.
import type { McpScope, McpServer, McpTestResult, McpToolInfo, ProjectSummary } from "../../../shared/contracts";
import type { McpServerRequest } from "../../../shared/ipc";
import { toRequest, type Draft } from "./mcpModel";

/** The project kind of a Navi: only a Navi's settings offer integrations, and the hub refuses them anywhere else. */
export const NAVI_KIND = "assistant";

export const isNavi = (p: ProjectSummary | undefined): boolean => p?.kind === NAVI_KIND;

export const DOCS = "https://fleetd.sh/docs/integrations/";

/** Integrations get only the lead's role: Navi's lead is the one whose every write asks first. */
const LEAD_ONLY = { lead: true, writers: false, reviewers: false } as const;

/** A Navi's own MCP servers connected as its integrations. */
export const connectionsOf = (servers: ReadonlyArray<McpServer>): ReadonlyArray<McpServer> => servers.filter((s) => s.integration !== undefined);

type Built = { ok: true; request: McpServerRequest } | { ok: false; problem: string };

/** A server for Navi's lead only, with the tools the person marked as only reading. */
export const customRequest = (draft: Draft, readTools: ReadonlyArray<string>, scope: McpScope, boxes: McpServerRequest["boxes"]): Built => {
  const built = toRequest({ ...draft, roles: LEAD_ONLY, enabled: true }, scope, boxes);
  if (!built.ok) return built;
  return { ok: true, request: { ...built.request, integration: readTools.length === 0 ? {} : { readTools: [...readTools] } } };
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

/** A failed test, said with where it ran. */
export const testProblem = (error: string, machine: string): string => `Failed on ${machine}: ${error}`;

/** A test that reached the server but lists no tools. */
export const emptyNote = (result: McpTestResult): string | null => ((result.tools ?? []).length > 0 ? null : "The server answered but lists no tools.");
