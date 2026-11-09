// An agent survives its node's restart: the node, a systemd user service as fleetd-node is (KillMode=mixed), starts a
// session's host with its own launch, in a transient scope of its own (src/node/runner/scope.ts); `systemctl --user
// restart` of the node leaves the host running, and the node that comes up re-adopts it. Without the scope the
// restart kills the host, as it did before scopes. Skipped where no user systemd manager answers (most CI runners).
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { current } from "../../src/node/runner/scope.ts";
import { tempHome } from "../helpers.ts";

setDefaultTimeout(120_000);
const home = tempHome();
const units: string[] = [];
const hosts: number[] = [];

const run = (argv: string[]) => Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
const scopes = process.platform === "linux" && Bun.which("systemctl") !== null && (await current()) !== undefined;

afterAll(() => {
  // Only what this test started: its hosts by pid, its node units by name.
  for (const pid of hosts) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  for (const unit of units) run(["systemctl", "--user", "stop", unit]);
  home.done();
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(what: string, fn: () => boolean, ms = 30_000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

/** The session host: the fake one (fake-host.ts) as a binary of its own, as the Rust `fleetd session-host` is. */
function hostBinary(): string {
  const out = join(home.dir, "fleetd-session-host");
  if (!existsSync(out)) {
    const built = run([process.execPath, "build", "--compile", join(import.meta.dir, "fake-host.ts"), "--outfile", out]);
    if (built.exitCode !== 0) throw new Error(`couldn't build the fake host: ${built.stderr.toString()}`);
  }
  return out;
}

/** Starts the node part (scope-node.ts) as a user service; resolves with its unit and dir once it started its host. */
async function node(mode: "scoped" | "unscoped") {
  const dir = join(home.dir, mode);
  mkdirSync(dir, { recursive: true });
  const unit = `fleetd-scope-test-${process.pid}-${mode}.service`;
  units.push(unit);
  const env = ["PATH", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"].flatMap((k) => (process.env[k] ? [`--setenv=${k}=${process.env[k]}`] : []));
  const started = run([
    "systemd-run",
    "--user",
    `--unit=${unit}`,
    "--property=KillMode=mixed",
    "--quiet",
    ...env,
    process.execPath,
    join(import.meta.dir, "scope-node.ts"),
    dir,
    mode,
    hostBinary(),
  ]);
  if (started.exitCode !== 0) throw new Error(`systemd-run: ${started.stderr.toString()}`);
  await until(`${mode} host launched`, () => existsSync(join(dir, "launched")));
  const pid = Number(readFileSync(join(dir, "launched"), "utf8"));
  hosts.push(pid);
  return { unit, dir, pid };
}

const cgroup = (pid: number) => readFileSync(`/proc/${pid}/cgroup`, "utf8");

test.skipIf(!scopes)("an agent's host in its own scope survives its node's restart, and the next node re-adopts it", async () => {
  const n = await node("scoped");
  expect(alive(n.pid)).toBe(true);
  // Its own transient scope, outside the node's unit.
  expect(cgroup(n.pid)).toMatch(/\/run-[^/]+\.scope\n/);
  expect(cgroup(n.pid)).not.toContain(n.unit);
  const restarted = run(["systemctl", "--user", "restart", n.unit]);
  expect(restarted.exitCode).toBe(0);
  await until("the next node re-adopted it", () => existsSync(join(n.dir, "adopted")));
  expect(Number(readFileSync(join(n.dir, "adopted"), "utf8"))).toBe(n.pid);
  expect(alive(n.pid)).toBe(true);
});

test.skipIf(!scopes)("without a scope the node's restart kills the host, as before scopes", async () => {
  const n = await node("unscoped");
  expect(cgroup(n.pid)).toContain(n.unit);
  rmSync(join(n.dir, "launched"));
  expect(run(["systemctl", "--user", "restart", n.unit]).exitCode).toBe(0);
  await until("the next node launched a new host", () => existsSync(join(n.dir, "launched")));
  hosts.push(Number(readFileSync(join(n.dir, "launched"), "utf8")));
  expect(alive(n.pid)).toBe(false);
  expect(existsSync(join(n.dir, "adopted"))).toBe(false);
});
