// A box's network keeps the guest off this machine itself. passt opens the guest's connections as sockets of its own,
// so with `--no-map-gw` alone the guest still reached every address of this machine but loopback: its LAN, its
// tailnet (where a hub may listen) and its bridges. So a box's passt runs in a network namespace of its own, which
// pasta (the same binary) links to this machine's network, and where this machine's own addresses, v4 and v6, are
// routes nowhere (`unreachable`, in a table of their own looked up first). The internet, DNS and the node's forwards
// (over the box's link, not the network) are untouched. The node reads the addresses again when they change (a new
// DHCP lease, IPv6's rotating addresses, a VPN coming up) and sets each running box's routes to them, through the
// shell that holds the namespace (`nsenter`): nothing needs root, and nothing changes on this machine.
import { existsSync } from "node:fs";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

/** The routing table a box's namespace keeps this machine's addresses in, and the rule's priority that reads it
 * before the main table (after `local`, which keeps the namespace's own addresses its own). */
export const TABLE = 4790;
export const RULE_PREF = 10;

/** Every address of this machine but loopback's (the namespace has a loopback of its own), each once, without its
 * zone: `fe80::1%eth0` is `fe80::1`. */
export function hostAddrs(ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): string[] {
  const out = new Set<string>();
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) {
      if (a.internal) continue;
      const addr = a.address.split("%")[0]!.toLowerCase();
      if (addr) out.add(addr);
    }
  }
  return [...out].sort();
}

/** `ip` and `nsenter`, by path. */
export type NetTools = { ip: string; nsenter: string };

/** What a box's network namespace is set up with, or what of it this machine lacks and the fix where there is one. */
export function netTools(): NetTools | { missing: string; fix?: string } {
  // The node's PATH may leave out the sbin dirs, where iproute2 puts `ip`.
  const PATH = `${process.env.PATH ?? ""}:/usr/sbin:/sbin:/usr/bin:/bin`;
  const ip = Bun.which("ip", { PATH });
  const nsenter = Bun.which("nsenter", { PATH });
  if (!ip) return { missing: "the `ip` command, which iproute2 installs" };
  if (!nsenter) return { missing: "the `nsenter` command, which util-linux installs" };
  if (!existsSync("/dev/net/tun")) return { missing: "/dev/net/tun, which the tun module makes", fix: "echo tun | sudo tee /etc/modules-load.d/fleetd-tun.conf && sudo modprobe tun" };
  return { ip, nsenter };
}

const prefix = (addr: string) => (addr.includes(":") ? `${addr}/128` : `${addr}/32`);

/** `ip -batch` lines making `add` routes nowhere and dropping `drop`'s. */
export function blockLines(add: string[], drop: string[] = []): string {
  const lines = [
    ...add.map((a) => `route replace unreachable ${prefix(a)} table ${TABLE}`),
    ...drop.filter((a) => !add.includes(a)).map((a) => `route del unreachable ${prefix(a)} table ${TABLE}`),
  ];
  return lines.length ? `${lines.join("\n")}\n` : "";
}

/** The addresses `ip route show table TABLE` (either family) lists as unreachable. */
export function blockedIn(shown: string): string[] {
  const out: string[] = [];
  for (const line of shown.split("\n")) {
    const m = /^unreachable\s+([0-9a-f.:]+)(?:\/(?:32|128))?\s/iu.exec(`${line.trim()} `);
    if (m?.[1]) out.push(m[1].toLowerCase());
  }
  return out;
}

const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/** What the shell in a box's namespace runs before its passt: the rule for each family, then this machine's addresses
 * from `blocks` (blockLines). Any of it failing ends the box before it has a network: closed, never open. A machine
 * without IPv6 has no v6 address to keep out. */
export function blockScript(ip: string, blocks: string): string {
  return [
    `${q(ip)} -4 rule add pref ${RULE_PREF} table ${TABLE} || exit 1`,
    `if [ -e /proc/net/if_inet6 ]; then ${q(ip)} -6 rule add pref ${RULE_PREF} table ${TABLE} || exit 1; fi`,
    `if [ -s ${q(blocks)} ]; then ${q(ip)} -batch ${q(blocks)} || exit 1; fi`,
  ].join("\n");
}

export type Spawned = { ok: boolean; out: string; err: string };

/** Runs argv with `input`; a stand-in for the tests. */
export type Runner = (argv: string[], input?: string) => Spawned;

const run: Runner = (argv, input) => {
  const r = Bun.spawnSync(argv, { stdin: input === undefined ? "ignore" : Buffer.from(input), stdout: "pipe", stderr: "pipe" });
  return { ok: r.success, out: r.stdout.toString(), err: r.stderr.toString().trim() };
};

/** Sets the routes in the namespace `holder` (a pid in it, and in the user namespace that owns it) to keep exactly
 * `want` out: adds the new ones first, then drops the ones this machine no longer has. Throws why it couldn't. */
export function setBlocks(nsenter: string, ip: string, holder: number, want: string[], runner: Runner = run): void {
  const enter = [nsenter, "-t", String(holder), "-U", "-n", "--preserve-credentials", ip];
  const shown = [runner([...enter, "-4", "route", "show", "table", String(TABLE)]), runner([...enter, "-6", "route", "show", "table", String(TABLE)])];
  const failed = shown.find((s) => !s.ok);
  if (failed && !shown.some((s) => s.ok)) throw new Error(`couldn't read the box's routes: ${failed.err || "nsenter failed"}`);
  const now = shown.flatMap((s) => (s.ok ? blockedIn(s.out) : []));
  const lines = blockLines(want, now);
  if (!lines) return;
  const set = runner([...enter, "-batch", "-"], lines);
  if (!set.ok) throw new Error(`couldn't set the box's routes: ${set.err || "ip failed"}`);
}
