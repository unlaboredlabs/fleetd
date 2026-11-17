// The `microvm` place (src/node/place/microvm.ts) against a stand-in box, so it runs without KVM: the "VM" is a child
// process running `fleetd sandbox-guest` (FLEETD_GUEST_ONCE, as a VM's init starts it) in a group it leads, dialled on
// a unix socket. What it covers: which sessions get a box and why a machine falls back to plain processes, setup
// booting the box and the start reusing it, the session's recorded pid being the box's (never 0), node.sock calls
// acting as the box's session, a node restart re-adopting the box, the box going with its session host, and stop,
// end, the start-up sweep and `stop-all` leaving no process of it behind.
import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import { sendToNode } from "../../src/cli/agent_mcp/socket.ts";
import { LeadRelay, leadSocketPath, type LeadSocketHooks } from "../../src/node/lead/index.ts";
import { Masker } from "../../src/node/mask.ts";
import { boxAlive, boxFile, readBox } from "../../src/node/place/box_record.ts";
import { pick, placeAt, useVm } from "../../src/node/place/index.ts";
import { forwards, gitInBox, kernelCmdline, launcherScript, MicroVm, reportVm, type BootPlan, type Booted } from "../../src/node/place/microvm.ts";
import { processPlace } from "../../src/node/place/process.ts";
import { marker, readRegistration, startOf, sweep, type HostLink, type RunnerEvent } from "../../src/node/runner/host.ts";
import { withSandbox } from "../../src/hub/slots/index.ts";
import type { VmCheck } from "../../src/sandbox/host/capable.ts";
import type { VmTools } from "../../src/sandbox/host/tools.ts";
import type { NodeFrame } from "../../src/node/wire.ts";
import type { NodeLoad } from "../../src/shared/node_link.ts";
import { imageEnv } from "../../src/node/sandbox/guest.ts";
import { shows } from "../../src/node/place/view.ts";

const MAIN = join(import.meta.dir, "../../src/main.ts");
const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-vm-"));
const leaders: number[] = [];
afterAll(() => {
  // Only the stand-ins this file started, by the groups they lead.
  for (const pid of leaders) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }
  rmSync(root, { recursive: true, force: true });
});

const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([p, Bun.sleep(ms).then(() => Promise.reject(new Error(`timed out: ${what}`)))]);

const OK: VmCheck = { ok: true, kvm: "direct", dns: ["192.0.2.53"], tools: "ready" };
const TOOLS: VmTools = { cloudHypervisor: "/vm/ch", chRemote: "/vm/ch-remote", kernel: "/vm/vmlinux", virtiofsd: "/vm/virtiofsd", passt: "/vm/passt", root: "/vm/root.ext4" };

/** The stand-in VM: sandbox-guest in a group it leads, its listen socket in the box's dir. */
async function standInBoot(b: BootPlan): Promise<Booted> {
  // A VM's node.sock is in its own view and goes with it; a stand-in's is on this machine's disk.
  rmSync(join(dirname(dirname(b.dir)), "node.sock"), { force: true });
  const child = spawn(process.execPath, [MAIN, "sandbox-guest", "--listen", join(b.dir, "link.sock"), "--dir", join(b.dir, "guest"), "--loopback", "127.0.0.2"], {
    cwd: b.dir,
    env: { ...process.env, FLEETD_GUEST_ONCE: "1" },
    stdio: ["ignore", "ignore", "inherit"],
    detached: true,
  });
  child.unref();
  leaders.push(child.pid!);
  return { leader: { pid: child.pid!, start: startOf(child.pid!)! }, helpers: [] };
}

const unixDial = (dir: string): Promise<Duplex> =>
  new Promise((resolve, reject) => {
    const s = connect(join(dir, "link.sock"));
    s.once("connect", () => resolve(s)).once("error", reject);
  });

/** Hooks whose hub answers each call with the session it was made as. */
function leadHooks(): LeadSocketHooks {
  const relay = new LeadRelay();
  relay.attach((frame: NodeFrame) => {
    const f = frame as unknown as { id: string; threadId?: string; call: { op: string } };
    queueMicrotask(() => relay.resolve({ id: f.id, result: { op: f.call.op, as: f.threadId ?? null } }));
  }, []);
  return { relay, identify: () => ({ kind: "outside" }), maskFor: () => new Masker() };
}

