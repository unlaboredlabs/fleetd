// `bun scripts/cutover-lab.ts --rust <fleetd> --bun <fleetd> [--keep]`: the cutover to Bun and its rollback, rehearsed on
// a throwaway fleet (docs/cutover/bun.md): a hub machine and two node machines, each with its own HOME, FLEETD_HOME and
// install, started from Rust; then the hub switched to Bun with `fleetd update --flavour bun`, the nodes one by one,
// and all three back to Rust: one node by the offline rollback (the Rust session host beside the Bun build copied
// back), the rest with `fleetd update --flavour rust`. After each step: the hub's /healthz, every machine linked on the
// build it should run, and the hub's database what both flavours open (scripts/db-check.ts, on a copy).
//
// --rust and --bun are release builds of one version (FLEETD_VERSION set at build: `cargo build -p fleetd` with it in
// the environment, `.github/release/bun-build.sh`). They are served as a release feed on loopback (FLEETD_BASE_URL).
// Nothing here reaches the live fleet: every command gets an environment of its own (never this one's FLEETD_* or
// PATH), `systemctl` and `systemd-run` on its PATH are stand-ins that only record the call (the harness restarts the
// processes itself, each by the PID it started), and `claude` is the factory lab's offline stand-in. Linux only.
import { spawn, spawnSync, type Subprocess } from "bun";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
const rustBin = opt("--rust");
const bunBin = opt("--bun");
if (!rustBin || !bunBin || process.platform !== "linux") {
  console.error("usage (Linux): bun scripts/cutover-lab.ts --rust <fleetd> --bun <fleetd> [--keep]");
  process.exit(2);
}
const keep = argv.includes("--keep");
const arch = process.arch === "arm64" ? "arm64" : "x64";
const RUST = `fleetd-linux-${arch}`;
const BUN = `fleetd-bun-linux-${arch}`;
const TESTED = /pub const TESTED: &str = "([^"]+)";/.exec(readFileSync(join(import.meta.dir, "../../../crates/fleetd/src/node/runner/claude/version.rs"), "utf8"))![1]!;

const D = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "cutover-lab-"));
const log = (line: string) => console.log(`[cutover-lab] ${line}`);
let failures = 0;
const check = (ok: boolean, what: string) => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  return ok;
};
const sha = (path: string) => new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, ms: number, probe: () => Promise<T | undefined> | T | undefined): Promise<T | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await probe();
    if (v !== undefined) return v;
    await sleep(300);
  }
  check(false, `${what} (gave up after ${ms / 1000} s)`);
  return undefined;
}

// The version both builds say they are: the feed's release.
const versionOf = (bin: string) => /\(([^,]+), protocol/.exec(spawnSync([bin, "--version"]).stdout.toString())?.[1];
const VERSION = versionOf(rustBin);
if (!VERSION || VERSION !== versionOf(bunBin) || VERSION === "0.0.0") {
  console.error(`cutover-lab: --rust says ${VERSION}, --bun ${versionOf(bunBin)}: build both as one release version`);
  process.exit(2);
}

// The release feed.
const feedDir = join(D, "feed");
mkdirSync(feedDir, { recursive: true });
copyFileSync(rustBin, join(feedDir, RUST));
copyFileSync(bunBin, join(feedDir, BUN));
writeFileSync(join(feedDir, "SHA256SUMS"), `${sha(join(feedDir, RUST))}  ${RUST}\n${sha(join(feedDir, BUN))}  ${BUN}\n`);
writeFileSync(join(feedDir, "release.json"), JSON.stringify({ channel: "edge", version: VERSION, cliVersion: VERSION }));
const feed = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (req) => {
    const name = new URL(req.url).pathname.slice(1);
    const path = join(feedDir, name);
    return name.includes("/") || !existsSync(path) ? new Response("not found", { status: 404 }) : new Response(Bun.file(path));
  },
});

