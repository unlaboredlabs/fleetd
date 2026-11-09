// Versions as people read them (crates/fleetd/src/lib.rs `version_label`, `version_shown`, `version_cmp`) and the one
// line `fleetd status` and `fleetd doctor` print when the CLI, the hub and the nodes differ (cli/versions.rs).
import { VERSION } from "../shared/version.ts";
import type { McpClient } from "./mcp_client.ts";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const numeric = (s: string) => /^[0-9]+$/.test(s);

/** `<base>-edge.<rest>` (or `-nightly.`, Edge's old name) split around its channel. */
export function edgeStamp(version: string): [string, string] | undefined {
  for (const sep of ["-edge.", "-nightly."]) {
    const at = version.indexOf(sep);
    if (at >= 0) return [version.slice(0, at), version.slice(at + sep.length)];
  }
  return undefined;
}

/** An Edge build by when and from which commit it was built: "Edge · Oct 26, 10:56 UTC · 1b563d7". */
export function versionLabel(raw: string): string {
  let version = raw.trim();
  if (version.startsWith("v")) version = version.slice(1);
  const plus = version.indexOf("+");
  const [bare, build] = plus < 0 ? [version, ""] : [version.slice(0, plus), version.slice(plus + 1)];
  const edge = edgeStamp(bare);
  const parts = edge?.[0].split(".") ?? [];
  const stamp = edge && parts.length === 3 && parts.every(numeric) && edge[1].length === 12 && numeric(edge[1]) ? edge[1] : undefined;
  if (stamp === undefined) return bare;
  const month = MONTHS[Number(stamp.slice(4, 6)) - 1];
  if (month === undefined) return bare;
  const day = stamp.slice(6, 8).replace(/^0+/, "");
  let label = `Edge · ${month} ${day}, ${stamp.slice(8, 10)}:${stamp.slice(10, 12)} UTC`;
  if (build.length >= 7 && /^[0-9a-fA-F]+$/.test(build)) label += ` · ${build.slice(0, 7).toLowerCase()}`;
  return label;
}

/** Its label, and the raw version after it when they differ. */
export function versionShown(version: string): string {
  const label = versionLabel(version);
  return label === version.trim() ? label : `${label} (${version.trim()})`;
}

/** `fleetd version`'s line. */
export function versionLine(version = VERSION, protocol = 1): string {
  const label = versionLabel(version);
  return label === version
    ? `fleetd ${version} (protocol ${protocol})\n`
    : `fleetd ${label} (${version}, protocol ${protocol})\n`;
}

/** Semver order, Edge and nightly one series; undefined across channels or for a local build's 0.0.0. */
export function versionCmp(a: string, b: string): number | undefined {
  const parse = (raw: string): [number[], string | undefined] | undefined => {
    let v = raw.trim();
    if (v.startsWith("v")) v = v.slice(1);
    const bare = v.split("+")[0]!;
    const dash = bare.indexOf("-");
    let core = bare;
    let pre: string | undefined;
    if (dash >= 0) {
      core = bare.slice(0, dash);
      pre = bare.slice(dash + 1);
      if (pre === "") return undefined;
      if (pre.startsWith("edge")) pre = `nightly${pre.slice(4)}`;
    }
    const nums = core.split(".");
    if (nums.length !== 3 || !nums.every(numeric)) return undefined;
    return [nums.map(Number), pre];
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return undefined;
  const local = ([n, p]: [number[], string | undefined]) => n.every((d) => d === 0) && p === undefined;
  const nightly = (p: string | undefined) => p?.startsWith("nightly") ?? false;
  if (local(x) || local(y) || nightly(x[1]) !== nightly(y[1])) return undefined;
  for (let i = 0; i < 3; i++) if (x[0][i] !== y[0][i]) return Math.sign(x[0][i]! - y[0][i]!);
  const [p, q] = [x[1], y[1]];
  if (p === undefined || q === undefined) return p === q ? 0 : p === undefined ? 1 : -1;
  const ps = p.split(".");
  const qs = q.split(".");
  for (let i = 0; ; i++) {
    const [pp, qq] = [ps[i], qs[i]];
    if (pp === undefined && qq === undefined) return 0;
    if (pp === undefined) return -1;
    if (qq === undefined) return 1;
    const [pn, qn] = [numeric(pp), numeric(qq)];
    const d = pn && qn ? Math.sign(Number(pp) - Number(qq)) : pn ? -1 : qn ? 1 : pp < qq ? -1 : pp > qq ? 1 : 0;
    if (d !== 0) return d;
  }
}

/** `have` is `want`, or as new or newer on the same channel. */
export const atLeast = (have: string, want: string) => have === want || (versionCmp(have, want) ?? -1) >= 0;

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
