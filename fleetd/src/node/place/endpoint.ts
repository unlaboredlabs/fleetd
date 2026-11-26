// How an agent in a hosted box reaches Claude, whatever the endpoint is: Anthropic's API, or a gateway on the
// internet or the team's tailnet, by name or IP, http or https.
// - The endpoint is the one claude itself picks (`claudeEndpoint`): ANTHROPIC_BASE_URL from its environment, then each
//   settings file's `env` in claude's own order, the last one setting it winning. The box mirrors those files, so its
//   claude picks the same one.
// - A hosted box calls the endpoint itself, as set: on the internet, or on the team's tailnet through its Tailscale
//   gateway (../sandbox/tailnet_box.ts). Nothing of this machine is relayed into it, so an endpoint only this machine
//   reaches (its loopback, its LAN) isn't reached there, and the check says what to do (`unreached`).
// - Before the agent starts there, the box calls the endpoint once (any HTTP answer will do, no key is sent): `probe`
//   throws, in plain words, when it can't.
import { readFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import type { RunOutcome } from "../cmd/index.ts";
import { configDir } from "../runner/claude.ts";
import type { Launch } from "../runner/host.ts";
import type { Box } from "../sandbox/box.ts";

export const ANTHROPIC_API = "https://api.anthropic.com";
/** How long the box's call to the endpoint may take. */
export const PROBE_SEC = 10;

/** The endpoint, and where it was set: a file's path, "the environment", or the default. */
export type Endpoint = { url: string; source: string };

function settingsUrl(text: string | undefined): string | undefined {
  if (!text) return undefined;
  try {
    const v = (JSON.parse(text) as { env?: Record<string, unknown> }).env?.ANTHROPIC_BASE_URL;
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  } catch {
    return undefined;
  }
}

const read = (file: string) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
};

const settingsFlags = (args: string[]) => args.flatMap((a, i) => (args[i - 1] === "--settings" ? [a] : []));
const inline = (v: string) => v.trimStart().startsWith("{");

/** The Claude endpoint claude picks for launch `l`, lowest first: its environment, the user's settings, the project's,
 * the project's local ones, then each `--settings` (a file or inline JSON). A hosted box's managed settings (its /etc)
 * are its own. */
export function claudeEndpoint(l: Pick<Launch, "env" | "args" | "cwd">): Endpoint {
  let found: Endpoint = { url: ANTHROPIC_API, source: "Anthropic's API, the default" };
  const fromEnv = l.env.ANTHROPIC_BASE_URL?.trim();
  if (fromEnv) found = { url: fromEnv, source: "the environment" };
  const files = [join(configDir(l.env), "settings.json"), join(l.cwd, ".claude", "settings.json"), join(l.cwd, ".claude", "settings.local.json")];
  for (const [text, source] of [
    ...files.map((f) => [read(f), f] as const),
    ...settingsFlags(l.args).map((f) => (inline(f) ? ([f, "--settings"] as const) : ([read(f), f] as const))),
  ]) {
    const url = settingsUrl(text);
    if (url) found = { url, source };
  }
  return found;
}

/** Whether `e` was set by the session's own project (its worktree's .claude), not the machine: a failure to reach it is
 * that project's, not every agent's. */
export const fromProject = (e: Endpoint, cwd: string) => e.source.startsWith(`${join(cwd, ".claude")}/`);

const isLoopback = (host: string) => host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));

/** The parts of `url` a box needs, or why it isn't one. */
function parse(url: string): { u: URL; host: string; port: number; label: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`the Claude endpoint ${JSON.stringify(url)} isn't a URL`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`the Claude endpoint ${url} isn't http or https`);
  const host = u.hostname.replace(/^\[(.*)\]$/u, "$1").toLowerCase();
  const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  return { u, host, port, label: `${isIP(host) === 6 ? `[${host}]` : host}:${port}` };
}

