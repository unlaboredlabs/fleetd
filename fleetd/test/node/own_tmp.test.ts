// Nothing the node starts leaves files in a /tmp that may be held in memory: a node started without TMPDIR runs itself
// again with one on disk under its home (pruned of only what is old and unheld as it starts), the commands it runs keep its TMPDIR, and throwaway fleets share one browser
// install (PLAYWRIGHT_BROWSERS_PATH) instead of each downloading Chrome into its new home.
import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installDir } from "../../src/node/browser/chrome.ts";
import { OWN_TMP_KEEP_MS, ownTmp, ownTmpOrExec } from "../../src/node/index.ts";
import { scrubbedEnv, selfArgv } from "../../src/node/util.ts";
import { tempHome } from "../helpers.ts";

setDefaultTimeout(30_000);

/** Backdates `path` and everything below it by `ms`. */
function age(path: string, ms: number): void {
  const then = new Date(Date.now() - ms);
  if (statSync(path).isDirectory()) for (const child of readdirSync(path)) age(join(path, child), ms);
  utimesSync(path, then, then);
}

test("a node without TMPDIR runs itself again with one of its own on disk; one with TMPDIR runs on", () => {
  const home = tempHome();
  try {
    const node = join(home.dir, "node");
    // An old download nothing holds goes; a fresh one stays, a running agent's build may be writing it.
    for (const name of ["playwright-download-old", "playwright-download-new"]) {
      mkdirSync(join(ownTmp(node), name), { recursive: true });
      writeFileSync(join(ownTmp(node), name, "chrome.zip"), "zip");
    }
    age(join(ownTmp(node), "playwright-download-old"), OWN_TMP_KEEP_MS + 60_000);
    // One old file written into lately keeps its dir.
    mkdirSync(join(ownTmp(node), "build"));
    writeFileSync(join(ownTmp(node), "build", "a.o"), "o");
    age(join(ownTmp(node), "build"), OWN_TMP_KEEP_MS + 60_000);
    writeFileSync(join(ownTmp(node), "build", "b.o"), "o");
    const calls: [string, string[], Record<string, string>][] = [];
    ownTmpOrExec(node, { HOME: home.dir, PATH: "/usr/bin:/bin" }, (file, args, env) => void calls.push([file, args, env]));
    expect(calls).toHaveLength(1);
    const [file, args, env] = calls[0]!;
    // This same command line: its first the program run.
    expect(file).toBe(selfArgv()[0]!);
    expect(args).toEqual([...selfArgv(), ...process.argv.slice(2)]);
    expect(env).toEqual({ HOME: home.dir, PATH: "/usr/bin:/bin", TMPDIR: ownTmp(node), TMP: ownTmp(node), TEMP: ownTmp(node) });
    expect(readdirSync(ownTmp(node)).sort()).toEqual(["build", "playwright-download-new"]);
    expect(statSync(ownTmp(node)).mode & 0o777).toBe(0o700);

    // A TMPDIR from its environment is the node's to keep, and nothing of it is touched.
    const other = join(home.dir, "node2");
    ownTmpOrExec(other, { HOME: home.dir, TMPDIR: home.dir }, () => calls.push(["", [], {}]));
    expect(calls).toHaveLength(1);
    expect(existsSync(ownTmp(other))).toBe(false);

    // An exec that fails leaves the node running as it is.
    expect(() =>
      ownTmpOrExec(other, { HOME: home.dir }, () => {
        throw new Error("ENOEXEC");
      }),
    ).not.toThrow();
  } finally {
    home.done();
  }
});

test.skipIf(process.platform !== "linux")("a file a still running child holds in the node's temp dir survives a node restart", async () => {
  const home = tempHome();
  const node = join(home.dir, "node");
  const environ = (pid: number) => {
    try {
      return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
    } catch {
      return [];
    }
  };
  const until = async (what: string, fn: () => boolean) => {
    const end = Date.now() + 20_000;
    while (!fn()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await Bun.sleep(50);
    }
  };
  // `fleetd node run` without TMPDIR, not joined: as a service (stderr not a terminal) it waits for its config, the
  // exec long done, and keeps its pid through it.
  const startNode = async () => {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../../src/main.ts"), "node", "run", "--home", node], {
      env: { HOME: home.dir, PATH: process.env.PATH ?? "/usr/bin:/bin" },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    await until("the node's own TMPDIR", () => environ(proc.pid).includes(`TMPDIR=${ownTmp(node)}`));
    expect(environ(proc.pid)).toContain(`TMP=${ownTmp(node)}`);
    return proc;
  };
  const stop = async (proc: Bun.Subprocess) => {
    proc.kill("SIGTERM");
    await proc.exited;
  };
  let child: Bun.Subprocess | undefined;
  try {
    const first = await startNode();
    // What the node started, with its TMPDIR: a file it keeps open, which outlives the node.
    child = Bun.spawn(["sh", "-c", 'mkdir "$TMPDIR/held" && exec 3>"$TMPDIR/held/out" && echo up && exec sleep 60'], {
      env: { PATH: "/usr/bin:/bin", TMPDIR: ownTmp(node) },
      stdout: "pipe",
    });
    await new Response(child.stdout as ReadableStream).body!.getReader().read();
    mkdirSync(join(ownTmp(node), "left"));
    // Both untouched for longer than the node keeps what nothing holds.
    for (const name of ["held", "left"]) age(join(ownTmp(node), name), OWN_TMP_KEEP_MS + 60_000);
    await stop(first);

    const second = await startNode();
    await stop(second);
    expect(existsSync(join(ownTmp(node), "held", "out"))).toBe(true);
    expect(existsSync(join(ownTmp(node), "left"))).toBe(false);
  } finally {
    child?.kill("SIGKILL");
    home.done();
  }
});

test("the commands the node runs keep its temp dir", () => {
  const was = process.env.TMPDIR;
  process.env.TMPDIR = "/home/ada/.fleetd/node/own-tmp";
  try {
    expect(scrubbedEnv().TMPDIR).toBe("/home/ada/.fleetd/node/own-tmp");
  } finally {
    if (was === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = was;
  }
});

test("the browser installs where PLAYWRIGHT_BROWSERS_PATH says, a cache throwaway fleets share, else in the node's home", () => {
  const home = "/home/ada/.fleetd/node";
  expect(installDir(home, {})).toBe("/home/ada/.fleetd/node/browser/ms-playwright");
  expect(installDir(home, { PLAYWRIGHT_BROWSERS_PATH: "/home/ada/.cache/ms-playwright" })).toBe("/home/ada/.cache/ms-playwright");
  // Playwright's "0" (inside its package) and an empty value are the node's own dir.
  expect(installDir(home, { PLAYWRIGHT_BROWSERS_PATH: "0" })).toBe("/home/ada/.fleetd/node/browser/ms-playwright");
  expect(installDir(home, { PLAYWRIGHT_BROWSERS_PATH: "" })).toBe("/home/ada/.fleetd/node/browser/ms-playwright");
});
