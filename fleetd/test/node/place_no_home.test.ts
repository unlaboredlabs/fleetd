// A local VM sees nothing of the person's home (D557, src/node/place/view.ts and provision.ts), proven against a
// stand-in box (no KVM): a person's home with a Claude login and settings, a gh login, shell files, a toolchain, a
// package cache, another repo and the repo's main checkout; a task's worktree of that repo under the node's home. The
// box a session boots shows its worktree and the repo's git store and nothing else of that home; where this machine
// lets a user make a mount namespace, the share is assembled for real and read from as the guest reads it. And what
// the box is given instead: its own home, only its own order's variables, Claude's variables from the person's
// settings, its transcript in and back out; a machine's own Claude login never goes in.
import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import { LeadRelay, type LeadSocketHooks } from "../../src/node/lead/index.ts";
import { Masker } from "../../src/node/mask.ts";
import { readBox } from "../../src/node/place/box_record.ts";
import { MicroVm, SIGN_IN_FIX, type BootPlan, type Booted } from "../../src/node/place/microvm.ts";
import { processPlace } from "../../src/node/place/process.ts";
import { leavesBox, pick, placeAt, useVm } from "../../src/node/place/index.ts";
import { BOX_HOME, boxHome, forClaude, keepShown, NoClaudeLogin, orderRefresh, provision, transcriptBack } from "../../src/node/place/provision.ts";
import { guestOwn, mountScript, shows, under, type View } from "../../src/node/place/view.ts";
import { marker, readRegistration, startOf, type HostLink } from "../../src/node/runner/host.ts";
import type { VmCheck } from "../../src/sandbox/host/capable.ts";
import type { VmTools } from "../../src/sandbox/host/tools.ts";

const MAIN = join(import.meta.dir, "../../src/main.ts");
const tmpBase = process.env.TMPDIR ?? "/tmp";
const root = mkdtempSync(join(guestOwn(tmpBase) ? homedir() : tmpBase, "fleetd-nohome-"));
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

const write = (path: string, text: string, mode = 0o644) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode });
};
const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};

/** A person's home as the devbox's: what agents found there before, the node's home in it, a task's worktree. */
function personHome(name: string) {
  const h = join(root, name);
  const node = join(h, ".fleetd/node");
  const secrets = {
    credentials: join(h, ".claude/.credentials.json"),
    claudeSettings: join(h, ".claude/settings.json"),
    gh: join(h, ".config/gh/hosts.yml"),
    shell: join(h, ".bashrc"),
    cargo: join(h, ".cargo/bin/cargo"),
    cache: join(h, ".bun/install/cache/pkg/index.js"),
    otherRepo: join(h, "src/other/README.md"),
    checkoutFile: join(h, "src/proj/secret.env"),
    gitconfig: join(h, ".gitconfig"),
    nodeConfig: join(node, "node.json"),
    otherOrder: join(node, "order-env/p1/W2.sh"),
  };
  write(secrets.credentials, '{"claudeAiOauth":{"accessToken":"sk-ant-oat-person"}}', 0o600);
  write(secrets.claudeSettings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://localhost:8317", ANTHROPIC_AUTH_TOKEN: "gateway-token", GITHUB_TOKEN: "ghp_person" }, hooks: { Stop: [] } }));
  write(secrets.gh, "github.com:\n  oauth_token: gho_person\n", 0o600);
  write(secrets.shell, "export SECRET=1\n");
  write(secrets.cargo, "#!/bin/sh\n", 0o755);
  write(secrets.cache, "x");
  write(secrets.otherRepo, "other");
  write(secrets.gitconfig, "[user]\n\tname = Pat Person\n\temail = pat@example.com\n[credential]\n\thelper = store\n");
  write(secrets.nodeConfig, JSON.stringify({ hub: "http://hub", machineId: "m", name: "m", enrolled: true }));
  write(secrets.otherOrder, "export GH_TOKEN='other-order'\n", 0o600);
  write(join(node, "order-env/p1/W1.sh"), "export GH_TOKEN='this-order'\n", 0o600);
  // The repo's main checkout, with work of the person's own in it, and a task's worktree of it in the node's home.
  const repo = join(h, "src/proj");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  write(join(repo, "README.md"), "proj\n");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "add", ".");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  write(secrets.checkoutFile, "TOKEN=person\n");
  const wt = join(node, "worktrees/w1");
  git(repo, "worktree", "add", "-q", "-b", "fleetd/T1-x", wt);
  // Pat's name and email as git reads them in the checkout (their global config, here the repo's).
  git(repo, "config", "user.name", "Pat Person");
  git(repo, "config", "user.email", "pat@example.com");
  return { h, node, repo, wt, secrets };
}