/** Whether `ip` is an internet address: not loopback, private, link-local, CGNAT (a tailnet's 100.64/10) or ULA. */
export function publicIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168));
  }
  const v = ip.toLowerCase();
  if (v === "::1" || v === "::") return false;
  if (v.startsWith("::ffff:")) return publicIp(v.slice(7));
  return !/^(f[cd]|fe[89ab])/u.test(v);
}

/** Whether a hosted box reaches `url` on its own: a name of the internet's (no tailnet or single-label name) that this
 * machine resolves to internet addresses only, or an internet IP. */
export async function publicEndpoint(url: string, resolve: (host: string) => Promise<string[]> = resolveAll): Promise<boolean> {
  const { host } = parse(url);
  if (isIP(host)) return publicIp(host);
  if (!host.includes(".") || host.endsWith(".ts.net") || host.endsWith(".local") || host.endsWith(".internal") || isLoopback(host)) return false;
  try {
    const addrs = await resolve(host);
    return addrs.length > 0 && addrs.every(publicIp);
  } catch {
    return false;
  }
}

/** Whether `url` is plainly not on the internet, by its address or name alone (no lookup): a loopback, a private or
 * tailnet address, or a tailnet, local or single-label name. */
export function privateByName(url: string): boolean {
  let host: string;
  try {
    host = parse(url).host;
  } catch {
    return false;
  }
  if (isIP(host)) return !publicIp(host);
  return isLoopback(host) || !host.includes(".") || host.endsWith(".ts.net") || host.endsWith(".local") || host.endsWith(".internal");
}

const resolveAll = async (host: string) => (await lookup(host, { all: true })).map((a) => a.address);

/** The box's one call to the endpoint: any HTTP answer is a working path, and no key goes with it. */
export const probeArgv = (url: string) => ["curl", "-sS", "-o", "/dev/null", "--max-time", String(PROBE_SEC), url];

const said = (o: RunOutcome) => (o.notRun ?? o.outputTail.trim().split("\n").slice(-2).join(" ")) || `exit ${o.exitCode}`;

/** Checks that `url` answers from inside `box`, as its claude will call it; throws why not, in plain words. */
export async function probe(box: Box, url: string): Promise<void> {
  const { label } = parse(url);
  const probed = await box.run({ argv: probeArgv(url), cwd: "/", timeoutSec: PROBE_SEC + 5 });
  if (probed.exitCode !== 0) throw new Error(`the box can't reach Claude at ${label}: ${said(probed)}`);
}

/** Why a box of provider `at` (its name, "boat.dev") didn't reach the endpoint `e`, in a person's words with what to
 * do: a hosted box reaches the internet, and the team's tailnet once Tailscale is connected (`tailnet`), and nothing
 * of a machine's own. Never the check's own output or where the endpoint was set: the log keeps those. */
export async function unreached(e: Endpoint, at: string, tailnet: boolean, resolve?: (host: string) => Promise<string[]>): Promise<string> {
  let host = e.url;
  try {
    host = parse(e.url).host;
  } catch {}
  const said = `a sandbox at ${at} couldn't reach the workspace's Claude account at ${host}`;
  const hint = await hostedHint(e.url, tailnet, resolve);
  return `${said}: ${hint ?? "it didn't answer from there. Check that it is up, then try again"}`;
}

/** What to do when the hosted side (a box, the hub's runner) doesn't reach `url`; none for an internet endpoint. */
export async function hostedHint(url: string, tailnet: boolean, resolve?: (host: string) => Promise<string[]>): Promise<string | undefined> {
  let host: string;
  try {
    host = parse(url).host;
  } catch {
    return undefined;
  }
  if (isLoopback(host))
    return `that is a machine's own loopback, which a hosted sandbox never reaches. Point the Claude account at the machine's tailnet address or name instead${tailnet ? "" : ", and connect Tailscale in Connections"}`;
  if (await publicEndpoint(url, resolve)) return undefined;
  if (!tailnet) return "it is on a private network, which hosted sandboxes reach only on the team's tailnet. Connect Tailscale in Connections";
  return "the team's tailnet doesn't reach it either. Check that the endpoint runs, and that the tailnet's access rules let the gateway device (fleetd) reach it";
}
