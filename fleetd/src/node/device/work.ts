// A screen hosted here for another machine, driven by agent-device commands sent through the hub (the runner's side
// of crates/fleetd/src/node/device/remote.rs): the hub's install of a PR's build into a person's Android screen
// (hub/machine_roles/screens.ts), and any agent's node that drives a screen elsewhere. Each step comes sealed with the
// session's relay key under its count (`openCall`), and its answer goes back sealed (`sealDone`), so the hub carries
// ciphertext alone and can't make one up or play one again.
//
// This node runs only what `parse` allows: agent-device commands that drive the screen, with flags that can't pick
// another device, another config, a script or a server, and paths only in the screen's own folder (`Work`). Files go
// both ways: what a command reads (an app to install) is sent first a piece at a time (`put`); what it writes (a
// screenshot) is fetched back the same way (`get`).
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, rmSync, statSync, writeSync } from "node:fs";
import { basename, join } from "node:path";
import { ToolError } from "../../shared/errors.ts";
import { secretbox, secretboxOpen } from "../../shared/sealed_box.ts";

/** The most of a file one `put` or `get` carries: well inside the hub link's frames, base64 and all. */
export const PIECE = 4 << 20;
/** The most a command reads in files, together, and the most of a file it writes that comes back. */
export const FILE_MAX = 64 << 20;
/** The most of a command's stdout, and of its stderr, that comes back. */
export const OUTPUT_MAX = 1 << 20;
/** How long a command may run on the screen's node. */
export const RUN_WAIT = 100_000;

const ONLY = "fleetd runs only agent-device commands that drive the screen on another machine";

const refuse = (message: string, fix: string) => new ToolError("invalid", message, fix);

/** What a flag takes after it: nothing, a value, or a file the command writes. */
type Take = "nothing" | "text" | "out";
/** What an argument is, by where it stands in the command. */
export type Role = "plain" | "in" | "out" | "in_or_json";
type Files = "none" | "install" | "screenshot" | "record" | "push" | "open" | "logs";
type Flags = [string, Take][];
type Command = { name: string; flags: Flags[]; files: Files };

const N = "nothing" as const;
const T = "text" as const;
const O = "out" as const;
/** Every command's. */
const COMMON: Flags = [["--json", N], ["--level", T], ["--cost", N], ["--help", N], ["-h", N]];
const SETTLE: Flags = [["--settle", N], ["--settle-quiet", T], ["--timeout", T]];
const TREE: Flags = [["--depth", T], ["-d", T], ["--scope", T], ["-s", T], ["--raw", N]];
const TAP: Flags = [["--count", T], ["--interval-ms", T], ["--hold-ms", T], ["--jitter-px", T], ["--double-tap", N], ["--verify", N]];
const command = (name: string, flags: Flags[], files: Files = "none"): Command => ({ name, flags, files });

/**
 * The commands a screen on another machine runs, with their flags. Not here, so refused: device lifecycle (`boot`,
 * `shutdown`, `devices`), scripts (`batch`, `replay`, `test`), servers and remote state (`mcp`, `daemon`, `proxy`,
 * `connect`, `auth`, `plugins`, `metro`, `web`), the host's clipboard and diagnostics, and every device or config
 * selector (`--platform`, `--udid`, `--device`, `--serial`, `--session`, `--config`).
 */
