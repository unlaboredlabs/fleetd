#!/usr/bin/env node
// Disposable stock-T3 lab: two pinned T3 servers with their own homes, ports and Claude config dirs.
// Usage: node lab/lab.mjs up | down | status | restart | crash-restart [lab-a|lab-b]
//
// Safety: never touches ~/.t3. Stops processes only by the PID recorded at spawn, after checking that
// the PID still runs our lab server (cmdline contains this instance's --base-dir).
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LAB = process.env.FLEETD_LAB ?? path.join(os.homedir(), "src/fleetd-lab");
const T3_SRC = process.env.T3_SRC ?? path.join(LAB, "t3-src");
const T3_PIN = "2fbd4318fc";
const HOST = "127.0.0.1";

// lab-a's "fleetd" Claude instance denies every T3 tool (the wildcard form DESIGN §3.2 calls for) and Claude's
// native subagent tools, Task and Workflow, so every fan-out is a fleetd task in a fleetd slot. T3 keeps one value
// per launch flag, so all of them go in one comma-separated list. lab-b is the control with no launch args.
const INSTANCES = [
  { name: "lab-a", port: 4711, launchArgs: "--disallowedTools mcp__t3-code__*,Task,Workflow" },
  { name: "lab-b", port: 4712, launchArgs: "" },
];

const suffix = (name) => name.slice(-1);
const homeDir = (i) => path.join(LAB, `home-${suffix(i.name)}`);
const claudeDir = (i) => path.join(LAB, `claude-${suffix(i.name)}`);
const repoDir = (i) => path.join(LAB, `repo-${suffix(i.name)}`);
const pidFile = (i) => path.join(LAB, "pids", `${i.name}.pid`);
const logFile = (i) => path.join(LAB, "logs", `${i.name}.log`);

if (path.resolve(LAB).startsWith(path.join(os.homedir(), ".t3"))) {
  throw new Error("refusing: lab dir is inside ~/.t3");
}

/** Claude reaches the model through the same base URL + token as the user's own CLI, read at
 *  start from ~/.claude/settings.json and passed only through process env (never written to disk). */
function claudeAuthEnv() {
  const file = path.join(os.homedir(), ".claude/settings.json");
  const env = JSON.parse(fs.readFileSync(file, "utf8")).env ?? {};
  const out = {};
  for (const key of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]) {
    if (typeof env[key] === "string" && env[key].length > 0) out[key] = env[key];
  }
  return out;
}

function scrubbedEnv(i) {
  const keep = {};
  for (const key of ["HOME", "PATH", "USER", "LANG"]) {
    if (process.env[key] !== undefined) keep[key] = process.env[key];
  }
  return {
    ...keep,
    // Leads run `fleetd` from their shell: test:lab writes LAB/bin/fleetd (the built CLI) and points
    // LAB/sock/<instance>.sock at that run's node socket.
    PATH: [path.join(LAB, "bin"), keep.PATH].filter(Boolean).join(":"),
    FLEETD_NODE_SOCK: path.join(LAB, "sock", `${i.name}.sock`),
    ...claudeAuthEnv(),
    // Every Claude process this server spawns uses the lab config dir, never ~/.claude.
    CLAUDE_CONFIG_DIR: claudeDir(i),
    CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "2",
    T3CODE_TELEMETRY_ENABLED: "false",
    T3CODE_NO_BROWSER: "true",
  };
}

/** Writes the "fleetd" instance into settings.json, keeping whatever else T3 stored there. */
function seedSettings(i) {
  const settingsPath = path.join(homeDir(i), "userdata", "settings.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const settings = fs.existsSync(settingsPath)
    ? JSON.parse(fs.readFileSync(settingsPath, "utf8"))
    : { enableProviderUpdateChecks: false };
  settings.providerInstances = {
    ...settings.providerInstances,
    fleetd: {
      driver: "claudeAgent",
      displayName: "fleetd",
      config: { homePath: claudeDir(i), launchArgs: i.launchArgs },
    },
  };
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

function seedRepo(i) {
  const dir = repoDir(i);
  if (fs.existsSync(path.join(dir, ".git"))) return;
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: dir,
      stdio: "ignore",
      env: { ...scrubbedEnv(i), GIT_AUTHOR_NAME: "lab", GIT_AUTHOR_EMAIL: "lab@localhost",
        GIT_COMMITTER_NAME: "lab", GIT_COMMITTER_EMAIL: "lab@localhost" },
    });
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "README.md"), `# ${i.name} test repo\n`);
  git("add", ".");
  git("commit", "-q", "-m", "init");
}