let made = 0;
function node(o: { check?: VmCheck; tools?: VmTools | undefined; fleetd?: string[]; fetch?: () => Promise<unknown>; config?: Record<string, unknown> } = {}) {
  const home = join(root, `n${++made}`);
  mkdirSync(join(home, "hosts"), { recursive: true });
  if (o.config) writeFileSync(join(home, "node.json"), JSON.stringify({ hub: "http://hub", machineId: "m", name: "m", enrolled: true, ...o.config }));
  const hooks = leadHooks();
  const make = () =>
    new MicroVm({
      home,
      fleetd: o.fleetd ?? ["/opt/fleetd"],
      lead: () => hooks,
      check: () => o.check ?? OK,
      tools: () => ("tools" in o ? o.tools : TOOLS),
      ...(o.fetch ? { fetch: o.fetch } : {}),
      boot: standInBoot,
      dial: unixDial,
      hidden: [home],
      userHome: root,
      goneMs: 1_000,
    });
  const cwd = join(home, "wt");
  mkdirSync(cwd, { recursive: true });
  return { home, vm: make(), make, cwd };
}

/** Says m0, then one init per line on its stdin: r1, r2, … */
const ECHO_CLAUDE = `#!/bin/sh
init() { echo "{\\"type\\":\\"system\\",\\"subtype\\":\\"init\\",\\"claude_code_version\\":\\"2.1.302\\",\\"model\\":\\"$1\\",\\"cwd\\":\\"/fake\\"}"; }
init m0
n=0
while read line; do n=$((n+1)); init "r$n"; done
`;

