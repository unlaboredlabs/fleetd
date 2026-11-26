// `fleetd heavy-slot` (agents' `fleetd-heavy`): a machine's heavy runs (full checks, whole suites) take turns for its
// heavy-run slots. N+1 at once: N run, one waits, saying so. A slot frees when its run ends however it ends (a crash, a
// kill), the queue is first come first served, and scripts/check.sh runs itself under the wrapper where there is one.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { callerUnit, HELD, install, machineCpus, machineHere, memoryLeft, parseCpuList, quotaArgs, slotShare, slotsFit, slotsHere, waitingLine } from "../../src/node/heavy_slots.ts";

const SRC = join(import.meta.dir, "../../src/main.ts");
const ROOT = join(import.meta.dir, "../../..");
// Bun's 5 s default doesn't fit several cold fleetd starts on a loaded machine.
const SLOW = 30_000;

describe("how many", () => {
  const GB = 2 ** 30;
  // Linux's default ephemeral range, 32768–60999.
  const LINUX_PORTS = 28_232;
  test("the fewest of cores left after builds, memory and ports, at least 1", () => {
    // The devbox: 32 cores, 60 GB (59.5 reported), 3 build slots of 2 jobs, 4 test workers. Cores: (32 − 6) / 4 = 6;
    // memory: 60 / 8 = 7; ports: 28,232 / 4,000 = 7.
    expect(slotsFit({ cores: 32, buildSlots: 3, buildJobs: 2, testWorkers: 4, memTotal: 59.5 * GB, ports: LINUX_PORTS })).toBe(6);
    // Memory: 16 cores, 16 GB: cores (16 − 2) / 4 = 3, memory 2.
    expect(slotsFit({ cores: 16, buildSlots: 1, buildJobs: 2, testWorkers: 4, memTotal: 16 * GB, ports: LINUX_PORTS })).toBe(2);
    // Ports: 128 cores, 512 GB, macOS's 16,384 ephemeral ports: 4.
    expect(slotsFit({ cores: 128, buildSlots: 8, buildJobs: 2, testWorkers: 4, memTotal: 512 * GB, ports: 16_384 })).toBe(4);
    // A laptop the builds fill: 4 cores, 8 GB, 1 build slot of 4 jobs: none left, still 1.
    expect(slotsFit({ cores: 4, buildSlots: 1, buildJobs: 4, testWorkers: 4, memTotal: 8 * GB, ports: LINUX_PORTS })).toBe(1);
    // Unknown memory doesn't limit it.
    expect(slotsFit({ cores: 64, buildSlots: 2, buildJobs: 2, testWorkers: 4, memTotal: undefined, ports: LINUX_PORTS })).toBe(7);
  });
  test("this machine's figures", () => {
    const m = machineHere(join(process.env.TMPDIR ?? "/tmp", "fleetd-no-node-home"));
    expect(m.cores).toBeGreaterThan(0);
    expect(m.buildSlots).toBeGreaterThan(0);
    expect(m.testWorkers).toBeGreaterThanOrEqual(4);
    expect(m.ports).toBeGreaterThan(0);
    expect(slotsFit(m)).toBeGreaterThanOrEqual(1);
  });
  test("node.json's heavySlots sets it (checkSlots, its old name, too), 0 turns turns off", () => {
    const home = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-heavy-slots-"));
    try {
      const write = (slots: Record<string, number>) =>
        writeFileSync(join(home, "node.json"), JSON.stringify({ hub: "http://127.0.0.1:1", machineId: "devbox", name: "devbox", enrolled: true, ...slots }));
      write({ heavySlots: 3 });
      expect(slotsHere(home)).toBe(3);
      write({ heavySlots: 0 });
      expect(slotsHere(home)).toBeUndefined();
      write({ checkSlots: 5 });
      expect(slotsHere(home)).toBe(5);
      write({ heavySlots: 1, checkSlots: 5 });
      expect(slotsHere(home)).toBe(1);
      write({});
      expect(slotsHere(home)).toBe(slotsFit(machineHere(home)));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  test("the waiting line says how many are ahead", () => {
    expect(waitingLine(4, 2)).toStartWith("fleetd: waiting for a heavy-run slot (2 runs ahead; 4 slots on this machine, all in use");
    expect(waitingLine(1, 0)).toStartWith("fleetd: waiting for a heavy-run slot (next in line; 1 slot on this machine, all in use");
  });
});

// A check that writes "start <name>" to the log, then holds its slot until the test writes go-<name> (or 30 s pass),
// then exits with go-<name>'s contents.
const CHECK = `#!/bin/sh
echo "start $1" >>"$HOME_DIR/log"
n=0
while [ ! -e "$HOME_DIR/go-$1" ] && [ $n -lt 600 ]; do sleep 0.05; n=$((n + 1)); done
exit "$(cat "$HOME_DIR/go-$1" 2>/dev/null || echo 0)"
`;

type Check = { name: string; proc: Bun.Subprocess<"ignore", "ignore", "pipe">; err: () => string };
const homes: string[] = [];
afterEach(() => {
  // Lets every check still holding (a killed wrapper's orphan among them) end, then drops its home.
  for (const home of homes.splice(0)) {
    for (const n of "abcd") if (!existsSync(join(home, `go-${n}`))) writeFileSync(join(home, `go-${n}`), "0");
    rmSync(home, { recursive: true, force: true });
  }
});

function machine(heavySlots: number) {
  const home = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-heavy-slots-"));
  homes.push(home);
  writeFileSync(join(home, "node.json"), JSON.stringify({ hub: "http://127.0.0.1:1", machineId: "devbox", name: "devbox", enrolled: true, heavySlots }));
  const script = join(home, "check");
  writeFileSync(script, CHECK);
  chmodSync(script, 0o755);
  // This test runs inside a check of its own, which holds a slot of another machine's.
  const env: Record<string, string | undefined> = { ...process.env, HOME_DIR: home };
  delete env[HELD];
  delete env.FLEETD_CHECK_SLOT;
  const started = () => (existsSync(join(home, "log")) ? readFileSync(join(home, "log"), "utf8").trim().split("\n") : []);
  // Through the wrapper agents run, as they do: `fleetd-heavy <command>`.
  const wrapper = install(home, [process.execPath, SRC]);
  // `fleetd-heavy <argv>` in `cwd`.
  const run = (name: string, argv: string[], cwd?: string): Check => {
    const proc = Bun.spawn([wrapper, ...argv], { cwd, env: { ...env, WRAPPER: wrapper }, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    let err = "";
    void (async () => {
      for await (const chunk of proc.stderr) err += new TextDecoder().decode(chunk);
    })();
    return { name, proc, err: () => err };
  };
  const start = (name: string) => run(name, [script, name]);
  const release = (name: string, code = 0) => writeFileSync(join(home, `go-${name}`), String(code));
  return { home, started, run, start, release };
}

async function until(what: string, ok: () => boolean) {
  for (const end = Date.now() + 20_000; !ok(); ) {
    if (Date.now() > end) throw new Error(`never: ${what}`);
    await Bun.sleep(20);
  }
}
const waiting = (c: Check) => c.err().includes("fleetd: waiting for a heavy-run slot");

describe("the slots", () => {
  test("N+1 heavy runs at once: N run, the one more waits, saying so, and starts once one frees", async () => {
    const m = machine(3);
    const a = m.start("a");
    const b = m.start("b");
    const c = m.start("c");
    await until("a, b and c start", () => m.started().length === 3);
    const d = m.start("d");
    await until("d waits", () => waiting(d));
    expect(d.err()).toContain("(next in line; 3 slots on this machine, all in use");
    await Bun.sleep(300);
    expect(m.started()).not.toContain("start d");
    m.release("b");
    expect(await b.proc.exited).toBe(0);
    await until("d starts", () => m.started().includes("start d"));
    for (const n of "acd") m.release(n);
    expect([await a.proc.exited, await c.proc.exited, await d.proc.exited]).toEqual([0, 0, 0]);
  }, SLOW);

  test("first come first served: each waits for every check queued before it", async () => {
    const m = machine(1);
    const a = m.start("a");
    await until("a starts", () => m.started().length === 1);
    const b = m.start("b");
    await until("b waits", () => waiting(b));
    const c = m.start("c");
    await until("c waits", () => waiting(c));
    expect(c.err()).toContain("(1 run ahead; 1 slot on this machine, all in use");
    m.release("a");
    await until("b starts", () => m.started().includes("start b"));
    // b holds the only slot: c is still waiting behind it.
    await Bun.sleep(300);
    expect(m.started()).toEqual(["start a", "start b"]);
    m.release("b");
    await until("c starts", () => m.started().includes("start c"));
    m.release("c");
    expect([await a.proc.exited, await b.proc.exited, await c.proc.exited]).toEqual([0, 0, 0]);
  }, SLOW);

  test("a check that fails or is killed frees its slot, and a waiter that is killed leaves the queue", async () => {
    const m = machine(1);
    const a = m.start("a");
    await until("a starts", () => m.started().length === 1);
    const b = m.start("b");
    await until("b waits", () => waiting(b));
    const c = m.start("c");
    await until("c waits", () => waiting(c));
    // c gives up waiting; d, queued after it, isn't held up by its ticket.
    c.proc.kill("SIGKILL");
    await c.proc.exited;
    // a crashes: its exit code comes back, its slot to b.
    m.release("a", 3);
    expect(await a.proc.exited).toBe(3);
    await until("b starts", () => m.started().includes("start b"));
    const d = m.start("d");
    await until("d waits", () => waiting(d));
    expect(d.err()).toContain("(next in line;");
    // b's wrapper is killed outright: its slot frees with it.
    b.proc.kill("SIGKILL");
    await b.proc.exited;
    await until("d starts", () => m.started().includes("start d"));
    expect(m.started()).not.toContain("start c");
    // b's check itself, left running without its wrapper, ends too.
    m.release("b");
    m.release("d");
    expect(await d.proc.exited).toBe(0);
  }, SLOW);

  // FLEETD_CHECK_SLOT: what a node from before Nov 23 sets, and the only one a branch's older scripts/check.sh reads.
  for (const held of [HELD, "FLEETD_CHECK_SLOT"]) {
    test(`a run already holding a slot (${held}) runs one inside it at once`, async () => {
      const m = machine(1);
      const a = m.start("a");
      await until("a starts", () => m.started().length === 1);
      const home = homes.at(-1)!;
      writeFileSync(join(home, "go-inner"), "0");
      // `check-slot`: the old wrapper's command.
      const inner = Bun.spawn([process.execPath, SRC, "check-slot", home, join(home, "check"), "inner"], {
        env: { ...process.env, HOME_DIR: home, [held]: "1" },
        stdout: "ignore",
        stderr: "pipe",
      });
      expect(await inner.exited).toBe(0);
      expect(await new Response(inner.stderr).text()).toBe("");
      m.release("a");
      await a.proc.exited;
    }, SLOW);
  }
});

describe("each slot's share of the CPUs", () => {
  test("past the build slots' jobs, an equal share each, at least one", () => {
    // The devbox: 32 CPUs, 3 build slots of 2 jobs, 6 slots: 4 each, 24 in all.
    expect(slotShare(32, 6, 6)).toBe(4);
    // Fewer slots (memory fits fewer), each gets more: 16 CPUs, 2 build jobs, 2 slots.
    expect(slotShare(16, 2, 2)).toBe(7);
    // Slots set past the CPUs (node.json): one each.
    expect(slotShare(8, 6, 3)).toBe(1);
    // Builds that fill the machine leave the slots every CPU.
    expect(slotShare(4, 4, 1)).toBe(4);
  });
  test("Linux's CPU lists", () => {
    expect(parseCpuList("0-3,8,10-11\n")).toEqual([0, 1, 2, 3, 8, 10, 11]);
    expect(parseCpuList("")).toBeUndefined();
    expect(parseCpuList("3-1")).toBeUndefined();
  });
  test("a run's scope: its quota and its short period, what the session's memory cap has left, bound to the caller", () => {
    expect(quotaArgs({ cpus: 4, shortPeriod: true, memory: { max: 1_000, swapMax: 20 }, unit: "run-p1-i2.scope" })).toEqual([
      "--user", "--scope", "--quiet", "--collect", "--description=fleetd heavy run", "--property=CPUQuota=400%", "--property=CPUQuotaPeriodSec=10ms",
      "--property=OOMPolicy=continue", "--property=MemoryMax=1000", "--property=MemorySwapMax=20", "--property=BindsTo=run-p1-i2.scope",
      "--property=After=run-p1-i2.scope", "--",
    ]);
    // An older systemd without the short period, a caller with no cap and outside a user manager: the quota alone.
    expect(quotaArgs({ cpus: 2, shortPeriod: false })).toEqual([
      "--user", "--scope", "--quiet", "--collect", "--description=fleetd heavy run", "--property=CPUQuota=200%", "--property=OOMPolicy=continue", "--",
    ]);
  });
  test("the unit the run is bound to: the session's scope, else the node's own service", () => {
    const app = "/user.slice/user-1000.slice/user@1000.service/app.slice";
    expect(callerUnit(`${app}/run-p1-i2.scope`)).toBe("run-p1-i2.scope");
    // Sessions without scopes of their own run in the node's unit: the run then stops with the node, and its slot.
    expect(callerUnit(`${app}/fleetd-node.service`)).toBe("fleetd-node.service");
    expect(callerUnit("/user.slice/user-1000.slice/user@1000.service")).toBeUndefined();
    expect(callerUnit("/system.slice/ssh.service")).toBeUndefined();
  });
  test("what the session's memory cap leaves for its run: the cap less what it holds, page cache aside", () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-heavy-cgroup-"));
    homes.push(dir);
    const files = (f: Record<string, string>) => {
      for (const [k, v] of Object.entries(f)) writeFileSync(join(dir, k), `${v}\n`);
    };
    // A 44 GB cap holding 10 GB, 4 of them page cache; 4 GB of swap, 1 in use.
    files({ "memory.max": String(44 * 2 ** 30), "memory.current": String(10 * 2 ** 30), "memory.stat": `anon 6000\nfile ${4 * 2 ** 30}\n`, "memory.swap.max": String(4 * 2 ** 30), "memory.swap.current": String(2 ** 30) });
    expect(memoryLeft(dir)).toEqual({ max: 38 * 2 ** 30, swapMax: 3 * 2 ** 30 });
    // No cap: none for the run either.
    files({ "memory.max": "max" });
    expect(memoryLeft(dir)).toBeUndefined();
  });
  // A run started from inside one held to a few CPUs (`scripts/check.sh --background` from a run under `taskset`) sizes
  // the machine, its build jobs and so its slots' share, as every other run does: from the machine's CPUs.
  test.if(process.platform === "linux" && Bun.which("taskset") !== null)("a run held to one CPU still sizes the whole machine", () => {
    const home = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-heavy-slots-"));
    homes.push(home);
    const mod = join(import.meta.dir, "../../src/node/heavy_slots.ts");
    const script = `const h = await import(${JSON.stringify(mod)}); console.log(JSON.stringify(h.machineHere(${JSON.stringify(home)})));`;
    const sized = (pin: string[]) => JSON.parse(Bun.spawnSync([...pin, process.execPath, "-e", script], { stderr: "inherit" }).stdout.toString());
    const whole = sized([]);
    expect(whole.cores).toBe(machineCpus()!.length);
    expect(sized([Bun.which("taskset")!, "-c", String(machineCpus()![0])])).toEqual(whole);
  });

  // What a run fans out to is capped at its slot's share by its scope's quota (cpu.max), on every CPU its caller has (a
  // run held to 4 CPUs instead put Electron's GPU threads on CPUs 0-3, whatever slot it was in). Before, a run had no
  // cap of its own.
  const scopes = process.platform === "linux" && Bun.spawnSync(["systemd-run", "--user", "--scope", "--quiet", "--collect", "true"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  test.if(scopes)("a run and its children are capped at their slot's share, on every CPU", async () => {
    const m = machine(2);
    const probe = join(m.home, "probe");
    writeFileSync(probe, `#!/bin/sh\nsh -c 'echo "$(cat /sys/fs/cgroup$(sed "s/^0:://" /proc/self/cgroup)/cpu.max) $(grep Cpus_allowed_list /proc/self/status | cut -f2)"' >>"$HOME_DIR/cpus"\nexec "$HOME_DIR/check" "$1"\n`);
    chmodSync(probe, 0o755);
    const a = m.run("a", [probe, "a"]);
    await until("a starts", () => m.started().length === 1);
    m.release("a");
    expect(await a.proc.exited).toBe(0);
    const here = machineHere(m.home);
    const share = slotShare(here.cores, here.buildSlots * here.buildJobs, 2);
    const [quota, period, cpus] = readFileSync(join(m.home, "cpus"), "utf8").trim().split(" ");
    expect(Number(quota) / Number(period)).toBe(share);
    // The wrapper narrows no run's CPUs: it has every one its caller has.
    expect(cpus).toBe(/Cpus_allowed_list:\s*(\S+)/.exec(readFileSync("/proc/self/status", "utf8"))![1]);
    // Its period is the short one.
    expect(period).toBe("10000");
  }, SLOW);

  // A run that goes past what its session's cap leaves is killed in its own scope, the session's other processes
  // untouched, and the agent hears what was killed, as from its session's own cap. Before, the run had a full cap of
  // its own beside the session's, and a kill there reached the agent as a bare exit 137.
  test.if(scopes)("a run past what the session's memory cap leaves is killed, and the agent is told what", async () => {
    const m = machine(1);
    // The node home's hosts dir, where each session's host has its own (place/index.ts hostDir).
    mkdirSync(join(m.home, "hosts"));
    // The session: a scope with a 256 MB cap and no swap, as the node starts each session's (runner/scope.ts).
    const grow = join(m.home, "grow");
    // As a check: it runs a while, one of its steps grows past the cap, and the check goes on to its end.
    writeFileSync(grow, `#!/bin/sh\necho "start $1" >>"$HOME_DIR/log"\nsleep 1.5\npython3 -I -c 'import time; b = [bytearray(16 << 20) for _ in range(32) if not time.sleep(0.2)]'\necho "survived $?" >>"$HOME_DIR/log"\nsleep 2\n`);
    chmodSync(grow, 0o755);
    const env: Record<string, string | undefined> = { ...process.env, HOME_DIR: m.home, FLEETD_RUNNER_SESSION: "t6141test.1.1" };
    delete env[HELD];
    delete env.FLEETD_CHECK_SLOT;
    const session = Bun.spawn(
      ["systemd-run", "--user", "--scope", "--quiet", "--collect", "--property=MemoryMax=256M", "--property=MemorySwapMax=0", "--property=OOMPolicy=continue", "--", process.execPath, SRC, "heavy-slot", m.home, grow, "a"],
      { env, stdout: "ignore", stderr: "pipe" },
    );
    expect(await session.exited).toBe(0);
    const err = await new Response(session.stderr).text();
    expect(m.started(), err).toEqual(["start a", "survived 137"]);
    const note = join(m.home, "hosts", "t6141test.memory");
    await until(`the kill is noted (${err})`, () => existsSync(note));
    expect(JSON.parse(readFileSync(note, "utf8"))).toMatch(/the kernel killed `python3 -I -c import time; .*` \(pid \d+, [\d.]+ GB\): this session went past its memory cap of 0\.\d GB/);
  }, SLOW);
});

describe("runs that take no slot", () => {
  test("a check that wraps itself, run under fleetd-heavy, takes one slot, not two", async () => {
    const m = machine(1);
    // As scripts/check.sh: it runs itself under the wrapper unless it holds a slot.
    const nests = join(m.home, "nests");
    writeFileSync(nests, `#!/bin/sh\n[ -n "$FLEETD_HEAVY_SLOT" ] || exec "$WRAPPER" "$0" "$@"\nexec "$HOME_DIR/check" "$@"\n`);
    chmodSync(nests, 0o755);
    const a = m.run("a", [nests, "a"]);
    await until("a starts", () => m.started().includes("start a"));
    m.release("a");
    expect(await a.proc.exited).toBe(0);
    expect(a.err()).toBe("");
  }, SLOW);

  test("the repo's declared background start and wait take none; its other commands do", async () => {
    const m = machine(1);
    const repo = join(m.home, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, ".fleetd"));
    mkdirSync(join(repo, "sub"));
    writeFileSync(join(repo, ".fleetd", "pre-push.json"), '{"check": "./check", "background": "./check bg", "wait": "./check wait"}');
    writeFileSync(join(repo, "check"), CHECK);
    chmodSync(join(repo, "check"), 0o755);
    const a = m.start("a");
    await until("a starts", () => m.started().length === 1);
    for (const n of ["bg", "wait", "full"]) writeFileSync(join(m.home, `go-${n}`), "0");
    // a holds the only slot: these run at once all the same.
    for (const [argv, cwd] of [[["./check", "wait"], repo], [[join(repo, "check"), "bg"], join(repo, "sub")], [["../check", "wait"], join(repo, "sub")]] as const) {
      const light = m.run("light", [...argv], cwd);
      expect(await light.proc.exited).toBe(0);
      expect(light.err()).toBe("");
    }
    expect(m.started()).toEqual(["start a", "start wait", "start bg", "start wait"]);
    // The check itself waits its turn.
    const full = m.run("full", ["./check", "full"], repo);
    await until("the check waits", () => waiting(full));
    m.release("a");
    expect([await a.proc.exited, await full.proc.exited]).toEqual([0, 0]);
  }, SLOW);
});

describe("the wrapper", () => {
  test("is written under both names, each running fleetd's heavy-slot command", () => {
    const home = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-heavy-slots-"));
    homes.push(home);
    const path = install(home, ["/opt/fleetd"]);
    expect(path).toEndWith("/fleetd-heavy");
    const text = readFileSync(path, "utf8");
    expect(text).toContain(`exec '/opt/fleetd' heavy-slot '${home}' "$@"`);
    expect(readFileSync(join(dirname(path), "fleetd-check-slot"), "utf8")).toBe(text);
  });
});

describe("scripts/check.sh", () => {
  // A stand-in wrapper, named `name`, that says what it was asked to run; the PATH has no real one (this test may run
  // as an agent's, whose PATH has).
  const withWrapper = (name: string, held?: string) => {
    const bin = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-check-wrapper-"));
    homes.push(bin);
    mkdirSync(join(bin, "bin"));
    writeFileSync(join(bin, "bin", name), `#!/bin/sh\necho "${name}: $*"\n`);
    chmodSync(join(bin, "bin", name), 0o755);
    const path = (process.env.PATH ?? "").split(":").filter((d) => !existsSync(join(d, "fleetd-heavy")) && !existsSync(join(d, "fleetd-check-slot")));
    const env: Record<string, string | undefined> = { ...process.env, PATH: [join(bin, "bin"), ...path].join(":") };
    delete env[HELD];
    delete env.FLEETD_CHECK_SLOT;
    if (held) env[held] = "1";
    return Bun.spawnSync(["bash", join(ROOT, "scripts/check.sh"), "nope"], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
  };
  test("runs itself under fleetd-heavy where it is on the PATH", () => {
    const out = withWrapper("fleetd-heavy");
    expect(out.stdout.toString()).toBe(`fleetd-heavy: ${join(ROOT, "scripts/check.sh")} nope\n`);
  });
  test("or a node's from before it, fleetd-check-slot", () => {
    const out = withWrapper("fleetd-check-slot");
    expect(out.stdout.toString()).toBe(`fleetd-check-slot: ${join(ROOT, "scripts/check.sh")} nope\n`);
  });
  for (const held of [HELD, "FLEETD_CHECK_SLOT"]) {
    test(`but not inside a run that holds a slot (${held})`, () => {
      const out = withWrapper("fleetd-heavy", held);
      expect(out.exitCode).toBe(2);
      expect(out.stderr.toString()).toContain("unknown check: nope");
    });
  }
});