function readPid(i) {
  try {
    return Number(fs.readFileSync(pidFile(i), "utf8").trim()) || null;
  } catch {
    return null;
  }
}

/** True only if the PID is alive and is this instance's server (guards against PID reuse). */
function isOurServer(i, pid) {
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    return cmdline.includes(homeDir(i)) && cmdline.some((a) => a.endsWith("apps/server/src/bin.ts"));
  } catch {
    return false;
  }
}

function portOwner(port) {
  const out = execFileSync("ss", ["-H", "-ltnp", `sport = :${port}`], { encoding: "utf8" });
  const m = out.match(/pid=(\d+)/);
  return m ? Number(m[1]) : null;
}

async function waitFor(fn, ms, what) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function up(i) {
  const pid = readPid(i);
  if (pid && isOurServer(i, pid)) {
    console.log(`${i.name}: already running pid=${pid} port=${i.port}`);
    return;
  }
  if (portOwner(i.port) !== null) throw new Error(`${i.name}: port ${i.port} is taken by someone else`);
  for (const d of [homeDir(i), claudeDir(i), path.dirname(pidFile(i)), path.dirname(logFile(i))]) {
    fs.mkdirSync(d, { recursive: true });
  }
  seedSettings(i);
  seedRepo(i);
  const log = fs.openSync(logFile(i), "a");
  const child = spawn(
    process.execPath,
    [path.join(T3_SRC, "apps/server/src/bin.ts"), "serve", "--base-dir", homeDir(i),
      "--host", HOST, "--port", String(i.port), "--no-browser"],
    { cwd: repoDir(i), env: scrubbedEnv(i), detached: true, stdio: ["ignore", log, log] },
  );
  fs.writeFileSync(pidFile(i), `${child.pid}\n`);
  child.unref();
  await waitFor(async () => {
    try {
      return (await fetch(`http://${HOST}:${i.port}/.well-known/t3/environment`, { signal: AbortSignal.timeout(2_000) })).ok;
    } catch {
      return false;
    }
  }, 90_000, `${i.name} on :${i.port}`);
  console.log(`${i.name}: up pid=${child.pid} http://${HOST}:${i.port} home=${homeDir(i)}`);
}

/** SIGTERM (graceful) by recorded PID; SIGKILL after 20 s. `signal: "SIGKILL"` simulates a crash. */
async function down(i, signal = "SIGTERM") {
  const pid = readPid(i);
  if (!pid) return console.log(`${i.name}: no pid file`);
  if (!isOurServer(i, pid)) {
    fs.rmSync(pidFile(i), { force: true });
    return console.log(`${i.name}: pid ${pid} is not our server (already stopped); cleared pid file`);
  }
  const t0 = Date.now();
  process.kill(pid, signal);
  let how = signal;
  try {
    await waitFor(() => !isOurServer(i, pid), 20_000, `${i.name} to exit`);
  } catch {
    process.kill(pid, "SIGKILL");
    how = `${signal}, then SIGKILL after 20 s`;
    await waitFor(() => !isOurServer(i, pid), 5_000, `${i.name} to die`);
  }
  fs.rmSync(pidFile(i), { force: true });
  console.log(`${i.name}: stopped pid=${pid} (${how}, exited in ${Date.now() - t0} ms)`);
}

function status(i) {
  const pid = readPid(i);
  const alive = pid !== null && isOurServer(i, pid);
  console.log(`${i.name}: ${alive ? `running pid=${pid}` : "stopped"} port=${i.port} home=${homeDir(i)}`);
}

const [cmd, name] = process.argv.slice(2);
const pinned = execFileSync("git", ["-C", T3_SRC, "rev-parse", "--short=10", "HEAD"], { encoding: "utf8" }).trim();
if (pinned !== T3_PIN) throw new Error(`t3-src is at ${pinned}, expected ${T3_PIN}`);
const targets = name ? INSTANCES.filter((i) => i.name === name) : INSTANCES;
if (targets.length === 0) throw new Error(`unknown instance ${name}`);
if (cmd === "up") for (const i of targets) await up(i);
else if (cmd === "down") for (const i of targets) await down(i);
else if (cmd === "restart") for (const i of targets) { await down(i); await up(i); }
else if (cmd === "crash-restart") for (const i of targets) { await down(i, "SIGKILL"); await up(i); }
else if (cmd === "status") targets.forEach(status);
else {
  console.error("usage: lab.mjs up|down|restart|crash-restart|status [lab-a|lab-b]");
  process.exit(2);
}
