// `fleetd build-slot`: which cargo calls wait and how many slots they take (the Rust module's own cases), and the
// slots interlocking with the Rust binary's: a build holding the only slot in one makes the other's queue.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { buildFirst, compilesNothing, heavy, queuedLine, slotsFit, slotsTaken } from "../../src/node/build_slots.ts";

const w = (s: string) => s.split(" ").filter(Boolean);

describe("what waits", () => {
  test("builds wait, everything else runs at once", () => {
    for (const a of ["build", "test -p fleetd", "+nightly clippy", "-C dir check", "nextest run", "b --release"]) expect(heavy(w(a))).toBe(true);
    for (const a of ["fmt", "metadata", "nextest --version", "build --help", "install --list", "-V", ""]) expect(heavy(w(a))).toBe(false);
  });
  test("a test that builds a lib's tests beside its lib takes two", () => {
    expect(slotsTaken(w("test"))).toBe(2);
    expect(slotsTaken(w("test -p fleetd --lib"))).toBe(1);
    expect(slotsTaken(w("test --test golden"))).toBe(1);
    expect(slotsTaken(w("test --lib --workspace"))).toBe(2);
    expect(slotsTaken(w("build --all-targets"))).toBe(2);
    expect(slotsTaken(w("check --all-targets"))).toBe(1);
    expect(slotsTaken(w("build"))).toBe(1);
  });
  test("cargo run builds first, without the program's arguments", () => {
    expect(buildFirst(w("run -q -p fleetd -- a b"))).toEqual(w("build -q -p fleetd"));
    expect(buildFirst(w("run --bin x a --release"))).toEqual(w("build --bin x --release"));
    expect(compilesNothing(w("run --help"))).toBe(true);
    expect(compilesNothing(w("run prog --help"))).toBe(false);
  });
  test("slots fit memory, one per 16 GB", () => {
    expect(slotsFit(undefined)).toBe(2);
    expect(slotsFit(59.5 * 2 ** 30)).toBe(3);
    expect(slotsFit(64 * 2 ** 30)).toBe(4);
    expect(slotsFit(8 * 2 ** 30)).toBe(1);
    expect(queuedLine(1, 0)).toBe("fleetd: queued for a build slot (next in line; 1 slot on this machine): it starts once one frees");
  });
});

const RUST = process.env.FLEETD_RUST_BIN;
const SRC = join(import.meta.dir, "../../src/main.ts");

describe("the slots, against another build-slot", () => {
  // A cargo that says it started, then waits a while: the first build holds the only slot.
  const setup = () => {
    const home = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-slots-"));
    const bin = join(home, "fakebin");
    mkdirSync(bin);
    writeFileSync(join(bin, "cargo"), "#!/bin/sh\necho \"cargo $*\"\nsleep 1\n");
    chmodSync(join(bin, "cargo"), 0o755);
    writeFileSync(join(home, "node.json"), JSON.stringify({ hub: "http://127.0.0.1:1", machineId: "devbox", name: "devbox", enrolled: true, buildSlots: 1 }));
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FLEETD_HOME: home };
    delete (env as Record<string, string | undefined>).FLEETD_BUILD_SLOT;
    return { home, env };
  };
  const cmd = (which: "bun" | "rust", home: string) =>
    which === "bun" ? [process.execPath, SRC, "build-slot", home, "build"] : [RUST!, "build-slot", home, "build"];
  const pairs: ["bun" | "rust", "bun" | "rust"][] = RUST ? [["bun", "bun"], ["rust", "bun"], ["bun", "rust"]] : [["bun", "bun"]];
  for (const [first, second] of pairs) {
    test(`${first} holds the slot, ${second} queues`, async () => {
      const { home, env } = setup();
      try {
        const a = Bun.spawn(cmd(first, home), { env, stdout: "pipe", stderr: "pipe" });
        await Bun.sleep(first === "bun" ? 400 : 150);
        const b = Bun.spawn(cmd(second, home), { env, stdout: "pipe", stderr: "pipe" });
        const [aCode, bCode] = await Promise.all([a.exited, b.exited]);
        const bErr = await new Response(b.stderr).text();
        expect([aCode, bCode]).toEqual([0, 0]);
        expect(await new Response(b.stdout).text()).toBe("cargo build\n");
        expect(bErr).toContain("fleetd: queued for a build slot (next in line; 1 slot on this machine)");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
});
