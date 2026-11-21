// `fleetd mcp-probe`: one MCP server's Test as the node runs it (`mcp_test`, src/node/actions/mcp_probe.ts), where no
// node is: fleetd cloud runs it in an agent's box. stdin holds the resolved server as JSON, its values included
// (`Resolved`: name, transport, values, secrets); stdout gets the result, the node's McpTestResult with its secrets
// masked, as one JSON line and nothing else. A stdio server starts in this command's directory with its environment
// plus the server's env, as an agent's claude would start it. Exit 0 when the probe ran (a failing server is the
// result's `error`), 2 on bad input. It takes nothing on argv, and no value of the server's reaches stderr.
import type { McpTransport } from "../shared/contracts.ts";
import { VERSION } from "../shared/version.ts";
import { probe, type Resolved } from "../node/actions/mcp_probe.ts";
import { spawnGroup } from "../node/actions/mcp_spawn.ts";

const USAGE = "usage: fleetd mcp-probe < server.json";

export async function run(argv: string[]): Promise<number> {
  if (argv.length > 0) return refuse(`takes no arguments: the server comes on stdin\n${USAGE}`);
  let server: Resolved;
  try {
    server = parse(await Bun.stdin.text());
  } catch (error) {
    return refuse((error as Error).message);
  }
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  const result = await probe(server, { fetch, spawn: spawnGroup, cwd: process.cwd(), env, version: VERSION });
  await Bun.write(Bun.stdout, `${JSON.stringify(result)}\n`);
  return 0;
}

function refuse(why: string): number {
  process.stderr.write(`fleetd mcp-probe: ${why}\n`);
  return 2;
}

/** The server on stdin, checked field by field. What it refuses names the field, never what it holds. */
export function parse(text: string): Resolved {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`stdin isn't JSON: ${USAGE}`);
  }
  if (!isObject(value)) throw new Error("stdin isn't a JSON object");
  if (typeof value.name !== "string" || !value.name) throw new Error("name isn't a string");
  return { name: value.name, transport: transport(value.transport), values: pairs(value.values, "values"), secrets: pairs(value.secrets, "secrets") };
}

function transport(t: unknown): McpTransport {
  if (!isObject(t)) throw new Error("transport isn't an object");
  if (t.type === "stdio") {
    if (typeof t.command !== "string" || !t.command) throw new Error("transport.command isn't a string");
    if (t.args !== undefined && !(Array.isArray(t.args) && t.args.every((a) => typeof a === "string"))) throw new Error("transport.args isn't a list of strings");
    return { type: "stdio", command: t.command, ...(t.args ? { args: t.args as string[] } : {}) };
  }
  if (t.type === "http" || t.type === "sse") {
    if (typeof t.url !== "string" || !URL.canParse(t.url)) throw new Error("transport.url isn't a URL");
    return { type: t.type, url: t.url };
  }
  throw new Error("transport.type isn't stdio, http or sse");
}

function pairs(list: unknown, field: string): [string, string][] {
  if (list === undefined) return [];
  if (!Array.isArray(list) || !list.every((p) => Array.isArray(p) && p.length === 2 && typeof p[0] === "string" && typeof p[1] === "string"))
    throw new Error(`${field} isn't a list of [name, value] pairs`);
  return list as [string, string][];
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