function program(name: string, script: string): string {
  const path = join(root, name);
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

async function inits(link: HostLink, n: number): Promise<string[]> {
  const models: string[] = [];
  while (models.length < n) {
    const event = (await within(link.next(), 10_000, "an event")) as Record<string, any> | undefined;
    expect(event).toBeDefined();
    if (typeof event === "object" && "Init" in event!) models.push(event.Init.model);
    link.applied++;
  }
  return models;
}

const launch = (home: string, id: string, cwd: string, claude: string) => ({
  // What a plain process's host runs (a box's runs the guest's own fleetd).
  fleetd: [process.execPath, MAIN],
  dir: join(home, "hosts", id),
  sessionId: id,
  program: claude,
  args: [],
  cwd,
  env: { ...envOf(home), FLEETD_RUNNER_SESSION: marker(id) },
});

/** What a session's commands run with: its scratch dir is in the node's (hidden) home, so the box shares it back. */
function envOf(home: string): Record<string, string> {
  const scratch = join(home, "tmp", "scratch");
  mkdirSync(scratch, { recursive: true });
  return { PATH: process.env.PATH!, HOME: root, TMPDIR: scratch };
}

const gone = async (pid: number, ms = 5_000) => {
  for (const until = Date.now() + ms; Date.now() < until; await Bun.sleep(20)) if (startOf(pid) === undefined) return true;
  return false;
};

test("a task's agent gets a box where the machine can run one; a lead, and every session of a machine that can't, a process", () => {
  const n = node();
  useVm(n.vm);
  try {
    const dir = join(n.home, "hosts", "s");
    expect(pick({ sessionId: "s", dir, role: "worker" }).kind).toBe("microvm");
    expect(pick({ sessionId: "s", dir, role: "lead" })).toBe(processPlace);
    expect(pick()).toBe(processPlace);
    // What a session left: a box is found by its record, anything else is a process.
    expect(placeAt(dir)).toBe(processPlace);
    mkdirSync(dir, { recursive: true });
    writeFileSync(boxFile(dir), JSON.stringify({ kind: "microvm", leader: { pid: 1, start: 1 }, helpers: [], tcp: [], port: 5000 }));
    expect(placeAt(dir).kind).toBe("microvm");
    const off = node({ config: { sandbox: "process" } });
    useVm(off.vm);
    expect(pick({ sessionId: "s", dir, role: "worker" })).toBe(processPlace);
  } finally {
    useVm(undefined);
  }
});

test("a machine that can't run VMs says why, in plain words, and fetches the VM files once while it waits", async () => {
  expect(node({ config: { sandbox: "process" } }).vm.status()).toEqual({ kind: "process", why: `turned off on this machine (node.json "sandbox": "process")` });
  expect(node({ fleetd: ["/usr/bin/bun", "/src/main.ts"] }).vm.status().kind).toBe("process");
  const noKvm = node({ check: { ok: false, why: "This user can't open /dev/kvm.", fix: "sudo usermod -aG kvm $USER" } });
  expect(noKvm.vm.status()).toEqual({ kind: "process", why: "This user can't open /dev/kvm. Fix: sudo usermod -aG kvm $USER" });
  let fetches = 0;
  let done!: () => void;
  const fetching = node({ tools: undefined, fetch: () => (fetches++, new Promise<void>((r) => (done = r))) });
  expect(fetching.vm.status(0).kind).toBe("process");
  expect(fetching.vm.status(70_000)).toMatchObject({ kind: "process", why: expect.stringContaining("fetching the VM files") });
  expect(fetches).toBe(1);
  done();
  // A heartbeat sizes the cap on the box's memory only when agents run in VMs, and says why when they don't.
  const load: Pick<NodeLoad, "memPerAgentBytes" | "sandbox"> = {};
  reportVm(load, { kind: "microvm" });
  expect(load).toEqual({ sandbox: { kind: "microvm" }, memPerAgentBytes: Math.round(4.1 * 2 ** 30) });
  const plain: Pick<NodeLoad, "memPerAgentBytes" | "sandbox"> = {};
  reportVm(plain, { kind: "process", why: "no KVM" });
  expect(plain).toEqual({ sandbox: { kind: "process", why: "no KVM" } });
  expect(withSandbox({ cap: 10, why: "memory 60 GB, about 4.4 GB an agent" }, { kind: "microvm" }).why).toBe("memory 60 GB, about 4.4 GB an agent; each agent in a VM of its own");
  expect(withSandbox({ cap: 22, why: "memory 60 GB, about 2 GB an agent" }, { kind: "process", why: "no KVM" }).why).toBe("memory 60 GB, about 2 GB an agent; agents run as plain processes: no KVM");
  expect(withSandbox({ cap: 22, why: "x" }, undefined).why).toBe("x");
});

test("setup boots the box and runs in it; the start reuses that box, and the session's pid is the box's", async () => {
  const n = node();
  const dir = join(n.home, "hosts", "s-setup");
  const place = n.vm.bound({ sessionId: "s-setup", dir, role: "worker" });
  const ran = await place.run({ cwd: n.cwd, argv: ["sh", "-c", "echo set up > setup.txt; echo $TOKEN; echo $GIT_CONFIG_VALUE_1"], timeoutSec: 10, env: { ...envOf(n.home), TOKEN: "s3cret" }, scrub: ["s3cret"] });
  expect(ran).toMatchObject({ exitCode: 0, timedOut: false });
  expect(ran.outputTail).toBe("[secret]\n!gh auth git-credential\n");
  expect(readFileSync(join(n.cwd, "setup.txt"), "utf8")).toBe("set up\n");
  const box = readBox(dir)!;
  expect(box.leader.pid).toBeGreaterThan(1);
  // A command killed at its limit, and one the node cancels.
  expect((await place.run({ cwd: n.cwd, argv: ["sh", "-c", "sleep 5"], timeoutSec: 0.3, env: envOf(n.home) })).timedOut).toBe(true);
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 200);
  const cancelled = await place.run({ cwd: n.cwd, argv: ["sh", "-c", "sleep 5"], timeoutSec: 30, env: envOf(n.home), signal: abort.signal });
  expect(cancelled.exitCode).toBeNull();
  expect(readBox(dir)!.leader).toEqual(box.leader);

  const link = await place.start(launch(n.home, "s-setup", n.cwd, program("claude-setup", ECHO_CLAUDE)));
  expect(readBox(dir)!.leader).toEqual(box.leader);
  expect(link.pid).toBe(box.leader.pid);
  expect(readRegistration(dir)).toMatchObject({ pid: box.leader.pid, hostPid: box.leader.pid, start: box.leader.start });
  expect(await inits(link, 1)).toEqual(["m0"]);
  link.send({ Send: { run_id: "r", text: "hi", mode: "plain" } });
  expect(await inits(link, 1)).toEqual(["r1"]);
  // The session's node.sock calls, at the node's own path in the box, act as its session.
  expect(await sendToNode(leadSocketPath(n.home), { t: "lead_call", id: "c1", cwd: "/", call: { op: "whoami" } }, 5_000, 0)).toMatchObject({ result: { as: "s-setup" } });
  await place.stop(dir);
  expect(await gone(box.leader.pid)).toBe(true);
  expect(existsSync(dir)).toBe(false);
}, 30_000);

