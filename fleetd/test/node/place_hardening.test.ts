// A box's walls (src/node/place/net.ts, box_record.ts reapLeaked), without KVM:
// - its network keeps this machine's own addresses out: which addresses, the routes that do it, and (where this machine
//   lets a user make a network namespace) those routes in a real namespace, set at its start and changed later
//   through nsenter as a box's are;
// - a box nothing records is reaped at the node's start, by the marker the node puts on it and never by name: one
//   still recorded stays, and another fleet's (another home's) is never touched.
import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BOX_MARKER, boxFile, liveProc, reapLeaked, type BoxRecord } from "../../src/node/place/box_record.ts";
import { blockedIn, blockLines, blockScript, hostAddrs, ipv6Of, netTools, setBlocks, TABLE, type Runner } from "../../src/node/place/net.ts";
import { startOf } from "../../src/node/runner/host.ts";

const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-walls-"));
const started: number[] = [];
afterAll(() => {
  for (const pid of started) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  rmSync(root, { recursive: true, force: true });
});

test("this machine's addresses are every one but loopback's, without zones, each once", () => {
  const ifaces = {
    lo: [{ address: "127.0.0.1", internal: true }, { address: "::1", internal: true }],
    eth0: [{ address: "192.168.2.8", internal: false }, { address: "fe80::1%eth0", internal: false }, { address: "2001:DB8::8", internal: false }],
    tailscale0: [{ address: "100.64.0.7", internal: false }, { address: "192.168.2.8", internal: false }],
  } as unknown as Parameters<typeof hostAddrs>[0];
  expect(hostAddrs(ifaces, { fibTrie: "", ifInet6: "" })).toEqual(["100.100.100.100", "100.64.0.7", "192.168.2.8", "2001:db8::8", "fd7a:115c:a1e0::53", "fe80::1"]);
});

test("a down interface's addresses are this machine's too: the kernel's local table names them, and a box keeps them out", () => {
  // docker0 with no carrier: libuv lists no interface that isn't up, but the kernel still answers at 172.17.0.1.
  const fibTrie = [
    "Main:",
    "  +-- 0.0.0.0/0 3 0 5",
    "     |-- 172.17.0.0",
    "        /16 link UNICAST",
    "Local:",
    "  +-- 0.0.0.0/0 3 0 5",
    "     +-- 127.0.0.0/8 2 0 2",
    "        +-- 127.0.0.0/31 1 0 0",
    "           |-- 127.0.0.0",
    "              /8 host LOCAL",
    "           |-- 127.0.0.1",
    "              /32 host LOCAL",
    "     +-- 172.17.0.0/16 2 0 2",
    "        |-- 172.17.0.1",
    "           /32 host LOCAL",
    "        |-- 172.17.255.255",
    "           /32 link BROADCAST",
    "     |-- 192.168.2.8",
    "        /32 host LOCAL",
    "",
  ].join("\n");
  const ifInet6 = [
    "00000000000000000000000000000001 01 80 10 80       lo",
    "fd4a4635315600003a0525fffe3af7be 02 40 00 00   enp3s0",
    "fe800000000000000000000000000001 05 40 20 80  docker0",
    "20010db8000000000001000000000000 06 40 00 80   lxdbr0",
    "",
  ].join("\n");
  const up = { eth0: [{ address: "192.168.2.8", internal: false }] } as unknown as Parameters<typeof hostAddrs>[0];
  expect(hostAddrs(up, { fibTrie, ifInet6 })).toEqual(["172.17.0.1", "192.168.2.8", "2001:db8:0:0:1::", "fd4a:4635:3156:0:3a05:25ff:fe3a:f7be", "fe80::1"]);
  // A tailnet address means this machine's tailscaled answers at its own quad-100 too.
  const tailnet = { tailscale0: [{ address: "100.104.0.9", internal: false }] } as unknown as Parameters<typeof hostAddrs>[0];
  expect(hostAddrs(tailnet, { fibTrie: "", ifInet6: "" })).toEqual(["100.100.100.100", "100.104.0.9", "fd7a:115c:a1e0::53"]);
  expect(hostAddrs(up, { fibTrie: "", ifInet6: "" })).not.toContain("100.100.100.100");
  expect(ipv6Of("00000000000000000000000000000000")).toBe("::");
  expect(ipv6Of("20010db8000000010000000000000001")).toBe("2001:db8:0:1::1");
  expect(ipv6Of("20010db8000000000001000000000000")).toBe("2001:db8:0:0:1::");
  expect(ipv6Of("20010db8000100000000000100000000")).toBe("2001:db8:1::1:0:0");
});

