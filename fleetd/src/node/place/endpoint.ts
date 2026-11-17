// How an agent in a box reaches Claude, whatever the endpoint is: Anthropic's API, a gateway on this machine's
// loopback, on its LAN or tailnet address, or on another tailnet host, by name or IP, http or https.
// - The endpoint is the one claude itself picks (`claudeEndpoint`): ANTHROPIC_BASE_URL from its environment, then each
//   settings file's `env` in claude's own order, the last one setting it winning. The box shares or mirrors those
//   files, so its claude picks the same one.
// - A relay (../sandbox/box.ts Relay) carries it through the node, over the box's link: a VM's network can't reach
//   this machine (net.ts), a hosted box's can't reach a tailnet, and a box's DNS needn't know tailnet names. The URL
//   keeps its name, so TLS still checks the endpoint's own certificate: a name is pinned to the box's loopback in its
//   /etc/hosts, an IP is added to its loopback, and the guest listens there on the endpoint's port. A local VM's guest
//   is root and takes any port, so its claude calls the URL exactly as set (claude counts only api.anthropic.com with
//   no port as Anthropic's own API). A hosted box's user may not take a port under 1024: there the relay listens on
//   RELAY_BASE plus it, and the box's claude is pointed at that port (`boxArgs`). The node dials the endpoint as this
//   machine reaches it.
// - A hosted box reaches a public endpoint (Anthropic's API) itself, as it reaches the internet: no relay (`direct`).
// - Before the agent starts there, the box calls the endpoint once (any HTTP answer will do, no key is sent):
//   `reach` throws, in plain words, when it can't.
import { readFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { connect, isIP } from "node:net";
import { join } from "node:path";
import type { RunOutcome } from "../cmd/index.ts";
import { configDir } from "../runner/claude.ts";
import type { Launch } from "../runner/host.ts";
import type { Box, Relay } from "../sandbox/box.ts";

export const ANTHROPIC_API = "https://api.anthropic.com";
/** How long the box's call to the endpoint may take. */
export const PROBE_SEC = 10;
/** Where in the box a relay for a port under 1024 listens: this plus the port (443 at 40443). */
export const RELAY_BASE = 40_000;

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
 * the project's local ones, then each `--settings` (a file or inline JSON). The machine's managed settings aren't a
 * box's: its /etc is its own. */
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

/** How a box reaches the endpoint: the relay (none when the box reaches it itself), what is pointed at the box's
 * loopback first, the URL as set, the one the box's claude calls (`boxUrl`, another port only), and its name. */
export type Reach = { relay?: Relay; pin?: { name: string } | { ip: string }; url: string; boxUrl: string; label: string };

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

/** How a box reaches `url`: through a relay, or (`direct`) on its own network. `lowPorts`: the box's guest may take a
 * port under 1024 (a local VM's root), so the relay keeps the endpoint's port and the URL stays as set. */
export function reachOf(url: string, o: { direct?: boolean; lowPorts?: boolean } = {}): Reach {
  const { u, host, port, label } = parse(url);
  if (o.direct) return { url, boxUrl: url, label };
  const inBox = port < 1024 && !o.lowPorts ? RELAY_BASE + port : port;
  const boxed = new URL(u.href);
  boxed.port = String(inBox);
  // The URL as written when the port stays, so a trailing slash or path reads as the person wrote it.
  const boxUrl = inBox === port ? url : boxed.href.replace(/\/$/u, url.endsWith("/") ? "/" : "");
  const to = { host, port };
  // On this machine's loopback: the same address in the box's (the guest's own loopback for 127.0.0.1 and localhost).
  if (isLoopback(host)) return { relay: { port: inBox, ...(host === "::1" || (host !== "localhost" && host !== "127.0.0.1") ? { addr: host } : {}), to }, url, boxUrl, label };
  if (isIP(host)) return { relay: { port: inBox, addr: host, to }, pin: { ip: host }, url, boxUrl, label };
  return { relay: { port: inBox, to }, pin: { name: host }, url, boxUrl, label };
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

const resolveAll = async (host: string) => (await lookup(host, { all: true })).map((a) => a.address);

/** The loopback address a gateway on `localhost` answers on here, v4 first: one listening only on ::1 or only on
 * 127.0.0.1 is dialled where it is. 127.0.0.1 when neither answers (the box's check then says so). */
export async function loopbackFor(port: number, ms = 1_000): Promise<string> {
  for (const host of ["127.0.0.1", "::1"]) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = connect({ host, port });
      const done = (v: boolean) => (s.destroy(), clearTimeout(t), resolve(v));
      const t = setTimeout(() => done(false), ms);
      s.once("connect", () => done(true)).once("error", () => done(false));
    });
    if (ok) return host;
  }
  return "127.0.0.1";
}