/** The stand-in VM: sandbox-guest in a group it leads, its listen socket in the box's dir. */
async function standInBoot(b: BootPlan): Promise<Booted> {
  // A VM's node.sock and build-slots.sock are in its own view and go with it; a stand-in's are on this machine's disk.
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

function hooks(): LeadSocketHooks {
  const relay = new LeadRelay();
  relay.attach(() => {}, []);
  return { relay, identify: () => ({ kind: "outside" }), maskFor: () => new Masker() };
}

/** A claude that writes its environment where the test reads it, then a transcript line in its own Claude dir, and
 * says init. */
const CLAUDE = (out: string) => `#!/bin/sh
env > '${out}'
d="$CLAUDE_CONFIG_DIR/projects/$(pwd -P | sed 's/[^A-Za-z0-9]/-/g')"
mkdir -p "$d" && echo '{"in":"box"}' >> "$d/s1.jsonl"
echo '{"type":"system","subtype":"init","claude_code_version":"2.1.302","model":"m0","cwd":"/fake"}'
while read line; do :; done
`;

function vmFor(node: string, claudeEnv?: () => Record<string, string | undefined>) {
  const h = hooks();
  return new MicroVm({ home: node, fleetd: ["/opt/fleetd"], lead: () => h, check: () => OK, tools: () => TOOLS, boot: standInBoot, dial: unixDial, reach: async () => {}, goneMs: 1_000, ...(claudeEnv ? { claudeEnv } : {}) });
}

/** What the session's spec gives claude (sessions/index.ts #spec), as a plain process has it in the person's home. */
function sessionEnv(p: ReturnType<typeof personHome>, session: string, extra: Record<string, string> = {}) {
  const files = join(p.node, "sessions", session);
  const scratch = join(p.node, "tmp", "scratch-1");
  mkdirSync(scratch, { recursive: true });
  write(join(files, "order-env.sh"), `if [ -r '${join(p.node, "order-env/p1/W1.sh")}' ]; then . '${join(p.node, "order-env/p1/W1.sh")}'; fi\n`);
  return {
    HOME: p.h,
    PATH: `${join(p.h, ".cargo/bin")}:${join(p.h, ".bun/bin")}:/usr/bin:/bin`,
    CARGO_HOME: join(p.h, ".cargo"),
    TMPDIR: scratch,
    CLAUDE_ENV_FILE: join(files, "order-env.sh"),
    FLEETD_NODE_SOCK: join(p.node, "node.sock"),
    FLEETD_RUNNER_SESSION: marker(session),
    ...extra,
  };
}

const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([p, Bun.sleep(ms).then(() => Promise.reject(new Error(`timed out: ${what}`)))]);

async function firstInit(link: HostLink): Promise<void> {
  for (;;) {
    const e = (await within(link.next(), 10_000, "an event")) as Record<string, unknown> | undefined;
    expect(e).toBeDefined();
    link.applied++;
    if (typeof e === "object" && "Init" in e!) return;
  }
}

/** Whether this machine lets a user make a user and mount namespace and mount in it (CI's may not). */
const canUnshare = Bun.spawnSync(["unshare", "--user", "--map-root-user", "--mount", "--", "/bin/sh", "-c", "mount -t tmpfs t /mnt 2>/dev/null || mount -t tmpfs t /tmp"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

test("a VM agent's box shows nothing of the person's home but its worktree and the repo's git store", async () => {
  const p = personHome("home-a");
  const vm = vmFor(p.node);
  const dir = join(p.node, "hosts", "s1");
  const seen = join(root, "env-a.txt");
  const claudeBin = join(p.h, ".local/bin/claude");
  write(claudeBin, CLAUDE(seen), 0o755);
  const link = await vm.bound({ sessionId: "s1", dir, role: "worker" }).start({
    fleetd: [process.execPath, MAIN],
    dir,
    sessionId: "s1",
    program: claudeBin,
    // The repo's main checkout is claude's --add-dir on this machine.
    args: ["--add-dir", p.repo, "--mcp-config", join(p.node, "sessions/s1/order-env.sh")],
    cwd: p.wt,
    env: sessionEnv(p, "s1"),
  });
  await firstInit(link);
  expect(vm.status()).toEqual({ kind: "microvm" });
  const view = readBox(dir)!.view!;
  expect(view.home).toBeUndefined();
  // Its worktree and the repo's git store, writable.
  expect(shows(view, { path: join(p.wt, "README.md"), rw: true })).toBe(true);
  expect(shows(view, { path: join(p.repo, ".git/objects"), rw: true })).toBe(true);
  // Nothing else of the person's home: their Claude login and settings, gh login, shell files, toolchain, package
  // cache, other repos, the repo's main checkout, their git config; and nothing of the node's but this session's own.
  for (const path of Object.values(p.secrets)) expect([path, shows(view, { path, rw: false })]).toEqual([path, false]);
  expect(shows(view, { path: p.h, rw: false })).toBe(false);
  expect(shows(view, { path: join(p.repo, "README.md"), rw: false })).toBe(false);
  // Every share is the worktree, its git store, or fleetd's own for this session (its files, scratch, its VM home).
  const allowed = [p.wt, join(p.repo, ".git"), join(p.node, "sessions/s1"), join(p.node, "tmp/scratch-1"), join(p.node, "update"), join(p.node, "vm/homes/s1"), join(p.node, "vm/cache"), join(p.node, "vm/env/s1"), join(p.node, "vm/claude"), "/opt/fleetd"];
  for (const s of view.shares) expect([s.path, allowed.some((a) => under(s.path, a))]).toEqual([s.path, true]);

  // What its claude ran with: a home of its own on its disk, its own files here, none of the person's paths, only its
  // own order's token.
  const env = Object.fromEntries(readFileSync(seen, "utf8").trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  expect(env.HOME).toBe(BOX_HOME);
  expect(env.CLAUDE_CONFIG_DIR).toBe(join(boxHome(p.node, "s1"), ".claude"));
  expect(env.CARGO_HOME).toBeUndefined();
  expect(env.PATH).not.toContain(p.h + "/.cargo");
  expect(env.PATH).toContain(join(BOX_HOME, ".cargo/bin"));
  // agent-browser's socket, which under that home would be past a socket path's limit.
  expect(env.AGENT_BROWSER_SOCKET_DIR).toBe("/tmp/agent-browser");
  const sourced = readFileSync(env.CLAUDE_ENV_FILE!, "utf8");
  expect(sourced).not.toContain("order-env/p1");
  const copies = [...new Set([...sourced.matchAll(/'(\/[^']+)'/gu)].map((m) => m[1]!))];
  expect(copies.map((c) => readFileSync(c, "utf8"))).toEqual(["export GH_TOKEN='this-order'\n"]);
  // Claude's own variables from the person's settings, and nothing else of them.
  expect(JSON.parse(readFileSync(join(env.CLAUDE_CONFIG_DIR!, "settings.json"), "utf8"))).toEqual({ env: { ANTHROPIC_BASE_URL: "http://localhost:8317", ANTHROPIC_AUTH_TOKEN: "gateway-token" } });
  // Git's name and email, and nothing else of the person's git config.
  expect(env.GIT_CONFIG_GLOBAL).toBe(join(boxHome(p.node, "s1"), ".gitconfig"));
  expect(readFileSync(env.GIT_CONFIG_GLOBAL!, "utf8")).toBe('[user]\n\tname = "Pat Person"\n\temail = "pat@example.com"\n');

  // The transcript comes back to the machine's Claude dir once the box is done: what --resume reads next.
  await vm.bound({ sessionId: "s1", dir, role: "worker" }).end(dir);
  const back = join(p.h, ".claude/projects", p.wt.replace(/[^A-Za-z0-9]/g, "-"), "s1.jsonl");
  expect(readFileSync(back, "utf8")).toBe('{"in":"box"}\n');
  // The task ended: its VM home and copies go.
  expect(existsSync(boxHome(p.node, "s1"))).toBe(false);
  expect(readRegistration(dir)).toBeUndefined();
}, 30_000);

test.skipIf(!canUnshare)("the share, assembled as a VM's virtiofsd serves it, reads the worktree and git store, never the home, and holds the guest's node.sock", () => {
  const p = personHome("home-b");
  const view: View = {
    shares: [
      { path: p.wt, rw: true },
      { path: join(p.repo, ".git"), rw: true },
      { path: join(p.node, "sessions/s2"), rw: false },
    ],
  };
  mkdirSync(join(p.node, "sessions/s2"), { recursive: true });
  const at = join(root, "view-b");
  mkdirSync(at, { recursive: true });
  const v = (x: string) => at + x;
  // What the guest does with the view: read each thing, and write where it may.
  const probe = [
    `cat '${v(join(p.wt, "README.md"))}'`,
    `test -d '${v(join(p.repo, ".git/objects"))}' && echo git-store`,
    `echo w > '${v(join(p.wt, "new.txt"))}' && echo wrote-worktree`,
    ...Object.values(p.secrets).map((s) => `cat '${v(s)}' 2>/dev/null && echo LEAK`),
    `ls -A '${v(p.h)}'`,
    `(echo x > '${v(join(p.h, "planted"))}') 2>/dev/null; true`,
    // The guest's own node.sock, at its path in the node's home, which no share holds (sandbox-guest listens there).
    `(cd '${v(p.node)}' && python3 -c 'import socket; socket.socket(socket.AF_UNIX).bind("node.sock"); print("node-sock")')`,
    // What the guest writes between the shares stays there, a megabyte at most.
    `(head -c 2000000 /dev/zero > '${v(join(p.h, "big"))}') 2>/dev/null || echo capped`,
    `(echo x > '${v(join(p.node, "sessions/s2/x"))}') 2>/dev/null && echo LEAK-RO`,
    "true",
  ].join("; ");
  const script = mountScript(view, at, ["/bin/sh", "-c", probe]);
  const r = Bun.spawnSync(["unshare", "--user", "--map-root-user", "--mount", "--propagation", "private", "--", "/bin/bash", "-c", script], { stdout: "pipe", stderr: "pipe" });
  const out = r.stdout.toString();
  expect([r.exitCode, r.stderr.toString()]).toEqual([0, ""]);
  expect(out).toContain("proj\n");
  expect(out).toContain("git-store\n");
  expect(out).toContain("wrote-worktree\n");
  expect(out).toContain("node-sock\n");
  expect(out).toContain("capped\n");
  expect(out).not.toContain("LEAK");
  // The home holds only the way down to the node's files and the repo's git store, and what the guest writes there
  // never reaches this machine's.
  expect(out).toContain(".fleetd\nsrc\n");
  expect(existsSync(join(p.h, "planted"))).toBe(false);
  expect(existsSync(join(p.node, "node.sock"))).toBe(false);
});

test("what a box is given: a value naming a place of the home it doesn't have is left out, a word or URL stays", () => {
  const p = personHome("home-c");
  const shown = (x: string) => guestOwn(x) || under(x, p.wt);
  expect(keepShown(`${join(p.h, ".cargo/bin")}:/usr/bin:${p.wt}`, shown)).toBe(`/usr/bin:${p.wt}`);
  expect(keepShown(join(p.h, ".cargo"), shown)).toBeUndefined();
  expect(keepShown("http://localhost:8317", shown)).toBe("http://localhost:8317");
  expect(keepShown("main", shown)).toBe("main");
  // A path this machine doesn't have (a socket the guest listens at, say) stays.
  expect(keepShown(join(p.node, "node.sock"), shown)).toBe(join(p.node, "node.sock"));
  // The order's variables renewed by the node reach the box's copy; another order's never do.
  const given = provision({ node: p.node, session: "s3", cwd: p.wt, env: sessionEnv(p, "s3") });
  const copy = [...readFileSync(given.env.CLAUDE_ENV_FILE!, "utf8").matchAll(/'(\/[^']+)'/gu)].map((m) => m[1]!)[0]!;
  write(join(p.node, "order-env/p1/W1.sh"), "export GH_TOKEN='renewed'\n", 0o600);
  utimesSync(join(p.node, "order-env/p1/W1.sh"), new Date(), new Date(Date.now() + 5_000));
  given.refresh();
  expect(readFileSync(copy, "utf8")).toBe("export GH_TOKEN='renewed'\n");
  // A node after this one, adopting the box without its launch, goes on copying them in.
  const adopted = orderRefresh(p.node, "s3")!;
  write(join(p.node, "order-env/p1/W1.sh"), "export GH_TOKEN='renewed again'\n", 0o600);
  utimesSync(join(p.node, "order-env/p1/W1.sh"), new Date(), new Date(Date.now() + 10_000));
  adopted();
  expect(readFileSync(copy, "utf8")).toBe("export GH_TOKEN='renewed again'\n");
  expect(given.ro.concat(given.rw).some((x) => under(join(p.node, "order-env"), x) || under(x, join(p.node, "order-env")))).toBe(false);
});

test("a machine's own Claude login never goes into a box: its agent runs as a plain process, one on a bot's Claude account in a VM, and the machine says which", async () => {
  const p = personHome("home-d");
  // The person's settings without a token: the login is the OAuth one in .credentials.json.
  write(p.secrets.claudeSettings, JSON.stringify({ env: { DISABLE_AUTOUPDATER: "1" } }));
  const env = sessionEnv(p, "s4");
  const given = provision({ node: p.node, session: "s4", cwd: p.wt, env });
  const claudeBin = join(p.h, ".local/bin/claude");
  write(claudeBin, CLAUDE(join(root, "env-d.txt")), 0o755);
  expect(() => forClaude({ node: p.node, session: "s4", cwd: p.wt, env, program: claudeBin, boxEnv: given.env })).toThrow(NoClaudeLogin);
  expect(() => forClaude({ node: p.node, session: "s4", cwd: p.wt, env, program: claudeBin, boxEnv: given.env })).toThrow("its own login (`claude login`)");
  // A bot's Claude account signs it in.
  expect(forClaude({ node: p.node, session: "s4", cwd: p.wt, env, program: claudeBin, boxEnv: { ...given.env, CLAUDE_CODE_OAUTH_TOKEN: "acct" } }).program).toStartWith(join(p.node, "vm/claude/"));
  // At the start, on a machine whose node knows its own Claude environment (the login, nothing a VM can be given): no
  // box, the session as a plain process on this machine.
  const vm = vmFor(p.node, () => ({ HOME: p.h }));
  const dir = join(p.node, "hosts", "s4");
  const link = await vm.bound({ sessionId: "s4", dir, role: "worker" }).start({ fleetd: [process.execPath, MAIN], dir, sessionId: "s4", program: claudeBin, args: [], cwd: p.wt, env });
  await firstInit(link);
  expect(readBox(dir)).toBeUndefined();
  // Not the machine's VMs: only this session. The machine runs agents in VMs still, and says which don't, why and the
  // fix, in its status (the app's and the doctor's line), never "in VMs" with nothing more while some aren't.
  const status = vm.status();
  expect(status).toEqual({ kind: "microvm", why: expect.stringContaining("its own login (`claude login`)"), fix: SIGN_IN_FIX, accountsOnly: true });
  expect(status.why).toContain("agents whose bot has no Claude account run as plain processes");
  expect(status.why).toContain("~/.fleetd/claude.env as CLAUDE_CODE_OAUTH_TOKEN=<token>");
  expect(SIGN_IN_FIX).toBe("claude setup-token");
  // Another bot's agent on the same machine, on its Claude account (its session's own token, actions/accounts.ts):
  // in a VM of its own.
  const acct = join(p.node, "hosts", "s5");
  const inBox = await vm.bound({ sessionId: "s5", dir: acct, role: "worker" }).start({
    fleetd: [process.execPath, MAIN],
    dir: acct,
    sessionId: "s5",
    program: claudeBin,
    args: [],
    cwd: p.wt,
    env: { ...sessionEnv(p, "s5"), CLAUDE_CODE_OAUTH_TOKEN: "account-token" },
  });
  await firstInit(inBox);
  expect(readBox(acct)).toBeDefined();
  await vm.bound({ sessionId: "s5", dir: acct, role: "worker" }).end(acct);

  // Setup and its agent run in the same place, picked once per session (index.ts pick, as sessions/index.ts asks it
  // for setup and for the start): a session with no Claude account runs both as plain processes, never its setup in a
  // VM whose home and tools its agent wouldn't have; one on a bot's account runs both in a VM.
  useVm(vm);
  try {
    for (const [id, account] of [["s6", false], ["s7", true]] as const) {
      const d = join(p.node, "hosts", id);
      const env6 = { ...sessionEnv(p, id), ...(account ? { CLAUDE_CODE_OAUTH_TOKEN: "account-token" } : {}) };
      const forSetup = pick({ sessionId: id, dir: d, role: "worker", account });
      expect(forSetup.kind).toBe(account ? "microvm" : "process");
      const ran = await forSetup.run({ cwd: p.wt, argv: ["sh", "-c", "echo $HOME"], timeoutSec: 10, env: env6 });
      expect(ran.exitCode).toBe(0);
      // A plain process's setup has the machine's home, a VM's its own.
      expect(ran.outputTail.trim()).toBe(account ? BOX_HOME : p.h);
      const forStart = pick({ sessionId: id, dir: d, role: "worker", account });
      expect(forStart.kind).toBe(forSetup.kind);
      const started = await forStart.start({ fleetd: [process.execPath, MAIN], dir: d, sessionId: id, program: claudeBin, args: [], cwd: p.wt, env: env6 });
      await firstInit(started);
      expect(readBox(d) !== undefined).toBe(account);
      // Neither is moved between turns: each stays where it was picked.
      if (account) expect(leavesBox(d, [], true)).toBe(false);
      await placeAt(d).end(d);
    }
  } finally {
    useVm(undefined);
  }
  // Its task ends where its session ran, as a plain process: what its VM was given goes too (its home, its copies of
  // the order's variables), never left on this machine's disk.
  expect(existsSync(boxHome(p.node, "s4"))).toBe(true);
  await processPlace.end(dir);
  expect(existsSync(boxHome(p.node, "s4"))).toBe(false);
  expect(existsSync(join(p.node, "vm/env/s4"))).toBe(false);
  vm.close();
  // A token in claude.env (the node's environment), or one in Claude's settings: every agent in a VM, nothing to say.
  const token = new MicroVm({ ...vm.o, claudeEnv: () => ({ HOME: p.h, CLAUDE_CODE_OAUTH_TOKEN: "t" }) });
  expect(token.status()).toEqual({ kind: "microvm" });
  token.close();
  write(p.secrets.claudeSettings, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "gw" } }));
  const settings = new MicroVm({ ...vm.o });
  expect(settings.status()).toEqual({ kind: "microvm" });
  settings.close();
}, 30_000);

test("a transcript comes back only when the box's is newer, and a missing one changes nothing", () => {
  const here = join(root, "t/here/s.jsonl");
  const box = join(root, "t/box/s.jsonl");
  transcriptBack({ here, box });
  expect(existsSync(here)).toBe(false);
  write(box, "a\nb\n");
  transcriptBack({ here, box });
  expect(readFileSync(here, "utf8")).toBe("a\nb\n");
  write(here, "a\nb\nc-here\n");
  utimesSync(box, new Date(0), new Date(0));
  transcriptBack({ here, box });
  expect(readFileSync(here, "utf8")).toBe("a\nb\nc-here\n");
  chmodSync(here, 0o600);
});