const COMMANDS: Command[] = [
  command(
    "open",
    [[["--metro-host", T], ["--metro-port", T], ["--bundle-url", T], ["--launch-url", T], ["--launch-args", T], ["--relaunch", N], ["--foreground", N], ["--no-record", N], ["--timeout", T], ["--wait", T]]],
    "open",
  ),
  command("close", []),
  command("install", [], "install"),
  command("reinstall", [], "install"),
  command("uninstall", []),
  command("apps", [[["--all", N]]]),
  command("appstate", []),
  command(
    "screenshot",
    [[["--out", O], ["--overlay-refs", N], ["--crop-on", T], ["--pixel-density", T], ["--fullscreen", N], ["--full", N], ["-f", N], ["--scale", T], ["--no-stabilize", N], ["--normalize-status-bar", N]]],
    "screenshot",
  ),
  command("record", [[["--fps", T], ["--quality", T], ["--hide-touches", N], ["--scope", T], ["--out", O]]], "record"),
  command("snapshot", [[["--diff", N], ["--record", N], ["--timeout", T], ["-i", N], ["--actions", N], ["--observe-only", N], ["--force-full", N]], TREE]),
  command("press", [TAP, SETTLE, TREE]),
  command("click", [TAP, SETTLE, TREE, [["--button", T]]]),
  command("fill", [[["--delay-ms", T], ["--record-as", T], ["--verify", N]], SETTLE, TREE]),
  command("type", [[["--delay-ms", T]]]),
  command("scroll", [[["--duration-ms", T], ["--pixels", T], ["--until", T], ["--max-passes", T]], SETTLE]),
  command("swipe", [[["--count", T], ["--pause-ms", T], ["--pattern", T]]]),
  command("longpress", [SETTLE, TREE]),
  command("gesture", [[["--count", T], ["--pointer-count", T], ["--hold-ms", T], ["--pause-ms", T]]]),
  command("wait", [TREE]),
  command("get", [TREE, [["--record", N]]]),
  command("is", [TREE, [["--record", N]]]),
  command("find", [[["--record", N], ["--depth", T], ["-d", T], ["--raw", N], ["--first", N], ["--last", N]]]),
  command("back", [[["--in-app", N], ["--system", N]], SETTLE]),
  command("home", []),
  command("app-switcher", []),
  command("alert", []),
  command("keyboard", []),
  command("settings", [[["--app", T]]]),
  command("push", [], "push"),
  command("orientation", []),
  command("focus", []),
  command("action-button", []),
  command("hardware-button", []),
  command("logs", [[["--restart", N]]], "logs"),
  command("capabilities", []),
  command("help", []),
];

/** A command as `parse` read it: its arguments, with `--flag=value` split in two, and what each one is. */
export type Parsed = { command: string; args: string[]; roles: Role[] };

/** A negative number stands where a positional argument does (`swipe 10 -20 …`), not a flag. */
const isFlag = (arg: string) => arg.startsWith("-") && !/^[0-9]/.test(arg.slice(1));

/** Reads an agent-device command against the commands and flags a screen on another machine runs: refused with the
 * reason when it names anything else. */
