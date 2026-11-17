// The seam for where a session runs (src/node/place): every session is in the `process` place, which starts, adopts,
// stops and ends hosts, runs setup commands and reads chat files on this machine; and setup runs its commands through
// the place it is given, never a spawn of its own.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostDir, pick, placeAt, type Place } from "../../src/node/place/index.ts";
import { processPlace } from "../../src/node/place/process.ts";
import { marker, readRegistration } from "../../src/node/runner/host.ts";
import { host } from "../../src/node/runner/host/serve.ts";
import * as setup from "../../src/node/worktree/setup.ts";

const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-place-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let dirs = 0;
const fresh = () => {
  const dir = join(root, `d${++dirs}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

test("every session runs in the process place, found again by its host dir", () => {
  expect(pick().kind).toBe("process");
  expect(hostDir("/n", "s1")).toBe("/n/hosts/s1");
  expect(placeAt(hostDir("/n", "s1"))).toBe(processPlace);
});

test("process runs a command in the worktree with its env, its secrets scrubbed, killed at its limit", async () => {
  const cwd = fresh();
  const ran = await processPlace.run({ cwd, argv: ["sh", "-c", 'pwd; echo "$TOKEN"'], timeoutSec: 10, env: { PATH: process.env.PATH!, TOKEN: "s3cret" }, scrub: ["s3cret"] });
  expect(ran.exitCode).toBe(0);
  expect(ran.outputTail).toContain(cwd);
  expect(ran.outputTail).toContain("[secret]");
  expect(ran.outputTail).not.toContain("s3cret");
  const slow = await processPlace.run({ cwd, argv: ["sh", "-c", "sleep 5"], timeoutSec: 0.2, env: { PATH: process.env.PATH! } });
  expect(slow.timedOut).toBe(true);
});

test("process reads a chat file from the session's working directory only", async () => {
  const cwd = fresh();
  writeFileSync(join(cwd, "notes.txt"), "hello");
  const piece = await processPlace.read(cwd, "notes.txt", 0, true);
  expect(piece.mime).toBe("text/plain");
  expect(piece.piece.toString()).toBe("hello");
  writeFileSync(join(root, "outside.txt"), "no");
  await expect(processPlace.read(cwd, "../outside.txt", 0, true)).rejects.toThrow("outside your working directory");
});

test("process adopts a host that answers, nothing where none does, and stops and ends idempotently", async () => {
  const empty = fresh();
  expect(await processPlace.adopt(empty)).toBeUndefined();
  expect(await processPlace.end(empty)).toBe(0);
  await processPlace.stop(join(empty, "never"));

  const dir = fresh();
  const program = join(root, "claude-place");
  writeFileSync(program, "#!/bin/sh\nexec cat > /dev/null\n");
  chmodSync(program, 0o755);
  await host(dir, "place-test", program, [], marker("place-test"));
  const link = await processPlace.adopt(dir);
  expect(link?.pid).toBe(readRegistration(dir)!.pid);
  await link!.detach();
  await processPlace.stop(dir);
  expect(existsSync(dir)).toBe(false);
  await processPlace.stop(dir);
});

test("setup runs each command where the agent runs, through its place", async () => {
  const cwd = fresh();
  const asked: string[][] = [];
  const place: Place = {
    ...processPlace,
    run: async (r) => {
      asked.push(r.argv);
      expect(r.cwd).toBe(cwd);
      return { exitCode: 0, outputTail: "ok", timedOut: false };
    },
  };
  const outcome = await setup.run(place, { commands: ["bun install", "make"] }, cwd, {}, [], () => {}, () => {});
  expect(outcome.kind).toBe("done");
  expect(asked).toEqual([
    ["sh", "-c", "bun install"],
    ["sh", "-c", "make"],
  ]);
});
