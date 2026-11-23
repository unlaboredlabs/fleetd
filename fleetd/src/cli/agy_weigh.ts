// `fleetd agy-weigh`: an Antigravity lead's MCP servers weighed as the node weighs them at its start
// (src/node/agy_budget.ts), where no node is: fleetd cloud runs it in the lead's box, where the bot's servers are
// reached. stdin holds the session's mcp.json (`{"mcpServers": {...}}`, values included); stdout gets one JSON line,
// `{"left":[names]}`: the servers the lead goes without so fleetd's own tools fit agy's budget, the biggest first. A
// stdio server starts in this command's directory with its environment plus the server's env. Exit 0 when it weighed,
// 2 on bad input. It takes nothing on argv, and no value of a server's reaches stderr.
import { VERSION } from "../shared/version.ts";
import { WEIGH_MS, overBudget } from "../node/agy_budget.ts";
import { listTools } from "../node/actions/mcp_probe.ts";
import { spawnGroup } from "../node/actions/mcp_spawn.ts";

const USAGE = "usage: fleetd agy-weigh < mcp.json";

export async function run(argv: string[]): Promise<number> {
  if (argv.length > 0) return refuse(`takes no arguments: the mcp.json comes on stdin\n${USAGE}`);
  let servers: Record<string, unknown>;
  try {
    servers = parse(await Bun.stdin.text());
  } catch (error) {
    return refuse((error as Error).message);
  }
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  const io = { fetch, spawn: spawnGroup, cwd: process.cwd(), env, version: VERSION };
  const left = await overBudget(servers, (server) => listTools(server, io, WEIGH_MS));
  await Bun.write(Bun.stdout, `${JSON.stringify({ left })}\n`);
  return 0;
}

function refuse(why: string): number {
  process.stderr.write(`fleetd agy-weigh: ${why}\n`);
  return 2;
}

/** The mcp.json on stdin's servers. What it refuses names the field, never what it holds. */
export function parse(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`stdin isn't JSON: ${USAGE}`);
  }
  const servers = (value as { mcpServers?: unknown } | null)?.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error("mcpServers isn't an object");
  return servers as Record<string, unknown>;
}
