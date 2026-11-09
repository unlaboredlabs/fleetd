// What sessions leave running (sessions/proc.rs and runner/host.rs `end_left`'s own cases): a starting node stops
// what a dead node's sessions left under its home, and a recorded claude with its tool children; a task's end stops
// what its hosts recorded its tree left behind. Nothing else, a person's look at a file there included.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { endLeft, leftFile, marker } from "../../src/node/runner/host.ts";
import { statOf } from "../../src/node/runner/procs.ts";
import { killOrphans, killRecorded, markerSession, orphaned, orphanRoots } from "../../src/node/sessions/proc.ts";
import { tempHome } from "../helpers.ts";

setDefaultTimeout(30_000);
const linux = process.platform === "linux";

test("an orphan is a browser of a profile or a process of a scratch dir", () => {
  const roots = orphanRoots("/n");
  const path = ["PATH=/usr/bin"];
  const chrome = (profile: string) => ["chrome", "--headless", `--user-data-dir=${profile}`];
  expect(orphaned(chrome("/n/tmp/0a1b/ab/prof"), path, roots)).toBe(true);
  expect(orphaned(chrome("/n/browser/profiles/profile-x"), path, roots)).toBe(true);
  expect(orphaned(["chrome", "--user-data-dir", "/n/tmp/0a1b/prof"], path, roots)).toBe(true);
  expect(orphaned(["node", "server.js"], ["TMPDIR=/n/tmp/0a1b"], roots)).toBe(true);
  // A person's look at a file there is no session's.
  for (const person of [["less", "/n/tmp/0a1b/out.log"], ["tail", "-f=/n/browser/profiles/p/x"]]) expect(orphaned(person, ["TMPDIR=/tmp"], roots)).toBe(false);
  expect(orphaned(["vim", "--user-data-dir-x=/n/tmp/a"], path, roots)).toBe(false);
  expect(orphaned(chrome("/home/me/prof"), ["TMPDIR=/tmp"], roots)).toBe(false);
  expect(orphaned(chrome("/n/tmpx/prof"), ["TMPDIR=/n/tmpx"], roots)).toBe(false);
  expect(orphaned(chrome("/n/tmp"), ["TMPDIR=/n/tmp"], roots)).toBe(false);
  expect(orphaned(chrome("/n/browser/ms-playwright/x"), path, roots)).toBe(false);
  // A TMPDIR in the browser's profiles is no session's scratch dir.
  expect(orphaned(path, ["TMPDIR=/n/browser/profiles/p"], roots)).toBe(false);
});

test("a marker names its session even when the id has dots", () => {
  expect(markerSession(marker("a.b"))).toBe("a.b");
  expect(markerSession("a.1.2")).toBeUndefined();
});

/** `sh` running `before`, with `args` and `env`, waiting on a `sleep` it started; once the sleep runs, both pids. */
async function leftover(env: Record<string, string>, before: string, args: string[] = [], detached = false) {
  const child = Bun.spawn(["sh", "-c", `${before} sleep 30 & echo $!; wait`, "leftover", ...args], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
    stdout: "pipe",
    // A process group of its own, as claude's is.
    ...(detached ? { detached: true } : {}),
  });
  const reader = child.stdout.getReader();
  let out = "";
  while (!out.includes("\n")) out += new TextDecoder().decode((await reader.read()).value);
  const sleep = Number(out.trim());
  const until = Date.now() + 10_000;
  while (Bun.spawnSync(["cat", `/proc/${sleep}/comm`]).stdout.toString().trim() !== "sleep") {
    if (Date.now() > until) throw new Error("the sleep never started");
    await Bun.sleep(10);
  }
  return { child, sleep };
}

const alive = (pid: number) => {
  const p = statOf(pid);
  return p !== undefined && !p.zombie;
};
const goneSoon = async (pids: number[]) => {
  const until = Date.now() + 5_000;
  while (pids.some(alive) && Date.now() < until) await Bun.sleep(20);
  return pids.filter(alive);
};

