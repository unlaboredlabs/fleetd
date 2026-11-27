// `fleetd uninstall` on a machine with a node (W890): it said it was done while the node, and the bot lead's claude
// under it, kept running from a deleted binary. And a hub whose port something else took was told to move to
// 127.0.0.1, out of its devices' reach. A scratch home and fleetd dir; PATH holds only stand-ins, so no command can
// reach this machine's own systemd.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hubAction } from "../../src/cli/setup/index.ts";

const MAIN = join(import.meta.dir, "../../src/main.ts");
const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-uninstall-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
/** A machine: its home, a fleetd dir of its own (so nothing is shared with this machine's ~/.fleetd), and a PATH of
 * stand-ins that write down how they were called. */
function machine() {
  const home = join(dir, `m${++n}`);
  const fleetd = join(home, "fleet");
  const bin = join(home, "stand-ins");
  mkdirSync(bin, { recursive: true });
  const calls = join(home, "calls");
  for (const tool of ["systemctl", "launchctl"]) {
    writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> "${calls}"\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  for (const tool of ["rm", "rmdir"]) symlinkSync(Bun.which(tool)!, join(bin, tool));
  const env = { PATH: bin, HOME: home, FLEETD_HOME: fleetd, XDG_CONFIG_HOME: join(home, ".config"), NO_COLOR: "1" };
  const run = async (...argv: string[]) => {
    const proc = Bun.spawn([process.execPath, MAIN, ...argv], { env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, said: stdout + stderr };
  };
  const called = () => (existsSync(calls) ? readFileSync(calls, "utf8") : "");
  return { home, fleetd, run, called };
}

const unitFor = (m: ReturnType<typeof machine>) =>
  process.platform === "darwin" ? join(m.home, "Library/LaunchAgents/sh.fleetd.node.plist") : join(m.home, ".config/systemd/user/fleetd-node.service");

/** What `machine add` or `init --join` leaves: the node's unit, its settings, a session host's dir and the binary,
 * here one that writes down that it was asked to stop the agents. */
function joined(m: ReturnType<typeof machine>) {
  const node = join(m.fleetd, "node");
  mkdirSync(join(node, "hosts/s1"), { recursive: true });
  writeFileSync(join(node, "node.json"), JSON.stringify({ hub: "http://hub.example:4790", machineId: "vps1", enrolled: true }));
  mkdirSync(join(m.fleetd, "bin"), { recursive: true });
  writeFileSync(join(m.fleetd, "bin/fleetd"), `#!/bin/sh\necho "fleetd $*" >> "${join(m.home, "calls")}"\necho "stopped 1 agent session(s)"\n`);
  chmodSync(join(m.fleetd, "bin/fleetd"), 0o755);
  mkdirSync(join(unitFor(m), ".."), { recursive: true });
  writeFileSync(unitFor(m), `[Service]\nExecStart=${m.fleetd}/bin/fleetd node run --home ${node}\n`);
}

test.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
  "uninstall stops and removes this machine's node and the agents it left running",
  async () => {
    const m = machine();
    joined(m);
    const out = await m.run("uninstall");
    expect(out.code, out.said).toBe(0);
    expect(existsSync(unitFor(m)), "the node's unit is gone").toBe(false);
    const called = m.called();
    if (process.platform === "linux") expect(called).toContain("systemctl --user disable --now fleetd-node.service");
    else expect(called).toContain("launchctl bootout --wait");
    expect(called).toContain(`fleetd session-host stop-all ${join(m.fleetd, "node/hosts")}`);
    expect(out.said).toContain("stop and remove the node service");
    expect(out.said).toContain("stopped 1 agent session(s)");
    // A worker that joined by itself: the hub elsewhere still lists it.
    expect(out.said).toContain("the workspace at http://hub.example:4790 still lists vps1");
    expect(out.said).toContain(`kept the node's files in ${join(m.fleetd, "node")}; --purge deletes them`);
    // No hub here: nothing about a hub's data.
    expect(out.said).not.toContain("workspace's data");

    // --purge on a machine with no hub deletes the node's files, and isn't refused for the hub it never had.
    joined(m);
    const purged = await m.run("uninstall", "--purge");
    expect(purged.code, purged.said).toBe(0);
    expect(existsSync(join(m.fleetd, "node")), purged.said).toBe(false);
  },
  30_000,
);

test("uninstall leaves another fleet's node alone", async () => {
  const m = machine();
  joined(m);
  writeFileSync(unitFor(m), "[Service]\nExecStart=/somewhere/else/fleetd node run --home /somewhere/else/node\n");
  const out = await m.run("uninstall");
  expect(out.code, out.said).toBe(0);
  expect(existsSync(unitFor(m))).toBe(true);
  expect(out.said).toContain("it runs another fleet's node");
  expect(m.called()).not.toContain("stop-all");
});

// The hub's port taken by another program: the fix keeps the hub's address (a LAN or tailnet one stays reachable) and
// says what holds it. It was "fleetd init --listen 127.0.0.1:4791" whatever the address.
test("a taken port's fix keeps the workspace's own address", () => {
  const busy = hubAction(true, "same", [], "other", "172.17.0.4:4790", "/h");
  expect(typeof busy).toBe("object");
  const f = busy as { message: string; fix: string };
  expect(f.message).toBe("172.17.0.4:4790 is in use by something else");
  expect(f.fix).not.toContain("127.0.0.1");
  expect(f.fix).toContain("fleetd init --listen 172.17.0.4:<free port>");
  expect(f.fix).toContain("starts again by itself");
  const named = hubAction(false, "missing", [], "other", "172.17.0.4:4790", "/h", { by: "nginx (pid 812)", move: "fleetd init --listen 172.17.0.4:4791" });
  expect((named as { message: string }).message).toBe("172.17.0.4:4790 is in use by something else: nginx (pid 812)");
  // With --no-service there is no service to start again by itself, and the move keeps --no-service.
  expect((named as { fix: string }).fix).toBe(
    "stop it, then run fleetd init --no-service again; or move the workspace to another port on the same address: fleetd init --listen 172.17.0.4:4791 --no-service (paired devices then reach it there)",
  );
  // This hub's own service, starting again every 5 s, may hold its database just as init looks: a program seen on
  // the port is still what's in the way.
  const restarting = hubAction(true, "same", [4242], "other", "172.17.0.4:4790", "/h", { by: "nc (pid 9)" });
  expect((restarting as { message: string }).message).toBe("172.17.0.4:4790 is in use by something else: nc (pid 9)");
});

test.skipIf(process.platform !== "linux")("init names the program on the workspace's port and a free port beside it", async () => {
  const m = machine();
  // 127.0.0.2: any address but 127.0.0.1, as a LAN hub's is.
  const server = Bun.serve({ hostname: "127.0.0.2", port: 0, fetch: () => new Response("not a workspace") });
  try {
    const out = await m.run("init", "--no-service", "--listen", `127.0.0.2:${server.port}`);
    expect(out.code, out.said).toBe(1);
    expect(out.said).toContain(`127.0.0.2:${server.port} is in use by something else: `);
    expect(out.said).toContain(`(pid ${process.pid})`);
    expect(out.said).toMatch(new RegExp(`fleetd init --listen 127\\.0\\.0\\.2:\\d+ --url http://127\\.0\\.0\\.2:\\d+ --no-service \\(paired`));
    expect(out.said).not.toContain("127.0.0.1:4791");
  } finally {
    server.stop(true);
  }
}, 30_000);
