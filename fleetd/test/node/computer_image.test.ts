// A bot's computer image (src/node/place/image.ts), proven against a stand-in box (no KVM): its setup commands build an
// image in the background, a VM over a disk of its own; a new session whose worktree has the same inputs starts from it,
// its box stacking its own disk over a read-only link of the image, and its setup doesn't run again. Old images go once
// a new one is ready. And every way it isn't there (no image yet, a failed build, a stale one, setup that writes into
// the checkout, a secret's value on the image's disk) is a clean start plus setup, never a failed one.
import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { connect } from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import type { ComputerImage } from "../../src/shared/contracts.ts";
import { LeadRelay, type LeadSocketHooks } from "../../src/node/lead/index.ts";
import { Masker } from "../../src/node/mask.ts";
import { Images, sessionDisk, sessionImage, sessionLayer, startsFrom, takesImage, type Backend } from "../../src/node/place/image.ts";
import { kernelCmdline, MicroVm, sealScript, type BootPlan, type Booted } from "../../src/node/place/microvm.ts";
import { BOX_HOME } from "../../src/node/place/provision.ts";
import { guestOwn } from "../../src/node/place/view.ts";
import { startOf } from "../../src/node/runner/host.ts";
import { readBox } from "../../src/node/place/box_record.ts";
import * as setup from "../../src/node/worktree/setup.ts";
import type { VmCheck } from "../../src/sandbox/host/capable.ts";
import type { VmTools } from "../../src/sandbox/host/tools.ts";

const MAIN = join(import.meta.dir, "../../src/main.ts");
const tmpBase = process.env.TMPDIR ?? "/tmp";
const root = mkdtempSync(join(guestOwn(tmpBase) ? homedir() : tmpBase, "fleetd-image-"));
const leaders: number[] = [];
afterAll(() => {
  for (const pid of leaders) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }
  rmSync(root, { recursive: true, force: true });
});

const OK: VmCheck = { ok: true, kvm: "direct", dns: ["192.0.2.53"], tools: "ready", net: { ip: "/usr/sbin/ip", nsenter: "/usr/bin/nsenter" } };
const TOOLS: VmTools = { cloudHypervisor: "/vm/ch", chRemote: "/vm/ch-remote", kernel: "/vm/vmlinux", virtiofsd: "/vm/virtiofsd", passt: "/vm/passt", root: "/vm/root.ext4" };

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};

/** A node's home with a bot's checkout (a lockfile among its files) and the boots its boxes made. */
function fixture(name: string) {
  const node = join(root, name, "node");
  const repo = join(root, name, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "bun.lock"), "lock v1\n");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  const boots: BootPlan[] = [];
  const sealed: string[] = [];
  const h = hooks();
  // What the guest's init would leave: the marker only where it stacked the image; a box can also fail to boot.
  const marker = join(root, name, "image-mounted");
  const flags = { mountFails: false, bootFails: false };
  const vm = new MicroVm({
    home: node,
    fleetd: ["/opt/fleetd"],
    lead: () => h,
    check: () => OK,
    tools: () => TOOLS,
    boot: (b) => {
      boots.push(b);
      if (flags.bootFails) return Promise.reject(new Error("no VM here"));
      if (b.layer && !flags.mountFails) writeFileSync(marker, "");
      else rmSync(marker, { force: true });
      return standInBoot(node, b);
    },
    imageMarker: marker,
    dial: unixDial,
    reach: async () => {},
    goneMs: 1_000,
    // The seal as root in the box, on a stand-in of its disk's upper dir: the image's own script, but its freeze.
    seal: async (_box, script, scrub) => {
      sealed.push(script);
      const r = Bun.spawnSync(["bash", "-c", script.replaceAll("/run/fleetd/rw", join(root, name, "rw")).replace("fsfreeze -f", "true")], {
        stdout: "pipe",
        stderr: "pipe",
        env: { PATH: process.env.PATH!, FLEETD_SECRETS: scrub.join("\n") },
      });
      return { exitCode: r.exitCode, outputTail: r.stdout.toString() + r.stderr.toString(), timedOut: false };
    },
  });
  const changes: ComputerImage[] = [];
  const vars = { env: {} as Record<string, string>, secrets: [] as string[] };
  const images = new Images({
    home: node,
    backend: () => vm.backend(),
    root: (p) => (p === "p1" ? repo : undefined),
    vars: () => vars,
    changed: (_p, image) => void changes.push(image),
  });
  return { node, repo, vm, images, boots, sealed, changes, vars, flags, rw: join(root, name, "rw") };
}

