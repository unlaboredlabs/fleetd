// Where devices reach the hub, as the hub itself works it out (crates/fleetd/src/cli/pair.rs `deep_link`,
// `hub_urls_at`, `phone_url`, `loopback_only_fix`; hub/pair/tools.rs `phone_hub_url`).
import { createSocket } from "node:dgram";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import type { Hub } from "../api/hub.ts";

/** `url::form_urlencoded::byte_serialize`: space as `+`, `*-._` and alphanumerics kept, the rest `%XX`. */
export function formEncode(text: string): string {
  let out = "";
  for (const byte of Buffer.from(text, "utf8")) {
    const c = String.fromCharCode(byte);
    if (/[A-Za-z0-9*\-._]/.test(c)) out += c;
    else if (c === " ") out += "+";
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** `fleetd://pair?hub=<hub, URL-encoded>&code=<code>`. */
export const deepLink = (hub: string, code: string) => `fleetd://pair?hub=${formEncode(hub)}&code=${code}`;

/** `url`'s host, without its port or IPv6 brackets. */
export function urlHost(url: string): string {
  const scheme = url.indexOf("://");
  let host = (scheme < 0 ? url : url.slice(scheme + 3)).split(/[/?#]/)[0] ?? "";
  const at = host.lastIndexOf("@");
  if (at >= 0) host = host.slice(at + 1);
  const colon = host.lastIndexOf(":");
  if (colon >= 0 && /^[0-9]*$/.test(host.slice(colon + 1))) host = host.slice(0, colon);
  return host.replace(/^\[+|\]+$/g, "");
}

const v4 = (ip: string) => ip.split(".").map(Number);

/** An IPv6 address's eight groups, each as lowercase hex without leading zeros. */
export function expand6(addr: string): string[] {
  const [head = "", tail] = addr.split("::");
  const parts = (s: string) => (s === "" ? [] : s.split(":"));
  const h = parts(head);
  const t = tail === undefined ? [] : parts(tail);
  return [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t].map((g) =>
    Number.parseInt(g, 16).toString(16),
  );
}

const isLoopback = (ip: string) => {
  if (isIP(ip) === 4) return v4(ip)[0] === 127;
  const g = expand6(ip);
  return g.slice(0, 7).every((x) => x === "0") && g[7] === "1";
};
export const isUnspecified = (ip: string) =>
  isIP(ip) === 4 ? ip === "0.0.0.0" : isIP(ip) === 6 && expand6(ip).every((x) => x === "0");

/**
 * The first of `urls` a phone can reach: none on this machine's loopback (127.0.0.1, ::1, localhost) or at the
 * every-interface 0.0.0.0, which reach nothing from another device.
 */
export function phoneUrl(urls: Iterable<string>): string | undefined {
  for (const raw of urls) {
    const url = raw.trim();
    const host = urlHost(url).toLowerCase();
    if (host === "") continue;
    const ok = isIP(host) ? !isLoopback(host) && !isUnspecified(host) : host !== "localhost" && !host.endsWith(".localhost");
    if (ok) return url;
  }
  return undefined;
}

/** What to do when the hub has no address `device` ("your phone", "the Mac") can reach, `then` once it has one. */
export const loopbackOnlyFix = (device: string, then: string) =>
  `Give the hub an address ${device} reaches, its tailnet or LAN address: on the hub, run \`fleetd init --listen ` +
  `<ip>:<port> --url http://<name>:<port>\` (Settings › Hub › Setup › Where the hub listens), then ${then}.`;

export const phoneLoopbackFix = () => loopbackOnlyFix("your phone", "pair the phone again");

/** Tailscale's CGNAT range, 100.64.0.0/10. */
const isTailnet = (ip: string) => {
  const [a = 0, b = 0] = v4(ip);
  return a === 100 && b >= 64 && b < 128;
};

function rankIp(ip: string): number {
  if (isLoopback(ip)) return 3;
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = v4(ip);
    if (isTailnet(ip)) return 0;
    if (a === 10 || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 169 && b === 254)) return 2;
    return 1;
  }
  const lower = ip.toLowerCase();
  if (lower.startsWith("fd7a:115c:a1e0:")) return 0;
  if (/^f[cd]/.test(lower) || /^fe[89ab]/.test(lower)) return 2;
  return 1;
}

function rankUrl(url: string): number {
  const host = urlHost(url);
  if (isIP(host)) return rankIp(host);
  if (host.endsWith(".ts.net")) return 0;
  return host === "localhost" ? 3 : 1;
}

/** Best first: tailnet, other names, LAN, loopback (cli/pair.rs `hub_urls`). */
export function hubUrls(listenHost: string, port: number, configured: string | undefined, tailnet?: string, lan?: string): string[] {
  const url = (ip: string) => (isIP(ip) === 6 ? `http://[${ip}]:${port}` : `http://${ip}:${port}`);
  const candidates: [number, string][] = [];
  if (configured !== undefined) candidates.push([rankUrl(configured), configured.replace(/\/+$/, "")]);
  const host = listenHost.replace(/^\[+|\]+$/g, "");
  if (isIP(host) && isUnspecified(host)) {
    for (const ip of [tailnet, lan]) if (ip !== undefined) candidates.push([rankIp(ip), url(ip)]);
    candidates.push([3, url("127.0.0.1")]);
  } else if (isIP(host)) candidates.push([rankIp(host), url(host)]);
  else candidates.push([1, `http://${listenHost}:${port}`]);
  candidates.sort((a, b) => a[0] - b[0]);
  return [...new Set(candidates.map(([, u]) => u))];
}

/** `tailscale ip -4`, only when a `tailscale` binary is on PATH. */
function tailnetIp(): string | undefined {
  const bin = Bun.which("tailscale");
  if (!bin) return undefined;
  try {
    const out = Bun.spawnSync([bin, "ip", "-4"], { stdin: "ignore", stderr: "ignore" });
    return out.stdout
      .toString()
      .split("\n")
      .map((l) => l.trim())
      .find((l) => isIP(l) === 4 && isTailnet(l));
  } catch {
    return undefined;
  }
}

/** The address of the interface the default route leaves by. Connecting a UDP socket sends nothing. */
function lanIp(): Promise<string | undefined> {
  return new Promise((resolve) => {
    const socket = createSocket("udp4");
    let settled = false;
    const done = (ip?: string) => {
      if (settled) return;
      settled = true;
      socket.close();
      resolve(ip !== undefined && !isUnspecified(ip) && !isLoopback(ip) ? ip : undefined);
    };
    socket.on("error", () => done());
    socket.connect(9, "192.0.2.1", () => {
      try {
        done(socket.address().address);
      } catch {
        done();
      }
    });
  });
}

/** `host:port` as `fleetd init` saves it (serve's `parseListen`; not imported, as serve imports the routes). */
function parseListen(value: string): { host: string; port: number } | undefined {
  const colon = value.lastIndexOf(":");
  const [rawHost, rawPort] = colon < 0 ? ["", value] : [value.slice(0, colon), value.slice(colon + 1)];
  if (!/^\d+$/.test(rawPort)) return undefined;
  const port = Number(rawPort);
  if (port < 1 || port > 65535) return undefined;
  const host = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
  return { host: host || "127.0.0.1", port };
}

/** `setup.json`'s listen and URL, when `fleetd init` wrote one. */
function readSetup(home: string): { listen: string; url: string } | undefined {
  try {
    const s = JSON.parse(readFileSync(join(home, "setup.json"), "utf8")) as { listen?: unknown; url?: unknown };
    return typeof s.listen === "string" && typeof s.url === "string" ? { listen: s.listen, url: s.url } : undefined;
  } catch {
    return undefined;
  }
}

/** `hub_urls_at(home, Some(own listen))`: the hub's addresses, best first, as the hub itself asks for them. */
export async function hubUrlsAt(hub: Hub): Promise<string[]> {
  const setup = readSetup(hub.config.home);
  const listen = setup ? parseListen(setup.listen) : hub.config.listen;
  if (!listen) return [];
  const host = listen.host.replace(/^\[+|\]+$/g, "");
  const everywhere = isIP(host) !== 0 && isUnspecified(host);
  const configured = setup?.url !== undefined && !setup.url.includes("0.0.0.0") && !setup.url.includes("[::]") ? setup.url : undefined;
  const [tailnet, lan] = everywhere ? [tailnetIp(), await lanIp()] : [undefined, undefined];
  return hubUrls(listen.host, listen.port, configured, tailnet, lan);
}

/**
 * Where a phone reaches the hub: the address the app reaches it at, else the hub's own (its `--url`, the one setup
 * saved, its tailnet and LAN addresses), never a loopback one. Undefined when it has only those.
 */
export async function phoneHubUrl(hub: Hub, appUrl: string | undefined): Promise<string | undefined> {
  const own = await hubUrlsAt(hub);
  const candidates = [...(appUrl === undefined ? [] : [appUrl]), ...(hub.config.url === undefined ? [] : [hub.config.url]), ...own];
  const found = phoneUrl(candidates);
  if (found === undefined) return undefined;
  const url = found.replace(/\/+$/, "");
  // The phone opens the link's hub as a URL: an address saved without its scheme gets http's.
  return url.includes("://") ? url : `http://${url}`;
}

/**
 * Why a worker told to reach the hub at `hub` can join only from the hub's own computer: undefined when another
 * machine can reach that address (cli/pair.rs `worker_reach_note`). Plain text: the app shows it as it is.
 */
export function workerReachNote(hub: string): string | undefined {
  if (phoneUrl([hub]) !== undefined) return undefined;
  return (
    `The hub is only at ${hub}, which no other machine reaches, so only a node on the hub's own computer can ` +
    "join it. For another machine, give the hub its tailnet or LAN address: on the hub, run fleetd init " +
    "--listen <ip>:<port> --url http://<name>:<port> (Settings › Hub › Setup › Where the hub listens), then " +
    "try again."
  );
}
