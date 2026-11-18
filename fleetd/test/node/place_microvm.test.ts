// The `microvm` place (src/node/place/microvm.ts) against a stand-in box, so it runs without KVM: the "VM" is a child
// process running `fleetd sandbox-guest` (FLEETD_GUEST_ONCE, as a VM's init starts it) in a group it leads, dialled on
// a unix socket. What it covers: which sessions get a box and why a machine falls back to plain processes, setup
// booting the box and the start reusing it, the session's recorded pid being the box's (never 0), node.sock calls
// acting as the box's session, a node restart re-adopting the box, the box going with its session host, and stop,
// end, the start-up sweep and `stop-all` leaving no process of it behind.
import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import { sendToNode } from "../../src/cli/agent_mcp/socket.ts";
import { LeadRelay, leadSocketPath, type LeadSocketHooks } from "../../src/node/lead/index.ts";
import { Masker } from "../../src/node/mask.ts";
import { dir as slotsDir, take } from "../../src/node/build_slots.ts";
import { boxAlive, boxFile, readBox } from "../../src/node/place/box_record.ts";
import { inBox, leavesBox, pick, placeAt, useVm } from "../../src/node/place/index.ts";
import { FAILED_MS, fdLimit, forgetAt, hostLike, forwards, gitInBox, kernelCmdline, launcherScript, MicroVm, openFds, reportVm, SOCKS, vsockDial, type BootPlan, type Booted, type MicroVmOptions } from "../../src/node/place/microvm.ts";
import { processPlace } from "../../src/node/place/process.ts";
import { marker, readRegistration, startOf, sweep, type HostLink, type RunnerEvent } from "../../src/node/runner/host.ts";
import { withSandbox } from "../../src/hub/slots/index.ts";
import type { VmCheck } from "../../src/sandbox/host/capable.ts";
import type { VmTools } from "../../src/sandbox/host/tools.ts";
import type { NodeFrame } from "../../src/node/wire.ts";
import type { NodeLoad } from "../../src/shared/node_link.ts";
import { asUser, guestUser, imageEnv, runArgv } from "../../src/node/sandbox/guest.ts";
import { apply, layHostSystem, plan } from "../../src/node/sandbox/system.ts";
import { mountScript, needs, shows, viewOf } from "../../src/node/place/view.ts";
import type { Reach } from "../../src/node/place/endpoint.ts";

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

const OK: VmCheck = { ok: true, kvm: "direct", dns: ["192.0.2.53"], tools: "ready", net: { ip: "/usr/sbin/ip", nsenter: "/usr/bin/nsenter" } };
const TOOLS: VmTools = { cloudHypervisor: "/vm/ch", chRemote: "/vm/ch-remote", kernel: "/vm/vmlinux", virtiofsd: "/vm/virtiofsd", passt: "/vm/passt", root: "/vm/root.ext4" };

/** The stand-in VM: sandbox-guest in a group it leads, its listen socket in the box's dir. */
async function standInBoot(b: BootPlan): Promise<Booted> {
  // A VM's node.sock is in its own view and goes with it; a stand-in's is on this machine's disk.
  rmSync(join(dirname(dirname(b.dir)), "node.sock"), { force: true });
  rmSync(join(dirname(dirname(b.dir)), "build-slots.sock"), { force: true });
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
/** A stand-in box can't be pointed at Claude (endpoint.ts pinScript runs only in a real box): most tests skip it. */
const noReach = async () => {};

function node(o: { check?: VmCheck; tools?: VmTools | undefined; fleetd?: string[]; fetch?: () => Promise<unknown>; config?: Record<string, unknown>; reach?: MicroVmOptions["reach"] | "real" } = {}) {
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
      ...(o.reach === "real" ? {} : { reach: o.reach ?? noReach }),
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
    expect(leavesBox(dir, [])).toBe(false);
    const off = node({ config: { sandbox: "process" } });
    useVm(off.vm);
    expect(pick({ sessionId: "s", dir, role: "worker" })).toBe(processPlace);
    // A session still in its VM once VMs are off leaves it before its next turn, which runs as a plain process; a run
    // under way (a steer or a queued message arriving mid-turn) finishes in its box first.
    expect(leavesBox(dir, [])).toBe(true);
    expect(leavesBox(dir, [{ status: "completed" }, { status: "starting" }])).toBe(true);
    expect(leavesBox(dir, [{ status: "running" }, { status: "queued" }])).toBe(false);
    expect(leavesBox(dir, [{ status: "waiting" }])).toBe(false);
    expect(leavesBox(join(n.home, "hosts", "plain"), [])).toBe(false);
  } finally {
    useVm(undefined);
  }
});

