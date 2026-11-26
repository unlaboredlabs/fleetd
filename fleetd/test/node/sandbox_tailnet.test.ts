// The team's tailnet inside a hosted box (src/node/sandbox/tailnet_box.ts, box.ts): what counts as the tailnet's, the
// guest's capture (a SOCKS listener the TUN feeds, the box's DNS at its own address) against a stand-in node, and the
// node's Box carrying each connection and lookup the guest opens on to the gateway's hooks. No Tailscale, no TUN and no
// root here: the capture's system half (TUN, routes, resolv.conf) is only checked as the scripts it runs.
import { afterAll, expect, test } from "bun:test";
import { createSocket } from "node:dgram";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { Duplex, PassThrough } from "node:stream";
import { tailnetIp, tailnetName } from "../../src/shared/tailnet.ts";
import { Box } from "../../src/node/sandbox/box.ts";
import { GUEST_PROTOCOL } from "../../src/node/sandbox/guest.ts";
import { Mux, type Target } from "../../src/node/sandbox/mux.ts";
import { BoxTailnet, DNS_ADDR, downScript, GUARD, nameservers, question, resolvScript, servfail, upScript } from "../../src/node/sandbox/tailnet_box.ts";
import { leadChannel, type LeadSocketHooks } from "../../src/node/lead/index.ts";

const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-tailnet-box-"));
const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
  rmSync(root, { recursive: true, force: true });
});

const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([p, Bun.sleep(ms).then(() => Promise.reject(new Error(`timed out: ${what}`)))]);

/** A DNS query for `name` of type `type`, with id `id`. */
function query(name: string, type: number, id = 0x1234): Uint8Array {
  const parts = [Buffer.from([id >> 8, id & 255, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0])];
  for (const l of name.split(".")) parts.push(Buffer.from([l.length]), Buffer.from(l));
  parts.push(Buffer.from([0, type >> 8, type & 255, 0, 1]));
  return new Uint8Array(Buffer.concat(parts));
}

/** An answer to `q`: the query with QR set and one more byte, `mark`, to tell answers apart. */
const answer = (q: Uint8Array, mark: number) => {
  const a = Buffer.from(q);
  a[2] = 0x81;
  a[3] = 0x80;
  return new Uint8Array(Buffer.concat([a, Buffer.from([mark])]));
};

async function echoServer(host = "127.0.0.1"): Promise<number> {
  const s = createServer((c) => c.pipe(c));
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, host, () => r()));
  return (s.address() as { port: number }).port;
}

test("the tailnet's addresses and names: its ranges, MagicDNS names, its own suffix and reverse lookups", () => {
  for (const ip of ["100.64.0.1", "100.101.102.103", "100.127.255.254", "fd7a:115c:a1e0::1", "FD7A:115C:A1E0:ab12::5"]) expect(tailnetIp(ip)).toBe(true);
  for (const ip of ["100.63.255.255", "100.128.0.1", "10.0.0.1", "fd7a:115c:a1e1::1", "devbox"]) expect(tailnetIp(ip)).toBe(false);
  expect(tailnetName("devbox.tail1234.ts.net", undefined)).toBe(true);
  expect(tailnetName("devbox.tail1234.ts.net.", undefined)).toBe(true);
  expect(tailnetName("devbox.corp.example", "corp.example")).toBe(true);
  expect(tailnetName("49.249.104.100.in-addr.arpa", undefined)).toBe(true);
  expect(tailnetName("1.2.3.100.in-addr.arpa", undefined)).toBe(false);
  expect(tailnetName("1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.e.1.a.c.5.1.1.a.7.d.f.ip6.arpa", undefined)).toBe(true);
  for (const n of ["github.com", "api.anthropic.com", "ts.net.example.com", "devbox"]) expect(tailnetName(n, "tail1234.ts.net")).toBe(false);
});