test("the routes add this machine's addresses first, then drop the ones it no longer has", () => {
  expect(blockLines(["100.64.0.7", "2001:db8::8"], ["100.64.0.7", "192.168.2.8"])).toBe(
    [`route replace unreachable 100.64.0.7/32 table ${TABLE}`, `route replace unreachable 2001:db8::8/128 table ${TABLE}`, `route del unreachable 192.168.2.8/32 table ${TABLE}`, ""].join("\n"),
  );
  expect(blockLines([])).toBe("");
  expect(blockedIn("unreachable 100.64.0.7 \nunreachable 2001:db8::8 dev lo metric 1024 pref medium\n")).toEqual(["100.64.0.7", "2001:db8::8"]);
  // A rule that fails, or routes that don't set, end the box before passt starts: closed, never open.
  const script = blockScript("/usr/sbin/ip", "/n/hosts/s/blocks");
  expect(script).toContain(`'/usr/sbin/ip' -4 rule add pref 10 table ${TABLE} || exit 1`);
  expect(script).toContain(`'/usr/sbin/ip' -batch '/n/hosts/s/blocks' || exit 1`);
});

test("a box's routes change through the shell holding its namespace, and a failure says so", () => {
  const calls: { argv: string[]; input?: string }[] = [];
  const runner: Runner = (argv, input) => {
    calls.push({ argv, ...(input !== undefined ? { input } : {}) });
    if (argv.includes("show")) return { ok: true, out: argv.includes("-4") ? "unreachable 192.168.2.8 \n" : "", err: "" };
    return { ok: true, out: "", err: "" };
  };
  setBlocks("/usr/bin/nsenter", "/usr/sbin/ip", 4242, ["192.168.2.9"], runner);
  expect(calls.at(-1)).toEqual({
    argv: ["/usr/bin/nsenter", "-t", "4242", "-U", "-n", "--preserve-credentials", "/usr/sbin/ip", "-batch", "-"],
    input: `route replace unreachable 192.168.2.9/32 table ${TABLE}\nroute del unreachable 192.168.2.8/32 table ${TABLE}\n`,
  });
  expect(() => setBlocks("/usr/bin/nsenter", "/usr/sbin/ip", 4242, ["192.168.2.9"], () => ({ ok: false, out: "", err: "nsenter: No such process" }))).toThrow(
    "couldn't read the box's routes: nsenter: No such process",
  );
});

const tools = netTools();
const nsOk =
  process.platform === "linux" &&
  !("missing" in tools) &&
  // A kernel with dummy links (a VM's guest kernel has none: this runs where an agent does).
  Bun.spawnSync(["unshare", "--user", "--map-root-user", "--net", (tools as { ip: string }).ip, "link", "add", "d0", "type", "dummy"], { stdout: "ignore", stderr: "ignore" }).success;