test("a machine that can't run VMs says why, in plain words, and fetches the VM files once while it waits", async () => {
  expect(node({ config: { sandbox: "process" } }).vm.status()).toEqual({ kind: "process", why: `turned off on this machine (node.json "sandbox": "process")`, expected: true });
  // An off switch mistyped, or a node.json that doesn't decode: VMs off, and it says why, never on silently.
  expect(node({ config: { sandbox: "proces" } }).vm.status()).toEqual({ kind: "process", why: `node.json "sandbox" is "proces": "process" turns VMs off and "microvm" (or no key) on, so they're off until it says which` });
  const broken = node();
  writeFileSync(join(broken.home, "node.json"), "{ not json");
  expect(broken.vm.status().why).toStartWith("node.json can't be read (");
  expect(node({ fleetd: ["/usr/bin/bun", "/src/main.ts"] }).vm.status().kind).toBe("process");
  const noKvm = node({ check: { ok: false, why: "This user can't open /dev/kvm.", fix: "sudo usermod -aG kvm $USER" } });
  expect(noKvm.vm.status()).toEqual({ kind: "process", why: "This user can't open /dev/kvm.", fix: "sudo usermod -aG kvm $USER" });
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
  // A setup command while its session host runs (its worktree came back, say), even one naming a path the box
  // doesn't show, runs in that box: a new one would end the session.
  const other = join(root, "setup-elsewhere");
  mkdirSync(other, { recursive: true });
  expect(await place.run({ cwd: n.cwd, argv: ["ls", other], timeoutSec: 10, env: envOf(n.home) })).toMatchObject({ exitCode: 0 });
  expect(readBox(dir)!.leader).toEqual(box.leader);
  link.send({ Send: { run_id: "r2", text: "still there?", mode: "plain" } });
  expect(await inits(link, 1)).toEqual(["r2"]);
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
  const flaky = new MicroVm({ home: n.home, fleetd: ["/opt/fleetd"], lead: () => undefined, check: () => check, tools: () => TOOLS, boot: standInBoot, dial: unixDial, reach: noReach, hidden: [n.home], userHome: root });
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
    { dir: "/n/hosts/s", sessionId: "s", view: { home: "/home/u", hidden: ["/home/u/.fleetd"], shares: [] }, port: 5000, exe: "/x/fleetd", tools: TOOLS, check: OK as Extract<VmCheck, { ok: true }>, blocked: ["100.64.0.7"] },
    0,
  );
  // No route back to this machine's loopback, no inbound ports, a read-only root, and no root anywhere.
  for (const want of ["'--no-map-gw'", "'-t' 'none' '-u' 'none'", "readonly=on", "shared=on", "unshare --user --map-root-user --mount", "'--sandbox=namespace'"]) expect(script).toContain(want);
  expect(script).not.toContain("sudo");
  // passt runs in pasta's network namespace, with no port either way and no gateway meaning this machine, behind the
  // routes that keep this machine's own addresses out, which must be set before passt starts (or the box doesn't).
  expect(script).toContain("(exec -a pasta '/vm/passt' '-q' '-f' '--config-net' '-t' 'none' '-u' 'none' '-T' 'none' '-U' 'none' '--no-map-gw' '--' '/bin/sh' '-c'");
  const inNs = script.slice(script.indexOf("'/bin/sh' '-c'"));
  expect(inNs.indexOf("rule add pref 10 table 4790 || exit 1")).toBeGreaterThan(0);
  expect(inNs.indexOf("-batch")).toBeLessThan(inNs.indexOf("'--vhost-user'"));
  expect(forwards({ AGENT_BROWSER_CDP: "ws://127.0.0.1:41234/devtools/browser/t", ANDROID_ADB_SERVER_PORT: "15037" })).toEqual([41234, 15037]);
  expect(forwards({ AGENT_BROWSER_CDP: "ws://hub.example:9222/x" })).toEqual([]);
  // Claude, wherever it is, is the box's relay, never a forward.
  expect(forwards({ ANTHROPIC_BASE_URL: "http://localhost:8317" })).toEqual([]);
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

test("a box's network follows this machine's addresses: new ones are set out of its reach, and a failure is tried again", async () => {
  const n = node();
  let addrs = ["192.0.2.1"];
  const plans: BootPlan[] = [];
  const set: [number, string[]][] = [];
  let failing = false;
  const vm = new MicroVm({
    ...n.vm.o,
    addrs: () => addrs,
    setBlocks: (holder, want) => {
      if (failing) throw new Error("nsenter: No such process");
      set.push([holder, want]);
    },
    // The stand-in's own process holds its "namespace".
    boot: async (b) => (plans.push(b), { ...(await standInBoot(b)), net: { pid: process.pid, start: startOf(process.pid)! } }),
  });
  const dir = join(n.home, "hosts", "s-net");
  await vm.bound({ sessionId: "s-net", dir, role: "worker" }).run({ cwd: n.cwd, argv: ["true"], timeoutSec: 5, env: envOf(n.home) });
  expect(plans[0]!.blocked).toEqual(["192.0.2.1"]);
  expect(readBox(dir)).toMatchObject({ net: { pid: process.pid }, blocked: ["192.0.2.1"] });
  await vm.keepOff();
  expect(set).toEqual([]);
  addrs = ["192.0.2.1", "2001:db8::2"];
  failing = true;
  await vm.keepOff();
  expect(readBox(dir)!.blocked).toEqual(["192.0.2.1"]);
  failing = false;
  await vm.keepOff();
  expect(set).toEqual([[process.pid, ["192.0.2.1", "2001:db8::2"]]]);
  expect(readBox(dir)!.blocked).toEqual(["192.0.2.1", "2001:db8::2"]);
  await vm.end(dir);
  vm.close();
});

test("a box's builds take this machine's build slots, queued with every other agent's, and give them back however they end", async () => {
  const n = node({ config: { buildSlots: 1 } });
  const dir = join(n.home, "hosts", "s-build");
  const place = n.vm.bound({ sessionId: "s-build", dir, role: "worker" });
  const bin = join(root, "fake-cargo");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "cargo"), '#!/bin/sh\necho "cargo ran: $*"\n[ "$2" = slow ] && sleep 30\nexit 0\n');
  chmodSync(join(bin, "cargo"), 0o755);
  const env = { ...envOf(n.home), PATH: `${bin}:${process.env.PATH}` };
  const build = (args: string, signal?: AbortSignal) =>
    place.run({ cwd: n.cwd, argv: [process.execPath, MAIN, "build-slot", n.home, ...args.split(" ")], timeoutSec: 30, env, ...(signal ? { signal } : {}) });
  // Another agent's build holds the machine's one slot: the box's queues on it, and runs once it frees.
  const other = await take(slotsDir(n.home), 1, 1, 50, () => {});
  const queued = build("build --release");
  await Bun.sleep(1_500);
  for (const fd of other) closeSync(fd);
  const ran = await within(queued, 15_000, "the box's build");
  expect(ran.exitCode).toBe(0);
  expect(ran.outputTail).toContain("fleetd: queued for a build slot (next in line; 1 slot on this machine)");
  expect(ran.outputTail).toContain("cargo ran: build --release");
  // A build killed while it holds the slot gives it back at once.
  const abort = new AbortController();
  const slow = build("build slow", abort.signal);
  await Bun.sleep(1_500);
  let waited = false;
  const next = take(slotsDir(n.home), 1, 1, 50, () => (waited = true));
  await Bun.sleep(300);
  expect(waited).toBe(true);
  abort.abort();
  expect((await slow).exitCode).toBeNull();
  for (const fd of await within(next, 10_000, "the slot back")) closeSync(fd);
  await n.vm.end(dir);
});