test("the capture's root scripts run only in a fleetd box: the TUN and its routes, the resolver kept and given back", () => {
  const up = upScript();
  expect(up.split("\n")[0]).toBe(GUARD);
  expect(up).toContain("ip route replace 100.64.0.0/10 dev tailnet0");
  expect(up).toContain("ip -6 route replace fd7a:115c:a1e0::/48 dev tailnet0");
  expect(up).toContain("net.ipv4.ip_unprivileged_port_start=53");
  expect(up).toContain("/usr/local/bin/hev-socks5-tunnel");
  // Never a default route: public traffic stays on the box's own.
  expect(up).not.toMatch(/route (add|replace) default|0\.0\.0\.0\/0/u);
  expect(resolvScript("tail1234.ts.net").split("\n")[0]).toBe(GUARD);
  expect(resolvScript("tail1234.ts.net")).toContain(`echo "nameserver ${DNS_ADDR}"`);
  expect(resolvScript("tail1234.ts.net")).toContain('echo "search tail1234.ts.net $search"');
  expect(downScript().split("\n")[0]).toBe(GUARD);
  // systemd-resolved's stub stays one of the box's own nameservers; only the guest's own address is left out.
  expect(nameservers(`# x\nnameserver 8.8.8.8\nnameserver 127.0.0.53\nnameserver ${DNS_ADDR}\nnameserver fe80::1%eth0\nsearch a\n`)).toEqual(["8.8.8.8", "127.0.0.53", "fe80::1%eth0"]);
});

test("a DNS question is read as the box asked it, and a SERVFAIL keeps its id and question", () => {
  const q = query("Devbox.Tail1234.ts.net", 28, 0xbeef);
  expect(question(q)).toEqual({ name: "devbox.tail1234.ts.net", type: 28, end: q.length });
  expect(question(new Uint8Array(5))).toBeUndefined();
  const f = servfail(q);
  expect([f[0], f[1]]).toEqual([0xbe, 0xef]);
  expect(f[3]! & 0x0f).toBe(2);
  expect(Buffer.from(f.subarray(12)).equals(Buffer.from(q.subarray(12)))).toBe(true);
});

/** A BoxTailnet whose node is a stand-in: each connection goes to `to` (the gateway's side), each lookup is answered
 * with `answer(q, 7)`, and `dials` lists what it was asked. */
function standInNode(to: number | "refuse") {
  const dials: Target[] = [];
  let t!: BoxTailnet;
  let channel = 2;
  const open = (target: Target, local: Duplex): number => {
    dials.push(target);
    const ch = channel++;
    if ("tailnet" in target) {
      if (to === "refuse") queueMicrotask(() => t.dialed(ch, "connect ECONNREFUSED"));
      else {
        const conn = connect({ host: "127.0.0.1", port: to });
        conn.once("connect", () => {
          t.dialed(ch, undefined);
          local.pipe(conn).pipe(local);
        });
      }
    } else if ("tailnetDns" in target) {
      const q = query(target.tailnetDns.name, target.tailnetDns.type, 0);
      local.resume();
      queueMicrotask(() => local.end(Buffer.from(answer(q, 7))));
    }
    return ch;
  };
  return {
    dials,
    make(o: Partial<ConstructorParameters<typeof BoxTailnet>[0]>) {
      t = new BoxTailnet({ open, root: async () => ({ code: 0, out: "" }), noSystem: true, ...o });
      return t;
    },
  };
}

/** A SOCKS5 CONNECT to `host`:`port` through `socks`, as the TUN makes one: the reply code and the socket. */
async function socksConnect(socks: number, host: string, port: number): Promise<{ code: number; s: Socket }> {
  const s = connect({ host: "127.0.0.1", port: socks });
  await new Promise((r) => s.once("connect", r));
  const parts = host.split(".").map(Number);
  s.write(Buffer.from([5, 1, 0]));
  s.write(Buffer.from([5, 1, 0, 1, ...parts, port >> 8, port & 255]));
  const got = await new Promise<Buffer>((resolve) => {
    let buf = Buffer.alloc(0);
    const on = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= 12) (s.off("data", on), resolve(buf));
    };
    s.on("data", on);
  });
  return { code: got[3]!, s };
}

