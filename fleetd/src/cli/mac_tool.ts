// `fleetd mac`, the `mac` on every agent session's PATH: the agents' Mac, from an
// agent on any machine, or on a Mac that runs agents that Mac itself. Each command goes to the agent's own node, which
// seals it to the Mac. `mac run` prints the command's output as it comes and exits with its exit code; it, `mac push`
// and `mac sim start` first say on stderr which Mac they use (`which`).
//
// In a hosted box (fleetd's computers), the worktree is in the box and no node is: there the node's half runs in this
// process (`FLEETD_MAC_HOME`, its folder), and only its `mac_where` and `mac_send` go up the box's node.sock.
import type { ErrorCode, ErrorReason } from "../shared/contracts.ts";
import { ToolError } from "../shared/errors.ts";
import { type MacCall, MacClient, type MacSide, worktreeOf } from "../node/mac_tool/client.ts";
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
      if (rest[0] !== undefined && SIM_CONTROLS.includes(rest[0])) {
        const parsed = simControlArgs(rest);
        return parsed instanceof Error ? usage(parsed.message) : printDone(await call({ step: "sim_control", ...parsed }, STEP_WAIT_MS));
      }
      return usage(`mac sim start [--device <type>] [--no-wait] | mac sim end | mac sim ${SIM_CONTROLS.join("|")} ...`);
    case "agent-device":
      return runCommand(["agent-device", ...rest.map(shQuote)], [], false, false);
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

/** The device controls `mac sim` takes. */
export const SIM_CONTROLS = ["rotate", "shake", "home", "lock", "appearance", "text-size", "location", "fold", "screenshot"];
const SIM_CONTROL_USAGE =
  "mac sim rotate left|right | shake | home | lock | appearance [light|dark] | text-size <size> | location <lat>,<lon> | fold closed|half-open|open|laptop | screenshot [to]";

