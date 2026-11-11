// What the CLI's commands share (setup/mod.rs, setup/state.rs, hub_key.rs
// `resolve_home`): the hub home, setup.json, private files, and how a command reports a failure.
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, writeSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expandHome, fleetdDir } from "../shared/home.ts";

/** The user's home directory, as Node's `os.homedir()` finds it ($HOME first). */
export const homeDir = () => homedir();

/** `[a-z0-9-]{1,32}`. */
export const isMachineId = (id: string) => /^[a-z0-9-]{1,32}$/.test(id);

/** The hub home: `--home` where given (hub start), else `<fleetd dir>/hub`. */
export const resolveHome = (home?: string) => (home === undefined ? join(fleetdDir(), "hub") : expandHome(home));

// ---- inside an agent's session ----

/** The fleetd session around this process, as the node gave it to claude: undefined outside one. Tests stand in. */
let standIn: Record<string, string> | null | undefined;

/** Tests only: the session variables to see instead of this process's (`null`: no session). `undefined` undoes it. */
export function standInSession(vars: Record<string, string> | null | undefined) {
  standIn = vars;
  live = undefined;
}

/** A variable of the fleetd session this process runs in: its own environment's, else the nearest ancestor's, so a
 * shell that unsets it is still found (node/sessions `#spec` sets them on claude). */
function sessionVar(name: string): string | undefined {
  if (standIn !== undefined) return standIn?.[name] || undefined;
  const env = process.env[name];
  if (env) return env;
  if (process.platform !== "linux") return undefined;
  const seen = new Set<number>();
  let at = process.pid;
  while (at > 1 && !seen.has(at)) {
    seen.add(at);
    try {
      const vars = readFileSync(`/proc/${at}/environ`, "latin1").split("\0");
      const hit = vars.find((v) => v.startsWith(`${name}=`))?.slice(name.length + 1);
      if (hit) return hit;
    } catch {}
    try {
      const stat = readFileSync(`/proc/${at}/stat`, "utf8");
      const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      at = Number(after[1]);
      if (!Number.isInteger(at)) return undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** The session's thread id when this runs inside a fleetd session (node/runner/process `session_thread_id`). */
export const sessionThreadId = () => sessionVar("FLEETD_THREAD_ID");

/** The lead's fleetd tools that set its project up: what an agent uses instead of the CLI's writes. */
export const LEAD_SETUP_TOOLS = ["repo_add", "repo_remove", "project_setup", "project_propose"];

/** Why a write to the live hub from an agent's session is refused, and what works instead: one line. */
export const liveHubRefusal = (what: string) =>
  `${what} would change the live hub, and inside an agent's session the fleetd CLI only reads it. ` +
  `The lead's fleetd tools set its project up (${LEAD_SETUP_TOOLS.join(", ")}); a task asks its lead. ` +
  `For a throwaway hub, set FLEETD_HOME.`;

/** A write the CLI refuses inside an agent's session. */
export class LiveHubRefused extends Error {}

/** The live hub of the node running this session: its home (beside the node's, whose socket the session holds) and
 * the `host:port`s it answers on. Undefined outside a session. */
type LiveHub = { home: string; addresses: { host: string; port: string }[] };
let live: LiveHub | null | undefined;

const realPath = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

function liveHub(): LiveHub | undefined {
  if (live !== undefined) return live ?? undefined;
  live = null;
  if (sessionThreadId() === undefined) return undefined;
  const sock = sessionVar("FLEETD_NODE_SOCK");
  // The passwd home, not $HOME: a session's shell may change that.
  const nodeHome = sock ? dirname(sock) : join(userInfo().homedir, ".fleetd", "node");
  const home = join(dirname(nodeHome), "hub");
  const urls: string[] = [];
  try {
    const setup = readSetup(home);
    if (setup) urls.push(`http://${setup.listen}`, setup.url);
  } catch {}
  try {
    const hub = JSON.parse(readFileSync(join(nodeHome, "node.json"), "utf8"))?.hub;
    if (typeof hub === "string") urls.push(hub);
  } catch {}
  const addresses = urls.flatMap((u) => {
    const a = address(u);
    return a ? [a] : [];
  });
  live = { home: realPath(home), addresses };
  return live;
}

function address(url: string): { host: string; port: string } | undefined {
  try {
    const u = new URL(url);
    const port = u.port || (u.protocol === "https:" || u.protocol === "wss:" ? "443" : "80");
    return { host: u.hostname.replace(/^\[|\]$/g, "").toLowerCase(), port };
  } catch {
    return undefined;
  }
}

const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "::"]);

/** Whether `home` is the live hub's home and this runs in an agent's session. */
export function isLiveHubHome(home: string): boolean {
  const hub = liveHub();
  return hub !== undefined && realPath(home) === hub.home;
}

/** Whether `url` reaches the live hub and this runs in an agent's session: the same address, or this machine at the
 * same port. */
export function isLiveHubUrl(url: string): boolean {
  const hub = liveHub();
  const at = address(url);
  if (hub === undefined || at === undefined) return false;
  return hub.addresses.some((a) => a.port === at.port && (a.host === at.host || LOCAL.has(at.host)));
}

/** Throws {@link LiveHubRefused} when `home` is the live hub's and this runs in an agent's session. */
export function refuseLiveHubWrite(home: string, what: string) {
  if (isLiveHubHome(home)) throw new LiveHubRefused(liveHubRefusal(what));
}

/** A failed step: what is wrong, and the exact command or action that fixes it. */
export type Failure = { message: string; fix: string };

export const write = (text: string) => void process.stdout.write(text);
export const writeErr = (text: string) => void process.stderr.write(text);
/** `println!` */
export const println = (text = "") => write(`${text}\n`);
/** `eprintln!` */
export const eprintln = (text = "") => writeErr(`${text}\n`);

/** Whether stdin and stdout are both a terminal. */
export const isTty = () => process.stdin.isTTY === true && process.stdout.isTTY === true;

export function mkdirPrivate(dir: string) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new Error(`cannot create ${dir}: ${ioMessage(error)}`);
  }
}