test("the guest's capture: each tailnet connection through the node, tailnet names to the gateway, the rest as before", async () => {
  const echo = await echoServer();
  // The box's own nameserver, which answers every other name.
  const upstream = createSocket("udp4");
  const asked: string[] = [];
  upstream.on("message", (m, from) => {
    asked.push(question(new Uint8Array(m))!.name);
    upstream.send(answer(new Uint8Array(m), 9), from.port, from.address);
  });
  await new Promise<void>((r) => upstream.bind(0, "127.0.0.9", () => r()));
  const upPort = upstream.address().port;
  const resolv = join(root, "resolv.conf");
  writeFileSync(resolv, "nameserver 127.0.0.9\nsearch corp.example\noptions edns0\n");
  const node = standInNode(echo);
  let scripts: string[] = [];
  // Ports the OS gives: none taken by anything else.
  const t = node.make({ socksPort: 0, dnsAddr: "127.0.0.8", dnsPort: 0, resolvConf: resolv, upstreamPort: upPort, root: async (s) => (scripts.push(s), Bun.spawnSync(["sh", "-c", s]).exitCode === 0 ? { code: 0, out: "" } : { code: 1, out: "failed" }) });
  expect(await t.set("tail1234.ts.net")).toBe("on (tail1234.ts.net)");
  const socksPort = t.socksPort!;
  const dnsPort = t.dnsPort!;
  // Only the resolver's script ran (no TUN here): the box's own kept beside it.
  expect(scripts).toHaveLength(1);
  expect(readFileSync(resolv, "utf8")).toContain("nameserver 127.0.0.8\nsearch tail1234.ts.net corp.example \noptions edns0");
  expect(readFileSync(`${resolv}.fleetd`, "utf8")).toBe("nameserver 127.0.0.9\nsearch corp.example\noptions edns0\n");

  // A connection, its bytes both ways, its target the node's to dial.
  const { code, s } = await socksConnect(socksPort, "100.101.102.103", 8317);
  expect(code).toBe(0);
  s.write("hello tailnet");
  const back = await within(new Promise<string>((r) => s.once("data", (d) => r(d.toString()))), 5_000, "the echo");
  expect(back).toBe("hello tailnet");
  s.destroy();
  expect(node.dials[0]).toEqual({ tailnet: { host: "100.101.102.103", port: 8317 } });

  // A tailnet name goes to the gateway (its answer with the box's own id); any other name to the box's nameserver.
  const ask = (name: string, id: number) =>
    new Promise<Uint8Array>((resolve) => {
      const c = createSocket("udp4");
      c.on("message", (m) => (c.close(), resolve(new Uint8Array(m))));
      c.send(query(name, 1, id), dnsPort, "127.0.0.8");
    });
  const ts = await within(ask("devbox.tail1234.ts.net", 0x4242), 5_000, "a tailnet answer");
  expect([ts[0], ts[1], ts.at(-1)]).toEqual([0x42, 0x42, 7]);
  expect(node.dials[1]).toEqual({ tailnetDns: { name: "devbox.tail1234.ts.net", type: 1 } });
  const pub = await within(ask("github.com", 0x5151), 5_000, "a public answer");
  expect([pub[0], pub[1], pub.at(-1)]).toEqual([0x51, 0x51, 9]);
  expect(asked).toEqual(["github.com"]);
  expect(node.dials).toHaveLength(2);
  // Over TCP too (a truncated answer's retry).
  const tcp = await within(
    new Promise<Uint8Array>((resolve) => {
      const c = connect({ host: "127.0.0.8", port: dnsPort }, () => {
        const q = query("devbox.tail1234.ts.net", 28, 0x0707);
        c.write(Buffer.concat([Buffer.from([q.length >> 8, q.length & 255]), q]));
      });
      c.on("data", (d) => (c.destroy(), resolve(new Uint8Array(d.subarray(2)))));
    }),
    5_000,
    "a TCP answer",
  );
  expect([tcp[0], tcp[1], tcp.at(-1)]).toEqual([7, 7, 7]);

  // Off: the box's own resolver back, nothing listening.
  scripts = [];
  expect(await t.set(null)).toBe("off");
  expect(readFileSync(resolv, "utf8")).toBe("nameserver 127.0.0.9\nsearch corp.example\noptions edns0\n");
  expect(existsSync(`${resolv}.fleetd`)).toBe(false);
  const refused = await new Promise<boolean>((r) => connect({ host: "127.0.0.1", port: socksPort }).once("error", () => r(true)).once("connect", () => r(false)));
  expect(refused).toBe(true);
  upstream.close();
}, 30_000);