// The stand-ins every machine's PATH starts with, then only the system's own directories: no fleetd from this machine.
const fake = join(D, "fakebin");
mkdirSync(fake);
const calls = join(D, "service-calls.log");
writeFileSync(join(fake, "systemctl"), `#!/bin/sh\necho "systemctl $*" >> '${calls}'\n`, { mode: 0o755 });
writeFileSync(join(fake, "systemd-run"), `#!/bin/sh\necho "systemd-run $*" >> '${calls}'\nexit 1\n`, { mode: 0o755 });
// The lab's offline claude (tests/lab/factory/fakeClaude.ts), saying it is the tested version so `fleetd update` leaves
// it be.
const fakeClaude = join(import.meta.dir, "../../../tests/lab/factory/fakeClaude.ts");
writeFileSync(join(fake, "claude"), `#!/bin/sh\n[ "$1" = --version ] && { echo "${TESTED} (Claude Code)"; exit 0; }\nexec '${process.execPath}' '${fakeClaude}' "$@"\n`, { mode: 0o755 });
const PATH = `${fake}:/usr/local/bin:/usr/bin:/bin`;

const freePort = () => {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const p = s.port;
  s.stop(true);
  return p;
};
const port = freePort();
const hubUrl = `http://127.0.0.1:${port}`;

