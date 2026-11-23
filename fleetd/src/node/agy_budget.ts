// An Antigravity lead's MCP servers, weighed before agy starts. agy shows its model at most TOOL_BUDGET bytes of MCP
// tools, every server's together, and hides the biggest past it (runner/antigravity_spec.ts): a bot's own server with
// many tools (Paper's are 55 KB) pushed fleetd's brief, spawn_agent and ten more out of a lead on Gemini (W844). So a
// lead's start lists each of the bot's servers' tools and goes without the biggest servers, as few as it takes, so
// that fleetd's own tools all fit; agents keep them. A server that doesn't list its tools in time goes too, as one that
// doesn't answer does, since its size is unknown: the next start weighs it again. The hub's chat says which, once
// (../mcp_reach.ts `heavyLine`, `skippedLine`).
import { toolList } from "../cli/agent_mcp/tools.ts";
import type { Resolved } from "./actions/mcp_probe.ts";
import { FLEETD_SERVER } from "./actions/mcp.ts";
import { leftOut, type ListedTool, toolBytes } from "./runner/antigravity_spec.ts";

/** How long a server has to list its tools before the start goes on without it. */
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

/** The servers of `servers` (fleetd's own aside) a lead on Antigravity goes without: those `list` couldn't list
 * (`unweighed`: it threw, or ran past its time), and of the rest the biggest, as few as it takes (`left`). */
export async function overBudget(
  servers: Entries,
  list: (server: Resolved) => Promise<unknown[]>,
  fleetdBytes = fleetdLeadBytes(),
): Promise<{ left: string[]; unweighed: string[] }> {
  const weighed = await Promise.all(
    Object.entries(servers)
      .filter(([name]) => name.toLowerCase() !== FLEETD_SERVER)
      .map(async ([name, entry]) => {
        const server = resolvedOf(name, entry);
        const tools = server ? await list(server).catch(() => undefined) : undefined;
        return { name, bytes: tools?.filter(isTool).reduce((sum, t) => sum + toolBytes(t), 0) };
      }),
  );
  const sized = weighed.filter((s): s is { name: string; bytes: number } => s.bytes !== undefined);
  return { left: leftOut(fleetdBytes, sized), unweighed: weighed.filter((s) => s.bytes === undefined).map((s) => s.name) };
}
