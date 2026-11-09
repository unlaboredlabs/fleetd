// Nothing the node starts leaves files in a /tmp that may be held in memory: a node started without TMPDIR runs itself
// again with one on disk under its home, the commands it runs keep its TMPDIR, and throwaway fleets share one browser
// install (PLAYWRIGHT_BROWSERS_PATH) instead of each downloading Chrome into its new home.
import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installDir } from "../../src/node/browser/chrome.ts";
import { ownTmp, ownTmpOrExec } from "../../src/node/index.ts";
import { scrubbedEnv, selfArgv } from "../../src/node/util.ts";
import { tempHome } from "../helpers.ts";

setDefaultTimeout(30_000);

test("a node without TMPDIR runs itself again with an emptied one of its own on disk; one with TMPDIR runs on", () => {
  const home = tempHome();
  try {
    const node = join(home.dir, "node");
    // What the last node left there goes.
    mkdirSync(join(ownTmp(node), "playwright-download-x"), { recursive: true });
    writeFileSync(join(ownTmp(node), "playwright-download-x", "chrome.zip"), "zip");
    const calls: [string, string[], Record<string, string>][] = [];
    ownTmpOrExec(node, { HOME: home.dir, PATH: "/usr/bin:/bin" }, (file, args, env) => void calls.push([file, args, env]));
    expect(calls).toHaveLength(1);
    const [file, args, env] = calls[0]!;
    // This same command line: its first the program run.
    expect(file).toBe(selfArgv()[0]!);
    expect(args).toEqual([...selfArgv(), ...process.argv.slice(2)]);
    expect(env).toEqual({ HOME: home.dir, PATH: "/usr/bin:/bin", TMPDIR: ownTmp(node), TMP: ownTmp(node), TEMP: ownTmp(node) });
    expect(existsSync(join(ownTmp(node), "playwright-download-x"))).toBe(false);
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

test.skipIf(process.platform !== "linux")("`fleetd node run` started without TMPDIR keeps its pid and gets the node's own", async () => {
  const home = tempHome();
  const node = join(home.dir, "node");
  // Not joined: as a service (stderr not a terminal) it waits for its config, the exec long done.
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../../src/main.ts"), "node", "run", "--home", node], {
    env: { HOME: home.dir, PATH: process.env.PATH ?? "/usr/bin:/bin" },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  try {
    const environ = () => {
      try {
        return readFileSync(`/proc/${proc.pid}/environ`, "utf8").split("\0");
      } catch {
        return [];
      }
    };
    const end = Date.now() + 20_000;
    while (!environ().includes(`TMPDIR=${ownTmp(node)}`) && proc.exitCode === null && Date.now() < end) await Bun.sleep(50);
    expect(environ()).toContain(`TMPDIR=${ownTmp(node)}`);
    expect(environ()).toContain(`TMP=${ownTmp(node)}`);
    expect(existsSync(ownTmp(node))).toBe(true);
  } finally {
    proc.kill("SIGTERM");
    await proc.exited;
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
