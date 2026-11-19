// A stand-in for Tailscale's own programs as the hub's gateway runs them (src/hub/tailnet/local.ts), so its tests need
// no Tailscale and reach no tailnet:
// - `daemon` (tailscaled): serves the local API on its --socket: status (logged in once its --state file says
//   `approved`, which is what a test writes for "the person approved it"; a sign-in page once `up` asked for one; its
//   own addresses and its peers), a dial (to 127.0.0.1 at the port asked, whatever the address, and refused for
//   100.64.0.9), and a DNS query (answered `<name>/<type>`).
// - `cli` (tailscale): `up` asks for a sign-in page and waits until it's approved; `logout` forgets the state and
//   leaves a mark in the test's dir.
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { dirname, join } from "node:path";

export const LOGIN_URL = "https://login.tailscale.com/a/standin";
/** The gateway's own addresses on the stand-in's tailnet. Its peers: devbox (100.104.249.49, fd7a:115c:a1e0::1) and
 * sshbox (100.64.0.9, whose dial tailscaled refuses). A dial to any address goes to 127.0.0.1 at its port, as a
 * userspace tailscaled's dial to its own address does: what the gateway must never let through. */
export const SELF_IPS = ["100.70.0.1", "fd7a:115c:a1e0::70"];

/** The stand-in's two programs, written into `dir`; `marks` is where `logout` leaves its mark. */
export function standInPrograms(dir: string, marks: string): { tailscale: string; tailscaled: string } {
  const me = import.meta.path;
  const out = { tailscale: join(dir, "tailscale"), tailscaled: join(dir, "tailscaled") };
  writeFileSync(out.tailscaled, `#!/bin/sh\nexec ${process.execPath} ${me} daemon "$@"\n`);
  writeFileSync(out.tailscale, `#!/bin/sh\nexec ${process.execPath} ${me} cli ${marks} "$@"\n`);
  for (const p of Object.values(out)) chmodSync(p, 0o755);
  return out;
}

const flag = (args: string[], name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

function daemon(args: string[]): void {
  const sock = flag(args, "socket")!;
  const state = flag(args, "state")!;
  const run = dirname(sock);
  const approved = () => existsSync(state) && readFileSync(state, "utf8").startsWith("approved");
  const status = () =>
    approved()
      ? {
          BackendState: "Running",
          CurrentTailnet: { Name: "example.com", MagicDNSSuffix: "tail1234.ts.net" },
          Self: { DNSName: "fleetd.tail1234.ts.net.", HostName: "fleetd", TailscaleIPs: SELF_IPS },
          Peer: {
            devbox: { DNSName: "devbox.tail1234.ts.net.", HostName: "devbox", TailscaleIPs: ["100.104.249.49", "fd7a:115c:a1e0::1"] },
            sshbox: { DNSName: "sshbox.tail1234.ts.net.", HostName: "sshbox", TailscaleIPs: ["100.64.0.9"] },
          },
        }
      : existsSync(join(run, "login"))
        ? { BackendState: "NeedsLogin", AuthURL: LOGIN_URL }
        : { BackendState: "NeedsLogin" };
  const reply = (c: Socket, code: number, body: string, type = "application/json") =>
    c.end(`HTTP/1.1 ${code} X\r\nContent-Type: ${type}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  createServer((c) => {
    let buf = Buffer.alloc(0);
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      c.off("data", onData);
      const [line, ...rest] = buf.subarray(0, end).toString().split("\r\n");
      const headers = Object.fromEntries(rest.map((h) => [h.slice(0, h.indexOf(":")).toLowerCase(), h.slice(h.indexOf(":") + 1).trim()]));
      const url = new URL(`http://x${line!.split(" ")[1]}`);
      if (url.pathname === "/localapi/v0/status") return reply(c, 200, JSON.stringify(status()));
      if (url.pathname === "/localapi/v0/dns-query") {
        if (!approved()) return reply(c, 503, "not running", "text/plain");
        return reply(c, 200, JSON.stringify({ Bytes: Buffer.from(`${url.searchParams.get("name")}/${url.searchParams.get("type")}`).toString("base64") }));
      }
      if (url.pathname === "/localapi/v0/dial") {
        const host = headers["dial-host"];
        const port = Number(headers["dial-port"]);
        if (host === "100.64.0.9") return reply(c, 502, "dial tcp 100.64.0.9:22: connection refused", "text/plain");
        const up = connect({ host: "127.0.0.1", port }, () => {
          c.write("HTTP/1.1 101 Switching Protocols\r\nConnection: upgrade\r\nUpgrade: ts-dial\r\n\r\n");
          const more = buf.subarray(end + 4);
          if (more.length) up.write(more);
          c.pipe(up).pipe(c);
        });
        up.on("error", () => reply(c, 502, "dial failed", "text/plain"));
        return;
      }
      reply(c, 404, "no such path", "text/plain");
    };
    c.on("data", onData);
    c.on("error", () => {});
  }).listen(sock);
}

async function cli(marks: string, args: string[]): Promise<void> {
  const sock = flag(args, "socket")!;
  const run = dirname(sock);
  const verb = args.find((a) => !a.startsWith("--"));
  if (verb === "up") {
    writeFileSync(join(run, "login"), "");
    writeFileSync(join(marks, "up-args"), JSON.stringify(args));
    for (;;) {
      await Bun.sleep(30);
      if (existsSync(join(run, "tailscaled.state")) && readFileSync(join(run, "tailscaled.state"), "utf8").startsWith("approved")) process.exit(0);
    }
  }
  if (verb === "logout") {
    rmSync(join(run, "tailscaled.state"), { force: true });
    writeFileSync(join(marks, "logged-out"), "");
    process.exit(0);
  }
  process.exit(2);
}

if (import.meta.main) {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === "daemon") daemon(rest);
  else if (mode === "cli") await cli(rest[0]!, rest.slice(1));
}
