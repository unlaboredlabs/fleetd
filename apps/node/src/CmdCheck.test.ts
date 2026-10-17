import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CmdCheck } from "@fleetd/contracts";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { runCmdCheck } from "./CmdCheck.ts";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fleetd-cmd-")));
const workspace = path.join(root, "repo");
const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fleetd-outside-")));
fs.mkdirSync(workspace);
fs.writeFileSync(path.join(workspace, "README.md"), "hi\n");
fs.symlinkSync(outside, path.join(workspace, "escape"));
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

const check = (argv: ReadonlyArray<string>, over: Partial<CmdCheck> = {}): CmdCheck => ({
  t: "cmd_check",
  id: "c1",
  cwd: workspace,
  argv,
  timeoutSec: 30,
  ...over,
});
const run = (frame: CmdCheck, roots: ReadonlyArray<string> = [root]) => Effect.runPromise(runCmdCheck(frame, roots));

/** True when `pid` is gone or a zombie waiting to be reaped. */
const dead = (pid: number) => {
  try {
    return fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.startsWith("Z");
  } catch {
    return true;
  }
};

describe("runCmdCheck", () => {
  it("reports the exit code and output of argv run in the workspace", async () => {
    expect(await run(check(["test", "-f", "README.md"]))).toEqual({ t: "cmd_result", id: "c1", exitCode: 0, outputTail: "", timedOut: false });
    expect(await run(check(["false"]))).toMatchObject({ exitCode: 1, timedOut: false });
    expect(await run(check(["sh", "-c", "echo out; echo err >&2; exit 3"]))).toMatchObject({ exitCode: 3, outputTail: "out\nerr\n" });
  });

  it("never goes through a shell", async () => {
    const result = await run(check(["echo", "$HOME; touch pwned"]));
    expect(result).toMatchObject({ exitCode: 0, outputTail: "$HOME; touch pwned\n" });
    expect(fs.existsSync(path.join(workspace, "pwned"))).toBe(false);
  });

  it("keeps only the last 2000 characters of output", async () => {
    const result = await run(check(["sh", "-c", "i=0; while [ $i -lt 600 ]; do echo line$i; i=$((i+1)); done"]));
    expect(result.outputTail).toHaveLength(2000);
    expect(result.outputTail.endsWith("line599\n")).toBe(true);
  });

  it("kills the whole process group at the timeout and reports no exit code", async () => {
    const pidFile = path.join(root, "bg.pid");
    const result = await run(check(["sh", "-c", `sleep 30 & echo $! > ${pidFile}; echo started; wait`], { timeoutSec: 1 }));
    expect(result).toMatchObject({ exitCode: null, timedOut: true, outputTail: "started\n[fleetd: killed after 1 s]" });
    expect(dead(Number(fs.readFileSync(pidFile, "utf8")))).toBe(true);
  });

  it("refuses a cwd outside its roots, including through a symlink, without running anything", async () => {
    const marker = path.join(outside, "ran");
    for (const cwd of [outside, path.join(workspace, "escape"), path.join(workspace, "..", "..")]) {
      const result = await run(check(["touch", marker], { cwd }));
      expect(result.exitCode).toBeNull();
      expect(result.timedOut).toBe(false);
      expect(result.outputTail).toContain("fleetd node refused to run this:");
      expect(result.outputTail).toContain("outside the directories this node runs commands in");
    }
    expect(fs.existsSync(marker)).toBe(false);
    expect((await run(check(["true"], { cwd: path.join(workspace, "missing") }))).outputTail).toContain("does not exist on this machine");
    expect((await run(check(["true"], { cwd: path.join(workspace, "README.md") }))).outputTail).toContain("is not a directory");
  });

  it("reports a command that cannot start", async () => {
    expect(await run(check(["no-such-command-fleetd"]))).toMatchObject({
      exitCode: null,
      timedOut: false,
      outputTail: expect.stringContaining("could not start no-such-command-fleetd"),
    });
  });
});