test.skipIf(process.platform !== "linux")("a box under a deep node home keeps every socket address short: its tools get them by name, the node dials through the dir", async () => {
  // A host dir whose sockets' paths are far past a socket address's 108 bytes.
  const dir = join(root, "a-node-home-deeper-than-a-socket-address-holds".repeat(2), "hosts", "0f1e2d3c-4b5a-4968-8776-655443322110");
  mkdirSync(dir, { recursive: true });
  expect(join(dir, SOCKS.vsock).length).toBeGreaterThan(108);
  const script = launcherScript(
    { dir, sessionId: "s", view: { home: "/home/u", hidden: [], shares: [] }, port: 5000, exe: "/x/fleetd", tools: TOOLS, check: OK as Extract<VmCheck, { ok: true }>, blocked: [] },
    0,
  );
  // Each tool runs in the dir (the launcher's cwd, and the namespace's shell's), and names each socket by itself.
  for (const name of Object.values(SOCKS)) expect(script).not.toContain(join(dir, name));
  // passt's and virtiofsd's are quoted once more, inside the shells that start them.
  const inner = (...args: string[]) => args.map((x) => `'\\''${x}'\\''`).join(" ");
  for (const arg of [inner("--socket-path=fs.sock"), inner("--socket", "net.sock"), "'path=api.sock'", "'tag=view,socket=fs.sock'", "'vhost_user=true,socket=net.sock,num_queues=2'", "'cid=3,socket=vsock.sock'"])
    expect(script).toContain(arg);
  expect(script).toContain(`\ncd '${dir}' || exit 1\n`);
  expect(script).toContain(`'/bin/sh' '-c' 'cd ${inner(dir)} || exit 1\n`);
  // A stand-in for the VMM's hybrid vsock socket in that dir, bound through an fd of it as the VMM binds by name.
  const fd = openSync(dir, "r");
  const vmm = createServer((s) => {
    s.once("data", (line) => {
      expect(line.toString()).toBe("CONNECT 5000\n");
      s.write("OK 1073741824\nhello from the guest");
    });
  });
  await new Promise<void>((r) => vmm.listen(`/proc/self/fd/${fd}/${SOCKS.vsock}`, r));
  closeSync(fd);
  try {
    const link = await within(vsockDial(dir, 5000), 5_000, "the dial");
    const got = await within(new Promise<string>((r) => link.once("data", (b: Buffer) => r(b.toString()))), 5_000, "the guest's bytes");
    expect(got).toBe("hello from the guest");
    link.destroy();
  } finally {
    vmm.close();
  }
});