export function parse(args: string[]): Parsed {
  const fix = `use only these commands, the screen already chosen: ${COMMANDS.map((c) => c.name).join(", ")}`;
  const first = args[0];
  if (first === undefined) return { command: "help", args: [], roles: [] };
  if (["--help", "-h", "--version", "-V"].includes(first) && args.length === 1) return { command: "help", args: [...args], roles: ["plain"] };
  const command = COMMANDS.find((c) => c.name === first);
  if (!command) throw refuse(`agent-device \`${first}\` doesn't run here: ${ONLY}.`, fix);
  const flag = (name: string) => [...COMMON, ...command.flags.flat()].find(([n]) => n === name)?.[1];
  const parsed: Parsed = { command: command.name, args: [first], roles: ["plain"] };
  const positional: number[] = [];
  let outs = 0;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (!isFlag(arg)) {
      positional.push(parsed.args.length);
      parsed.args.push(arg);
      parsed.roles.push("plain");
      continue;
    }
    const eq = arg.indexOf("=");
    const [name, inline] = eq >= 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
    const take = flag(name);
    if (take === undefined) {
      throw refuse(
        `agent-device ${command.name} ${name} doesn't run here: ${ONLY}, on its own simulator.`,
        `leave ${name} out (agent-device help ${command.name} lists the flags)`,
      );
    }
    parsed.args.push(name);
    parsed.roles.push("plain");
    if (take === "nothing") {
      if (inline !== undefined) throw refuse(`${name} takes no value.`, "leave the =value out");
      continue;
    }
    const value = inline ?? args[++i];
    if (value === undefined) throw refuse(`${name} needs a value.`, "give it one");
    parsed.args.push(value);
    if (take === "out") outs++;
    parsed.roles.push(take === "out" ? "out" : "plain");
  }
  const at = (i: number) => (positional[i] === undefined ? undefined : parsed.args[positional[i]!]);
  const role = (i: number, r: Role) => {
    if (positional[i] !== undefined) parsed.roles[positional[i]!] = r;
  };
  const named = (what: string, example: string) =>
    refuse(`agent-device ${command.name} needs a file name for ${what} here.`, `name one in your worktree, as in \`agent-device ${example}\``);
  switch (command.files) {
    case "install":
      if ((positional.length === 1 || positional.length === 2) && command.name === "install") role(positional.length - 1, "in");
      else if (positional.length === 2) role(1, "in");
      else throw refuse(`agent-device ${command.name} takes an app and a file.`, "agent-device help install shows its shapes");
      break;
    case "screenshot":
      if (positional.length === 1 && outs === 0) role(0, "out");
      else if (!(positional.length === 0 && outs === 1)) throw named("the screenshot", "screenshot shots/home.png");
      break;
    case "record":
      if (at(0) === "start") {
        if (positional.length === 2 && outs === 0) role(1, "out");
        else if (!(positional.length === 1 && outs === 1)) throw named("the recording", "record start run.mp4");
      } else if (!(at(0) === "stop" && positional.length === 1 && outs === 0)) {
        throw refuse("Only `record start <file>` and `record stop` run here.", "leave the rest out");
      }
      break;
    case "logs": {
      const sub = at(0);
      if (sub === "path") {
        if (positional.length === 2) role(1, "out");
        else throw named("the log", "logs path logs/app.log");
      } else if (!((["start", "stop", "clear", "doctor"].includes(sub ?? "") && positional.length === 1) || sub === "mark")) {
        throw refuse(
          "Only `logs path <file>`, `logs start`, `logs stop`, `logs clear`, `logs doctor` and `logs mark [message]` run here.",
          "leave the rest out",
        );
      }
      break;
    }
    case "push": {
      const payload = at(1);
      if (payload !== undefined && !payload.trimStart().startsWith("{")) role(1, "in_or_json");
      break;
    }
  }
  if (command.files === "open") {
    const values = [
      ...positional,
      ...parsed.args.flatMap((a, i) => (a === "--launch-url" || a === "--bundle-url" ? [i + 1] : [])),
    ];
    for (const i of values) {
      const value = parsed.args[i]!.trim();
      if (/^[/~.]/.test(value) || value.toLowerCase().startsWith("file:")) {
        throw refuse(
          `agent-device open ${value} names a file on the screen's machine, which it doesn't open.`,
          "open an app by its bundle id or name, or a web or app URL",
        );
      }
    }
  }
  // The macOS host's own privacy grants, which a simulator has none of.
  if (command.name === "settings" && positional.some((p) => ["accessibility", "screen-recording", "input-monitoring"].includes(parsed.args[p]!))) {
    throw refuse("Those settings are the host Mac's, not the simulator's.", "leave them out");
  }
  return parsed;
}

/** Whether `session` is a key the hub gave this node for a session it hosts for an agent elsewhere (`HostKey`). */
export const isHostKey = (session: string) => /^H[0-9a-f]{32}$/.test(session);

/** A name a file has in a screen's folder: plain, with no path in it. */
export const safeName = (name: string) => name.length >= 1 && name.length <= 128 && !name.startsWith(".") && /^[A-Za-z0-9._\-+@]+$/.test(name);

/** The command as the action log shows it. */
export function commandLine(args: string[]): string {
  const quoted = args.map((a) => (a !== "" && /^[A-Za-z0-9@~._\-/:=+,]+$/.test(a) ? a : `'${a.replaceAll("'", "'\\''")}'`));
  return `agent-device ${quoted.join(" ")}`;
}

// ---- sealed between the two nodes ----

/** A device step as the frame carries it (fleetd-contracts `DeviceCall`), and its answer (`DeviceDone`). */
export type DeviceCall =
  | { step: "run"; args: string[] }
  | { step: "put"; name: string; offset: number; dataB64: string }
  | { step: "get"; name: string; offset: number }
  | { step: "sealed"; count: number; dataB64: string };
export type DeviceFile = { name: string; bytes: number };
export type DeviceDone =
  | { step: "run"; stdout: string; stderr: string; exitCode: number; files: DeviceFile[] }
  | { step: "put"; bytes: number }
  | { step: "get"; dataB64: string; total: number }
  | { step: "sealed"; dataB64: string };

type Way = "call" | "answer";

