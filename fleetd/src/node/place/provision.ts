// What a fresh local VM is given before its agent starts, in one place: a box gets nothing of this machine's home or
// config (D557), only what this provisions, the way a hosted box gets its template and its files. A per-bot image could
// do this instead later: what it returns (the shares, the environment, the program) is all `microvm.ts` takes from it.
// - Its own home: `<node home>/vm/homes/<session>`, writable, kept between its boxes (the idle reap) and gone when its
//   task ends. Its .gitconfig holds the person's git name and email, read here, and nothing else of theirs.
// - The VM caches: `<node home>/vm/cache`, writable and shared by this machine's VMs (Bun's and npm's, XDG's).
// - Its order's variables (GH_TOKEN): copies of only its own order's file in `<node home>/vm/env/<session>`, read-only,
//   copied again when the node renews them (`refresh`). Never the machine's gh login.
// - Its environment: every variable naming a place of this machine the box doesn't show is left out (the person's
//   CARGO_HOME, say), PATH keeps fleetd's tool dirs and adds the home's own bins and the image's; agent-browser's
//   sockets go in the guest's own /tmp, whose path is short enough for one.
// For the session itself (`forClaude`):
// - Claude: this machine's claude program, linked into `<node home>/vm/claude`; its endpoint and credentials, from the
//   `env` of the person's Claude settings (only Claude's own variables), in the box's own Claude settings, so the box's
//   claude picks what the machine's does, through the node's relay (./endpoint.ts). A machine whose agents sign in with
//   its own Claude login (~/.claude/.credentials.json, which refreshes itself there) gives a box nothing to sign in with:
//   such a session runs as a plain process, and says why.
// - Its transcript, in from the machine's Claude dir before the start, and back after its box (`transcriptBack`), as a
//   hosted box's: the machine's copy is what `--resume` reads, wherever the next start runs.
import { closeSync, copyFileSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { vmDir } from "../../sandbox/host/tools.ts";
import { configDir, sessionFile } from "../runner/claude.ts";
import { MANAGED_SETTINGS } from "./endpoint.ts";
import { fleetdOwn, gitCommonDir, guestOwn, under } from "./view.ts";

type Env = Record<string, string | undefined>;

export const boxHome = (node: string, session: string) => join(vmDir(node), "homes", session);
export const boxCache = (node: string) => join(vmDir(node), "cache");
export const boxEnvDir = (node: string, session: string) => join(vmDir(node), "env", session);
export const boxClaudeDir = (node: string) => join(vmDir(node), "claude");

/** Where agent-browser's daemon sockets go in a box. */
export const BROWSER_SOCKETS = "/tmp/agent-browser";

/** The image's own program dirs, after what the session's PATH keeps. */
const IMAGE_PATH = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"];

/** Claude's own variables in the person's settings: what the box's claude is given of them. */
const CLAUDE_VAR = /^(ANTHROPIC|CLAUDE|DISABLE|ENABLE|MAX|MCP|BASH)_/u;
/** What a box's claude signs in with. */
const CREDENTIALS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
/** Claude on a cloud's API signs in with that cloud's variables, which the session's environment carries. */
const CLOUDS = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"];

export type Provision = { node: string; session: string; cwd: string; env: Env };

export type Provisioned = {
  /** What the box shows writable and read-only for it, besides the session's own (./view.ts needs). */
  rw: string[];
  ro: string[];
  /** The command's environment in the box. */
  env: Record<string, string>;
  /** Copies the order's variables in again where the node renewed them. */
  refresh: () => void;
};

/** A path this machine has as a file or dir. */
const isThere = (p: string) => {
  try {
    const st = statSync(p);
    return st.isFile() || st.isDirectory();
  } catch {
    return false;
  }
};

/** For any command in session `p.session`'s box (its setup commands and its session): its home, the caches, its
 * order's variables and its environment. */
export function provision(p: Provision): Provisioned {
  const home = boxHome(p.node, p.session);
  const cache = boxCache(p.node);
  const envDir = boxEnvDir(p.node, p.session);
  for (const d of [home, envDir]) mkdirSync(d, { recursive: true, mode: 0o700 });
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  writeGitconfig(home, p.cwd);
  const git = gitCommonDir(p.cwd);
  const shown = (path: string) =>
    guestOwn(path) || under(path, p.cwd) || (git !== undefined && under(path, git)) || under(path, vmDir(p.node)) || fleetdOwn(p.node, p.session, path);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(p.env)) {
    if (v === undefined) continue;
    const kept = keepShown(v, shown);
    if (kept !== undefined) env[k] = kept;
  }
  const orders = orderCopies(p.env.CLAUDE_ENV_FILE, envDir);
  if (orders) env.CLAUDE_ENV_FILE = orders.file;
  else delete env.CLAUDE_ENV_FILE;
  const bins = [".local/bin", ".cargo/bin", ".bun/bin"].map((b) => join(home, b));
  const path = (env.PATH ?? "").split(":").filter((d) => d && !bins.includes(d) && !IMAGE_PATH.includes(d));
  Object.assign(env, {
    HOME: home,
    PATH: [...path, ...bins, ...IMAGE_PATH].join(":"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    XDG_CACHE_HOME: cache,
    BUN_INSTALL_CACHE_DIR: join(cache, "bun"),
    npm_config_cache: join(cache, "npm"),
    // agent-browser's daemon socket, in the guest's own /tmp: under the box's home its path passes a socket's 108 bytes.
    AGENT_BROWSER_SOCKET_DIR: env.AGENT_BROWSER_SOCKET_DIR ?? BROWSER_SOCKETS,
  });
  mkdirSync(boxClaudeDir(p.node), { recursive: true, mode: 0o755 });
  return { rw: [home, cache], ro: [envDir, boxClaudeDir(p.node)], env, refresh: () => orders?.refresh() };
}

/**
 * `value` with what it names of this machine that the box doesn't show taken out: a path, or the parts of a `:` list
 * that are paths (PATH). Undefined when nothing of it is left. A value that isn't a path (a word, a URL, a socket's
 * path, a place this machine doesn't have) stays as it is.
 */
export function keepShown(value: string, shown: (path: string) => boolean): string | undefined {
  const parts = value.split(":");
  if (!parts.every((x) => isAbsolute(x) || x === "")) return value;
  const kept = parts.filter((x) => x === "" || !isThere(x) || shown(x));
  if (kept.length === parts.length) return value;
  const left = kept.filter((x) => x !== "");
  return left.length ? left.join(":") : undefined;
}

/** The home's .gitconfig: the person's git name and email as this checkout reads them, and only those. */
function writeGitconfig(home: string, cwd: string): void {
  const get = (key: string) => {
    const r = Bun.spawnSync(["git", "-C", cwd, "config", "--get", key], { stdout: "pipe", stderr: "ignore" });
    return r.exitCode === 0 ? r.stdout.toString().trim() : "";
  };
  const quote = (v: string) => `"${v.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", " ")}"`;
  const name = get("user.name");
  const email = get("user.email");
  const lines = name || email ? ["[user]", ...(name ? [`\tname = ${quote(name)}`] : []), ...(email ? [`\temail = ${quote(email)}`] : [])] : [];
  writeAtomic(join(home, ".gitconfig"), lines.length ? `${lines.join("\n")}\n` : "");
}

/** The files `file` sources (single-quoted paths), each copied into `dir`, and `file` again there sourcing the copies:
 * the order's own variables and nothing else of the node's. Undefined without one. */
function orderCopies(file: string | undefined, dir: string): { file: string; refresh: () => void } | undefined {
  if (!file) return undefined;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const sources = [...new Set([...text.matchAll(/'(\/[^']+)'/gu)].map((m) => m[1]!))];
  const copies = new Map(sources.map((s, i) => [s, join(dir, `${i}-${basename(s)}`)]));
  let out = text;
  for (const [s, c] of copies) out = out.replaceAll(`'${s}'`, `'${c}'`);
  const at = join(dir, "env.sh");
  writeAtomic(at, out);
  const seen = new Map<string, number>();
  const refresh = () => {
    for (const [s, c] of copies) {
      let mtime = 0;
      try {
        mtime = statSync(s).mtimeMs;
      } catch {}
      if (seen.get(s) === mtime) continue;
      seen.set(s, mtime);
      if (mtime) copyAtomic(s, c);
      else rmSync(c, { force: true });
    }
  };
  refresh();
  return { file: at, refresh };
}

export type ForClaude = {
  /** The program the box runs: this machine's claude, as fleetd's copy. */
  program: string;
  ro: string[];
  /** The transcript, here and in the box, for `transcriptBack`. */
  transcript?: Transcript;
};

export type Transcript = { here: string; box: string };

/** Why a box has nothing to sign Claude in with. */
export class NoClaudeLogin extends Error {}

/**
 * What session `p.session`'s claude needs in its box: the program, its settings' Claude variables, its transcript.
 * `hostEnv` is the session's environment as a plain process has it (the machine's Claude dir); `boxEnv` what
 * `provision` made of it. Throws NoClaudeLogin when nothing in either signs the box's claude in.
 */
export function forClaude(p: Provision & { program: string; boxEnv: Record<string, string> }): ForClaude {
  const hostConfig = configDir(p.env as Record<string, string>);
  const boxConfig = p.boxEnv.CLAUDE_CONFIG_DIR!;
  const relayed: Record<string, string> = {};
  for (const file of [join(hostConfig, "settings.json"), MANAGED_SETTINGS]) Object.assign(relayed, claudeVars(file));
  mkdirSync(boxConfig, { recursive: true, mode: 0o700 });
  writeAtomic(join(boxConfig, "settings.json"), `${JSON.stringify(Object.keys(relayed).length ? { env: relayed } : {}, null, 2)}\n`);
  const has = (k: string) => !!(p.boxEnv[k] || relayed[k]);
  if (!CREDENTIALS.some(has) && !CLOUDS.some(has))
    throw new NoClaudeLogin(
      existsSync(join(hostConfig, ".credentials.json"))
        ? "this agent signs in to Claude with this machine's own login, which stays on the machine and is never given to a VM: give its bot a Claude account (or put a token in Claude's settings) to run it in one"
        : "nothing signs this agent in to Claude that a VM can be given (no Claude account for its bot, and no token in the environment or Claude's settings)",
    );
  const here = sessionFile(hostConfig, p.cwd, p.session);
  const box = sessionFile(boxConfig, p.cwd, p.session);
  const transcript = here && box ? { here, box } : undefined;
  if (transcript) newer(transcript.here, transcript.box);
  return { program: linkClaude(p.node, p.program), ro: [boxClaudeDir(p.node)], ...(transcript ? { transcript } : {}) };
}

/** The box's transcript back here, where it is newer: what the next start, in a box or not, resumes from. */
export const transcriptBack = (t: Transcript | undefined) => void (t && newer(t.box, t.here));

/** Claude's own variables in a settings file's `env`. */
function claudeVars(file: string): Record<string, string> {
  try {
    const env = (JSON.parse(readFileSync(file, "utf8")) as { env?: Record<string, unknown> }).env ?? {};
    return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => CLAUDE_VAR.test(e[0]) && typeof e[1] === "string"));
  } catch {
    return {};
  }
}

/** Copies `from` over `to` when `from` is there and `to` isn't, or is older. */
function newer(from: string, to: string): void {
  let a;
  try {
    a = statSync(from);
  } catch {
    return;
  }
  try {
    const b = statSync(to);
    if (b.mtimeMs >= a.mtimeMs) return;
  } catch {}
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  copyAtomic(from, to);
}

/** A file's first bytes. */
function magic(path: string): Buffer {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(4);
    return buf.subarray(0, readSync(fd, buf, 0, 4, 0));
  } finally {
    closeSync(fd);
  }
}