/** A stand-in Claude gateway on this machine's loopback: any request gets a 404, as a gateway's root does. */
async function gateway(): Promise<{ port: number; hits: () => number; close: () => void }> {
  let hits = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => (hits++, new Response("no", { status: 404 })) });
  return { port: server.port!, hits: () => hits, close: () => server.stop(true) };
}

/** A Claude config dir whose settings.json names `url`, as the devbox's ~/.claude/settings.json does. */
function settingsWith(name: string, url: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: url, ANTHROPIC_AUTH_TOKEN: "not-a-key" } }));
  return dir;
}

test.skipIf(process.platform !== "linux")("a Claude gateway only claude's own settings name is relayed into the box and checked from inside before the agent starts", async () => {
  const gw = await gateway();
  const n = node({ reach: "real" });
  const dir = join(n.home, "hosts", "s-gateway");
  const l = launch(n.home, "s-gateway", n.cwd, program("claude-gw", ECHO_CLAUDE));
  // Not in the node's environment, claude.env or an account: only in claude's settings, which the box shares.
  const link = await n.vm.bound({ sessionId: "s-gateway", dir, role: "worker" }).start({ ...l, env: { ...l.env, CLAUDE_CONFIG_DIR: settingsWith("cfg-gw", `http://localhost:${gw.port}`) } });
  expect(await inits(link, 1)).toEqual(["m0"]);
  const box = readBox(dir)!;
  // Dialled where the gateway listens on this machine's loopback.
  expect(box.relays).toEqual([{ port: gw.port, to: { host: "127.0.0.1", port: gw.port } }]);
  expect(n.vm.status().kind).toBe("microvm");
  // The box's own loopback (127.0.0.2 for a stand-in) at the gateway's port reaches the gateway, through the node.
  const before = gw.hits();
  const res = await fetch(`http://127.0.0.2:${gw.port}/v1/messages`);
  expect(res.status).toBe(404);
  expect(gw.hits()).toBe(before + 1);
  await n.vm.bound({ sessionId: "s-gateway", dir, role: "worker" }).stop(dir);
  gw.close();
}, 30_000);

test.skipIf(process.platform !== "linux")("a box that can't reach Claude runs nothing: the agent and the machine's next ones run as plain processes, saying why", async () => {
  const gw = await gateway();
  const closed = gw.port;
  gw.close();
  const n = node({ reach: "real" });
  const dir = join(n.home, "hosts", "s-noclaude");
  const l = launch(n.home, "s-noclaude", n.cwd, program("claude-noclaude", ECHO_CLAUDE));
  const at = Date.now();
  const link = await n.vm.bound({ sessionId: "s-noclaude", dir, role: "worker" }).start({ ...l, env: { ...l.env, CLAUDE_CONFIG_DIR: settingsWith("cfg-closed", `http://localhost:${closed}`) } });
  // Fast and plain: no stall, a plain process, the box gone.
  expect(Date.now() - at).toBeLessThan(20_000);
  expect(existsSync(boxFile(dir))).toBe(false);
  expect(await inits(link, 1)).toEqual(["m0"]);
  const status = n.vm.status();
  expect(status.kind).toBe("process");
  expect(status.kind === "process" && status.why).toContain(`the last VM didn't start: the box can't reach Claude at localhost:${closed}`);
  expect(status.kind === "process" && status.why).toContain("cfg-closed/settings.json");
  useVm(n.vm);
  try {
    expect(pick({ sessionId: "s-next", dir: join(n.home, "hosts", "s-next"), role: "worker" }).kind).toBe("process");
  } finally {
    useVm(undefined);
  }
  // Until FAILED_MS has passed.
  expect(n.vm.status(Date.now() + FAILED_MS + 61_000).kind).toBe("microvm");
  await processPlace.stop(dir);
}, 30_000);

