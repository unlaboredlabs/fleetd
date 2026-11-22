// The team's Tailscale gateway as the hub and its nodes both speak of it (hub/tailnet, node/sandbox/tailnet.ts): the
// routes a node reaches it at, how a node signs a call to them, and what counts as the tailnet's in a box (its
// addresses and its names).
//
// A node's call carries its machine id, the time, a fresh nonce and a signature by the node's own identity key over
// all of them and the call itself (`signedMessage`); the hub checks it against the key it enrolled for that machine,
// which every host of a hub can read, so the call needs no token handed out first.

/** Whether `s` is an IPv4 address (4), looks like an IPv6 one (6: a name never holds a colon), or is a name (0); as
 * `node:net`'s isIP for what the tailnet's checks ask, without the import, so this module stays pure for fleetd
 * cloud. */
function isIP(s: string): 0 | 4 | 6 {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(s)) return s.split(".").every((p) => Number(p) <= 255 && (p === "0" || !p.startsWith("0"))) ? 4 : 0;
  if (!s.includes(":") || !/^[0-9a-f:.]+$/iu.test(s) || (s.match(/::/gu) ?? []).length > 1) return 0;
  const tail = s.slice(s.lastIndexOf(":") + 1);
  if (tail.includes(".") && isIP(tail) !== 4) return 0;
  const groups = s.split(":");
  return groups.length <= 8 && groups.every((g) => g.length <= 4 || g === tail) ? 6 : 0;
}

/** One tailnet connection: a websocket, `?host=&port=`. The hub's first message says how the dial went
 * (`{"ok":true}` or `{"error","retry"?}`); the bytes follow as binary messages, the hub's acks (WINDOW) as text. */
export const DIAL_PATH = "/node/tailnet/dial";
/** One tailnet name lookup: `?name=&type=` (a DNS type number), answered with the DNS response's bytes. */
export const DNS_PATH = "/node/tailnet/dns";

export const MACHINE_HEADER = "x-fleetd-machine";
export const AT_HEADER = "x-fleetd-at";
export const NONCE_HEADER = "x-fleetd-nonce";
export const SIG_HEADER = "x-fleetd-sig";

/** How far a call's time may be from the hub's. */
export const SKEW_MS = 120_000;

/** A dial's bytes from the node to the gateway are windowed: the hub says `{"ack":n}` once it has handed n more bytes
 * to the gateway's connection, and the node keeps at most WINDOW bytes unacknowledged, so the hub never holds more of
 * one connection than that. A node past CAP (one that ignores the window) is cut off. */
export const WINDOW = 1 << 20;
export const ACK_EVERY = 64 << 10;
export const CAP = 2 * WINDOW;

/** A gateway that lives on another host than the one a call landed on (a cloud's): the node calls again. HTTP 421
 * Misdirected Request for a lookup, and `retry` in a dial's first message. */
export const NOT_HERE = 421;
/** How many times a node calls again on NOT_HERE. */
export const NOT_HERE_TRIES = 8;

/** The bytes a node signs for one call: `op` is `dial` or `dns`, `what` its target (`host:port`, `name/type`). */
export const signedMessage = (machineId: string, at: number, nonce: string, op: "dial" | "dns", what: string) =>
  `fleetd-tailnet/1|${machineId}|${at}|${nonce}|${op}|${what}`;

/** Whether `message` is one a node signs for the gateway, so its identity key never signs one for anything else. */
export const isTailnetMessage = (message: string) => message.startsWith("fleetd-tailnet/1|");

/** The tailnet's address ranges: Tailscale's CGNAT range and its IPv6 ULA. */
export const RANGES = { v4: "100.64.0.0/10", v6: "fd7a:115c:a1e0::/48" } as const;

/** Whether `ip` is a tailnet address. */
export function tailnetIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 100 && b >= 64 && b < 128;
  }
  return isIP(ip) === 6 && /^fd7a:115c:a1e0:/iu.test(ip);
}

/** Whether a box asks the gateway for `name` (lowercase, no trailing dot): a MagicDNS name (`*.ts.net`, and the tailnet's
 * own `suffix`, which may be a custom one), or a reverse lookup of a tailnet address. Every other name goes to the box's
 * own resolver. */
export function tailnetName(name: string, suffix: string | undefined): boolean {
  const n = name.toLowerCase().replace(/\.$/u, "");
  const s = suffix?.toLowerCase().replace(/\.$/u, "");
  if (n === "ts.net" || n.endsWith(".ts.net")) return true;
  if (s && (n === s || n.endsWith(`.${s}`))) return true;
  const v4 = /^(?:\d+\.){0,2}(\d+)\.100\.in-addr\.arpa$/u.exec(n);
  if (v4) {
    const b = Number(v4[1]);
    return b >= 64 && b < 128;
  }
  return n.endsWith("0.e.1.a.c.5.1.1.a.7.d.f.ip6.arpa");
}

/** Whether a URL's `host` (an address, bracketed or not, or a name) is on the tailnet: one of its addresses, or a
 * MagicDNS name (`suffix` the tailnet's own, when known). What a server's Test says it reached "via Tailscale", and
 * what a node not on the tailnet reaches through the hub's route. */
export function isTailnetHost(host: string, suffix?: string): boolean {
  const h = host.replace(/^\[(.*)\]$/u, "$1");
  return isIP(h) !== 0 ? tailnetIp(h) : tailnetName(h, suffix) && !/\.arpa$/iu.test(h);
}
