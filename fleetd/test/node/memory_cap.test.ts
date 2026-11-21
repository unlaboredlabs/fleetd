// A session's memory cap (src/node/runner/scope.ts `memoryCap`): a runaway inside a session is killed inside its own
// scope, and nothing else is. On 2026-11-21 one agent's `bun` grew to 58 GB of the devbox's 59 GB before the kernel
// killed it. A real session host (`fleetd session-host`) starts in the node's own scope, with a cap small enough to
// test (the rule's is a third of the machine); its stand-in claude starts a sibling and then a process that allocates
// past the cap. The runaway dies with SIGKILL; the sibling, the host, claude and a process outside stay, and the host
// leaves the agent a note naming what was killed and why. Skipped where no user systemd manager answers (most CI
// runners).
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HostLink, launch, readRegistration, stop } from "../../src/node/runner/host.ts";
import { killed, memoryHook, noteFile, oomKills, ownCgroup, words } from "../../src/node/runner/host/memory.ts";
import { command, current, memoryCap, swapTotal } from "../../src/node/runner/scope.ts";
import { tempHome } from "../helpers.ts";

setDefaultTimeout(90_000);
const scope = process.platform === "linux" ? await current() : undefined;
const home = tempHome();
const main = join(import.meta.dir, "../../src/main.ts");
const links: HostLink[] = [];
const dirs: string[] = [];
const started: Bun.Subprocess[] = [];

afterAll(async () => {
  for (const link of links) await link.detach();
  for (const dir of dirs) await stop(dir);
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

async function until(what: string, fn: () => boolean, ms = 60_000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

const MiB = 1024 * 1024;
const CAP = 384 * MiB;

/** Starts a sibling, then a `bun` that grows by 16 MiB each 0.1 s to 2 GiB, and says how each ended in `$1`. */
const RUNAWAY = `#!/bin/sh
out="$1"
sleep 300 & echo "sibling $!" > "$out.tmp"
"${process.execPath}" -e 'const kept = []; for (let i = 0; i < 128; i++) { kept.push(Buffer.alloc(16 << 20, 1)); await Bun.sleep(100); }' &
echo "runaway $!" >> "$out.tmp"
wait $!
echo "exit $?" >> "$out.tmp"
mv "$out.tmp" "$out"
exec cat > /dev/null
`;

test("the cap is a third of the machine's memory and of its swap, set on the session's scope", () => {
  const cap = memoryCap(59 * 1024 ** 3, 8 * 1024 ** 3);
  expect(cap).toEqual({ max: Math.floor((59 * 1024 ** 3) / 3), swapMax: Math.floor((8 * 1024 ** 3) / 3) });
  const [, argv] = command("fleetd", [], { program: "systemd-run", oomContinue: true, memory: cap, env: {} }, "s1");
  expect(argv).toContain(`--property=MemoryMax=${cap.max}`);
  expect(argv).toContain(`--property=MemorySwapMax=${cap.swapMax}`);
  expect(swapTotal("MemTotal:       61712364 kB\nSwapTotal:       8388604 kB\n")).toBe(8388604 * 1024);
  expect(swapTotal("")).toBe(0);
});

test("the note names the process the kernel picks: the one gone with the most memory and its score's share", () => {
  const gone = (pid: number) => pid !== 3;
  const seen = [
    { pid: 1, command: "bun build", bytes: 300, adj: 500 },
    { pid: 2, command: "chrome --renderer", bytes: 100, adj: 1000 },
    { pid: 3, command: "bun huge", bytes: 900, adj: 500 },
  ];
  // Pid 3 still runs; of the others, the renderer's score outweighs 200 bytes at a cap of 1000.
  expect(killed(seen, (pid) => !gone(pid), 1000)?.pid).toBe(2);
  expect(killed(seen, (pid) => !gone(pid), 100)?.pid).toBe(1);
  expect(killed(seen, () => true, 1000)).toBeUndefined();
  expect(words(undefined, 3 * 1024 ** 3, "2026-01-02T03:04:05.000Z", 9 * 1024 ** 3)).toStartWith(
    "fleetd: at 03:04:05 UTC the kernel killed a process of this session: this session went past its memory cap of 3.0 GB (each session may use at most a third of this machine's 9.0 GB).",
  );
});

test("the note reaches claude once, beside the next tool result", () => {
  const file = join(home.dir, "hook.memory");
  writeFileSync(file, JSON.stringify('fleetd: the kernel killed `bun "x"`'));
  const run = () => Bun.spawnSync(["sh", "-c", memoryHook(file, "PostToolUseFailure")]).stdout.toString();
  expect(JSON.parse(run())).toEqual({ hookSpecificOutput: { hookEventName: "PostToolUseFailure", additionalContext: 'fleetd: the kernel killed `bun "x"`' } });
  expect(run()).toBe("");
  expect(existsSync(file)).toBe(false);
});

test.if(scope !== undefined)("a session's runaway past its cap is killed in its own scope, the rest untouched, and the agent is told", async () => {
  const outside = Bun.spawn(["sleep", "300"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  started.push(outside);
  const program = join(home.dir, "claude-runaway");
  writeFileSync(program, RUNAWAY);
  chmodSync(program, 0o755);
  const dir = join(home.dir, "hosts", "runaway");
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  const out = join(home.dir, "runaway");
  const link = await launch({
    fleetd: [process.execPath, main],
    dir,
    sessionId: "runaway",
    program,
    args: [out],
    cwd: home.dir,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home.dir, FLEETD_HOME: join(home.dir, ".fleetd"), FLEETD_HUB_URL: "http://127.0.0.1:1" },
    scope: { ...scope!, memory: { max: CAP, swapMax: 0 } },
  });
  links.push(link);
  const registration = readRegistration(dir)!;
  await until("the runaway's end", () => existsSync(out));
  const said = Object.fromEntries(
    readFileSync(out, "utf8")
      .trim()
      .split("\n")
      .map((l) => l.split(" ")),
  );
  // Killed by the kernel (128 + SIGKILL), well short of its 2 GiB.
  expect(said.exit).toBe("137");
  const cgroup = ownCgroup(readFileSync(`/proc/${registration.pid}/cgroup`, "utf8"))!;
  expect(Number(readFileSync(`${cgroup}/memory.max`, "utf8"))).toBe(CAP);
  expect(oomKills(readFileSync(`${cgroup}/memory.events`, "utf8"))).toBeGreaterThanOrEqual(1);
  for (const pid of [Number(said.sibling), registration.pid, registration.hostPid, outside.pid]) expect(alive(pid)).toBe(true);
  await until("the agent's note", () => existsSync(noteFile(dir)), 5_000);
  const note = JSON.parse(readFileSync(noteFile(dir), "utf8")) as string;
  expect(note).toContain(`(pid ${said.runaway},`);
  expect(note).toContain("this session went past its memory cap of 0.4 GB");
  expect(note).toContain("Only that process was killed");
});