type Machine = { name: string; home: string; exe: string; fleetdHome: string; nodeHome: string; env: Record<string, string>; args: string[]; proc?: Subprocess };
const machine = (name: string, hub: boolean): Machine => {
  const home = join(D, name);
  const exe = join(home, ".local/bin/fleetd");
  mkdirSync(dirname(exe), { recursive: true });
  copyFileSync(rustBin, exe);
  chmodSync(exe, 0o755);
  const fleetdHome = join(home, ".fleetd");
  const nodeHome = join(fleetdHome, "node");
  const args = hub ? ["hub", "start", "--home", join(fleetdHome, "hub"), "--listen", `127.0.0.1:${port}`] : ["node", "run", "--home", nodeHome];
  // The service `fleetd init` would have made for this binary: what `fleetd update` finds and restarts. A name of its
  // own, so even a real systemctl would find no such unit.
  const units = join(home, ".config/systemd/user");
  mkdirSync(units, { recursive: true });
  writeFileSync(join(units, `fleetd-${hub ? "hub" : "node"}-lab.service`), `[Service]\nExecStart=${exe} ${args.join(" ")}\n`);
  const env = {
    HOME: home,
    PATH,
    LANG: "C.UTF-8",
    USER: process.env.USER ?? "lab",
    FLEETD_HOME: fleetdHome,
    FLEETD_NODE_SOCK: join(nodeHome, "node.sock"),
    FLEETD_BASE_URL: `http://127.0.0.1:${feed.port}`,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_RUNTIME_DIR: join(home, "run"),
    // On disk, never a /tmp that may be held in memory; the Rust node has no temp dir of its own without it.
    TMPDIR: join(home, "tmp"),
    // The user's own caches, so each new machine doesn't download Chrome and agent-browser again.
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache/ms-playwright"),
    npm_config_cache: process.env.npm_config_cache || join(homedir(), ".npm"),
  };
  mkdirSync(env.XDG_RUNTIME_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(env.TMPDIR, { recursive: true });
  return { name, home, exe, fleetdHome, nodeHome, env, args };
};
const hub = machine("hubm", true);
const nodes = [machine("node-a", false), machine("node-b", false)];
const all = [hub, ...nodes];

/** A command of `m`'s build, awaited: never spawnSync, which would stall the feed this process serves. */
const run = async (m: Machine, args: string[]) => {
  const p = spawn([m.exe, ...args], { env: m.env, cwd: m.home, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: out + err };
};
/** Starts `m` from the build at its path, its output in a log of this start's own. */
const startLogged = (m: Machine, args = m.args) => {
  const logs = join(D, "logs");
  mkdirSync(logs, { recursive: true });
  const out = Bun.file(join(logs, `${m.name}-${Date.now()}.log`));
  m.proc = spawn([m.exe, ...args], { env: m.env, cwd: m.home, stdout: out, stderr: out });
  log(`started ${m.name} pid=${m.proc.pid} (${flavourOf(m)}): ${args.join(" ")}`);
};
const stop = async (m: Machine) => {
  const p = m.proc;
  if (!p || p.exitCode !== null) return;
  p.kill("SIGTERM");
  const timer = setTimeout(() => p.kill("SIGKILL"), 15_000);
  await p.exited;
  clearTimeout(timer);
  log(`stopped ${m.name} pid=${p.pid}`);
};
const flavourOf = (m: Machine) => {
  const s = sha(m.exe);
  return s === sha(join(feedDir, BUN)) ? "bun" : s === sha(join(feedDir, RUST)) ? "rust" : "other";
};
/** What the service manager would do on `systemctl --user restart`: the harness's own stop and start. */
const restarted = async (m: Machine) => {
  const said = existsSync(calls) ? readFileSync(calls, "utf8") : "";
  check(said.includes(`restart fleetd-${m === hub ? "hub" : "node"}-lab.service`), `${m.name}: fleetd update restarted its service`);
  rmSync(calls, { force: true });
  await stop(m);
  startLogged(m);
};

const healthy = () =>
  until("hub /healthz", 60_000, async () => ((await fetch(`${hubUrl}/healthz`).then((r) => r.ok, () => false)) ? true : undefined));
const keyFile = join(D, "read.key");
/** `fleetd_status` through the hub's MCP endpoint, with the read key. */
async function fleetdStatus(): Promise<{ machines?: { machineId: string; status: string }[] } | undefined> {
  const post = async (body: unknown, session?: string) => {
    const r = await fetch(`${hubUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${readFileSync(keyFile, "utf8").trim()}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session === undefined ? {} : { "mcp-session-id": session }),
      },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    return { session: r.headers.get("mcp-session-id") ?? session, body: JSON.parse(text.startsWith("{") ? text : (/^data: (.*)$/mu.exec(text)?.[1] ?? "{}")) };
  };
  try {
    const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cutover-lab", version: "0" } } });
    const r = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "fleetd_status", arguments: {} } }, init.session ?? undefined);
    return JSON.parse(r.body.result?.content?.[0]?.text ?? "{}");
  } catch {
    return undefined;
  }
}
/** Every node online, on `flavours`' builds (by what is installed at each one's path; each node runs its own). */
async function linked(step: string, flavours: Record<string, "rust" | "bun">) {
  check((await healthy()) === true, `${step}: hub /healthz`);
  check(flavourOf(hub) === flavours[hub.name], `${step}: hub runs ${flavours[hub.name]}`);
  let last: unknown;
  const online = await until(`${step}: machines linked`, 90_000, async () => {
    const ms = (await fleetdStatus())?.machines ?? [];
    last = ms.map((m) => `${m.machineId}:${m.status}`);
    return nodes.every((n) => ms.some((m) => m.machineId === n.name && m.status === "online")) ? ms : undefined;
  });
  if (!online) log(`${step}: machines last seen ${JSON.stringify(last)}`);
  if (online) check(true, `${step}: ${nodes.map((n) => n.name).join(" and ")} linked`);
  for (const n of nodes) check(flavourOf(n) === flavours[n.name], `${step}: ${n.name} runs ${flavours[n.name]}`);
}

/** `fleetd update --flavour <to>` on `m`, checked: the build at its path, the Rust session host beside a Bun one. */
async function switchTo(m: Machine, to: "rust" | "bun") {
  const r = await run(m, ["update", "--flavour", to, "--now"]);
  log(`${m.name}: fleetd update --flavour ${to}: ${r.out.trim().split("\n").join(" | ")}`);
  check(r.code === 0, `${m.name}: fleetd update --flavour ${to} exits 0`);
  check(flavourOf(m) === to, `${m.name}: ${to} build at ${m.exe}`);
  if (to === "bun") check(existsSync(join(dirname(m.exe), "fleetd-session-host")) && sha(join(dirname(m.exe), "fleetd-session-host")) === sha(join(feedDir, RUST)), `${m.name}: the Rust build beside it as fleetd-session-host`);
  await restarted(m);
}

/** The hub's database, copied while the hub is stopped, through scripts/db-check.ts. */
async function dbCheck(step: string) {
  const copy = join(D, "db-copy.sqlite");
  const src = join(hub.fleetdHome, "hub/hub.sqlite");
  spawnSync(["python3", "-I", "-c", "import sqlite3,sys;s=sqlite3.connect(sys.argv[1]);d=sqlite3.connect(sys.argv[2]);s.backup(d)", src, copy]);
  const r = spawnSync(["bun", join(import.meta.dir, "db-check.ts"), copy], { env: { PATH: process.env.PATH ?? "", TMPDIR: D } });
  check(r.exitCode === 0, `${step}: db-check on the hub's database: ${r.stdout.toString().trim().split("\n").at(-1)}`);
  rmSync(copy, { force: true });
}

let ok = false;
try {
  log(`fleet under ${D}; feed ${feed.url}; release ${VERSION}`);
  // Rust everywhere, as today.
  startLogged(hub);
  check((await healthy()) === true, "rust: hub /healthz");
  check((await run(hub, ["hub", "key", "create", "--name", "lab-read", "--role", "read", "--machines", "*", "--out", keyFile])).code === 0, "rust: a read key");
  for (const n of nodes) {
    const token = /--code (\S+)/.exec((await run(hub, ["pair", "--worker", n.name])).out)?.[1];
    check(token !== undefined, `rust: an enrollment code for ${n.name}`);
    startLogged(n, ["node", "join", "--hub", hubUrl, "--token", token ?? "", "--machine", n.name, "--home", n.nodeHome]);
  }
  await linked("rust", { hubm: "rust", "node-a": "rust", "node-b": "rust" });

  // 1. The hub first.
  await switchTo(hub, "bun");
  await linked("bun hub", { hubm: "bun", "node-a": "rust", "node-b": "rust" });
  // The Bun build writes the database (a key, as the CLI does while the hub runs).
  check((await run(hub, ["hub", "key", "create", "--name", "written-by-bun", "--role", "read", "--machines", "*", "--out", join(D, "bun.key")])).code === 0, "bun hub: the Bun CLI writes a key into its database");
  // 2. The machines one by one.
  await switchTo(nodes[0]!, "bun");
  await linked("bun node-a", { hubm: "bun", "node-a": "bun", "node-b": "rust" });
  await switchTo(nodes[1]!, "bun");
  await linked("all bun", { hubm: "bun", "node-a": "bun", "node-b": "bun" });
  await stop(hub);
  await dbCheck("all bun");
  startLogged(hub);
  await linked("all bun, hub restarted", { hubm: "bun", "node-a": "bun", "node-b": "bun" });

  // Rollback, step by step in reverse. node-b with the command; node-a offline, from the session host beside it.
  await switchTo(nodes[1]!, "rust");
  await linked("rollback node-b", { hubm: "bun", "node-a": "bun", "node-b": "rust" });
  const a = nodes[0]!;
  const helper = join(dirname(a.exe), "fleetd-session-host");
  copyFileSync(helper, join(dirname(a.exe), ".fleetd.new"));
  renameSync(join(dirname(a.exe), ".fleetd.new"), a.exe);
  check(flavourOf(a) === "rust", "rollback node-a: the session host copied over the Bun build is the Rust build");
  await stop(a);
  startLogged(a);
  await linked("rollback node-a", { hubm: "bun", "node-a": "rust", "node-b": "rust" });
  // The hub last: the Rust hub on the database the Bun hub wrote.
  await switchTo(hub, "rust");
  await linked("rollback hub", { hubm: "rust", "node-a": "rust", "node-b": "rust" });
  const keys = (await run(hub, ["hub", "key", "list"])).out;
  check(keys.includes("written-by-bun"), "rollback hub: the Rust hub lists the key the Bun build wrote");
  await stop(hub);
  await dbCheck("rollback");
  ok = failures === 0;
} finally {
  for (const m of all) await stop(m);
  feed.stop(true);
  log(`logs in ${join(D, "logs")}`);
  if (!keep && ok) rmSync(D, { recursive: true, force: true });
  else log(`kept ${D}`);
}
console.log(failures === 0 ? "cutover-lab: every step passed" : `cutover-lab: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