test.skipIf(!nsOk)("in a real network namespace, this machine's addresses go nowhere while the rest is routed, and follow a change", async () => {
  const { ip, nsenter } = tools as { ip: string; nsenter: string };
  const blocks = join(root, "blocks");
  writeFileSync(blocks, blockLines(["192.0.2.7", "2001:db8:7::7"]));
  // A namespace with a route out (a dummy link standing in for pasta's), whose shell sets the routes as a box's does.
  const setup = [
    `${ip} link set lo up`,
    `${ip} link add d0 type dummy`,
    `${ip} addr add 10.9.9.1/24 dev d0`,
    `${ip} -6 addr add 2001:db8:9::1/64 dev d0 nodad`,
    `${ip} link set d0 up`,
    `${ip} route add default via 10.9.9.2`,
    `${ip} -6 route add default via 2001:db8:9::2`,
  ].join(" && ");
  const holder = spawn("unshare", ["--user", "--map-root-user", "--net", "/bin/sh", "-c", `${setup} || exit 1\n${blockScript(ip, blocks)}\necho ready\nexec sleep 60`], {
    stdio: ["ignore", "pipe", "inherit"],
    detached: true,
  });
  started.push(holder.pid!);
  await new Promise<void>((resolve, reject) => {
    holder.stdout!.on("data", (d: Buffer) => d.toString().includes("ready") && resolve());
    holder.once("exit", (code) => reject(new Error(`the namespace's shell exited ${code}`)));
  });
  const route = (addr: string) => {
    const r = Bun.spawnSync([nsenter, "-t", String(holder.pid), "-U", "-n", "--preserve-credentials", ip, "route", "get", addr], { stdout: "pipe", stderr: "pipe" });
    return r.success ? (r.stdout.toString().includes("via") ? "routed" : r.stdout.toString().trim()) : "nowhere";
  };
  expect([route("192.0.2.7"), route("2001:db8:7::7"), route("198.51.100.9"), route("2001:db8:5::5")]).toEqual(["nowhere", "nowhere", "routed", "routed"]);
  // This machine's addresses changed: the new one goes nowhere, the old ones are routed again.
  setBlocks(nsenter, ip, holder.pid!, ["198.51.100.9"]);
  expect([route("192.0.2.7"), route("2001:db8:7::7"), route("198.51.100.9")]).toEqual(["routed", "routed", "nowhere"]);
});

/** A stand-in box process: a shell leading a group of its own, with a child, marked as the node marks a box. */
function markedBox(dir: string): { pid: number; child: () => number | undefined } {
  const p = spawn("/bin/sh", ["-c", "sleep 600 & wait"], { env: { PATH: process.env.PATH, [BOX_MARKER]: dir }, stdio: "ignore", detached: true });
  started.push(p.pid!);
  return {
    pid: p.pid!,
    child: () => {
      const r = Bun.spawnSync(["pgrep", "-P", String(p.pid)], { stdout: "pipe" });
      const pid = Number(r.stdout.toString().trim().split("\n")[0]);
      return Number.isInteger(pid) && pid > 0 ? pid : undefined;
    },
  };
}

const alive = (pid: number) => liveProc({ pid, start: startOf(pid) ?? -1 }) !== undefined;

test.skipIf(process.platform !== "linux")("at a node's start, boxes nothing records are reaped, and none recorded or of another fleet", async () => {
  const hosts = join(root, "a", "hosts");
  const otherHosts = join(root, "b", "hosts");
  for (const d of ["s-rec", "s-norec"]) mkdirSync(join(hosts, d), { recursive: true });
  mkdirSync(otherHosts, { recursive: true });
  const recorded = markedBox(join(hosts, "s-rec"));
  const unrecorded = markedBox(join(hosts, "s-norec"));
  const dirGone = markedBox(join(hosts, "s-gone"));
  const otherFleet = markedBox(join(otherHosts, "s-x"));
  // Not a box: a process marked with nothing, beside them.
  const plain = spawn("sleep", ["600"], { stdio: "ignore", detached: true });
  started.push(plain.pid!);
  await Bun.sleep(150);
  const record: BoxRecord = { kind: "microvm", leader: { pid: recorded.pid, start: startOf(recorded.pid)! }, helpers: [], tcp: [], port: 5000 };
  writeFileSync(boxFile(join(hosts, "s-rec")), JSON.stringify(record));
  const children = [unrecorded.child(), dirGone.child()];
  expect(children.every((c) => c !== undefined)).toBe(true);

  const ended = await reapLeaked(hosts);
  expect(ended).toBe(4);
  expect([alive(unrecorded.pid), alive(dirGone.pid), ...children.map((c) => alive(c!))]).toEqual([false, false, false, false]);
  expect([alive(recorded.pid), alive(recorded.child()!), alive(otherFleet.pid), alive(plain.pid!)]).toEqual([true, true, true, true]);
  expect(await reapLeaked(hosts)).toBe(0);
  // A record whose launcher went no longer holds what is left of its box.
  const orphan = recorded.child()!;
  process.kill(recorded.pid, "SIGKILL");
  await Bun.sleep(150);
  expect(await reapLeaked(hosts)).toBe(1);
  expect(alive(orphan)).toBe(false);
  expect(alive(otherFleet.pid)).toBe(true);
});
