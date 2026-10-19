// `pnpm debug-guard-check [--packaged <binary>] [--test-packaged <binary>]`: a release build launched with a debugging
// switch exits at once and nothing ever listens on the debug port; the unpublished test build (MAIN_VITE_FLEETD_TEST_BUILD=1)
// still opens it, for the packaged CDP smoke.
//
// --packaged: a real package (electron-builder, with the electronFuses from electron-builder.yml). Every switch is
// checked, Node's --inspect included, which only the fuses can keep closed (it listens before any app code runs).
// Without it, the script builds both variants and lays each out as a packaged app around a copy of Electron (no fuses),
// and checks the switches the app itself refuses. Linux only; each launch gets a throwaway FLEETD_HOME.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";

const ROOT = path.resolve(import.meta.dirname, "..");
const WORK = path.join(ROOT, "node_modules/.cache/debug-guard");
/** The lead's port, and one for Node's inspector. */
const PORTS = [9333, 9334] as const;
const REFUSED_EXIT = 3;
const START_MS = 15_000;

const { values } = parseArgs({ options: { packaged: { type: "string" }, "test-packaged": { type: "string" } } });

const fail = (message: string): never => {
  console.error(`FAIL ${message}`);
  process.exit(1);
};

/** Electron's binary, fetched on first use (its download progress goes to stdout too). */
const electronDist = (): string => path.dirname(createRequire(path.join(ROOT, "package.json"))("electron") as string);

/** Builds one variant into WORK/<name>/out with electron-vite. */
const build = (name: string, testBuild: boolean): string => {
  const out = path.join(WORK, name, "out");
  fs.rmSync(out, { recursive: true, force: true });
  const env = { ...process.env, MAIN_VITE_FLEETD_TEST_BUILD: testBuild ? "1" : "" };
  execFileSync(path.join(ROOT, "node_modules/.bin/electron-vite"), ["build", "--outDir", out], { cwd: ROOT, env, stdio: "ignore" });
  return out;
};

/** Hard-links (or, across filesystems, copies) the tree at `from` into `to`, giving the file `rename[0]` the name `rename[1]`. */
const linkTree = (from: string, to: string, rename: readonly [string, string]): void => {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, src === rename[0] ? rename[1] : entry.name);
    if (entry.isDirectory()) linkTree(src, dst, rename);
    else if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(src), dst);
    else {
      try {
        fs.linkSync(src, dst);
      } catch {
        fs.copyFileSync(src, dst);
        fs.chmodSync(dst, fs.statSync(src).mode);
      }
    }
  }
};

/**
 * A packaged layout: Electron's files with the binary named `fleetd`, so app.isPackaged is true, and the app in
 * resources/app. Returns the binary.
 */
const fakePackage = (name: string, out: string): string => {
  const dist = electronDist();
  const dir = path.join(WORK, name, "fleetd");
  fs.rmSync(dir, { recursive: true, force: true });
  linkTree(dist, dir, [path.join(dist, "electron"), "fleetd"]);
  const app = path.join(dir, "resources/app");
  fs.mkdirSync(app, { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { name: string; productName: string };
  fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: pkg.name, productName: pkg.productName, type: "module", main: "out/main/index.js" }));
  fs.cpSync(out, path.join(app, "out"), { recursive: true });
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(app, "node_modules"));
  return path.join(dir, "fleetd");
};

/**
 * The reviewer's repro: the same package with its binary renamed `electron`, which makes app.isPackaged false. The
 * guard must not care. Returns the renamed binary.
 */
const renamedCopy = (binary: string): string => {
  const dir = path.join(WORK, "renamed");
  fs.rmSync(dir, { recursive: true, force: true });
  linkTree(path.dirname(binary), dir, [binary, "electron"]);
  return path.join(dir, "electron");
};

const listening = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

interface Run {
  readonly code: number | null;
  /** The ports that ever accepted a connection, probed every 2 ms from spawn until 300 ms after exit. */
  readonly opened: Array<number>;
  readonly output: string;
}