/** The stand-in VM: sandbox-guest in a group it leads, its listen socket in the box's dir. */
async function standInBoot(node: string, b: BootPlan): Promise<Booted> {
  rmSync(join(node, "node.sock"), { force: true });
  rmSync(join(node, "build-slots.sock"), { force: true });
  mkdirSync(b.dir, { recursive: true });
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

function hooks(): LeadSocketHooks {
  const relay = new LeadRelay();
  relay.attach(() => {}, []);
  return { relay, identify: () => ({ kind: "outside" }), maskFor: () => new Masker() };
}

/** A task's worktree of the bot's checkout, as the node makes one. */
const worktreeOf = (repo: string, at: string, ref = "HEAD") => (git(repo, "worktree", "add", "-q", "--detach", at, ref), at);

/** Runs a session's setup as the node does (sessions/index.ts #setUp): from its bot's image when it has one. */
async function sessionSetup(f: ReturnType<typeof fixture>, session: string, plan: setup.Plan, cwd: string, base?: string) {
  const place = f.vm.bound({ sessionId: session, dir: join(f.node, "hosts", session), role: "worker" });
  const chose = f.images.use("p1", plan, cwd, session, "vm", base);
  // The build it started, first: a stand-in box's node.sock is this machine's, one box's at a time.
  await f.images.idle();
  const image = await startsFrom(place, chose, f.node, session, cwd, {});
  const ran: string[] = [];
  const outcome = await setup.run(place, plan, cwd, {}, [], () => {}, (_i, r) => void ran.push(r.command), undefined, image);
  // Its box goes before the next one boots, for the same reason.
  await place.stop(join(f.node, "hosts", session));
  return { place, chose, image, outcome, ran };
}

test("a bot's setup builds its image in the background, and a new session starts from it without running setup again", async () => {
  const f = fixture("a");
  const log = join(root, "a", "setup-ran.log");
  const plan: setup.Plan = { commands: [`echo "$PWD" >> '${log}'`, "echo tools installed"], inputs: ["bun.lock"] };

  // The Computer page's first look: none yet, so it builds.
  const first = f.images.status("p1", plan);
  expect(first.state).toBe("building");
  expect(first.where).toBe("vm");
  await f.images.idle();
  const ready = f.images.status("p1", plan);
  expect(ready.state).toBe("ready");
  expect(ready.builtAt).toBeDefined();
  expect(ready.bytes).toBeGreaterThanOrEqual(0);
  expect(f.changes.map((c) => c.state)).toEqual(["building", "ready"]);
  // Setup ran once, in a worktree of the bot's base, in a box over the bare root image with a disk of its own, which
  // was sealed as root (secrets searched, frozen) before it became the image, read-only.
  expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
  const build = f.boots[0]!;
  expect(build.disk).toMatch(/images\/p1-[0-9a-f]{12}\.img\.part$/);
  expect(build.layer).toBeUndefined();
  expect(build.home).toBe(BOX_HOME);
  expect(f.sealed[0]).toContain("fsfreeze -f /run/fleetd/rw");
  const file = build.disk!.replace(/\.part$/, "");
  expect(statSync(file).mode & 0o777).toBe(0o444);
  // Its build's worktree is gone with it.
  expect(git(f.repo, "worktree", "list").split("\n")).toHaveLength(1);

  // A new session of the bot: its worktree has the same lockfile, so its box starts from the image and setup doesn't run.
  const wt = worktreeOf(f.repo, join(root, "a", "wt-s1"));
  const s1 = await sessionSetup(f, "s1", plan, wt);
  expect(s1.image?.ref).toBe(file);
  expect(s1.outcome).toEqual({ kind: "image", builtAt: ready.builtAt! });
  expect(s1.ran).toEqual([]);
  expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
  expect(setup.note(s1.outcome, 600, false)).toContain("started from the bot's computer image");
  // Its box: its own disk, over its own link to the image (the same file, read-only), which the kernel line names.
  expect(statSync(sessionLayer(f.node, "s1")).ino).toBe(statSync(file).ino);
  const ran = await s1.place.run({ cwd: wt, argv: ["sh", "-c", "echo hi"], timeoutSec: 10, env: {} });
  expect(ran.exitCode).toBe(0);
  const boot = f.boots.at(-1)!;
  expect(boot.disk).toBe(sessionDisk(f.node, "s1"));
  expect(boot.layer).toBe(sessionLayer(f.node, "s1"));
  expect(statSync(boot.disk!).size).toBeGreaterThan(2 ** 30);
  expect(statSync(boot.disk!).blocks).toBe(0);
  expect(kernelCmdline({ exe: "/f", port: 1, dns: [], now: 0, home: BOX_HOME, disk: true, layer: true })).toContain("fleetd.upper=/dev/vdb fleetd.layer=/dev/vdc");

  // Its box goes between turns (the idle reap); its disk and link stay. (A stand-in box's node.sock is this machine's.)
  await s1.place.stop(join(f.node, "hosts", "s1"));
  expect(existsSync(sessionLayer(f.node, "s1"))).toBe(true);

  // The commands change: a new image is built, the old one goes from the store, and s1 keeps the one it started from.
  const changed: setup.Plan = { ...plan, commands: [...plan.commands!, "echo more"] };
  expect(f.images.status("p1", changed).state).toBe("building");
  await f.images.idle();
  expect(f.images.status("p1", changed).state).toBe("ready");
  expect(existsSync(file)).toBe(false);
  expect(existsSync(sessionLayer(f.node, "s1"))).toBe(true);
  // The task ended: its disk and its link go.
  await s1.place.end(join(f.node, "hosts", "s1"));
  expect(existsSync(sessionDisk(f.node, "s1"))).toBe(false);
  expect(existsSync(sessionLayer(f.node, "s1"))).toBe(false);
  expect(sessionImage(f.node, "s1")).toBeUndefined();
  // A Rebuild builds it again with nothing changed.
  expect(f.images.ensure("p1", changed, true).state).toBe("building");
  await f.images.idle();
  expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(3);
  f.vm.close();
}, 60_000);

test("a missing, failed or stale image is a clean start plus setup, never a failed one", async () => {
  const f = fixture("b");
  const log = join(root, "b", "setup-ran.log");
  const failing: setup.Plan = { commands: [`echo ran >> '${log}'`, "echo cargo fetch went wrong; exit 7"], inputs: ["bun.lock"] };

  // No image yet: the session starts clean and runs setup, and the image due is built for later sessions.
  const wt1 = worktreeOf(f.repo, join(root, "b", "wt-1"));
  const s1 = await sessionSetup(f, "f1", failing, wt1);
  expect(s1.image).toBeUndefined();
  expect(s1.outcome.kind).toBe("failed");
  await f.images.idle();
  // The build failed: the Computer page shows it with its log, and isn't tried again for the same commands.
  const failed = f.images.status("p1", failing);
  expect(failed.state).toBe("failed");
  expect(failed.log).toContain("cargo fetch went wrong");
  expect(failed.log).toContain("exited 7");
  expect(failed.builtAt).toBeUndefined();
  const wt2 = worktreeOf(f.repo, join(root, "b", "wt-2"));
  const s2 = await sessionSetup(f, "f2", failing, wt2);
  expect(s2.image).toBeUndefined();
  expect(s2.ran).toHaveLength(2);
  expect(f.images.status("p1", failing).state).toBe("failed");

  // A good image, then a worktree whose lockfile moved on: stale, so it starts clean and runs setup.
  const good: setup.Plan = { commands: [`echo ran >> '${log}'`], inputs: ["bun.lock"] };
  f.images.status("p1", good);
  await f.images.idle();
  expect(f.images.status("p1", good).state).toBe("ready");
  const wt3 = worktreeOf(f.repo, join(root, "b", "wt-3"));
  writeFileSync(join(wt3, "bun.lock"), "lock v2\n");
  const s3 = await sessionSetup(f, "f3", good, wt3);
  expect(s3.image).toBeUndefined();
  expect(s3.outcome.kind).toBe("done");
  expect(s3.ran).toEqual(good.commands!);

  // Setup that writes into the checkout (node_modules), which no image holds: it runs again, over the image.
  const installs: setup.Plan = { commands: ["mkdir -p node_modules && touch node_modules/x"], inputs: ["bun.lock"] };
  f.images.status("p1", installs);
  await f.images.idle();
  const wt4 = worktreeOf(f.repo, join(root, "b", "wt-4"));
  const s4 = await sessionSetup(f, "f4", installs, wt4);
  expect(s4.image?.worktree).toBe(true);
  expect(s4.outcome.kind).toBe("done");
  expect(existsSync(join(wt4, "node_modules/x"))).toBe(true);
  expect(existsSync(sessionLayer(f.node, "f4"))).toBe(true);

  // A setup that wrote a secret's value to the image's disk: the build fails, naming the file, and nothing is kept.
  const before = f.images.status("p1", installs).builtAt;
  f.vars.secrets = ["s3cr3t-value-123"];
  mkdirSync(join(f.rw, "up", "home"), { recursive: true });
  writeFileSync(join(f.rw, "up", "home", ".npmrc"), "//registry/:_authToken=s3cr3t-value-123\n");
  const leaky: setup.Plan = { commands: ["echo writes a token"], inputs: ["bun.lock"] };
  f.images.status("p1", leaky);
  await f.images.idle();
  const refused = f.images.status("p1", leaky);
  expect(refused.state).toBe("failed");
  expect(refused.log).toContain("/home/.npmrc");
  expect(refused.log).not.toContain("s3cr3t-value-123");
  expect(refused.builtAt).toBe(before);

  // Commands removed: no image, nothing to build.
  expect(f.images.status("p1", { commands: [] })).toEqual({ state: "none" });
  f.vm.close();
}, 60_000);

test("an image build's box is a box of the node's hosts dir, which the node's shutdown ends, and a failed build leaves no disk", async () => {
  const f = fixture("d");
  const go = join(root, "d", "go");
  const waiting = join(root, "d", "waiting");
  const plan: setup.Plan = { commands: [`touch '${waiting}'; until [ -e '${go}' ]; do sleep 0.05; done`], inputs: ["bun.lock"] };
  f.images.status("p1", plan);
  const until = Date.now() + 20_000;
  while (!existsSync(waiting) && Date.now() < until) await Bun.sleep(20);
  // Where a node that stops mid-build has its next one end the box at its start (the hosts sweep, the leak reaper).
  const dir = join(f.node, "hosts", "image-p1");
  expect(f.boots[0]!.dir).toBe(dir);
  const leader = readBox(dir)!.leader.pid;
  const alive = () => {
    try {
      process.kill(leader, 0);
      return true;
    } catch {
      return false;
    }
  };
  expect(alive()).toBe(true);
  const part = f.boots[0]!.disk!;
  expect(existsSync(part)).toBe(true);
  // The node shuts down: nothing would come back for the build, so its box ends with it.
  f.vm.close();
  const gone = Date.now() + 5_000;
  while (alive() && Date.now() < gone) await Bun.sleep(20);
  expect(alive()).toBe(false);
  await f.images.idle();
  expect(f.images.status("p1", plan).state).toBe("failed");
  // The failed build's disk, with whatever its setup installed, went with it.
  expect(existsSync(part)).toBe(false);
  expect(existsSync(dir)).toBe(false);
}, 60_000);

test("the image is built from the bot's base branch, which its new worktrees start from, not origin's default", async () => {
  const f = fixture("e");
  // The bot's base is `release`, whose lockfile differs from the checkout's own branch's (main).
  git(f.repo, "checkout", "-q", "-b", "release");
  writeFileSync(join(f.repo, "bun.lock"), "lock v2\n");
  git(f.repo, "commit", "-qam", "release lock");
  git(f.repo, "checkout", "-q", "main");
  const log = join(root, "e", "ran.log");
  const plan: setup.Plan = { commands: [`echo ran >> '${log}'`], inputs: ["bun.lock"] };
  // The Computer page asks with the repo's base branch.
  f.images.status("p1", plan, "release");
  await f.images.idle();
  expect(f.images.status("p1", plan).state).toBe("ready");
  // A task's worktree starts from release: same lockfile, so it starts from the image.
  const wt = worktreeOf(f.repo, join(root, "e", "wt-1"), "release");
  const s1 = await sessionSetup(f, "e1", plan, wt, "release");
  expect(s1.image).toBeDefined();
  expect(s1.outcome.kind).toBe("image");
  // The base was kept: a later look without it builds nothing new.
  expect(f.images.status("p1", plan).state).toBe("ready");
  expect(readFileSync(log, "utf8")).toBe("ran\n");
  f.vm.close();
}, 60_000);

test("a reader's or reviewer's detached worktree at a PR's head never moves the bot's image off its base", async () => {
  const f = fixture("h");
  const log = join(root, "h", "ran.log");
  const plan: setup.Plan = { commands: [`echo built >> '${log}'`], inputs: ["bun.lock"] };
  f.images.status("p1", plan, "main");
  await f.images.idle();
  expect(readFileSync(log, "utf8")).toBe("built\n");
  // A PR that changes the lockfile, which a reviewer's worktree is detached at: its base is the PR head's commit.
  git(f.repo, "checkout", "-q", "-b", "pr");
  writeFileSync(join(f.repo, "bun.lock"), "lock v2\n");
  git(f.repo, "commit", "-qam", "bump");
  const head = git(f.repo, "rev-parse", "HEAD");
  git(f.repo, "checkout", "-q", "main");
  const wt = worktreeOf(f.repo, join(root, "h", "wt-review"), head);
  // The node never asks: a detached session (no branch) takes no image.
  expect(takesImage({})).toBe(false);
  expect(takesImage({ branch: "fleetd/T1-x" })).toBe(true);
  // And were its commit named as a base, it isn't kept as the bot's: the image stays main's, built once.
  expect(f.images.use("p1", plan, wt, "r1", "vm", head)).toBeUndefined();
  await f.images.idle();
  expect(f.images.status("p1", plan).state).toBe("ready");
  expect(readFileSync(log, "utf8")).toBe("built\n");
  const wt2 = worktreeOf(f.repo, join(root, "h", "wt-task"), "main");
  expect(f.images.use("p1", plan, wt2, "t1", "vm", "main")).toBeDefined();
  f.vm.close();
}, 60_000);

test("a session whose image didn't mount, or whose box didn't come up, runs its setup: never neither", async () => {
  const f = fixture("g");
  const log = join(root, "g", "ran.log");
  const plan: setup.Plan = { commands: [`echo ran >> '${log}'`], inputs: ["bun.lock"] };
  f.images.status("p1", plan);
  await f.images.idle();
  expect(readFileSync(log, "utf8")).toBe("ran\n");
  // The image is chosen, but the box's init couldn't mount it: the choice goes and setup runs in the box.
  f.flags.mountFails = true;
  const wt1 = worktreeOf(f.repo, join(root, "g", "wt-1"));
  const s1 = await sessionSetup(f, "g1", plan, wt1);
  expect(s1.chose).toBeDefined();
  expect(s1.image).toBeUndefined();
  expect(s1.outcome.kind).toBe("done");
  expect(s1.ran).toEqual(plan.commands!);
  expect(sessionImage(f.node, "g1")).toBeUndefined();
  expect(existsSync(sessionLayer(f.node, "g1"))).toBe(false);
  // No VM comes up at all: the session runs as a plain process, and so does its setup.
  f.flags.mountFails = false;
  f.flags.bootFails = true;
  const wt2 = worktreeOf(f.repo, join(root, "g", "wt-2"));
  const s2 = await sessionSetup(f, "g2", plan, wt2);
  expect(s2.chose).toBeDefined();
  expect(s2.image).toBeUndefined();
  expect(s2.outcome.kind).toBe("done");
  expect(readFileSync(log, "utf8")).toBe("ran\nran\nran\n");
  f.vm.close();
}, 60_000);

test("an image build's seal strips what is the box's alone and refuses a secret's value", () => {
  const s = sealScript(BOX_HOME);
  expect(s).toContain(`"$up${BOX_HOME}/.claude"`);
  expect(s).toContain('"$up/run" "$up/tmp"');
  expect(s).toContain("grep -rlFa -f");
  expect(s.trimEnd().endsWith("fsfreeze -f /run/fleetd/rw")).toBe(true);
});

test("a machine whose agents don't run in VMs builds no images: the Computer page says none", () => {
  const images = new Images({ home: join(root, "c"), backend: () => undefined as Backend | undefined, root: () => root, vars: () => ({ env: {}, secrets: [] }) });
  expect(images.status("p1", { commands: ["echo"] })).toEqual({ state: "none" });
  expect(images.use("p1", { commands: ["echo"] }, root, "s", "vm")).toBeUndefined();
});