/** A key of its own per way, from the session's relay key; a step's nonce is its count. */
function wayKey(relayKey: Uint8Array, way: Way): Uint8Array {
  const label = way === "call" ? "fleetd device 1: agent to runner" : "fleetd device 1: runner to agent";
  return new Uint8Array(new Bun.CryptoHasher("sha256").update(label).update(relayKey).digest());
}

function nonce(count: number): Uint8Array {
  const out = new Uint8Array(24);
  new DataView(out.buffer).setBigUint64(0, BigInt(count), true);
  return out;
}

function sealWith(relayKey: Uint8Array, way: Way, count: number, value: unknown): string {
  return Buffer.from(secretbox(wayKey(relayKey, way), nonce(count), new TextEncoder().encode(JSON.stringify(value)))).toString("base64");
}

function openWith<T>(relayKey: Uint8Array, way: Way, count: number, dataB64: string): T | undefined {
  const plain = secretboxOpen(wayKey(relayKey, way), nonce(count), Buffer.from(dataB64, "base64"));
  if (!plain) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch {
    return undefined;
  }
}

/** A step, sealed by the agent's node as its `count`th. */
export const sealCall = (relayKey: Uint8Array, count: number, call: DeviceCall): DeviceCall => ({
  step: "sealed",
  count,
  dataB64: sealWith(relayKey, "call", count, call),
});

/** A sealed step, opened by the screen's node: undefined when it doesn't open, or is sealed again inside. */
export function openCall(relayKey: Uint8Array, count: number, dataB64: string): DeviceCall | undefined {
  const call = openWith<DeviceCall>(relayKey, "call", count, dataB64);
  return call && typeof call === "object" && call.step !== "sealed" ? call : undefined;
}

export const sealDone = (relayKey: Uint8Array, count: number, done: DeviceDone): DeviceDone => ({
  step: "sealed",
  dataB64: sealWith(relayKey, "answer", count, done),
});

/** The answer to the agent's `count`th step. */
export function openDone(relayKey: Uint8Array, count: number, done: DeviceDone): DeviceDone | undefined {
  if (done.step !== "sealed") return undefined;
  const opened = openWith<DeviceDone>(relayKey, "answer", count, done.dataB64);
  return opened && typeof opened === "object" && opened.step !== "sealed" ? opened : undefined;
}

// ---- the screen's node ----

/** A command's outcome on the screen's node. */
export type Ran = { stdout: string; stderr: string; exitCode: number; files: DeviceFile[] };

/** What the action log keeps of it, as a command's output there. */
export const ranOutput = (ran: Ran) => `${ran.stdout}${ran.stderr}`;
export const ranDone = (ran: Ran): DeviceDone => ({ step: "run", ...ran });

const failed = (what: string, e: unknown) =>
  new ToolError("failed", `The screen's node could not ${what}: ${(e as Error).message}.`, "try again; if it keeps failing, say so in your result");