/** Writes `text` to a new or existing file, creating it 0600. */
export function writePrivate(file: string, text: string) {
  try {
    const fd = openSync(file, "w", 0o600);
    try {
      writeSync(fd, text);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    throw new Error(`cannot write ${file}: ${ioMessage(error)}`);
  }
}

/** A new file only its owner can read, created 0600 (never an existing one); its directory made 0700 when missing. */
export function newPrivateFile(path: string): number {
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (dir) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new Error(`cannot make ${dir}: ${ioMessage(error)}`);
    }
  }
  try {
    const fd = openSync(path, "wx", 0o600);
    chmodSync(path, 0o600);
    return fd;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`${path} exists; a key is only written to a new file`);
    }
    throw new Error(`cannot write ${path}: ${ioMessage(error)}`);
  }
}

/** An io error as Rust's `std::io::Error` displays it: `No such file or directory (os error 2)`. */
export function ioMessage(error: unknown): string {
  const e = error as NodeJS.ErrnoException;
  const known: Record<string, [string, number]> = {
    ENOENT: ["No such file or directory", 2],
    EACCES: ["Permission denied", 13],
    EEXIST: ["File exists", 17],
    EISDIR: ["Is a directory", 21],
    ENOTDIR: ["Not a directory", 20],
    ENOTEMPTY: ["Directory not empty", 39],
    EPERM: ["Operation not permitted", 1],
  };
  const hit = e?.code ? known[e.code] : undefined;
  return hit ? `${hit[0]} (os error ${hit[1]})` : (e?.message ?? String(error));
}

/** `std::fs::read_to_string`, its error as Rust words it. */
export function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(ioMessage(error));
  }
}

// ---- setup.json ----

