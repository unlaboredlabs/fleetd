// The tunnel end to end on this machine (crates/fleetd/src/hub/pool/tunnel_tests.rs): a local ssh2 server stands in for
// a cloud machine's sshd, a fake boat names it and its host key, and a local "hub" answers what comes through the
// reverse forward. Nothing reaches boat.dev.
import { afterAll, expect, test } from "bun:test";
import { createServer, type Server as TcpServer } from "node:net";
import { Server, utils } from "ssh2";
import type { Boat, Sandbox, SshAccess } from "../src/hub/pool/boat.ts";
import { keyOf, MACHINE_PORT, publicLine, SshTunnels } from "../src/hub/pool/tunnel.ts";

const hostKey = utils.generateKeyPairSync("ed25519");
const otherHostKey = utils.generateKeyPairSync("ed25519");
const hubKey = keyOf(new Uint8Array(32).fill(7));

/** The hub: answers "hub" to every connection. */
const hub: TcpServer = createServer((s) => s.end("hub"));
await new Promise<void>((r) => hub.listen(0, "127.0.0.1", r));
const hubPort = (hub.address() as { port: number }).port;

const forwards: string[] = [];
let authed: string[] = [];
let sshd: Server;
const sshdPort = await new Promise<number>((resolve) => {
  sshd = new Server({ hostKeys: [hostKey.private] }, (client) => {
    client.on("error", () => {});
    client.on("authentication", (ctx) => {
      const ok = ctx.method === "publickey" && ctx.key.algo === "ssh-ed25519" && Buffer.compare(ctx.key.data, Buffer.from(publicLine(hubKey).split(" ")[1]!, "base64")) === 0;
      // ssh2 asks whether the key would do before it signs: only the signed attempt is a sign-in.
      if (ok && (ctx as { signature?: Buffer }).signature) authed.push(ctx.username);
      ok ? ctx.accept() : ctx.reject(["publickey"]);
    });
    client.on("ready", () => {
      client.on("request", (accept, reject, name, info) => {
        if (name !== "tcpip-forward") return reject?.();
        forwards.push(`${(info as { bindAddr: string }).bindAddr}:${(info as { bindPort: number }).bindPort}`);
        accept?.();
        // A connection on the machine's 47900 comes through to the hub.
        client.forwardOut("127.0.0.1", MACHINE_PORT, "127.0.0.1", 55555, (err, ch) => {
          if (err) return;
          let got = "";
          ch.on("data", (d: Buffer) => (got += d.toString()));
          ch.on("close", () => results.push(got));
          ch.end();
        });
      });
    });
  });
  sshd.listen(0, "127.0.0.1", () => resolve((sshd.address() as { port: number }).port));
});
const results: string[] = [];

afterAll(() => {
  sshd.close();
  hub.close();
});

function fakeBoat(named: string): Boat {
  const access: SshAccess = { sshEndpoint: `127.0.0.1:${sshdPort}`, sshUser: "user", hostKey: named };
  const sb: Sandbox = { id: "bx_1", state: "running", labels: {}, sshEndpoint: `127.0.0.1:${sshdPort}` };
  return {
    sshKey: async () => access,
    get: async () => sb,
  } as unknown as Boat;
}

async function until(f: () => boolean, ms = 3000) {
  for (let i = 0; i < ms / 10 && !f(); i++) await Bun.sleep(10);
}

test("the tunnel signs in with the hub's in-memory key, pins the host key and carries the forward to the hub", async () => {
  const t = new SshTunnels(fakeBoat(hostKey.public), () => hubKey, ["127.0.0.1", hubPort], { shortest: 50, longest: 200, keepalive: 1000 });
  t.open("boat-1", "bx_1");
  expect(t.status("boat-1")).toEqual({ down: "opening" });
  await until(() => results.length > 0);
  expect(t.status("boat-1")).toEqual({ up: true });
  expect(authed).toEqual(["user"]);
  expect(forwards).toEqual([`127.0.0.1:${MACHINE_PORT}`]);
  expect(results).toEqual(["hub"]);
  t.close("boat-1");
  expect(t.status("boat-1")).toBeUndefined();
});

test("a server showing another host key is refused, and one boat names none for is never dialled", async () => {
  authed = [];
  const wrong = new SshTunnels(fakeBoat(otherHostKey.public), () => hubKey, ["127.0.0.1", hubPort], { shortest: 50, longest: 200, keepalive: 1000 });
  wrong.open("boat-2", "bx_1");
  await until(() => "down" in (wrong.status("boat-2") ?? {}) && (wrong.status("boat-2") as { down: string }).down !== "opening");
  expect((wrong.status("boat-2") as { down: string }).down).toBe(`its SSH server at 127.0.0.1:${sshdPort} showed a host key other than the one pinned: refused`);
  expect(authed).toEqual([]);
  wrong.close("boat-2");
  const none = new SshTunnels(fakeBoat(""), () => hubKey, ["127.0.0.1", hubPort], { shortest: 50, longest: 200, keepalive: 1000 });
  none.open("boat-3", "bx_1");
  await until(() => (none.status("boat-3") as { down?: string })?.down !== "opening");
  expect(none.status("boat-3")).toEqual({ down: "boat.dev named no host key for its SSH server: not dialled" });
  none.close("boat-3");
});

test("the hub's public key line is OpenSSH's, made from its seed", () => {
  const line = publicLine(hubKey);
  expect(line).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43} fleetd-hub$/);
  const parsed = utils.parseKey(hubKey.openssh);
  expect(parsed instanceof Error).toBe(false);
  expect((parsed as { type: string }).type).toBe("ssh-ed25519");
});
