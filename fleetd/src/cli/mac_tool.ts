// `fleetd mac`, the `mac` on every agent session's PATH: the agents' Mac, from an
// agent on any machine. Each command goes to the agent's own node, which seals it to the Mac. `mac run` prints the
// command's output as it comes and exits with its exit code.
import { ASK_EVERY } from "../node/mac_tool/queue.ts";
import { nodeCall, why } from "./node_call.ts";
import { MAC_HELP } from "./usages.ts";

/** One step: past the node's own wait for the Mac (node/mac_tool/client.ts, 180 s) plus its wait for a restarting
 * hub's link (node/lead RELINK_WAIT_MS, 30 s). */
const STEP_WAIT_MS = 230_000;
/** A push or pull: many steps in one call. */
const FILES_WAIT_MS = 3_600_000;
export const UNAVAILABLE = 69;
export const USAGE = 64;

const parseJob = (text: string | undefined) => (text !== undefined && /^\+?[0-9]+$/.test(text) && Number(text) <= 0xffffffff ? Number(text) : undefined);

export async function run(args: string[]): Promise<number> {
  const rest = args.slice(1);
  switch (args[0]) {
    case undefined:
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(MAC_HELP);
      return 0;
    case "push":
      return printDone(await call({ step: "push" }, FILES_WAIT_MS));
    case "run": {
      const parsed = parseRun(rest, (n) => process.env[n]);
      return typeof parsed === "string" ? usage(parsed) : runCommand(...parsed);
    }
    case "logs": {
      const follow = rest.some((a) => a === "-f" || a === "--follow");
      const job = parseJob(rest.find((a) => !a.startsWith("-")));
      return job === undefined ? usage("mac logs <job> [-f]") : followJob(job, follow);
    }
    case "ps":
      return printDone(await call({ step: "ps" }, STEP_WAIT_MS));
    case "kill": {
      const job = parseJob(rest[0]);
      return job === undefined ? usage("mac kill <job>") : printDone(await call({ step: "kill", job }, STEP_WAIT_MS));
    }
    case "pull":
      return rest[0] === undefined
        ? usage("mac pull <path> [to]")
        : printDone(await call({ step: "pull", path: rest[0], to: rest[1] ?? null }, FILES_WAIT_MS));
    case "sim":
      if (rest[0] === "start") {
        const parsed = simStartArgs(rest.slice(1));
        return parsed instanceof Error ? usage(parsed.message) : simStart(...parsed);
      }
      if (rest[0] === "end") return printDone(await call({ step: "sim_end" }, STEP_WAIT_MS));
      return usage("mac sim start [--device <type>] [--no-wait] | mac sim end");
    case "agent-device":
      return runCommand(["agent-device", ...rest.map(shQuote)], [], false);
    default:
      return usage(`mac has no command ${args[0]}`);
  }
}

/** `mac sim start`'s arguments: the device type, and whether it waits its turn (all but `--no-wait`). */
export function simStartArgs(args: string[]): [string | undefined, boolean] | Error {
  const wait = !args.includes("--no-wait");
  const device = simDevice(args.filter((a) => a !== "--no-wait"));
  return device instanceof Error ? device : [device, wait];
}

/** `mac sim start`'s simulator: asked for again every ASK_EVERY while it waits in the Mac's line, its place printed
 * each time it changes. */
async function simStart(device: string | undefined, wait: boolean): Promise<number> {
  let said: string | undefined;
  for (;;) {
    const a = await call({ step: "sim_start", device: device ?? null, wait }, STEP_WAIT_MS);
    if (!("ok" in a) || a.ok?.step !== "sim_queued") return printDone(a);
    const now = JSON.stringify([u64OrNull(a.ok.place), a.ok.why ?? null]);
    if (said !== now) {
      await new Promise<void>((r) => process.stdout.write(shown(a.ok), () => r()));
      said = now;
    }
    await Bun.sleep(ASK_EVERY);
  }
}

/** `mac sim start --device`'s type: nothing, or `--device <type>` (`--device=<type>`). */
export function simDevice(args: string[]): string | undefined | Error {
  const bad = new Error("mac sim start [--device <type>] [--no-wait], a type as xcrun simctl list devicetypes names it");
  if (args.length === 0) return undefined;
  if (args.length === 2 && args[0] === "--device" && args[1]!.trim() !== "") return args[1];
  if (args.length === 1 && args[0]!.startsWith("--device=") && args[0]!.slice(9).trim() !== "") return args[0]!.slice(9);
  return bad;
}

function usage(why: string): number {
  process.stderr.write(`mac: ${why}\nmac: see mac --help\n`);
  return USAGE;
}

/** `run`'s command line, the variables it names with their values, and `--bg`; or why not. */
export function parseRun(args: string[], vars: (name: string) => string | undefined): [string[], object[], boolean] | string {
  const env: object[] = [];
  let background = false;
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      i++;
      break;
    }
    if (a === "--bg") background = true;
    else if (a === "--env") {
      const name = args[i + 1];
      if (name === undefined) return "--env needs a variable's name";
      const value = vars(name);
      if (value === undefined) return `--env ${name}: ${name} isn't set here`;
      env.push({ name, value });
      i++;
    } else if (a.startsWith("--env=")) {
      const name = a.slice(6);
      const value = vars(name);
      if (value === undefined) return `--env ${name}: ${name} isn't set here`;
      env.push({ name, value });
    } else break;
  }
  const line = args.slice(i);
  if (line.length === 0) return "mac run needs a command line";
  return [line, env, background];
}

