// An Antigravity lead's MCP servers, weighed before agy starts. agy shows its model at most TOOL_BUDGET bytes of MCP
// tools, every server's together, and hides the biggest past it (runner/antigravity_spec.ts): a bot's own server with
// many tools (Paper's are 55 KB) pushed fleetd's brief, spawn_agent and ten more out of a lead on Gemini (W844). So a
// lead's start lists each of the bot's servers' tools and goes without the biggest servers, as few as it takes, so
// that fleetd's own tools all fit; agents keep them. The hub's chat says which, once (../mcp_reach.ts `heavyLine`).
import { toolList } from "../cli/agent_mcp/tools.ts";
import type { Resolved } from "./actions/mcp_probe.ts";
import { FLEETD_SERVER } from "./actions/mcp.ts";
import { leftOut, type ListedTool, toolBytes } from "./runner/antigravity_spec.ts";

/** How long a server has to list its tools before it counts as none: agy would wait on it too. */
export const WEIGH_MS = 10_000;

type Entries = Record<string, unknown>;

/** What fleetd's own lead tools take of the budget. */
export const fleetdLeadBytes = () => toolList("lead").tools.reduce((sum, t) => sum + toolBytes(t), 0);

/** An `mcpServers` entry as the probe takes it; undefined for one it can't reach. */
export function resolvedOf(name: string, entry: unknown): Resolved | undefined {
  const e = entry as { type?: unknown; command?: unknown; args?: unknown; env?: unknown; url?: unknown; headers?: unknown };
  const values = (o: unknown) => Object.entries((o ?? {}) as Record<string, unknown>).map(([k, v]): [string, string] => [k, String(v)]);
  if ((e.type === "http" || e.type === "sse") && typeof e.url === "string") return { name, transport: { type: e.type, url: e.url }, values: values(e.headers), secrets: [] };
  if (typeof e.command === "string") {
    const args = Array.isArray(e.args) ? e.args.map(String) : [];
    return { name, transport: { type: "stdio", command: e.command, args }, values: values(e.env), secrets: [] };
  }
  return undefined;
}

const isTool = (t: unknown): t is ListedTool => typeof (t as { name?: unknown } | null)?.name === "string";

/** The servers of `servers` (fleetd's own aside) a lead on Antigravity goes without, the biggest first; `list` gives
 * a server's tools, and one it can't list counts nothing. */
export async function overBudget(servers: Entries, list: (server: Resolved) => Promise<unknown[]>, fleetdBytes = fleetdLeadBytes()): Promise<string[]> {
  const weighed = await Promise.all(
    Object.entries(servers)
      .filter(([name]) => name.toLowerCase() !== FLEETD_SERVER)
      .map(async ([name, entry]) => {
        const server = resolvedOf(name, entry);
        const tools = server ? await list(server).catch(() => []) : [];
        return { name, bytes: tools.filter(isTool).reduce((sum, t) => sum + toolBytes(t), 0) };
      }),
  );
  return leftOut(fleetdBytes, weighed);
}