/** claude's argv with the box's endpoint (`boxUrl`) in its `--settings`, which claude ranks above the user's and the
 * project's settings: the file's or inline JSON, merged, inline. Unchanged when the box calls the URL as set. */
export function boxArgs(args: string[], r: Pick<Reach, "url" | "boxUrl">): string[] {
  if (r.boxUrl === r.url) return args;
  const at = args.findIndex((a, i) => args[i - 1] === "--settings");
  let base: { env?: Record<string, unknown> } = {};
  if (at >= 0) {
    try {
      base = JSON.parse(inline(args[at]!) ? args[at]! : (read(args[at]!) ?? "{}"));
    } catch {}
  }
  const merged = JSON.stringify({ ...base, env: { ...(base.env ?? {}), ANTHROPIC_BASE_URL: r.boxUrl } });
  return at >= 0 ? args.map((a, i) => (i === at ? merged : a)) : [...args, "--settings", merged];
}

const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/** The shell that points the box at its relay: as root, or through sudo where the box's user isn't. It refuses to run
 * anywhere but in a fleetd box (its root image's /etc/fleetd/guest.env), so a stand-in box beside its node changes
 * nothing of the machine. /etc/hosts is written in place: a provider may mount it. */
export function pinScript(pin: NonNullable<Reach["pin"]>): string {
  const root = 'as_root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo -n "$@"; fi; }';
  const guard = '[ -e /etc/fleetd/guest.env ] || { echo "not in a fleetd box"; exit 1; }';
  if ("ip" in pin) {
    const add = isIP(pin.ip) === 6 ? `ip -6 addr replace ${q(`${pin.ip}/128`)} dev lo nodad` : `ip addr replace ${q(`${pin.ip}/32`)} dev lo`;
    return [guard, root, `as_root ${add}`].join("\n");
  }
  const line = `127.0.0.1 ${pin.name}`;
  const edit = `grep -qxF ${q(line)} /etc/hosts || { { printf '%s\\n' ${q(line)}; cat /etc/hosts; } > /etc/hosts.fleetd && cat /etc/hosts.fleetd > /etc/hosts && rm -f /etc/hosts.fleetd; }`;
  return [guard, root, `as_root sh -c ${q(edit)}`].join("\n");
}

/** The box's one call to the endpoint: any HTTP answer is a working path, and no key goes with it. */
export const probeArgv = (url: string) => ["curl", "-sS", "-o", "/dev/null", "--max-time", String(PROBE_SEC), url];

const said = (o: RunOutcome) => (o.notRun ?? o.outputTail.trim().split("\n").slice(-2).join(" ")) || `exit ${o.exitCode}`;

/** Points `box` at `r` and checks the endpoint answers from inside it, at the URL its claude calls; throws why not, in
 * plain words. */
export async function reach(box: Box, r: Reach): Promise<void> {
  if (r.pin) {
    const pinned = await box.run({ argv: ["/bin/sh", "-c", pinScript(r.pin)], cwd: "/", timeoutSec: 15 });
    if (pinned.exitCode !== 0) throw new Error(`the box couldn't point ${r.label} at the node: ${said(pinned)}`);
  }
  if (r.relay) {
    const relay = r.relay.to.host === "localhost" ? { ...r.relay, to: { ...r.relay.to, host: await loopbackFor(r.relay.to.port) } } : r.relay;
    try {
      await box.relay(relay);
    } catch (error) {
      throw new Error(`the box couldn't listen for ${r.label}: ${(error as Error).message}`);
    }
  }
  const probed = await box.run({ argv: probeArgv(r.boxUrl), cwd: "/", timeoutSec: PROBE_SEC + 5 });
  if (probed.exitCode !== 0) throw new Error(`the box can't reach Claude at ${r.label}: ${said(probed)}`);
}
