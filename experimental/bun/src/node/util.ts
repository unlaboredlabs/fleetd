// The node's small helpers (crates/fleetd/src/node/util.rs).
import { homedir } from "node:os";

// The temp dir too: without it a command's temp files go to /tmp, which may be held in memory.
const BASE_ENV = ["HOME", "PATH", "USER", "LANG", "TMPDIR", "TMP", "TEMP"];
const GIT_SSH_ENV = ["SSH_AUTH_SOCK", "SSH_AGENT_PID", "GIT_SSH_COMMAND", "GIT_SSH"];

export type Env = Record<string, string>;

const passed = (keys: string[], from: NodeJS.ProcessEnv = process.env): Env =>
  Object.fromEntries(keys.flatMap((k) => (from[k] === undefined ? [] : [[k, from[k]!]])));

/** What a command the node runs inherits: HOME, PATH, USER, LANG and the temp dir only. */
export const scrubbedEnv = (): Env => passed(BASE_ENV);
/** Git the hub runs reaches an SSH remote through the user's agent; nothing else gets it. */
export const gitCommandEnv = (): Env => ({ ...scrubbedEnv(), ...passed(GIT_SSH_ENV) });

/** This binary's own command line: the compiled one, or Bun with the entry it runs. */
export const selfArgv = (): string[] => (Bun.main.startsWith("/$bunfs/") ? [process.execPath] : [process.execPath, Bun.main]);

export const homeDir = () => process.env.HOME || homedir() || "/";

/** RFC 3339 with milliseconds and `Z`, as chrono's `to_rfc3339_opts(Millis, true)`. */
export const nowIso = () => new Date().toISOString();

/** The end of `text` that fits `max` UTF-16 units (JS string length is UTF-16 already), never splitting a pair. */
export function tailUtf16(text: string, max: number): string {
  if (text.length <= max) return text;
  let at = text.length - max;
  const code = text.charCodeAt(at);
  if (code >= 0xdc00 && code <= 0xdfff) at++;
  return text.slice(at);
}

/** The start of `text` that fits `max` UTF-16 units, never splitting a pair. */
export function headUtf16(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return text.slice(0, end);
}

/** The errno's name for a spawn or fs failure (ENOENT, EACCES), as the Rust node's `errno_name`. */
export const errnoName = (error: unknown) => (error as { code?: string } | undefined)?.code;

export type Exec = { stdout: string; error?: string };

/** argv with the scrubbed environment, its stdout, and an error when it failed or ran past `timeoutMs`. */
export async function exec(argv: string[], timeoutMs: number, opts: { cwd?: string; env?: Env } = {}): Promise<Exec> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(argv, { cwd: opts.cwd, env: opts.env ?? scrubbedEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    return { stdout: "", error: `spawn ${argv[0] ?? ""} ${errnoName(error) ?? String(error)}` };
  }
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  if (proc.signalCode) return { stdout: "", error: `Command failed: ${argv.join(" ")}` };
  return code === 0 ? { stdout } : { stdout, error: `Command failed: ${argv.join(" ")}\n${stderr}` };
}

/** One-shot promise with its resolver. */
export function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