test.skipIf(process.platform !== "linux")("an endpoint only a bot's own settings name, unreachable, sends that session to a plain process and leaves the machine on VMs", async () => {
  const gw = await gateway();
  const closed = gw.port;
  gw.close();
  const n = node({ reach: "real" });
  const cwd = join(n.home, "wt-project");
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://localhost:${closed}` } }));
  const dir = join(n.home, "hosts", "s-project");
  const link = await n.vm.bound({ sessionId: "s-project", dir, role: "worker" }).start(launch(n.home, "s-project", cwd, program("claude-project", ECHO_CLAUDE)));
  expect(await inits(link, 1)).toEqual(["m0"]);
  expect(existsSync(boxFile(dir))).toBe(false);
  expect(n.vm.status().kind).toBe("microvm");
  await processPlace.stop(dir);
}, 30_000);

test("a VM agent on Anthropic's own API calls it exactly as set: the relay takes port 443 in the box", async () => {
  const seen: Reach[] = [];
  const n = node({ reach: async (_box, r) => void seen.push(r) });
  const dir = join(n.home, "hosts", "s-api");
  const l = launch(n.home, "s-api", n.cwd, program("claude-api", ECHO_CLAUDE));
  const args = ["-p", "--model", "m"];
  const link = await n.vm.bound({ sessionId: "s-api", dir, role: "worker" }).start({ ...l, args, env: { ...l.env, CLAUDE_CONFIG_DIR: join(root, "cfg-none") } });
  expect(await inits(link, 1)).toEqual(["m0"]);
  expect(seen).toMatchObject([{ url: "https://api.anthropic.com", boxUrl: "https://api.anthropic.com", relay: { port: 443, to: { host: "api.anthropic.com", port: 443 } } }]);
  await n.vm.bound({ sessionId: "s-api", dir, role: "worker" }).stop(dir);
}, 30_000);

test("a setup command whose box doesn't boot runs as a plain process, and the machine says why, never silently", async () => {
  const n = node();
  const vm = new MicroVm({
    ...n.vm.o,
    boot: async () => {
      throw new Error("the VM didn't start: Invalid socket path: net.sock");
    },
  });
  const dir = join(n.home, "hosts", "s-noboot");
  const ran = await vm.bound({ sessionId: "s-noboot", dir, role: "worker" }).run({ cwd: n.cwd, argv: ["sh", "-c", "echo on the host"], timeoutSec: 5, env: envOf(n.home) });
  expect(ran).toMatchObject({ exitCode: 0, outputTail: "on the host\n" });
  const status = vm.status();
  expect(status.kind).toBe("process");
  expect(status.kind === "process" && status.why).toContain("the last VM didn't start: the VM didn't start: Invalid socket path: net.sock");
  vm.close();
});

test("a box's share is watched: at a quarter of its fd limit the guest forgets its files, and the node says so", async () => {
  const n = node();
  let open = 10;
  const forgot: number[] = [];
  const logs: string[] = [];
  const log = console.log;
  const warn = console.warn;
  console.log = (line: string) => logs.push(line);
  console.warn = (line: string) => logs.push(line);
  // A stand-in virtiofsd: a forget brings its count down to what the agent keeps open (`kept`).
  let kept = 100;
  const vm = new MicroVm({
    ...n.vm.o,
    shareFds: () => ({ open, limit: 1000 }),
    forget: async () => {
      forgot.push(open);
      open = kept;
    },
    shareEveryMs: 3_600_000,
  });
  const dir = join(n.home, "hosts", "s-share");
  try {
    await vm.bound({ sessionId: "s-share", dir, role: "worker" }).run({ cwd: n.cwd, argv: ["true"], timeoutSec: 5, env: envOf(n.home) });
    await vm.watchShares();
    open = 249;
    await vm.watchShares();
    expect(forgot).toEqual([]);
    open = 250;
    await vm.watchShares();
    expect(forgot).toEqual([250]);
    expect(logs.some((l) => l.includes("INFO a VM's file share held 250 open files of its 1000: the VM forgot the ones it wasn't using, 100 now"))).toBe(true);
    // The agent keeps 600 open itself: forgetting again only once the count is an eighth of the limit over that, and
    // the node warns, once, that the agent's own files near the limit.
    kept = 600;
    open = 300;
    await vm.watchShares();
    expect(forgot).toEqual([250, 300]);
    expect(logs.filter((l) => l.includes("WARN the agent in a VM keeps 600 files open itself, of its file share's 1000")).length).toBe(1);
    open = 700;
    await vm.watchShares();
    expect(forgot).toEqual([250, 300]);
    open = 725;
    await vm.watchShares();
    expect(forgot).toEqual([250, 300, 725]);
    expect(logs.filter((l) => l.includes("WARN the agent in a VM keeps")).length).toBe(1);
    // Once what it keeps falls, a quarter of the limit is the mark again.
    kept = 50;
    open = 60;
    await vm.watchShares();
    open = 250;
    await vm.watchShares();
    expect(forgot).toEqual([250, 300, 725, 250]);
  } finally {
    console.log = log;
    console.warn = warn;
    await vm.end(dir);
    vm.close();
  }
  expect(forgetAt(524_288, 0)).toBe(131_072);
  expect(forgetAt(524_288, 120_000)).toBe(185_536);
});

