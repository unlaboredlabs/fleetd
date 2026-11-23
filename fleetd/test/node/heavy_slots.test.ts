// `fleetd heavy-slot` (agents' `fleetd-heavy`): a machine's heavy runs (full checks, whole suites) take turns for its
// heavy-run slots. N+1 at once: N run, one waits, saying so. A slot frees when its run ends however it ends (a crash, a
// kill), the queue is first come first served, and scripts/check.sh runs itself under the wrapper where there is one.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HELD, install, slotsFit, slotsHere, waitingLine } from "../../src/node/heavy_slots.ts";

const SRC = join(import.meta.dir, "../../src/main.ts");
const ROOT = join(import.meta.dir, "../../..");
// Bun's 5 s default doesn't fit several cold fleetd starts on a loaded machine.
const SLOW = 30_000;

describe("how many", () => {
  test("one per 8 cores, at least 2", () => {
    expect(slotsFit(32)).toBe(4);
    expect(slotsFit(8)).toBe(2);
    expect(slotsFit(1)).toBe(2);
    expect(slotsFit(64)).toBe(8);
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
      expect(slotsHere(home)).toBeGreaterThanOrEqual(2);
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
  const start = (name: string): Check => {
    const proc = Bun.spawn([wrapper, script, name], { env, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    let err = "";
    void (async () => {
      for await (const chunk of proc.stderr) err += new TextDecoder().decode(chunk);
    })();
    return { name, proc, err: () => err };
  };
  const release = (name: string, code = 0) => writeFileSync(join(home, `go-${name}`), String(code));
  return { started, start, release };
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