/** `arg` as one word for the Mac's shell. */
export const shQuote = (arg: string) =>
  arg !== "" && /^[A-Za-z0-9\-_./=:@,+%^]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;

type Answer = { ok: any } | { text: string; code: number };

async function call(step: Record<string, unknown>, waitMs: number): Promise<Answer> {
  try {
    return answer(await nodeCall({ ...step, op: "mac" }, waitMs));
  } catch (error) {
    return { text: `mac: ${why(error)}\n`, code: UNAVAILABLE };
  }
}

export function answer(frame: Record<string, unknown>): Answer {
  const result = frame.result;
  if (result !== null && typeof result === "object" && !Array.isArray(result)) return { ok: result };
  const error = frame.error as any;
  let text = `mac: ${typeof error?.message === "string" ? error.message : "the node sent no answer"}\n`;
  if (typeof error?.fix === "string") text += `mac: ${error.fix}\n`;
  return { text, code: error?.code === "machine_offline" || error?.code === "forbidden" ? UNAVAILABLE : 1 };
}

const u64 = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);
const u64OrNull = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
/** serde_json's `Value` display: a number or string as JSON. */
const display = (v: unknown) => (v === undefined ? "null" : JSON.stringify(v));

export function shown(result: any): string {
  switch (result?.step) {
    case "push":
      return `pushed: ${typeof result.folder === "string" ? result.folder : "?"} (${Math.ceil(u64(result.sentBytes) / 1024)} KB sent)\n`;
    case "ps": {
      const jobs: any[] = Array.isArray(result.jobs) ? result.jobs : [];
      if (jobs.length === 0) return "no jobs\n";
      return jobs
        .map((j) => {
          const state =
            j.running === true ? "running" : typeof j.exitCode === "number" && Number.isInteger(j.exitCode) ? `exited ${j.exitCode}` : "ended";
          return `${String(u64(j.job)).padStart(4)}  ${state.padEnd(10)} ${j.background === true ? "--bg " : ""}${typeof j.command === "string" ? j.command : ""}\n`;
        })
        .join("");
    }
    case "kill":
      return result.killed === true ? `job ${display(result.job)} ends\n` : `job ${display(result.job)} isn't running\n`;
    case "pull":
      return `pulled: ${typeof result.path === "string" ? result.path : "?"} (${Math.ceil(u64(result.bytes) / 1024)} KB)\n`;
    case "run":
      return `job ${display(result.job)}\n`;
    case "sim_start":
      return `your simulator: ${typeof result.device === "string" ? result.device : "?"} (${typeof result.udid === "string" ? result.udid : "?"}). Drive it with agent-device, which runs on the Mac now; end it with mac sim end. Plain simctl there needs fleetd's device set: mac run -- 'xcrun simctl --set "$FLEETD_MAC_SIM_SET" install "$FLEETD_MAC_SIM" <app>'\n`;
    case "sim_queued": {
      const secs = u64OrNull(result.secs);
      const about = secs === null ? "" : `, about ${secs} s`;
      return `${ordinal(u64(result.place))} in line for a simulator${about}: ${typeof result.why === "string" ? result.why : "waiting"}\n`;
    }
    case "sim_end":
      return result.ended === true ? "your simulator ended\n" : "you had no simulator on the Mac\n";
    default:
      return `${display(result)}\n`;
  }
}

/** 1st, 2nd, 3rd, 4th, ..., 11th, 12th, 13th, 21st. */
export function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${n}${suffix}`;
}

function printDone(a: Answer): number {
  if ("ok" in a) {
    process.stdout.write(shown(a.ok));
    return 0;
  }
  process.stderr.write(a.text);
  return a.code;
}

async function runCommand(line: string[], env: object[], background: boolean): Promise<number> {
  const a = await call({ step: "run", args: line, env, background }, STEP_WAIT_MS);
  if (!("ok" in a)) {
    process.stderr.write(a.text);
    return a.code;
  }
  const job = u64(a.ok.job) >>> 0;
  if (background) {
    process.stdout.write(`job ${job} runs on the Mac: mac logs ${job} -f follows it, mac kill ${job} ends it\n`);
    return 0;
  }
  return followJob(job, true);
}

/** Prints the job's output from the start; following, until it ends, with its exit code. */
async function followJob(job: number, follow: boolean): Promise<number> {
  let offset = 0;
  for (;;) {
    const a = await call({ step: "logs", job, offset }, STEP_WAIT_MS);
    if (!("ok" in a)) {
      process.stderr.write(a.text);
      return a.code;
    }
    const result = a.ok;
    const data = Buffer.from(typeof result.dataB64 === "string" ? result.dataB64 : "", "base64");
    if (data.length > 0) await new Promise<void>((r) => process.stdout.write(data, () => r()));
    offset = typeof result.offset === "number" ? result.offset : offset;
    if (result.done === true) {
      const code = typeof result.exitCode === "number" ? result.exitCode : 1;
      return Number.isInteger(code) && code >= 0 && code <= 255 ? code : 1;
    }
    if (!follow && data.length === 0) return 0;
  }
}