test("a box's guest is told to forget through its link, and a guest that can't says why in the node's log", async () => {
  const n = node();
  const logs: string[] = [];
  const warn = console.warn;
  console.warn = (line: string) => logs.push(line);
  // The real guest (not root here) can't write the kernel's drop_caches: the op reaches it, and its error the log.
  const vm = new MicroVm({ ...n.vm.o, shareFds: () => ({ open: 500, limit: 1000 }), shareEveryMs: 3_600_000 });
  const dir = join(n.home, "hosts", "s-forget");
  try {
    await vm.bound({ sessionId: "s-forget", dir, role: "worker" }).run({ cwd: n.cwd, argv: ["true"], timeoutSec: 5, env: envOf(n.home) });
    await vm.watchShares();
    const line = logs.find((l) => l.includes("WARN a VM's file share holds 500 open files of its 1000, and the VM couldn't forget the ones it isn't using"));
    expect(line).toBeDefined();
    expect(line).not.toContain("no such op");
  } finally {
    console.warn = warn;
    await vm.end(dir);
    vm.close();
  }
});

test.skipIf(process.platform !== "linux")("a process's open files and its limit are read from /proc", () => {
  const before = openFds(process.pid);
  const fd = openSync(join(root, "an-open-file"), "w");
  expect(openFds(process.pid)).toBe(before + 1);
  closeSync(fd);
  expect(fdLimit(process.pid)).toBeGreaterThan(0);
});

test("a box shares this machine's system dirs read-only, in a share of their own, links as links, fleetd's hidden there too", () => {
  const system = [{ name: "usr" }, { name: "opt" }, { name: "bin", link: "usr/bin" }];
  const script = mountScript({ home: "/home/u", hidden: ["/home/u/.fleetd", "/opt/fleetd"], shares: [] }, "/v", ["/vm/virtiofsd", "view"], { at: "/h", exec: ["/vm/virtiofsd", "host"] }, system);
  for (const want of [
    "mount -t tmpfs -o mode=0755 fleetd-system '/h'",
    "mount --rbind '/usr' '/h/usr'",
    "mount -o remount,bind,ro '/h/usr'",
    "mount -o remount,bind,ro '/h/opt'",
    "ln -s 'usr/bin' '/h/bin'",
    "[ ! -d '/h/opt/fleetd' ] || mount -t tmpfs -o mode=0700 fleetd-hidden '/h/opt/fleetd'",
    "mount -t tmpfs -o mode=0700 fleetd-hidden '/v/home/u/.fleetd'",
    "'/vm/virtiofsd' 'host' &\nh=$!\n'/vm/virtiofsd' 'view' &\nw=$!\nwait -n || true",
  ])
    expect(script).toContain(want);
  // A hidden dir in a system dir is hidden there, never put at `/opt` in the view, which would shadow the guest's /opt.
  expect(script).not.toContain("'/v/opt/fleetd'");
  expect(script.indexOf("'/h/opt'")).toBeLessThan(script.indexOf("'/h/opt/fleetd'"));
  // The share's own virtiofsd: read-only, cached as long as the guest likes; the view's checks each file with the host.
  const launcher = launcherScript(
    { dir: "/n/hosts/s", sessionId: "s", view: { home: "/home/u", hidden: [], shares: [] }, port: 5000, exe: "/x/fleetd", tools: TOOLS, check: OK as Extract<VmCheck, { ok: true }>, blocked: [] },
    0,
  );
  for (const want of [
    "'\\''--socket-path=host.sock'\\'' '\\''--shared-dir=/n/hosts/s/host'\\''",
    "'\\''--cache=always'\\'' '\\''--readonly'\\'' '\\''--translate-uid=host:65534:0:1'\\''",
    "'tag=host,socket=host.sock'",
    "[ -S host.sock ]",
    // The box ends with the first of its VMM and helpers to end.
    "wait -n $c $p $v",
  ])
    expect(launcher).toContain(want);
});