describe.if(linux)("on Linux", () => {
  /** The devbox's headless Chrome, its profile under a session's scratch dir, ran on for a day after its session. */
  test("a starting node stops what sessions left running under its home, but never a re-adopted one's", async () => {
    const home = tempHome();
    const scratch = join(home.dir, "tmp", "0a1b");
    const other = join(home.dir, "tmpx");
    mkdirSync(scratch, { recursive: true });
    const byEnv = await leftover({ TMPDIR: scratch }, "");
    const byArg = await leftover({ TMPDIR: other }, "", [`--user-data-dir=${join(scratch, "ab", "prof")}`]);
    const stubborn = await leftover({ TMPDIR: scratch }, "trap '' TERM;");
    const kept = await leftover({ TMPDIR: other }, "", [join(scratch, "out.log")]);
    const adopted = await leftover({ TMPDIR: scratch }, "");
    try {
      const found = await killOrphans(home.dir, new Set([adopted.child.pid, adopted.sleep]));
      // The three, and the sleeps that inherited the scratch TMPDIR.
      expect(found).toBe(5);
      await Promise.all([byEnv.child.exited, byArg.child.exited]);
      expect([byEnv.child.signalCode, byArg.child.signalCode]).toEqual(["SIGTERM", "SIGTERM"]);
      await stubborn.child.exited;
      expect(stubborn.child.signalCode).toBe("SIGKILL");
      expect(await goneSoon([byEnv.sleep, byArg.sleep, stubborn.sleep])).toEqual([]);
      for (const p of [kept.child.pid, kept.sleep, adopted.child.pid, adopted.sleep]) expect(alive(p)).toBe(true);
    } finally {
      for (const l of [kept, adopted]) {
        l.child.kill("SIGKILL");
        process.kill(l.sleep, "SIGKILL");
      }
      home.done();
    }
  });

  test("a restart kills the recorded claude and its tool children only", async () => {
    const session = `restart-${process.pid}`;
    const claude = await leftover({ FLEETD_RUNNER_SESSION: marker(session) }, "setsid", [], true);
    const bystander = await leftover({ FLEETD_RUNNER_SESSION: marker("another") }, "setsid", [], true);
    try {
      await killRecorded(claude.child.pid, String(statOf(claude.child.pid)!.start), session, 5_000);
      await claude.child.exited;
      expect(await goneSoon([claude.sleep])).toEqual([]);
      expect(alive(bystander.sleep)).toBe(true);
    } finally {
      bystander.child.kill("SIGKILL");
      process.kill(bystander.sleep, "SIGKILL");
    }
  });

  test("a restart finds tool children orphaned by a claude that already died", async () => {
    const session = `died-${process.pid}`;
    const claude = await leftover({ FLEETD_RUNNER_SESSION: marker(session) }, "setsid", [], true);
    const start = String(statOf(claude.child.pid)!.start);
    claude.child.kill("SIGKILL");
    await claude.child.exited;
    expect(alive(claude.sleep)).toBe(true);
    await killRecorded(claude.child.pid, start, session, 5_000);
    expect(await goneSoon([claude.sleep])).toEqual([]);
  });

  test("a task's end stops what its hosts recorded its tree left behind, and forgets the record", async () => {
    const home = tempHome();
    const dir = join(home.dir, "hosts", "s1");
    mkdirSync(dir, { recursive: true });
    const left = await leftover({}, "", [], true);
    try {
      // Its own record, and one whose pid now names another process (this one): only the first is ended.
      writeFileSync(leftFile(dir), `${left.child.pid} ${statOf(left.child.pid)!.start}\n${process.pid} 1\n`);
      expect(await endLeft(dir)).toBe(2);
      await left.child.exited;
      expect(left.child.signalCode).toBe("SIGKILL");
      expect(await goneSoon([left.sleep])).toEqual([]);
      expect(existsSync(leftFile(dir))).toBe(false);
      expect(await endLeft(dir)).toBe(0);
    } finally {
      home.done();
    }
  });
});