/** Launches `binary`; stops it by its PID after `keepMs` if it's still running (null code then). */
const launch = async (name: string, binary: string, args: Array<string>, env: Record<string, string>, keepMs = START_MS): Promise<Run> => {
  for (const port of PORTS) if (await listening(port)) fail(`port ${port} is already in use; free it and run again`);
  const home = path.join(WORK, "homes", name.replace(/\W+/gu, "-"));
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  const child = spawn(binary, ["--no-sandbox", "--ozone-platform=headless", `--user-data-dir=${path.join(home, "chromium")}`, ...args], {
    env: { HOME: process.env["HOME"] ?? "", PATH: process.env["PATH"] ?? "", FLEETD_HOME: path.join(home, "fleetd"), ...env },
    // fd 3 and 4 for --remote-debugging-pipe.
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (d: Buffer) => (output += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (output += d.toString()));
  const opened = new Set<number>();
  const probing = { on: true };
  const probe = (async () => {
    while (probing.on) {
      for (const port of PORTS) if (await listening(port)) opened.add(port);
      await new Promise((r) => setTimeout(r, 2));
    }
  })();
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  // Electron quits cleanly on SIGTERM (exit 0), so whether it was still running is ours to remember.
  const stopped = { byUs: false };
  const timer = setTimeout(() => {
    stopped.byUs = true;
    child.kill("SIGTERM");
  }, keepMs);
  const code = await exited;
  clearTimeout(timer);
  await new Promise((r) => setTimeout(r, 300));
  probing.on = false;
  await probe;
  return { code: stopped.byUs ? null : code, opened: [...opened], output };
};

interface Case {
  readonly name: string;
  readonly args: Array<string>;
  readonly env: Record<string, string>;
  /** False where the fuse makes Electron drop the setting before the app sees it: it starts, and nothing listens. */
  readonly refused: boolean;
}

const REMOTE: Array<Case> = [
  { name: "--remote-debugging-port=9333", args: ["--remote-debugging-port=9333"], env: {}, refused: true },
  { name: "-remote-debugging-port=9333", args: ["-remote-debugging-port=9333"], env: {}, refused: true },
  { name: "--remote-debugging-pipe", args: ["--remote-debugging-pipe"], env: {}, refused: true },
  { name: "ELECTRON_EXTRA_LAUNCH_ARGS", args: [], env: { ELECTRON_EXTRA_LAUNCH_ARGS: "--remote-debugging-port=9333" }, refused: true },
];
const INSPECT: Array<Case> = [
  { name: "--inspect=9334", args: ["--inspect=9334"], env: {}, refused: true },
  { name: "--inspect-brk=9334", args: ["--inspect-brk=9334"], env: {}, refused: true },
  { name: "NODE_OPTIONS=--inspect", args: [], env: { NODE_OPTIONS: "--inspect=9334" }, refused: false },
];

if (process.platform !== "linux") fail("Linux only");
const real = values.packaged !== undefined;
const release = values.packaged ?? fakePackage("release", build("release", false));
const test = values["test-packaged"] ?? (real ? null : fakePackage("test", build("test", true)));

for (const c of real ? [...REMOTE, ...INSPECT] : REMOTE) {
  const run = await launch(c.name, release, c.args, c.env, c.refused ? START_MS : 3000);
  if (run.opened.length > 0) fail(`release build with ${c.name}: port ${run.opened.join(", ")} listened`);
  if (!c.refused) {
    if (run.code !== null) fail(`release build with ${c.name}: exit ${run.code}\n${run.output}`);
    console.log(`ok  release build ignores ${c.name} (fuse; nothing listened)`);
    continue;
  }
  if (run.code !== REFUSED_EXIT) fail(`release build with ${c.name}: exit ${run.code ?? "none (still running)"}, not ${REFUSED_EXIT}\n${run.output}`);
  if (!run.output.includes("refusing to start")) fail(`release build with ${c.name}: no refusal message\n${run.output}`);
  console.log(`ok  release build refuses ${c.name} (exit ${REFUSED_EXIT}, nothing listened)`);
}
if (!real) console.log("--  --inspect is closed by electron-builder.yml's electronFuses; run with --packaged <binary> to check it");

for (const c of REMOTE.slice(0, 1)) {
  const run = await launch(`renamed ${c.name}`, renamedCopy(release), c.args, c.env);
  if (run.opened.length > 0) fail(`release build renamed to electron with ${c.name}: port ${run.opened.join(", ")} listened`);
  if (run.code !== REFUSED_EXIT) fail(`release build renamed to electron with ${c.name}: exit ${run.code ?? "none (still running)"}\n${run.output}`);
  console.log(`ok  release build renamed to electron still refuses ${c.name} (exit ${REFUSED_EXIT}, nothing listened)`);
}

const plain = await launch("plain", release, [], {}, 3000);
if (plain.code !== null) fail(`release build without switches exited (${plain.code})\n${plain.output}`);
console.log("ok  release build without switches starts");

if (test !== null) {
  const run = await launch("test-build", test, ["--remote-debugging-port=9333"], {}, 3000);
  if (run.code !== null || !run.opened.includes(9333)) fail(`test build with --remote-debugging-port: exit ${run.code}, opened ${run.opened.join(",")}\n${run.output}`);
  console.log("ok  test build keeps --remote-debugging-port (for the packaged CDP smoke)");
}
console.log("PASS");