test("a connection the node can't make is refused to the program in the box, in SOCKS's words", async () => {
  const node = standInNode("refuse");
  const resolv = join(root, "resolv2.conf");
  writeFileSync(resolv, "nameserver 127.0.0.9\n");
  const t = node.make({ socksPort: 0, dnsAddr: "127.0.0.10", dnsPort: 0, resolvConf: resolv });
  await t.set("");
  const socksPort = t.socksPort!;
  const { code, s } = await socksConnect(socksPort, "100.64.0.9", 22);
  expect(code).toBe(5);
  s.destroy();
  // A program in the box speaking SOCKS to the listener itself gets the tailnet and nothing else.
  const off = await socksConnect(socksPort, "127.0.0.1", 22);
  expect(off.code).toBe(2);
  off.s.destroy();
  expect(node.dials).toHaveLength(1);
  await t.set(null);
});

test("in a box that runs systemd-resolved (127.0.0.53 taken), the box's DNS listens at its own address and asks the stub", async () => {
  // systemd-resolved's stub, at 127.0.0.53: on a port of the OS's here, as at 53 in a box.
  const stub = createSocket("udp4");
  stub.on("message", (m, from) => stub.send(answer(new Uint8Array(m), 5), from.port, from.address));
  await new Promise<void>((r) => stub.bind(0, "127.0.0.53", () => r()));
  const port = stub.address().port;
  const resolv = join(root, "resolv-resolved.conf");
  writeFileSync(resolv, "# This is /run/systemd/resolve/stub-resolv.conf\nnameserver 127.0.0.53\noptions edns0 trust-ad\nsearch .\n");
  expect(DNS_ADDR).not.toMatch(/^127\.0\.0\.5[34]$/u);
  // The box's DNS on the stub's own port (53 in a box): taken at 127.0.0.53, free at the guest's address.
  // The resolver's own script runs (on a file of the test's, which no guard keeps from it).
  const asRoot = async (script: string) => (Bun.spawnSync(["sh", "-c", script]).exitCode === 0 ? { code: 0, out: "" } : { code: 1, out: "failed" });
  const t = standInNode(await echoServer()).make({ socksPort: 0, dnsPort: port, upstreamPort: port, resolvConf: resolv, root: asRoot });
  expect(await t.set("tail1234.ts.net")).toBe("on (tail1234.ts.net)");
  expect(t.dnsPort).toBe(port);
  expect(readFileSync(resolv, "utf8")).toContain(`nameserver ${DNS_ADDR}\n`);
  const got = await within(
    new Promise<Uint8Array>((resolve) => {
      const c = createSocket("udp4");
      c.on("message", (m) => (c.close(), resolve(new Uint8Array(m))));
      c.send(query("github.com", 1, 0x3131), port, DNS_ADDR);
    }),
    5_000,
    "the stub's answer",
  );
  expect([got[0], got[1], got.at(-1)]).toEqual([0x31, 0x31, 5]);
  await t.set(null);
  expect(readFileSync(resolv, "utf8")).toContain("nameserver 127.0.0.53\n");
  stub.close();
});

test("a DNS address already taken fails the switch on in plain words, and leaves nothing listening", async () => {
  const taken = createSocket("udp4");
  await new Promise<void>((r) => taken.bind(0, "127.0.0.11", () => r()));
  const port = taken.address().port;
  const resolv = join(root, "resolv-taken.conf");
  writeFileSync(resolv, "nameserver 127.0.0.9\n");
  const t = standInNode(await echoServer()).make({ socksPort: 0, dnsAddr: "127.0.0.11", dnsPort: port, resolvConf: resolv });
  await expect(t.set("tail1234.ts.net")).rejects.toThrow(`the box's DNS couldn't listen at 127.0.0.11:${port}`);
  taken.close();
  // Its UDP socket was let go: the address binds again.
  const again = createSocket("udp4");
  await new Promise<void>((r, j) => (again.once("error", j), again.bind(port, "127.0.0.11", () => r())));
  again.close();
});