/**
 * fleetd's copy of this machine's claude, which a box runs: Claude Code's native build (one program), or a script
 * that names its interpreter, linked into `<node home>/vm/claude` (copied across file systems), each version once. The
 * person's own install stays out of the box. Copies of other versions go.
 */
export function linkClaude(node: string, program: string): string {
  let real: string;
  try {
    real = realpathSync(program);
  } catch {
    throw new Error(`this machine's claude (${program}) isn't there`);
  }
  const head = magic(real);
  const elf = head.length === 4 && head[0] === 0x7f && head.toString("latin1", 1, 4) === "ELF";
  if (!elf && head.toString("latin1", 0, 2) !== "#!") throw new Error(`this machine's claude (${real}) isn't a program a VM can run`);
  const dir = boxClaudeDir(node);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const st = statSync(real);
  const name = `${basename(real)}-${st.size}`;
  const at = join(dir, name);
  if (!existsSync(at)) {
    const tmp = `${at}.${process.pid}.tmp`;
    rmSync(tmp, { force: true });
    try {
      linkSync(real, tmp);
    } catch {
      copyFileSync(real, tmp);
    }
    renameSync(tmp, at);
    for (const other of readdirSync(dir)) if (other !== name && !other.endsWith(".tmp")) rmSync(join(dir, other), { force: true });
  }
  return at;
}

/** Session `session`'s home and copies go: its task ended. */
export function unprovision(node: string, session: string): void {
  for (const d of [boxHome(node, session), boxEnvDir(node, session)]) rmSync(d, { recursive: true, force: true });
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

function copyAtomic(from: string, to: string): void {
  const tmp = `${to}.${process.pid}.tmp`;
  copyFileSync(from, tmp);
  renameSync(tmp, to);
}
