// `fleetd pair` (crates/fleetd/src/cli/pair.rs): mints a one-time pairing code in the hub home's database (so the hub
// need not be running) and writes `app-pair.json`, which the desktop app on this machine reads to pair by itself.
// Also the worker codes: `--worker` prints the line that joins a machine, `--worker-codes` and `--worker-revoke`.
import { existsSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { delimiter, dirname, join } from "node:path";
import type { Role } from "../shared/contracts.ts";
import { VERSION } from "../shared/version.ts";
import { ArgError, parse } from "./args.ts";
import { homeDir, isMachineId, mkdirPrivate, readSetup, resolveHome, writePrivate } from "./common.ts";
import { type CliResult, err, ok } from "./result.ts";
import { DEFAULT_LISTEN, parseListen, runningListen } from "./setup/shared.ts";
import { relocated } from "../shared/home.ts";
import {
  createEnrollToken,
  createPairCode,
  ENROLL_CODE_ID_LEN,
  openEnrollTokens,
  openHub,
  revokeEnrollToken,
} from "./store.ts";
import { terminalQr } from "./qr.ts";
import { PAIR_USAGE } from "./usages.ts";
export { PAIR_USAGE };

/** `fleetd://pair?hub=<hub>&code=<code>`, the hub form-urlencoded. */
export function deepLink(hub: string, code: string): string {
  const enc = encodeURIComponent(hub)
    .replace(/[!'()~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+");
  return `fleetd://pair?hub=${enc}&code=${code}`;
}

/** `$XDG_CONFIG_HOME/fleetd/app-pair.json`; a relocated fleetd dir holds it instead. */
export function appPairFile(): string {
  const dir = relocated();
  if (dir !== undefined) return join(dir, "app-pair.json");
  const home = homeDir();
  const base =
    process.platform === "darwin"
      ? join(home, "Library/Application Support")
      : process.env.XDG_CONFIG_HOME?.startsWith("/")
        ? process.env.XDG_CONFIG_HOME
        : join(home, ".config");
  return join(base, "fleetd", "app-pair.json");
}

function writeAppPair(file: string, hub: string, code: string, expiresAt: string) {
  mkdirPrivate(dirname(file));
  writePrivate(file, `${JSON.stringify({ code, expiresAt, hub })}\n`);
}

// ---- where a device reaches the hub ----

/** The hub's addresses from setup.json, or the defaults when `fleetd init` never ran; best first. */
export function localHubUrls(home: string): string[] {
  const setup = readSetup(home);
  const running = setup === undefined ? runningListen(home) : undefined;
  const listenText = setup?.listen ?? running ?? DEFAULT_LISTEN;
  const parsed = parseListen(listenText);
  if (!parsed) throw new Error(`the hub's listen address '${listenText}' is not host:port`);
  const [host, port] = parsed;
  const everywhere = host === "0.0.0.0" || host === "::";
  const configured = setup?.url !== undefined && !setup.url.includes("0.0.0.0") && !setup.url.includes("[::]") ? setup.url : undefined;
  return hubUrls(host, port, configured, everywhere ? tailnetIp() : undefined, everywhere ? lanIp() : undefined);
}

const isLoopback = (ip: string) => /^127\./.test(ip) || ip === "::1";
const isUnspecified = (ip: string) => ip === "0.0.0.0" || ip === "::";
const isTailnet = (ip: string) => {
  const m = /^100\.(\d+)\./.exec(ip);
  return m !== null && Number(m[1]) >= 64 && Number(m[1]) < 128;
};
const isPrivate4 = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(ip);
const v6Head = (ip: string) => ip.toLowerCase().split(":").slice(0, 3);
const isTailnet6 = (ip: string) => {
  const [a, b, c] = v6Head(ip).map((h) => parseInt(h || "0", 16));
  return a === 0xfd7a && b === 0x115c && c === 0xa1e0;
};
const isLocal6 = (ip: string) => {
  const a = parseInt(v6Head(ip)[0] || "0", 16);
  return (a & 0xfe00) === 0xfc00 || (a & 0xffc0) === 0xfe80;
};

function rankIp(ip: string): number {
  if (isLoopback(ip)) return 3;
  if (isIP(ip) === 4) return isTailnet(ip) ? 0 : isPrivate4(ip) ? 2 : 1;
  return isTailnet6(ip) ? 0 : isLocal6(ip) ? 2 : 1;
}

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

function rankUrl(url: string): number {
  const host = urlHost(url);
  if (isIP(host)) return rankIp(host);
  if (host.endsWith(".ts.net")) return 0;
  return host === "localhost" ? 3 : 1;
}

/** Best first: tailnet, other names, LAN, loopback. */
export function hubUrls(listenHost: string, port: number, configured?: string, tailnet?: string, lan?: string): string[] {
  const url = (ip: string) => (isIP(ip) === 6 ? `http://[${ip}]:${port}` : `http://${ip}:${port}`);
  const candidates: [number, string][] = [];
  if (configured !== undefined) candidates.push([rankUrl(configured), configured.replace(/\/+$/, "")]);
  const host = listenHost.replace(/^[[\]]+|[[\]]+$/g, "");
  if (isIP(host) && isUnspecified(host)) {
    for (const ip of [tailnet, lan]) if (ip !== undefined) candidates.push([rankIp(ip), url(ip)]);
    candidates.push([3, url("127.0.0.1")]);
  } else if (isIP(host)) candidates.push([rankIp(host), url(host)]);
  else candidates.push([1, `http://${listenHost}:${port}`]);
  // A stable sort by rank.
  candidates.sort((a, b) => a[0] - b[0]);
  const urls: string[] = [];
  for (const [, u] of candidates) if (!urls.includes(u)) urls.push(u);
  return urls;
}

/** The first of `urls` a phone can reach: none on loopback or the every-interface address. */
export function phoneUrl(urls: string[]): string | undefined {
  return urls
    .map((u) => u.trim())
    .find((u) => {
      const host = urlHost(u).toLowerCase();
      if (host === "") return false;
      if (isIP(host)) return !isLoopback(host) && !isUnspecified(host);
      return host !== "localhost" && !host.endsWith(".localhost");
    });
}

/** Why a worker told to reach the hub at `hub` can join only from the hub's own computer; undefined when another can. */
export function workerReachNote(hub: string): string | undefined {
  return phoneUrl([hub]) === undefined
    ? `The hub is only at ${hub}, which no other machine reaches, so only a node on the hub's own computer can join it. For another machine, give the hub its tailnet or LAN address: on the hub, run fleetd init --listen <ip>:<port> --url http://<name>:<port> (Settings › Hub › Setup › Where the hub listens), then try again.`
    : undefined;
}

export const loopbackOnlyFix = (device: string, then: string) =>
  `Give the hub an address ${device} reaches, its tailnet or LAN address: on the hub, run \`fleetd init --listen <ip>:<port> --url http://<name>:<port>\` (Settings › Hub › Setup › Where the hub listens), then ${then}.`;
export const phoneLoopbackFix = () => loopbackOnlyFix("your phone", "pair the phone again");

/** `tailscale ip -4`, only when a `tailscale` binary is on PATH. */
function tailnetIp(): string | undefined {
  const bin = (process.env.PATH ?? "")
    .split(delimiter)
    .map((d) => join(d, "tailscale"))
    .find((p) => existsSync(p) && statSync(p).isFile());
  if (!bin) return undefined;
  const out = Bun.spawnSync([bin, "ip", "-4"], { stdin: "ignore", stderr: "ignore" }).stdout.toString();
  return out
    .split("\n")
    .map((l) => l.trim())
    .find((l) => isIP(l) === 4 && isTailnet(l));
}

/** The address of the interface the default route leaves by: a UDP socket connected sends nothing. */
function lanIp(): string | undefined {
  // `ip route get` names the address a connected UDP socket would take.
  const out = Bun.spawnSync(["ip", "-o", "route", "get", "192.0.2.1"], { stderr: "ignore" }).stdout.toString();
  const ip = /\bsrc (\S+)/.exec(out)?.[1];
  return ip !== undefined && !isUnspecified(ip) && !isLoopback(ip) ? ip : undefined;
}

// ---- the command ----

type Minted = { code: string; urls: string[]; deepLink: string; expiresAt: string; role: Role; appPairFile: string };

export function mint(home: string | undefined, name: string | undefined, role: Role): Minted {
  const dir = resolveHome(home);
  const db = openHub(dir);
  let minted;
  try {
    minted = createPairCode(db, name?.trim() ? name : undefined, role);
  } finally {
    db.conn.close();
  }
  const urls = localHubUrls(dir);
  const file = appPairFile();
  writeAppPair(file, urls[0]!, minted.code, minted.expiresAt);
  return { code: minted.code, urls, deepLink: deepLink(urls[0]!, minted.code), expiresAt: minted.expiresAt, role, appPairFile: file };
}

export async function pairCommand(argv: string[]): Promise<CliResult> {
  const usage = (m: string) => err(2, `fleetd: ${m}\n\nusage:\n${PAIR_USAGE}`);
  const v = parse(argv, {
    options: { name: "str", "no-qr": "bool", role: "str", worker: "str", "worker-codes": "bool", "worker-revoke": "str" },
    positionals: false,
  });
  if (v instanceof ArgError) return usage(v.message);
  const attempt = (fn: () => string): CliResult => {
    try {
      return ok(fn());
    } catch (error) {
      return err(1, `fleetd: ${(error as Error).message}\n`);
    }
  };
  if (v.has("worker-codes") || v.has("worker-revoke")) {
    if (v.keys().length > 1) return usage("--worker-codes and --worker-revoke take no other option");
    const id = v.str("worker-revoke");
    return attempt(() => (id !== undefined ? revokeWorkerCode(undefined, id) : workerCodes(undefined)));
  }
  const machine = v.str("worker");
  if (machine !== undefined) {
    if (v.has("role") || v.flag("no-qr")) return usage("--worker joins a machine and takes no --role or --no-qr");
    return attempt(() => workerCommand(undefined, machine));
  }
  const roleText = v.str("role");
  const role = roleText === undefined ? "admin" : roleText;
  if (role !== "read" && role !== "operate" && role !== "admin") return usage("--role must be read, operate or admin");
  return attempt(() => describe(mint(undefined, v.str("name"), role), !v.flag("no-qr")));
}

/** The line a new worker runs to join, with a one-time enroll code for `machine`. */
export function workerCommand(home: string | undefined, machine: string): string {
  if (!isMachineId(machine)) throw new Error(`'${machine}' is not a machine id ([a-z0-9-]{1,32})`);
  const dir = resolveHome(home);
  const join = workerJoin(dir, machine, false, false);
  let text = `On ${machine}, run:\n\n  ${join.line}\n\nThe code works once, until ${untilWords(join.expiresAt)}. ${machine} needs claude installed and must reach the hub at that address.\n`;
  const note = workerReachNote(join.hub);
  if (note !== undefined) text += `\n${note}\n`;
  return text;
}

/** `00:53 UTC`, or the timestamp as it is when it doesn't parse. */
export function untilWords(expiresAt: string): string {
  const ms = Date.parse(expiresAt);
  if (Number.isNaN(ms)) return expiresAt;
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

const MAC_ID_LEN = ENROLL_CODE_ID_LEN;
const MAC_CODE_TTL_MS = 10 * 60_000;

export function workerCodes(home: string | undefined): string {
  const db = openHub(resolveHome(home));
  try {
    const codes = openEnrollTokens(db);
    const mac = db.conn
      .query<{ id: string; machine_id: string; created_ms: number | null; expires_ms: number }, [number, number]>(
        `SELECT substr(hash, 1, ?1) AS id, machine_id, created_ms, expires_ms FROM pair_codes WHERE machine_id IS NOT NULL
         AND used_ms IS NULL AND revoked_ms IS NULL AND expires_ms > ?2 ORDER BY created_ms DESC LIMIT 1`,
      )
      .get(MAC_ID_LEN, Date.now());
    if (codes.length === 0 && !mac) return "No open worker codes. `fleetd pair --worker <machine-id>` makes one.\n";
    let out = "";
    for (const c of codes) {
      out += `${c.id}  ${c.machineId}  made ${c.createdAt}  until ${c.expiresAt}${c.pool ? "  (the hub's own, for a cloud machine)" : ""}\n`;
    }
    if (mac) {
      const created = new Date(mac.created_ms ?? mac.expires_ms - MAC_CODE_TTL_MS).toISOString();
      out += `${mac.id}  ${mac.machine_id}  made ${created}  until ${new Date(mac.expires_ms).toISOString()}  (the agents' Mac's 6-digit setup code)\n`;
    }
    return `${out}Take one back with \`fleetd pair --worker-revoke <id>\`.\n`;
  } finally {
    db.conn.close();
  }
}

export function revokeWorkerCode(home: string | undefined, id: string): string {
  if (id.length !== ENROLL_CODE_ID_LEN || !/^[0-9a-f]+$/.test(id)) {
    throw new Error(`'${id}' is not a worker code id (${ENROLL_CODE_ID_LEN} hex digits); \`fleetd pair --worker-codes\` lists them`);
  }
  const db = openHub(resolveHome(home));
  try {
    const machine = revokeEnrollToken(db, id);
    if (machine !== undefined) return `Revoked worker code ${id} for ${machine}: a machine that tries it is refused.\n`;
    const now = Date.now();
    const mac = db.conn
      .query<{ machine_id: string }, [number, string, number]>(
        `UPDATE pair_codes SET revoked_ms = ?3 WHERE substr(hash, 1, ?1) = ?2 AND length(?2) = ?1
         AND machine_id IS NOT NULL AND used_ms IS NULL AND revoked_ms IS NULL AND expires_ms > ?3 RETURNING machine_id`,
      )
      .get(MAC_ID_LEN, id, now);
    if (mac) return `Revoked the setup code ${id} for the agents' Mac ${mac.machine_id}: a Mac that types it is refused.\n`;
    throw new Error(`no open worker code ${id}; \`fleetd pair --worker-codes\` lists them`);
  } finally {
    db.conn.close();
  }
}

export type WorkerJoin = { hub: string; code: string; expiresAt: string; gitIdentity?: string; line: string };

/** Mints the one-time code `fleetd pair --worker` prints, and the line that installs fleetd and joins with it. */
export function workerJoin(home: string, machine: string, rejoin: boolean, mac: boolean): WorkerJoin {
  const setup = readSetup(home);
  const urls = localHubUrls(home);
  const db = openHub(home);
  let token;
  try {
    token = createEnrollToken(db, machine);
  } finally {
    db.conn.close();
  }
  const id = setup?.gitIdentity;
  const gitIdentity = id === undefined ? undefined : `${id.name} <${id.email}>`;
  return {
    line: joinLine(urls[0]!, token.token, machine, gitIdentity) + (rejoin ? " --rejoin" : "") + (mac ? macFlags(VERSION) : ""),
    hub: urls[0]!,
    code: token.token,
    expiresAt: token.expiresAt,
    ...(gitIdentity === undefined ? {} : { gitIdentity }),
  };
}

/** Quoted for the shell only when it needs it (setup/units.rs `q`). */
export function q(value: string): string {
  return value !== "" && /^[A-Za-z0-9_/.,:@%+=-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

export const macFlags = (version: string) => (version === "0.0.0" ? " --mac" : ` --mac --version ${q(version)}`);

export function joinLine(hub: string, code: string, machine: string, identity?: string): string {
  let line = `curl -fsSL https://fleetd.sh | sh -s -- --join ${q(hub)} --code ${q(code)} --machine-id ${q(machine)}`;
  if (identity !== undefined) line += ` --git-identity ${q(identity)}`;
  return line;
}

function describe(minted: Minted, qr: boolean): string {
  const [shown, scan] = qr ? phoneQr(minted) : ["", false];
  let out = shown;
  out += `Pairing code: ${minted.code}  (single use, valid until ${minted.expiresAt})\nGrants:       ${minted.role} on every machine\nHub address:  ${minted.urls[0]}\n`;
  if (minted.urls.length > 1) out += `  or:         ${minted.urls.slice(1).join(", ")}\n`;
  const phone = scan
    ? "On a phone, scan the QR with the\nfleetd app. On another device, enter"
    : "On a phone or another device,\nenter";
  out += `Pairing link: ${minted.deepLink}\n\nThe fleetd app on this machine pairs by itself when it opens. ${phone} the code and hub address above in the app, or open the link there.\n`;
  return out;
}

function phoneQr(minted: Minted): [string, boolean] {
  const hub = phoneUrl(minted.urls);
  if (hub === undefined) {
    return [
      `No QR for a phone: the hub is only at ${minted.urls.join(", ")}, which a phone can't reach. ${phoneLoopbackFix()}\n\n`,
      false,
    ];
  }
  const qr = terminalQr(deepLink(hub, minted.code));
  return qr === undefined ? ["", false] : [`Scan with the fleetd app on your phone:\n\n${qr}\n\n`, true];
}