export type GitIdentity = { name: string; email: string };

/** What `fleetd machine add` set up on a machine, so `machine remove` can undo it with only the id. */
export type MachineRecord = {
  sshHost: string;
  sshConfig?: string;
  /** The hub's own machine, set up without SSH. */
  local?: boolean;
  platform: "linux" | "darwin";
  home: string;
  configHome: string;
  uid: number;
};

export type SetupState = {
  listen: string;
  /** Where devices and nodes reach the hub. */
  url: string;
  gitIdentity?: GitIdentity;
  machines: Record<string, MachineRecord>;
};

export const setupFile = (home: string) => join(home, "setup.json");

/** setup.json, or undefined when there is none; throws the Rust message for a file that isn't valid. */
export function readSetup(home: string): SetupState | undefined {
  const file = setupFile(home);
  if (!existsSync(file)) return undefined;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`cannot read ${file}: ${ioMessage(error)}`);
  }
  let state: SetupState;
  try {
    state = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid: ${(error as Error).message}`);
  }
  if (typeof state?.listen !== "string" || typeof state.url !== "string" || typeof state.machines !== "object") {
    throw new Error(`${file} is not valid: missing field`);
  }
  const bad = Object.keys(state.machines).find((id) => !isMachineId(id));
  if (bad !== undefined) throw new Error(`${file} is not valid: '${bad}' is not a machine id`);
  return state;
}

/** setup.json as serde writes it: pretty, keys in the struct's order, machines sorted by id. */
export function writeSetup(home: string, state: SetupState) {
  mkdirPrivate(home);
  const machines: Record<string, MachineRecord> = {};
  for (const id of Object.keys(state.machines).sort()) {
    const m = state.machines[id]!;
    machines[id] = {
      sshHost: m.sshHost,
      ...(m.sshConfig === undefined ? {} : { sshConfig: m.sshConfig }),
      ...(m.local ? { local: true } : {}),
      platform: m.platform,
      home: m.home,
      configHome: m.configHome,
      uid: m.uid,
    };
  }
  const ordered = {
    listen: state.listen,
    url: state.url,
    ...(state.gitIdentity === undefined ? {} : { gitIdentity: state.gitIdentity }),
    machines,
  };
  writePrivate(setupFile(home), `${JSON.stringify(ordered, null, 2)}\n`);
}

/** `Name <email>`, as git prints an identity. */
export function parseGitIdentity(value: string): GitIdentity | undefined {
  const v = value.trim();
  const open = v.indexOf("<");
  if (open < 0 || !v.endsWith(">")) return undefined;
  const inner = v.slice(open + 1, -1).trim();
  const name = v.slice(0, open).trim();
  const bad = (t: string) => /[<>]/.test(t);
  const at = inner.indexOf("@");
  if (at < 0) return undefined;
  const local = inner.slice(0, at);
  const domain = inner.slice(at + 1);
  if (!name || bad(name) || bad(inner) || /\s/.test(inner) || !local || !domain) return undefined;
  return { name, email: inner };
}

export const isNoreply = (id: GitIdentity) => id.email.toLowerCase().endsWith("@users.noreply.github.com");

/** 16 random bytes as hex: a call's `clientRequestId`. */
export function clientRequestId(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
}

/** A JSON value's string at `pointer` (`/a/b`), or "". */
export function s(value: unknown, pointer: string): string {
  let at: any = value;
  for (const part of pointer.split("/").slice(1)) {
    if (at === null || typeof at !== "object") return "";
    at = Array.isArray(at) ? at[Number(part)] : at[part];
  }
  return typeof at === "string" ? at : "";
}

/** A string field that isn't empty, or undefined. */
export function st(value: unknown, key: string): string | undefined {
  const v = (value as any)?.[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** `path` with the user's home as `~`. */
export function tilde(path: string): string {
  const home = homeDir();
  if (path === home) return "~/";
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

/** Sleeps `ms`. */
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