test("a guest lays this machine's system dirs over the image's: /usr first, dirs before links, its own network files kept", () => {
  const steps = plan([{ name: "lib64", link: "usr/lib" }, { name: "etc" }, { name: "usr" }, { name: "lib32" }, { name: "home" }], (name) => name !== "lib32", "/s", "/img");
  expect(steps).toEqual([
    { name: "usr", lower: ["/s/usr", "/img/usr"] },
    { name: "etc", lower: ["/s/etc", "/img/etc"] },
    { name: "lib32", lower: ["/s/lib32"] },
    { name: "lib64", link: "usr/lib" },
  ]);
  // On a stand-in root: the overlay mounts are recorded, and what they'd show is written as this machine's /etc.
  const r = join(root, "guest-root");
  mkdirSync(join(r, "etc"), { recursive: true });
  writeFileSync(join(r, "etc/resolv.conf"), "nameserver 192.0.2.53\n");
  writeFileSync(join(r, "etc/hostname"), "fleetd-box\n");
  symlinkSync("usr/lib64", join(r, "lib64"));
  mkdirSync(join(r, "lib32-real"));
  const mounts: string[][] = [];
  apply(steps, {
    root: r,
    layers: join(r, "run/fleetd/system"),
    prepare: () => {},
    overlay: (target, lower, upper, work) => {
      mounts.push([target, lower.join(":"), upper, work]);
      // This machine's /etc over the guest's: its resolv.conf a link to its own stub, which the guest's replaces.
      if (target.endsWith("/etc")) {
        rmSync(join(r, "etc/resolv.conf"));
        symlinkSync("../run/systemd/resolve/stub-resolv.conf", join(r, "etc/resolv.conf"));
        writeFileSync(join(r, "etc/gitconfig"), "[user]\n\tname = u");
      }
    },
  });
  expect(mounts.map((m) => m[0])).toEqual([join(r, "usr"), join(r, "etc"), join(r, "lib32")]);
  expect(mounts[0]!.slice(1)).toEqual(["/s/usr:/img/usr", join(r, "run/fleetd/system/usr/up"), join(r, "run/fleetd/system/usr/work")]);
  expect(readlinkSync(join(r, "lib64"))).toBe("usr/lib");
  expect(readFileSync(join(r, "etc/resolv.conf"), "utf8")).toBe("nameserver 192.0.2.53\n");
  expect(readFileSync(join(r, "etc/hostname"), "utf8")).toBe("fleetd-box\n");
  expect(readFileSync(join(r, "etc/gitconfig"), "utf8")).toBe("[user]\n\tname = u\n[safe]\n\tdirectory = *\n");
  expect(() => apply([{ name: "usr", lower: ["/a:b"] }], { root: r, layers: join(r, "l"), prepare: () => {}, overlay: () => {} })).toThrow("can't layer");
  // Only the VM's own guest lays them: never a stand-in an agent in the box runs (not root, no kernel's user).
  expect(layHostSystem({ FLEETD_GUEST_UID: "1000" })).toBeUndefined();
  expect(layHostSystem({})).toBeUndefined();
});

test("a local VM's guest runs the agent as this machine's user, never root; elsewhere as it is", () => {
  const env = { FLEETD_GUEST_UID: "1000", FLEETD_GUEST_GID: "1001" };
  expect(guestUser(env, true)).toEqual({ uid: 1000, gid: 1001 });
  expect(guestUser(env, false)).toBeUndefined();
  expect(guestUser({}, true)).toBeUndefined();
  expect(guestUser({ FLEETD_GUEST_UID: "0", FLEETD_GUEST_GID: "0" }, true)).toBeUndefined();
  expect(asUser(["bun", "test"], { uid: 1000, gid: 1001 })).toEqual(["/bin/sh", "-c", 'echo 0 > /proc/self/oom_score_adj; exec "$@"', "sh", "/usr/bin/setpriv", "--reuid=1000", "--regid=1001", "--clear-groups", "--", "bun", "test"]);
  expect(asUser(["bun", "test"], undefined)).toEqual(["bun", "test"]);
  // The node's own commands (its pin to Claude's relay, which changes the box's loopback) stay root.
  expect(runArgv(["/bin/sh", "-c", "pin"], true, { uid: 1000, gid: 1001 })).toEqual(["/bin/sh", "-c", "pin"]);
  expect(runArgv(["make"], false, { uid: 1000, gid: 1001 })).toContain("/usr/bin/setpriv");
  expect(kernelCmdline({ exe: "/x/fleetd", port: 5000, dns: [], now: 0, uid: 1000, gid: 1001 })).toContain("fleetd.once=1 fleetd.uid=1000 fleetd.gid=1001");
  const script = launcherScript(
    { dir: "/n/hosts/s", sessionId: "s", view: { home: "/home/u", hidden: [], shares: [] }, port: 5000, exe: "/x/fleetd", tools: TOOLS, check: OK as Extract<VmCheck, { ok: true }>, blocked: [] },
    0,
  );
  const uid = process.getuid!();
  expect(script).toContain(`--translate-uid=map:${uid}:0:1`);
  expect(script).toContain(`fleetd.uid=${uid}`);
});