const isFile = (path: string) => {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * A hosted screen's own folder on the node that runs it: `in/` holds what its next command reads (gone after it),
 * `out/` what its commands wrote until the agent's node fetched it. The commands run in it; it goes with the screen.
 */
export class Work {
  readonly dir: string;

  constructor(home: string, session: string) {
    this.dir = join(home, "sessions", session, "device-work");
  }

  private ensure(): void {
    for (const dir of [this.dir, join(this.dir, "in"), join(this.dir, "out")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  private totalIn(): number {
    try {
      return readdirSync(join(this.dir, "in")).reduce((sum, n) => sum + (isFile(join(this.dir, "in", n)) ? statSync(join(this.dir, "in", n)).size : 0), 0);
    } catch {
      return 0;
    }
  }

  /** One piece of a file the next command reads, after the pieces before it. */
  put(name: string, offset: number, dataB64: string): DeviceDone {
    if (!safeName(name)) throw refuse(`${name} is not a plain file name.`, "send it under a plain one");
    const data = Buffer.from(dataB64, "base64");
    if (data.length > PIECE) throw refuse("the piece is too large", "send smaller pieces");
    try {
      this.ensure();
    } catch (e) {
      throw failed("make the screen's folder", e);
    }
    const path = join(this.dir, "in", name);
    let had = 0;
    try {
      const meta = lstatSync(path);
      if (!meta.isFile()) throw refuse(`${name} is not a file here.`, "send it under another name");
      had = meta.size;
    } catch (e) {
      if (e instanceof ToolError) throw e;
    }
    if (had !== offset) throw refuse(`${name} has ${had} bytes here, not ${offset}.`, "send the file again from its start under a new name");
    if (this.totalIn() + data.length > FILE_MAX) {
      throw refuse(`The files for one command come to more than ${FILE_MAX >> 20} MiB.`, "send a smaller build");
    }
    try {
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
      try {
        writeSync(fd, data);
      } finally {
        closeSync(fd);
      }
    } catch (e) {
      throw failed("keep the file", e);
    }
    return { step: "put", bytes: offset + data.length };
  }

  /** One piece of a file a command wrote; the file goes once its last piece is read. */
  get(name: string, offset: number): DeviceDone {
    const path = join(this.dir, "out", name);
    if (!safeName(name) || !isFile(path)) throw new ToolError("not_found", `No file ${name} here.`);
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (e) {
      throw failed("read the file", e);
    }
    try {
      const total = fstatSync(fd).size;
      if (total > FILE_MAX) {
        rmSync(path, { force: true });
        throw refuse(`${name} is ${total >> 20} MiB, more than the ${FILE_MAX >> 20} MiB that come back.`, "make it smaller (a shorter recording)");
      }
      const data = Buffer.alloc(Math.max(0, Math.min(PIECE, total - offset)));
      let read = 0;
      while (read < data.length) {
        const n = readSync(fd, data, read, data.length - read, offset + read);
        if (n === 0) break;
        read += n;
      }
      if (offset + read >= total) rmSync(path, { force: true });
      return { step: "get", dataB64: data.subarray(0, read).toString("base64"), total };
    } finally {
      closeSync(fd);
    }
  }

  /** A `put` or a `get`. */
  step(call: DeviceCall): DeviceDone {
    if (call.step === "put") return this.put(String(call.name), Number(call.offset), String(call.dataB64));
    if (call.step === "get") return this.get(String(call.name), Number(call.offset));
    throw refuse("not a file step", "send it as a run");
  }

  /** Checks a command the agent's node sent: one `parse` allows, its files only in this folder (`in/` ones sent
   * already). */
  check(args: string[]): void {
    const parsed = parse(args);
    if (parsed.args.length !== args.length || parsed.args.some((a, i) => a !== args[i])) {
      throw refuse("the command is not in its plain form", "send it as the agent's node maps it");
    }
    parsed.args.forEach((arg, i) => {
      const r = parsed.roles[i]!;
      if (r === "plain") return;
      const side = r === "out" ? "out" : "in";
      const name = arg.startsWith(`${side}/`) ? arg.slice(side.length + 1) : undefined;
      if (name === undefined || !safeName(name)) {
        throw refuse(`${arg} is not a file of this screen's folder.`, "send files as the agent's node maps them");
      }
      if (side === "in" && !isFile(join(this.dir, "in", name))) throw refuse(`${arg} was not sent.`, "send it first");
    });
  }

  /**
   * Runs a checked command with `program` (the node's agent-device wrapper) in this folder, with the node's own
   * environment less any agent-device setting, then `env` (the screen's agent-device home and control file). The
   * files it read go; the ones it wrote are listed.
   */
  async run(program: string, env: [string, string][], args: string[], waitMs = RUN_WAIT): Promise<Ran> {
    try {
      this.ensure();
    } catch (e) {
      return { stdout: "", stderr: `fleetd: the screen's folder could not be made: ${(e as Error).message}\n`, exitCode: 1, files: [] };
    }
    // `logs path <file>`: agent-device takes no file there, and its log is copied into `out/` after it.
    let log: number | undefined;
    try {
      const p = parse(args);
      if (p.command === "logs") {
        const i = p.roles.indexOf("out");
        if (i >= 0) log = i;
      }
    } catch {}
    const runArgs = this.paths(args);
    if (log !== undefined) runArgs.splice(log, 1);
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("AGENT_DEVICE_")) childEnv[k] = v;
    for (const [k, v] of env) childEnv[k] = v;
    let stdout = "";
    let stderr = "";
    let exitCode = 1;
    try {
      const child = Bun.spawn([program, ...runArgs], { cwd: this.dir, env: childEnv, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const outputs = Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).arrayBuffer()]);
      const code = await Promise.race([child.exited, Bun.sleep(waitMs).then(() => "timeout" as const)]);
      if (code === "timeout") {
        child.kill("SIGKILL");
        stderr = `fleetd: agent-device ran past ${Math.round(waitMs / 1000)} s and was stopped.\n`;
        exitCode = 124;
      } else {
        const [out, err] = await outputs;
        stdout = this.text(new Uint8Array(out));
        stderr = this.text(new Uint8Array(err));
        exitCode = code;
      }
    } catch (e) {
      stderr = `fleetd: agent-device did not start: ${(e as Error).message}\n`;
    }
    rmSync(join(this.dir, "in"), { recursive: true, force: true });
    if (log !== undefined && exitCode === 0) {
      const out = args[log]!;
      try {
        const said = this.bringLog(stdout, out.startsWith("out/") ? out.slice(4) : out);
        stdout = stdout.replaceAll(said, out);
      } catch (e) {
        stderr += `fleetd: ${(e as Error).message}\n`;
        exitCode = 1;
      }
    }
    return { stdout, stderr, exitCode, files: this.written() };
  }

  /**
   * The app log `logs path` named, in an agent-device home of this node, copied into `out/` as `name` (its last
   * FILE_MAX bytes if it is longer), so it comes back as a screenshot does. Returns the path agent-device said.
   */
  private bringLog(stdout: string, name: string): string {
    let said: string | undefined;
    try {
      const v = JSON.parse(stdout) as { data?: { path?: unknown }; path?: unknown };
      const path = v.data?.path ?? v.path;
      if (typeof path === "string") said = path;
    } catch {}
    said ??= (stdout.split("\n")[0] ?? "").trim();
    // The node's home: `<home>/sessions/<session>/device-work`.
    let home: string | undefined;
    try {
      home = realpathSync(join(this.dir, "..", "..", ".."));
    } catch {}
    let real: string | undefined;
    try {
      const r = realpathSync(said);
      if (basename(r) === "app.log" && home !== undefined && r.startsWith(`${home}/`) && statSync(r).isFile()) real = r;
    } catch {}
    if (!real) {
      throw new Error(
        `there is no app log to send back yet (${said === "" ? "agent-device named none" : said}): open the app, or run \`agent-device logs start\`, first`,
      );
    }
    try {
      const src = openSync(real, constants.O_RDONLY);
      try {
        const len = fstatSync(src).size;
        const start = Math.max(0, len - FILE_MAX);
        const data = Buffer.alloc(len - start);
        readSync(src, data, 0, data.length, start);
        const dst = openSync(join(this.dir, "out", name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          writeSync(dst, data);
        } finally {
          closeSync(dst);
        }
      } finally {
        closeSync(src);
      }
    } catch (e) {
      throw new Error(`the app log ${said} could not be copied: ${(e as Error).message}`);
    }
    return said;
  }

  /** A checked command with its files (`in/…`, `out/…`) as full paths in this folder: agent-device's daemon reads an
   * install's app from its own working directory, not the command's. */
  private paths(args: string[]): string[] {
    let parsed: Parsed;
    try {
      parsed = parse(args);
    } catch {
      return [...args];
    }
    return args.map((arg, i) => (parsed.roles[i] === "plain" ? arg : join(this.dir, arg)));
  }

  /** A command's output, cut short, with this folder's own path left out: the files in it go by their names alone. */
  private text(bytes: Uint8Array): string {
    let text = new TextDecoder().decode(bytes.subarray(0, OUTPUT_MAX));
    const dirs = [this.dir];
    try {
      dirs.unshift(realpathSync(this.dir));
    } catch {}
    for (const dir of dirs) text = text.replaceAll(`${dir}/`, "");
    return text;
  }

  /** The files in `out/`, plain files only. */
  private written(): DeviceFile[] {
    let names: string[] = [];
    try {
      names = readdirSync(join(this.dir, "out"));
    } catch {}
    return names
      .filter((n) => safeName(n) && isFile(join(this.dir, "out", n)))
      .sort()
      .map((name) => ({ name, bytes: statSync(join(this.dir, "out", name)).size }));
  }

  /** The screen ended: its folder goes. */
  remove(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