/** `mac sim <control> …` as the step's control and value (and a screenshot's `to`), or why not. */
export function simControlArgs(args: string[]): { control: string; value?: string; to?: string } | Error {
  const [verb, ...more] = args;
  const bad = new Error(SIM_CONTROL_USAGE);
  switch (verb) {
    case "rotate":
      return more.length === 1 && (more[0] === "left" || more[0] === "right") ? { control: `rotate_${more[0]}` } : bad;
    case "shake":
    case "home":
    case "lock":
      return more.length === 0 ? { control: verb } : bad;
    case "appearance":
      if (more.length === 0) return { control: "appearance" };
      return more.length === 1 && (more[0] === "light" || more[0] === "dark") ? { control: "appearance", value: more[0] } : bad;
    case "text-size":
      return more.length === 1 && /^[a-z-]{4,40}$/.test(more[0]!) ? { control: "text_size", value: more[0] } : bad;
    case "location": {
      const at = more.join(",").replace(/,+/g, ",");
      return /^-?[0-9.]+,-?[0-9.]+$/.test(at) ? { control: "location", value: at } : bad;
    }
    case "fold":
      return more.length === 1 && ["closed", "half-open", "open", "laptop"].includes(more[0]!) ? { control: "fold", value: more[0] } : bad;
    case "screenshot":
      return more.length <= 1 ? { control: "screenshot", ...(more[0] ? { to: more[0] } : {}) } : bad;
    default:
      return bad;
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

/** Where the node's half of `mac` runs in this process: a hosted box's folder for it, which the box's session sets. */
export const MAC_HOME_ENV = "FLEETD_MAC_HOME";
/** A hub call's backstop past the wait the client gives it: the box's link may be moving to another host. */
const RELINK_MS = 50_000;

async function call(step: Record<string, unknown>, waitMs: number): Promise<Answer> {
  try {
    const home = process.env[MAC_HOME_ENV];
    return answer(home ? await here(home, step, process.env.FLEETD_THREAD_ID, process.cwd()) : await nodeCall({ ...step, op: "mac" }, waitMs));
  } catch (error) {
    return { text: `mac: ${why(error)}\n`, code: UNAVAILABLE };
  }
}

/** The node's answer to `step`, made here: the session's Mac client, from the worktree `cwd` is in, its hub calls sent
 * with `send` (up the box's node.sock). */
export async function here(
  home: string,
  step: Record<string, unknown>,
  thread: string | undefined,
  cwd: string,
  send: (call: Record<string, unknown>, waitMs: number) => Promise<Record<string, unknown>> = nodeCall,
): Promise<Record<string, unknown>> {
  try {
    if (!thread) throw new ToolError("forbidden", "The agents' Mac is for agents' sessions, and this call comes from none.", "run fleetd mac from an agent's session");
    const side: MacSide = {
      home,
      async call(op, args, opts) {
        let frame: Record<string, unknown>;
        try {
          frame = await send({ ...args, op }, opts.waitMs + RELINK_MS);
        } catch (e) {
          // The box's node.sock not reached, or no answer: what the node's own call meets as its hub link away, so it's
          // sent again where a step may be, and said as it is.
          throw new ToolError("machine_offline", why(e), "try again shortly");
        }
        const error = frame.error as { code?: string; message?: string; fix?: string; reason?: ErrorReason } | undefined;
        if (error) throw new ToolError((error.code ?? "failed") as ErrorCode, error.message ?? "the workspace sent no answer", error.fix, error.reason);
        return (frame.result ?? {}) as Record<string, unknown>;
      },
    };
    return { result: { op: "mac", ...(await new MacClient(side).call(thread, worktreeOf(cwd, undefined), step as MacCall)) } };
  } catch (e) {
    return { error: e instanceof ToolError ? e.toJSON() : { code: "failed", message: why(e) } };
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

/** The line saying which Mac a command used: the agent's own, or the agents' Mac. */
export function which(result: any): string {
  const mac = result?.mac;
  if (typeof mac?.name !== "string") return "";
  return mac.here === true
    ? `mac: on this Mac (${mac.name}), the one you run on: jobs run in your worktree, no push needed\n`
    : `mac: on the agents' Mac (${mac.name})\n`;
}

export function shown(result: any): string {
  switch (result?.step) {
    case "push":
      if (result.mac?.here === true) return `nothing to push: jobs run in your worktree (${typeof result.folder === "string" ? result.folder : "?"})\n`;
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
      return `your simulator: ${typeof result.device === "string" ? result.device : "?"} (${typeof result.udid === "string" ? result.udid : "?"}), your screen: the person can watch it in Screens and take it over. Drive it with agent-device, which runs on the Mac now; end it with mac sim end. Plain simctl there needs fleetd's device set: mac run -- 'xcrun simctl --set "$FLEETD_MAC_SIM_SET" install "$FLEETD_MAC_SIM" <app>'\n`;
    case "sim_queued": {
      const secs = u64OrNull(result.secs);
      const about = secs === null ? "" : `, about ${secs} s`;
      return `${ordinal(u64(result.place))} in line for a simulator${about}: ${typeof result.why === "string" ? result.why : "waiting"}\n`;
    }
    case "sim_end":
      return result.ended === true ? "your simulator ended\n" : "you had no simulator on the Mac\n";
    case "sim_control":
      return typeof result.path === "string"
        ? `screenshot of your ${typeof result.device === "string" ? result.device : "simulator"}: ${result.path} (${u64(result.width)}x${u64(result.height)})\n`
        : `${typeof result.control === "string" ? result.control.replace("_", " ") : "done"}: done on your ${typeof result.device === "string" ? result.device : "simulator"}\n`;
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
    if (a.ok.step === "push" || a.ok.step === "sim_start") process.stderr.write(which(a.ok));
    process.stdout.write(shown(a.ok));
    return 0;
  }
  process.stderr.write(a.text);
  return a.code;
}

/** `say`: the line saying which Mac first (not for the forwarding agent-device's every command). */
async function runCommand(line: string[], env: object[], background: boolean, say = true): Promise<number> {
  const a = await call({ step: "run", args: line, env, background }, STEP_WAIT_MS);
  if (!("ok" in a)) {
    process.stderr.write(a.text);
    return a.code;
  }
  if (say) process.stderr.write(which(a.ok));
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
