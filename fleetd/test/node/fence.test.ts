// A signal from inside a session reaches only that session's own processes (src/node/runner/host/fence.ts). On
// 2026-11-21 an agent's cleanup loop sent SIGTERM to every process of the user, `systemd --user`, the hub and the node
// included. Here real session hosts (`fleetd session-host`, as the node starts one for an agent or a lead) run a
// stand-in claude that signals a stand-in hub, node and another session, every one a process this test started:
// each refuses it, while the session still stops its own children (a setsid or a double fork too) and sees every
// process, and the node still stops the session. Skipped where the kernel's Landlock can't scope signals (before
// Linux 6.12, macOS).
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HostLink, launch, readRegistration, stop } from "../../src/node/runner/host.ts";
import { landlockAbi, SIGNAL_ABI } from "../../src/node/runner/host/fence.ts";
import { tempHome } from "../helpers.ts";

setDefaultTimeout(60_000);
const fenceable = process.platform === "linux" && landlockAbi() >= SIGNAL_ABI;
const home = tempHome();
const main = join(import.meta.dir, "../../src/main.ts");
const started: Bun.Subprocess[] = [];
const links: HostLink[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const link of links) await link.detach();
  for (const dir of dirs) await stop(dir);
  // Only what this test started, by pid.
  for (const p of started) p.kill("SIGKILL");
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

async function until(what: string, fn: () => boolean, ms = 20_000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

/** A process outside every session, as the hub, the node or `systemd --user` is: a `sleep` this test owns. */
function standIn(): number {
  const p = Bun.spawn(["sleep", "300"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  started.push(p);
  return p.pid;
}

/** Starts a session as the node does, its stand-in claude `script` run with `args`; its host dir and registration. */
async function session(name: string, script: string, args: string[] = []) {
  const program = join(home.dir, `claude-${name}`);
  writeFileSync(program, script);
  chmodSync(program, 0o755);
  const dir = join(home.dir, "hosts", name);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  const link = await launch({
    fleetd: [process.execPath, main],
    dir,
    sessionId: name,
    program,
    args,
    cwd: home.dir,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home.dir, FLEETD_HOME: join(home.dir, ".fleetd"), FLEETD_HUB_URL: "http://127.0.0.1:1" },
  });
  links.push(link);
  return { dir, registration: readRegistration(dir)! };
}

/** A claude that waits until its stdin closes. */
const IDLE = "#!/bin/sh\nexec cat > /dev/null\n";

/** Signals each pid it's given, then its own children, and says in `$1` what landed and what the kernel refused. */
const SIGNALLING = `#!/bin/sh
out="$1"; shift
# Landed, refused (EPERM) or gone (ESRCH): \`$2\` words it.
send() { if kill "$1" "$2" 2>"$out.err"; then echo "$2 $3landed"; elif grep -q "not permitted" "$out.err"; then echo "$2 $3refused"; else echo "$2 $3gone"; fi; }
for p in "$@"; do send -TERM "$p"; done > "$out.tmp"
# Its own child, a setsid one and a double-forked one: each stops.
sleep 300 & own=$!
kill "$own" && echo "own stopped" >> "$out.tmp"
setsid sh -c 'sleep 300 & echo $! > "$0.setsid"; wait' "$out" &
while [ ! -s "$out.setsid" ]; do sleep 0.01; done
kill "$(cat "$out.setsid")" && echo "setsid stopped" >> "$out.tmp"
# A double fork, gone from claude's tree, probes the stand-ins too.
( ( for p in "$@"; do send -0 "$p" "probe "; done > "$out.double.tmp"; mv "$out.double.tmp" "$out.double" ) & )
while [ ! -e "$out.double" ]; do sleep 0.01; done
cat "$out.double" >> "$out.tmp"
# Every process stays in sight.
for p in "$@"; do [ -d "/proc/$p" ] && echo "$p seen"; done >> "$out.tmp"
mv "$out.tmp" "$out"
exec cat > /dev/null
`;

test.if(fenceable)("a signal from inside a session reaches none of a stand-in hub, node or other session, and the node still stops it", async () => {
  const hub = standIn();
  const node = standIn();
  const other = await session("other", IDLE);
  const others = [other.registration.hostPid, other.registration.pid];
  const out = join(home.dir, "signals");
  const fenced = await session("agent", SIGNALLING, [out, String(hub), String(node), ...others.map(String)]);
  await until("the session's signals", () => existsSync(out));
  const said = readFileSync(out, "utf8").trim().split("\n");
  for (const pid of [hub, node, ...others]) {
    expect(said).toContain(`${pid} refused`);
    expect(said).toContain(`${pid} probe refused`);
    expect(said).toContain(`${pid} seen`);
    expect(alive(pid)).toBe(true);
  }
  expect(said).toContain("own stopped");
  expect(said).toContain("setsid stopped");
  // The node, outside every session, stops it.
  await stop(fenced.dir);
  await until("the session stopped", () => !alive(fenced.registration.hostPid) && !alive(fenced.registration.pid));
  expect(others.every(alive)).toBe(true);
});
