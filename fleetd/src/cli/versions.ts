// Versions as people read them (`version_shown`, `version_cmp`) and the one
// line `fleetd status` and `fleetd doctor` print when the CLI, the hub and the nodes differ (cli/versions.rs).
import { VERSION } from "../shared/version.ts";
import { versionLabel, versionShown } from "../update/version.ts";
import type { McpClient } from "./mcp_client.ts";

/** How a version reads, and its label with the raw version after it when they differ: src/update/version.ts's, one rule
 * for the CLI, the hub and its updates. */
export { edgeStamp, versionLabel, versionShown } from "../update/version.ts";

/** `fleetd version`'s line. */
export function versionLine(version = VERSION, protocol = 1): string {
  const label = versionLabel(version);
  return label === version
    ? `fleetd ${version} (protocol ${protocol})\n`
    : `fleetd ${label} (${version}, protocol ${protocol})\n`;
}

/** How two versions order, and whether `have` is `want` or newer: src/update/version.ts's (0.9.0 is newer than every
 * 0.0.0-edge build before it; undefined for a local build's 0.0.0). */
export { atLeast, versionCmp } from "../update/version.ts";

/** The hub's `hub_info`; the error is one plain reason. */
export async function hubInfo(client: McpClient): Promise<any> {
  let result;
  try {
    result = await client.callTool("hub_info", {}, 30_000);
  } catch (error) {
    const m = (error as Error).message;
    throw new Error(m.includes("not found") ? "the hub's fleetd is too old to say" : m);
  }
  if (result.isError) {
    throw new Error(typeof result.body?.message === "string" ? result.body.message : JSON.stringify(result.body));
  }
  return result.body;
}

/** The versions line for the hub `client` reaches, or undefined when everything known matches. */
export async function line(client: McpClient): Promise<string | undefined> {
  const hub = await hubInfo(client).then(
    (i) => (typeof i?.version === "string" ? (i.version as string) : undefined),
    () => undefined,
  );
  const machines: any[] = await client.callTool("fleetd_status", {}, 30_000).then(
    (r) => (Array.isArray(r.body?.machines) ? r.body.machines : []),
    () => [],
  );
  const nodes = machines.filter((m) => m.status !== "offline").map((m) => [String(m.name), String(m.nodeVersion)] as const);
  return mismatch(VERSION, hub, nodes);
}

export function mismatch(cli: string, hub: string | undefined, nodes: readonly (readonly [string, string])[]) {
  const who: [string, string][] = [[cli, "this CLI"]];
  if (hub !== undefined) who.push([hub, "the hub"]);
  for (const [name, v] of nodes) who.push([v, `node ${name}`]);
  const groups: [string, string[]][] = [];
  for (const [version, name] of who) {
    if (version === "" || version === "0.0.0") continue;
    const g = groups.find(([v]) => v === version);
    if (g) g[1].push(name);
    else groups.push([version, [name]]);
  }
  if (groups.length < 2) return undefined;
  const parts = groups.map(([v, names]) => `${versionShown(v)} on ${names.join(", ")}`);
  return `Versions differ: ${parts.join("; ")}. Run \`fleetd update\` on each machine that's behind.`;
}
