// `fleetd check-slot`: a machine's full pre-push checks take turns for its check slots. The limit holds, a slot frees
// when its check ends however it ends (a crash, a kill), the queue is first come first served, and scripts/check.sh
// runs itself under the wrapper where there is one.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HELD, slotsFit, slotsHere, waitingLine } from "../../src/node/check_slots.ts";

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
  test("node.json's checkSlots sets it, 0 turns turns off", () => {
    const home = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-check-slots-"));
    try {
      const write = (checkSlots?: number) =>
        writeFileSync(join(home, "node.json"), JSON.stringify({ hub: "http://127.0.0.1:1", machineId: "devbox", name: "devbox", enrolled: true, checkSlots }));
      write(3);
      expect(slotsHere(home)).toBe(3);
      write(0);
      expect(slotsHere(home)).toBeUndefined();
      write(undefined);
      expect(slotsHere(home)).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  test("the waiting line says how many are ahead", () => {
    expect(waitingLine(4, 2)).toStartWith("fleetd: waiting for a check slot (2 checks ahead; 4 slots on this machine, all in use)");
    expect(waitingLine(1, 0)).toStartWith("fleetd: waiting for a check slot (next in line; 1 slot on this machine, all in use)");
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

function machine(checkSlots: number) {
  const home = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-check-slots-"));
  homes.push(home);
  writeFileSync(join(home, "node.json"), JSON.stringify({ hub: "http://127.0.0.1:1", machineId: "devbox", name: "devbox", enrolled: true, checkSlots }));
  const script = join(home, "check");
  writeFileSync(script, CHECK);
  chmodSync(script, 0o755);
  // This test runs inside a check of its own, which holds a slot of another machine's.
  const env: Record<string, string | undefined> = { ...process.env, HOME_DIR: home };
  delete env[HELD];
  const started = () => (existsSync(join(home, "log")) ? readFileSync(join(home, "log"), "utf8").trim().split("\n") : []);
  const start = (name: string): Check => {
    const proc = Bun.spawn([process.execPath, SRC, "check-slot", home, script, name], { env, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
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
const waiting = (c: Check) => c.err().includes("fleetd: waiting for a check slot");

describe("the slots", () => {
  test("no more checks run at once than the machine has slots; one more waits, saying so, and starts once one frees", async () => {
    const m = machine(2);
    const a = m.start("a");
    const b = m.start("b");
    await until("a and b start", () => m.started().length === 2);
    const c = m.start("c");
    await until("c waits", () => waiting(c));
    expect(c.err()).toContain("(next in line; 2 slots on this machine, all in use)");
    expect(m.started()).not.toContain("start c");
    m.release("a");
    expect(await a.proc.exited).toBe(0);
    await until("c starts", () => m.started().includes("start c"));
    m.release("b");
    m.release("c");
    expect([await b.proc.exited, await c.proc.exited]).toEqual([0, 0]);
  }, SLOW);

  test("first come first served: each waits for every check queued before it", async () => {
    const m = machine(1);
    const a = m.start("a");
    await until("a starts", () => m.started().length === 1);
    const b = m.start("b");
    await until("b waits", () => waiting(b));
    const c = m.start("c");
    await until("c waits", () => waiting(c));
    expect(c.err()).toContain("(1 check ahead; 1 slot on this machine, all in use)");
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

  test("a check already holding a slot runs one inside it at once", async () => {
    const m = machine(1);
    const a = m.start("a");
    await until("a starts", () => m.started().length === 1);
    const home = homes.at(-1)!;
    writeFileSync(join(home, "go-inner"), "0");
    const inner = Bun.spawn([process.execPath, SRC, "check-slot", home, join(home, "check"), "inner"], {
      env: { ...process.env, HOME_DIR: home, [HELD]: "1" },
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await inner.exited).toBe(0);
    expect(await new Response(inner.stderr).text()).toBe("");
    m.release("a");
    await a.proc.exited;
  }, SLOW);
});

describe("scripts/check.sh", () => {
  // A stand-in wrapper that says what it was asked to run.
  const withWrapper = (held: boolean) => {
    const bin = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-check-wrapper-"));
    homes.push(bin);
    mkdirSync(join(bin, "bin"));
    writeFileSync(join(bin, "bin", "fleetd-check-slot"), '#!/bin/sh\necho "wrapped: $*"\n');
    chmodSync(join(bin, "bin", "fleetd-check-slot"), 0o755);
    const env: Record<string, string | undefined> = { ...process.env, PATH: `${join(bin, "bin")}:${process.env.PATH}` };
    if (held) env[HELD] = "1";
    else delete env[HELD];
    return Bun.spawnSync(["bash", join(ROOT, "scripts/check.sh"), "nope"], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
  };
  test("runs itself under fleetd-check-slot where it is on the PATH", () => {
    const out = withWrapper(false);
    expect(out.stdout.toString()).toBe(`wrapped: ${join(ROOT, "scripts/check.sh")} nope\n`);
  });
  test("but not inside a check that holds a slot", () => {
    const out = withWrapper(true);
    expect(out.exitCode).toBe(2);
    expect(out.stderr.toString()).toContain("unknown check: nope");
  });
});