test("a node restart re-adopts the box: the link comes back to the same session host, and commands reach it", async () => {
  const n = node();
  const dir = join(n.home, "hosts", "s-adopt");
  const first = n.vm.bound({ sessionId: "s-adopt", dir, role: "worker" });
  const link = await first.start(launch(n.home, "s-adopt", n.cwd, program("claude-adopt", ECHO_CLAUDE)));
  expect(await inits(link, 1)).toEqual(["m0"]);
  // The node goes: its links let go, the box and its session go on.
  await link.detach();
  n.vm.close();
  const pid = link.pid;
  expect(startOf(pid)).toBeDefined();
  // The next node finds the box by its record, as SessionService.start does.
  const next = n.make();
  useVm(next);
  try {
    const place = placeAt(dir);
    expect(place.kind).toBe("microvm");
    const again = (await place.adopt(dir))!;
    expect(again).toBeDefined();
    expect(again.pid).toBe(pid);
    again.send({ Send: { run_id: "r", text: "after", mode: "plain" } });
    expect(await inits(again, 1)).toEqual(["r1"]);
    expect(await sendToNode(leadSocketPath(n.home), { t: "lead_call", id: "c2", cwd: "/", call: { op: "whoami" } }, 5_000, 0)).toMatchObject({ result: { as: "s-adopt" } });
    // The adopted box keeps what it showed: its record's view, fleetd's folders hidden.
    expect(readBox(dir)!.view).toMatchObject({ home: root, hidden: [n.home] });
    // Its claude ends and the box with it (the idle close); the next message boots a box that still hides them.
    await again.detach();
    process.kill(-pid, "SIGKILL");
    expect(await gone(pid)).toBe(true);
    const after = await next.bound({ sessionId: "s-adopt", dir, role: "worker" }).start(launch(n.home, "s-adopt", n.cwd, program("claude-adopt2", ECHO_CLAUDE)));
    expect(after.pid).not.toBe(pid);
    const view = readBox(dir)!.view!;
    expect(view.home).toBe(root);
    expect(view.hidden).toEqual([n.home]);
    expect(shows(view, { path: n.cwd, rw: true })).toBe(true);
    expect(await inits(after, 1)).toEqual(["m0"]);
    // A task's end destroys it with whatever ran in it.
    expect(await place.end(dir)).toBeGreaterThan(0);
    expect(await gone(after.pid)).toBe(true);
    expect(await place.adopt(dir)).toBeUndefined();
  } finally {
    useVm(undefined);
  }
}, 30_000);

test("the box goes with its session host: once claude exits, the guest ends and the box with it", async () => {
  const n = node();
  const dir = join(n.home, "hosts", "s-once");
  const place = n.vm.bound({ sessionId: "s-once", dir, role: "worker" });
  const link = await place.start(launch(n.home, "s-once", n.cwd, program("claude-once", "#!/bin/sh\nexit 0\n")));
  const events: RunnerEvent[] = [];
  for (let e = await within(link.next(), 10_000, "an event"); e !== undefined; e = await within(link.next(), 10_000, "an event")) {
    events.push(e);
    link.applied++;
  }
  expect(events.some((e) => typeof e === "object" && "Exited" in e)).toBe(true);
  expect(await gone(link.pid, 8_000)).toBe(true);
  await place.stop(dir);
}, 30_000);