test("a box's pnpm store is in its checkout, out of git; its temp files stay in its scratch dir, outside the repo", async () => {
  const n = node();
  const repo = join(n.home, "wt-tmp");
  mkdirSync(repo, { recursive: true });
  expect(Bun.spawnSync(["git", "init", "-q", repo]).success).toBe(true);
  const dir = join(n.home, "hosts", "s-tmp");
  const place = n.vm.bound({ sessionId: "s-tmp", dir, role: "worker" });
  const env = envOf(n.home);
  const script = 'mkdir -p "$pnpm_config_store_dir" && touch "$pnpm_config_store_dir/x" && echo "tmp=$TMPDIR store=$pnpm_config_store_dir" && git status --porcelain';
  const ran = await place.run({ cwd: repo, argv: ["/bin/sh", "-c", script], timeoutSec: 10, env });
  expect(ran.exitCode).toBe(0);
  // A temp dir inside the repo would be found by every tool walking up from it (its package.json, its test runner).
  expect(ran.outputTail).toContain(`tmp=${env.TMPDIR} store=${join(repo, ".fleetd/pnpm-store/")}`);
  expect(ran.outputTail).not.toContain("??");
  expect(readFileSync(join(repo, ".git/info/exclude"), "utf8")).toContain("/.fleetd/pnpm-store/\n");
  await place.end(dir);
}, 30_000);

test("a program on PATH that links into a hidden dir (agent-browser's, into its package) is put back where it links to", () => {
  const home = join(root, "links-home");
  const node = join(home, ".fleetd/node");
  const pkg = join(node, "browser/agent-browser/node_modules/agent-browser/bin");
  const bin = join(node, "browser/agent-browser/bin");
  mkdirSync(pkg, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(pkg, "agent-browser-linux-x64"), "#!/bin/sh\n");
  symlinkSync(join(pkg, "agent-browser-linux-x64"), join(bin, "agent-browser"));
  const view = viewOf(home, [join(home, ".fleetd")], needs({ cwd: join(home, "wt"), env: { PATH: `${bin}:/usr/bin` }, argv: [] }));
  expect(shows(view, { path: join(pkg, "agent-browser-linux-x64"), rw: false })).toBe(true);
  expect(shows(view, { path: join(node, "node.json"), rw: false })).toBe(false);
});

test("a VM's guest takes this machine's umask and inotify limits, from the kernel line", () => {
  const like = hostLike();
  expect(like.umask).toMatch(/^0[0-7]{3}$/);
  expect(like.watches).toBeGreaterThan(0);
  expect(kernelCmdline({ exe: "/x/fleetd", port: 5000, dns: [], now: 0, like: { umask: "0002", watches: 1048576, instances: 1024 } })).toContain(
    "fleetd.umask=0002 fleetd.watches=1048576 fleetd.instances=1024",
  );
});

test("a VM's agent is in a box: what this machine would run for it (the Linux desktop's launch) is refused", async () => {
  const n = node();
  const dir = join(n.home, "hosts", "s-inbox");
  useVm(n.vm);
  try {
    expect(inBox("s-inbox")).toBe(false);
    await n.vm.bound({ sessionId: "s-inbox", dir, role: "worker" }).run({ cwd: n.cwd, argv: ["true"], timeoutSec: 5, env: envOf(n.home) });
    expect(inBox("s-inbox")).toBe(true);
    expect(inBox("s-other")).toBe(false);
    await n.vm.end(dir);
    expect(inBox("s-inbox")).toBe(false);
  } finally {
    useVm(undefined);
  }
});

test("an order's variables dir that isn't there yet is made before the box boots, so a variable set later reaches it", () => {
  const home = join(root, "order-home");
  const dir = join(home, ".fleetd/node/order-env/p1");
  const envFile = join(home, "claude-env.sh");
  mkdirSync(home, { recursive: true });
  writeFileSync(envFile, `if [ -r '${dir}/W3.sh' ]; then . '${dir}/W3.sh'; fi\n`);
  const shares = needs({ cwd: join(home, "wt"), env: { CLAUDE_ENV_FILE: envFile }, argv: [] });
  expect(existsSync(dir)).toBe(true);
  expect(shares).toContainEqual({ path: dir, rw: false });
});

test("a box can mark its tool calls held for an update (the update dir is writable), and nothing else of the node home", async () => {
  const n = node();
  const dir = join(n.home, "hosts", "s-held");
  await n.vm.bound({ sessionId: "s-held", dir, role: "worker" }).run({ cwd: n.cwd, argv: ["true"], timeoutSec: 5, env: envOf(n.home) });
  const view = readBox(dir)!.view!;
  expect(shows(view, { path: join(n.home, "update/held/tu_1"), rw: true })).toBe(true);
  expect(shows(view, { path: join(n.home, "sessions/s-held"), rw: true })).toBe(false);
  expect(shows(view, { path: join(n.home, "node.json"), rw: false })).toBe(false);
  await n.vm.end(dir);
});
