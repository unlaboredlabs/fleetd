// Lab-only stand-in for `claude` (tests/lab/failure; never shipped, only ever first on a lab node's PATH). It runs the
// real claude as its child with the same argv and environment and relays stdin and stdout line by line, except that
// the first N stream-json user messages (a shared counter, across processes) are answered from a recorded fixture
// instead of reaching claude. It never opens a network connection itself; the real claude does all of that.
//
// usage (from the `claude` script installShim writes): node claudeShim.ts <config.json> <claude args…>
//
// A replayed message never reaches claude, so its session file may not exist when the node later respawns with
// `--resume <id>`; the shim then starts it with `--session-id <id>`, as the first real message would have.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

interface Config {
  readonly real: string;
  readonly fixture: string;
  readonly replays: number;
  readonly state: string;
  readonly resetsInSec: number;
}
type Msg = Record<string, any>;
interface Line {
  readonly dir: string;
  readonly ms: number;
  readonly msg?: Msg;
}

const [configPath, ...args] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath!, "utf8")) as Config;
const fixture = fs
  .readFileSync(config.fixture, "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "")
  .map((l) => JSON.parse(l) as Line);
const fixtureIn = fixture.find((l) => l.dir === "in" && l.msg?.type === "user")!;
const fixtureOut = fixture.filter((l) => l.dir === "out" && l.msg !== undefined);
const fixtureRun = fixtureIn.msg!.uuid as string;
const fixtureSession = fixtureOut.find((l) => typeof l.msg!.session_id === "string" && l.msg!.session_id !== "")?.msg!.session_id as string;

const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const sessionId = flag("--session-id") ?? flag("--resume") ?? randomUUID();
const configDir = process.env.CLAUDE_CONFIG_DIR;
const resumeId = flag("--resume");
if (resumeId !== undefined && configDir !== undefined) {
  const projects = path.join(configDir, "projects");
  const filed = fs.existsSync(projects) && fs.readdirSync(projects).some((d) => fs.existsSync(path.join(projects, d, `${resumeId}.jsonl`)));
  if (!filed) args[args.indexOf("--resume")] = "--session-id";
}

/** Takes one replay from the shared budget, or returns false when it is spent. */
const takeReplay = () => {
  const done = Number(fs.readFileSync(config.state, "utf8").trim());
  if (done >= config.replays) return false;
  fs.writeFileSync(config.state, `${done + 1}\n`);
  return true;
};

const child = spawn(config.real, args, { stdio: ["pipe", "pipe", "inherit"], env: process.env });
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => child.kill(signal));

// Whole lines only, so a replayed line never lands inside one of claude's.
let lastResultError = false;
const emit = (msg: Msg) => {
  if (msg.type === "result") lastResultError = msg.is_error === true;
  process.stdout.write(`${JSON.stringify(msg)}\n`);
};
readline.createInterface({ input: child.stdout! }).on("line", (line) => {
  try {
    emit(JSON.parse(line) as Msg);
  } catch {
    process.stdout.write(`${line}\n`);
  }
});

/** The fixture's output for one user message, as if claude had produced it now for this session and run. */
const replay = async (runId: string) => {
  let prev = fixtureIn.ms;
  for (const line of fixtureOut) {
    // The recorded pacing, capped so a replay stays quick.
    await new Promise((r) => setTimeout(r, Math.min(Math.max(line.ms - prev, 0), 500)));
    prev = line.ms;
    const text = JSON.stringify(line.msg)
      .replaceAll(fixtureRun, runId)
      .replaceAll(fixtureSession, sessionId)
      .replaceAll("/work/project", process.cwd())
      .replaceAll("/work/claude-config", configDir ?? "/work/claude-config");
    const msg = JSON.parse(text) as Msg;
    if (typeof msg.uuid === "string") msg.uuid = randomUUID();
    if (typeof msg.message?.id === "string") msg.message.id = randomUUID();
    if (msg.type === "rate_limit_event" && msg.rate_limit_info !== undefined) {
      msg.rate_limit_info.resetsAt = Math.floor(Date.now() / 1000) + config.resetsInSec;
    }
    emit(msg);
  }
};

// stdin lines are handled strictly in order: a message forwarded while a replay runs waits for it.
let queue = Promise.resolve();
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  queue = queue.then(async () => {
    let msg: Msg | undefined;
    try {
      msg = JSON.parse(line) as Msg;
    } catch {
      msg = undefined;
    }
    if (msg?.type === "user" && takeReplay()) return replay(typeof msg.uuid === "string" ? msg.uuid : randomUUID());
    child.stdin!.write(`${line}\n`);
  });
});
input.on("close", () => void queue.then(() => child.stdin!.end()));

child.on("exit", (code, signal) => {
  // claude exits 1 when stdin closes after an error result; a replayed one counts as its last result.
  if (signal !== null) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  } else process.exit(lastResultError && code === 0 ? 1 : (code ?? 1));
});
