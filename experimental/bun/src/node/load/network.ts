// Whether the machine has an IPv4 network, sent with each heartbeat's load (`network`; crates/fleetd/src/node/
// network.rs). Only the machine's own network hardware counts (an interface with a device behind it in
// /sys/class/net), so Tailscale's address, docker's bridge and loopback, which stay up when DHCP fails, never make it
// look fine. A routable IPv4 on one of them, or none (only 169.254.x link-local, what systemd-networkd falls back to
// when DHCP times out under memory pressure). The hub degrades the machine only when GitHub can't be reached from it
// too. Linux only: the fix it names is systemd-networkd's and netplan's.
import { existsSync, readdirSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { NodeNetwork } from "../../shared/contracts.ts";

const octets = (ip: string) => ip.split(".").map(Number);
const linkLocal = (ip: string) => {
  const [a, b] = octets(ip);
  return a === 169 && b === 254;
};
const loopback = (ip: string) => octets(ip)[0] === 127;

/** What the interfaces say: `addrs` each IPv4 address with its interface's name, `hardware` the names of the
 * interfaces of the machine's own hardware. Undefined with no hardware interface (a container): nothing to tell. */
export function verdict(addrs: [string, string][], hardware: string[]): NodeNetwork | undefined {
  if (!hardware.length) return undefined;
  const own = [...hardware].sort();
  const onHardware = (name: string) => own.includes(name);
  const ipv4 = addrs.some(([name, ip]) => onHardware(name) && !linkLocal(ip) && !loopback(ip) && ip !== "0.0.0.0");
  if (ipv4) return { ipv4 };
  const iface = addrs.find(([name, ip]) => onHardware(name) && linkLocal(ip))?.[0] ?? own[0];
  return { ipv4, ...(iface && iface.length <= 64 ? { iface } : {}) };
}

/** Reads the interfaces now; undefined off Linux. */
export function read(): NodeNetwork | undefined {
  if (process.platform !== "linux") return undefined;
  let hardware: string[];
  try {
    hardware = readdirSync("/sys/class/net").filter((name) => existsSync(join("/sys/class/net", name, "device")));
  } catch {
    return undefined;
  }
  const addrs: [string, string][] = [];
  for (const [name, list] of Object.entries(networkInterfaces()))
    for (const a of list ?? []) if (a.family === "IPv4") addrs.push([name, a.address]);
  return verdict(addrs, hardware);
}
