// How an agent in a box reaches Claude: through the node, over the box's link (../sandbox/box.ts Relay), whatever the
// endpoint is: Anthropic's API, a gateway on this machine's loopback, on its LAN or tailnet address, or on another
// tailnet host, by name or IP, http or https. A box's own network never carries it: a VM's can't reach this machine
// (net.ts), a hosted box's can't reach a tailnet, and a box's DNS needn't know tailnet names.
// - The endpoint is the one claude itself picks (`claudeEndpoint`): ANTHROPIC_BASE_URL from its environment, then each
//   settings file's `env` in claude's own order, the last one setting it winning. The box shares or mirrors those
//   files, so its claude picks the same one, unchanged.
// - In the box the URL keeps its name and port, so TLS still checks the endpoint's own certificate: a name is pinned to
//   the box's loopback in its /etc/hosts, an IP is added to its loopback, and the guest listens there on the
//   endpoint's port; the node pipes each connection to the endpoint as this machine reaches it.
// - Before the agent starts there, the box calls the endpoint once (any HTTP answer will do, no key is sent):
//   `reach` throws, in plain words, when it can't.
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import type { RunOutcome } from "../cmd/index.ts";
import { configDir } from "../runner/claude.ts";
import type { Launch } from "../runner/host.ts";
import type { Box, Relay } from "../sandbox/box.ts";

export const ANTHROPIC_API = "https://api.anthropic.com";
/** claude's managed settings on Linux, above every other. */
export const MANAGED_SETTINGS = "/etc/claude-code/managed-settings.json";
/** How long the box's call to the endpoint may take. */
export const PROBE_SEC = 10;

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

/** The Claude endpoint claude picks for launch `l`, lowest first: its environment, the user's settings, the project's,
 * the project's local ones, each `--settings` (a file or inline JSON), then the machine's managed settings. */
export function claudeEndpoint(l: Pick<Launch, "env" | "args" | "cwd">, managed = MANAGED_SETTINGS): Endpoint {
  let found: Endpoint = { url: ANTHROPIC_API, source: "Anthropic's API, the default" };
  const fromEnv = l.env.ANTHROPIC_BASE_URL?.trim();
  if (fromEnv) found = { url: fromEnv, source: "the environment" };
  const files = [join(configDir(l.env), "settings.json"), join(l.cwd, ".claude", "settings.json"), join(l.cwd, ".claude", "settings.local.json")];
  const flags = l.args.flatMap((a, i) => (l.args[i - 1] === "--settings" ? [a] : []));
  for (const [text, source] of [
    ...files.map((f) => [read(f), f] as const),
    ...flags.map((f) => (f.trimStart().startsWith("{") ? ([f, "--settings"] as const) : ([read(f), f] as const))),
    [read(managed), managed] as const,
  ]) {
    const url = settingsUrl(text);
    if (url) found = { url, source };
  }
  return found;
}

/** What makes the endpoint reachable in a box: the relay, what the box's resolver or loopback is pointed at first, and
 * the URL the box calls to check it. */
export type Reach = { relay: Relay; pin?: { name: string } | { ip: string }; url: string; label: string };

const isLoopback = (host: string) => host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));

/** How a box reaches `url`, or why it can't be. */
export function reachOf(url: string): Reach {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`the Claude endpoint ${JSON.stringify(url)} isn't a URL`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`the Claude endpoint ${url} isn't http or https`);
  const host = u.hostname.replace(/^\[(.*)\]$/u, "$1").toLowerCase();
  const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  const label = `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
  const to = { host, port };
  // On this machine's loopback: the same address in the box's (the guest's own loopback for 127.0.0.1 and localhost).
  if (isLoopback(host)) return { relay: { port, ...(host === "::1" || (host !== "localhost" && host !== "127.0.0.1") ? { addr: host } : {}), to }, url, label };
  if (isIP(host)) return { relay: { port, addr: host, to }, pin: { ip: host }, url, label };
  return { relay: { port, to }, pin: { name: host }, url, label };
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

/** Points `box` at `r` and checks the endpoint answers from inside it; throws why not, in plain words. */
export async function reach(box: Box, r: Reach): Promise<void> {
  if (r.pin) {
    const pinned = await box.run({ argv: ["/bin/sh", "-c", pinScript(r.pin)], cwd: "/", timeoutSec: 15 });
    if (pinned.exitCode !== 0) throw new Error(`the box couldn't point ${r.label} at the node: ${said(pinned)}`);
  }
  try {
    await box.relay(r.relay);
  } catch (error) {
    throw new Error(`the box couldn't listen for ${r.label}: ${(error as Error).message}`);
  }
  const probed = await box.run({ argv: probeArgv(r.url), cwd: "/", timeoutSec: PROBE_SEC + 5 });
  if (probed.exitCode !== 0) throw new Error(`the box can't reach Claude at ${r.label}: ${said(probed)}`);
}