let played = 0;
/** The node's Box against a guest the test plays: a Mux on the other end of a unix socket. */
async function boxWithPlayedGuest(hooks?: { dial: (h: string, p: number) => Promise<Duplex>; dns: (n: string, t: number) => Promise<Uint8Array> }) {
  const sock = join(root, `played-${++played}.sock`);
  const words: Record<string, unknown>[] = [];
  const asked: Record<string, unknown>[] = [];
  let guest!: Mux;
  const ready = new Promise<void>((resolve) => {
    const server = createServer((s) => {
      guest = new Mux(s, {
        control: (m) => {
          if (m.op === "tailnetDialed") return void words.push(m);
          asked.push(m);
          guest.control({ id: m.id, ok: m.op === "tailnet" ? `on (${String(m.suffix)})` : null });
        },
        open: () => undefined,
        closed: () => {},
      });
      guest.control({ op: "hello", protocol: GUEST_PROTOCOL, host: null });
      resolve();
    });
    servers.push(server);
    server.listen(sock);
  });
  const box = await Box.open({
    session: "s-tail",
    dial: () => new Promise<Duplex>((r) => {
      const c: Socket = connect(sock, () => r(c));
    }),
    nodeSock: join(root, `never-${played}.sock`),
    tcp: [],
    lead: (s) => leadChannel(s, {} as LeadSocketHooks),
    ...(hooks ? { tailnet: hooks } : {}),
  });
  await ready;
  return { box, guest, words, asked };
}

test("the node's Box carries the guest's tailnet connections and lookups to the gateway, and tells the guest how each dial went", async () => {
  const echo = await echoServer();
  const dialled: string[] = [];
  const { box, guest, words, asked } = await boxWithPlayedGuest({
    dial: async (h, p) => {
      dialled.push(`${h}:${p}`);
      if (h === "100.64.0.9") throw new Error("connect ECONNREFUSED 100.64.0.9:22");
      return connect({ host: "127.0.0.1", port: echo });
    },
    dns: async (n, t) => new Uint8Array(Buffer.from(`${n}/${t}`)),
  });
  expect(await box.tailnet("tail1234.ts.net")).toBe("on (tail1234.ts.net)");
  expect(asked.find((m) => m.op === "tailnet")).toMatchObject({ op: "tailnet", suffix: "tail1234.ts.net" });

  const conn = new PassThrough();
  const got: Buffer[] = [];
  const end = new Duplex({
    read() {},
    write(chunk, _e, cb) {
      got.push(chunk as Buffer);
      cb();
    },
  });
  guest.open(5, { tailnet: { host: "100.101.102.103", port: 8317 } }, end);
  await within(
    (async () => {
      while (!words.some((w) => w.channel === 5)) await Bun.sleep(10);
    })(),
    5_000,
    "the word",
  );
  expect(words.find((w) => w.channel === 5)).toEqual({ op: "tailnetDialed", channel: 5 });
  end.push(Buffer.from("ping"));
  await within(
    (async () => {
      while (Buffer.concat(got).toString() !== "ping") await Bun.sleep(10);
    })(),
    5_000,
    "the echo",
  );
  conn.destroy();

  guest.open(6, { tailnet: { host: "100.64.0.9", port: 22 } }, new PassThrough());
  await within(
    (async () => {
      while (!words.some((w) => w.channel === 6)) await Bun.sleep(10);
    })(),
    5_000,
    "the refusal",
  );
  expect(words.find((w) => w.channel === 6)).toEqual({ op: "tailnetDialed", channel: 6, error: "connect ECONNREFUSED 100.64.0.9:22" });
  expect(dialled).toEqual(["100.101.102.103:8317", "100.64.0.9:22"]);

  const dnsEnd = new PassThrough();
  const answered = new Promise<string>((resolve) => {
    const parts: Buffer[] = [];
    dnsEnd.on("data", (d: Buffer) => parts.push(d));
    dnsEnd.on("end", () => resolve(Buffer.concat(parts).toString()));
  });
  guest.open(7, { tailnetDns: { name: "devbox.tail1234.ts.net", type: 28 } }, dnsEnd);
  expect(await within(answered, 5_000, "the lookup")).toBe("devbox.tail1234.ts.net/28");
  box.close();
}, 20_000);

test("a box without the tailnet's hooks (a local VM's) opens no tailnet channel", async () => {
  const { box, guest } = await boxWithPlayedGuest();
  const end = new PassThrough();
  const ended = new Promise<void>((r) => end.once("finish", () => r()));
  end.resume();
  guest.open(5, { tailnet: { host: "100.101.102.103", port: 8317 } }, end);
  await within(ended, 5_000, "the refusal");
  box.close();
});