test("stop-all and the start-up sweep destroy boxes; a refused box falls back to a plain process", async () => {
  const n = node();
  const dir = join(n.home, "hosts", "s-sweep");
  const place = n.vm.bound({ sessionId: "s-sweep", dir, role: "worker" });
  await place.run({ cwd: n.cwd, argv: ["true"], timeoutSec: 5 });
  const box = readBox(dir)!;
  expect(boxAlive(box)).toBe(true);
  // `fleetd session-host stop-all` and SessionService.start both sweep through runner/host.ts.
  await sweep(join(n.home, "hosts"), new Set());
  expect(await gone(box.leader.pid)).toBe(true);
  expect(existsSync(dir)).toBe(false);

  // A machine whose check fails between setup and start: the start runs as a plain process, its box gone.
  let check: VmCheck = OK;
  const flaky = new MicroVm({ home: n.home, fleetd: ["/opt/fleetd"], lead: () => undefined, check: () => check, tools: () => TOOLS, boot: standInBoot, dial: unixDial, hidden: [n.home], userHome: root });
  const d2 = join(n.home, "hosts", "s-fallback");
  const p2 = flaky.bound({ sessionId: "s-fallback", dir: d2, role: "worker" });
  await p2.run({ cwd: n.cwd, argv: ["true"], timeoutSec: 5 });
  const left = readBox(d2)!;
  check = { ok: false, why: "no KVM" };
  const link = await new MicroVm({ ...flaky.o, check: () => check }).bound({ sessionId: "s-fallback", dir: d2, role: "worker" }).start(launch(n.home, "s-fallback", n.cwd, program("claude-plain", ECHO_CLAUDE)));
  expect(await gone(left.leader.pid)).toBe(true);
  expect(existsSync(boxFile(d2))).toBe(false);
  expect(readRegistration(d2)!.hostPid).not.toBe(left.leader.pid);
  expect(await inits(link, 1)).toEqual(["m0"]);
  await processPlace.stop(d2);
}, 30_000);

test("a box's launcher, kernel line and forwards", () => {
  const line = kernelCmdline({ exe: "/home/u/.fleetd/node/bin/fleetd", port: 5000, dns: ["192.0.2.53", "2001:db8::1"], now: 1_700_000_000_500 });
  expect(line).toContain("root=/dev/vda ro");
  expect(line).toContain("init=/sbin/fleetd-init");
  expect(line).toContain("fleetd.exe=/home/u/.fleetd/node/bin/fleetd fleetd.port=5000 fleetd.now=1700000000");
  expect(line).toContain("fleetd.dns=192.0.2.53,2001:db8::1 fleetd.once=1");
  const script = launcherScript(
    { dir: "/n/hosts/s", sessionId: "s", view: { home: "/home/u", hidden: ["/home/u/.fleetd"], shares: [] }, port: 5000, exe: "/x/fleetd", tools: TOOLS, check: OK as Extract<VmCheck, { ok: true }> },
    0,
  );
  // No route back to this machine's loopback, no inbound ports, a read-only root, and no root anywhere.
  for (const want of ["'--no-map-gw'", "'-t' 'none' '-u' 'none'", "readonly=on", "shared=on", "unshare --user --map-root-user --mount", "'--sandbox=namespace'"]) expect(script).toContain(want);
  expect(script).not.toContain("sudo");
  expect(forwards({ AGENT_BROWSER_CDP: "ws://127.0.0.1:41234/devtools/browser/t", ANDROID_ADB_SERVER_PORT: "15037" })).toEqual([41234, 15037]);
  expect(forwards({ AGENT_BROWSER_CDP: "ws://hub.example:9222/x" })).toEqual([]);
  // A Claude gateway on this machine is reached at its port; one elsewhere needs nothing.
  expect(forwards({ ANTHROPIC_BASE_URL: "http://localhost:8317" })).toEqual([8317]);
  expect(forwards({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" })).toEqual([]);
});

test("git in a box asks the box's own gh for GitHub, after whatever config the command already has", () => {
  expect(gitInBox({ PATH: "/bin" })).toEqual({
    PATH: "/bin",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_1: "!gh auth git-credential",
  });
  const after = gitInBox({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/h" });
  expect(after).toMatchObject({ GIT_CONFIG_COUNT: "3", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_1: "", GIT_CONFIG_VALUE_2: "!gh auth git-credential" });
});

test("a box's guest gives what it starts the image's own variables (Playwright's browsers), over the node's", () => {
  const file = join(root, "guest.env");
  writeFileSync(file, "PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright\n# a comment\nNOT SET=x\n");
  expect(imageEnv(file, { PLAYWRIGHT_BROWSERS_PATH: "/opt/ms-playwright", OTHER: "y" })).toEqual({ PLAYWRIGHT_BROWSERS_PATH: "/opt/ms-playwright" });
  expect(imageEnv(join(root, "none.env"), { PLAYWRIGHT_BROWSERS_PATH: "/x" })).toEqual({});
});
