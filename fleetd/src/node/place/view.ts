// What a session's VM sees of this machine: only what it is given, at the same paths as here, through one virtiofs
// share (`view`, a dir whose top-level dirs the guest's init binds at `/<name>`). Nothing of the person's home is
// shared (D557: the machine is a clean hypervisor, and a local VM is provisioned as a hosted box is): the view holds
// the task's worktree and its repo's git store, writable, and fleetd's own files for this session (its session files,
// its scratch dir, the fleetd binary, the update hold, the tools fleetd installed that its PATH names), plus what
// ./provision.ts gives the box (its own home, the VM caches, claude). Everything else the session's launch names (the
// person's ~/.claude, ~/.config, toolchains on PATH, the repo's main checkout, other repos) isn't there. The guest's
// system is its image's alone.
//
// The view is assembled by bind mounts in a user and mount namespace of its own, where virtiofsd then serves it: nothing
// is mounted on this machine, and nothing needs root.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";

/** One path put back in the view, at the same path. */
export type Share = { path: string; rw: boolean };

/** What a box shows: its shares, each at its own path, and nothing else of this machine. A record from before D557
 * also has the home it shared whole (`home`), which a new start never takes as covering anything. */
export type View = { shares: Share[]; home?: string; hidden?: string[] };

/** The guest's own top-level dirs: a path there is never put back by itself. */
const SYSTEM = new Set(["bin", "boot", "dev", "etc", "lib", "lib32", "lib64", "libx32", "opt", "proc", "root", "run", "sbin", "sys", "tmp", "usr", "var"]);

export const under = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

const top = (path: string) => path.split(sep)[1] ?? "";

/** Whether `path` is the guest's own (its system dirs), so the view never holds it. */
export const guestOwn = (path: string) => SYSTEM.has(top(path)) || path === "/";

/** Whether the view shows `path` as `rw` asks: the deepest share holding it decides. */
export function shows(view: View, need: Share): boolean {
  const p = need.path;
  if (guestOwn(p)) return true;
  const holding = view.shares.filter((s) => under(p, s.path)).sort((a, b) => b.path.length - a.path.length)[0];
  return !!holding && (holding.rw || !need.rw);
}

/** What a session's command needs to see: its cwd writable, and what fleetd gave it. */
export type Needs = {
  cwd: string;
  /** The command's whole environment. */
  env: Record<string, string | undefined>;
  /** Its program and arguments. */
  argv: string[];
  /** The node's home: of what the command names, only fleetd's own files for it there are shared (`fleetdOwn`). */
  node: string;
  session: string;
  /** Writable besides the cwd and its git store (the box's own home and caches, the update marks). */
  rw?: string[];
  /** Read-only, as given (the session's files, the update hold, the binary, claude). */
  ro?: string[];
};

const TMP_VARS = ["TMPDIR", "TMP", "TEMP", "CLAUDE_CODE_TMPDIR"];

const real = (p: string) => normalize(resolve(p)).replace(/\/+$/u, "") || "/";

/** The dirs of the node's home that hold tools fleetd installed for agents (agent-browser, agent-device and the
 * Android SDK, the build-slot, Revyl and Mac shims): a path the session's launch names there is shared read-only. */
const TOOL_AREAS = [join("browser", "agent-browser"), "device", join("build-slots", "bin"), join("revyl", "bin"), join("mac", "bin"), "bin"];
/** And what of them never is: the screens' recordings. */
const NEVER = [join("device", "recordings")];

/** Whether `path` is fleetd's own for session `session` in node home `node`: its session's files, a scratch dir, or a
 * tool fleetd installed. The node's other files (its keys, database, vault, other sessions' and orders' files) never
 * are. */
export function fleetdOwn(node: string, session: string, path: string): boolean {
  const p = real(path);
  const n = real(node);
  if (NEVER.some((a) => under(p, join(n, a)))) return false;
  if (under(p, join(n, "sessions", session))) return true;
  if (p !== join(n, "tmp") && under(p, join(n, "tmp"))) return true;
  return TOOL_AREAS.some((a) => under(p, join(n, a)));
}

/** The git dir a worktree's commits write to: the repo's own `.git` for a linked worktree. */
export function gitCommonDir(cwd: string): string | undefined {
  try {
    const dotGit = join(cwd, ".git");
    if (statSync(dotGit).isDirectory()) return undefined;
    const m = /^gitdir:\s*(.+)$/mu.exec(readFileSync(dotGit, "utf8"));
    if (!m?.[1]) return undefined;
    const gitdir = resolve(cwd, m[1].trim());
    const common = join(gitdir, "commondir");
    return existsSync(common) ? resolve(gitdir, readFileSync(common, "utf8").trim()) : gitdir;
  } catch {
    return undefined;
  }
}

/** Absolute paths of files and dirs, named by a value: itself, or each part of a `:` list (PATH). Never a socket: the
 * node's own (FLEETD_NODE_SOCK) is the guest's to listen at. */
export function pathsIn(value: string): string[] {
  return value.split(":").filter((p) => {
    if (!isAbsolute(p) || p.includes("\n")) return false;
    try {
      const st = statSync(p);
      return st.isFile() || st.isDirectory();
    } catch {
      return false;
    }
  });
}

/** Where the links in dir `d` lead, each resolved. */
function linkedFrom(d: string): string[] {
  try {
    return readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      if (!e.isSymbolicLink()) return [];
      try {
        return [realpathSync(join(d, e.name))];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

/** agent-device's variables naming the dirs it writes (node/device/agent_device.ts agentEnv). */
const DEVICE_DIRS = ["AGENT_DEVICE_HOME", "AGENT_DEVICE_STATE_DIR"];

/** A file's first 256 bytes, as text. */
function head(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(256);
    return buf.subarray(0, readSync(fd, buf, 0, 256, 0)).toString("latin1");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** fleetd's own wrappers in dir `d` (their second line starts `# fleetd's`): the dirs their quoted paths name. */
function wrapped(d: string): string[] {
  const out: string[] = [];
  try {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (!e.isFile()) continue;
      // Its head first: a PATH dir holds large programs too.
      const path = join(d, e.name);
      if (!head(path).split("\n")[1]?.startsWith("# fleetd's")) continue;
      const text = readFileSync(path, "utf8").slice(0, 16_384);
      for (const m of text.matchAll(/'(\/[^'\n]+)'/gu)) {
        try {
          if (statSync(m[1]!).isDirectory()) out.push(m[1]!);
        } catch {}
      }
    }
  } catch {}
  return out;
}

/** The shares a command needs, each once: writable wins over read-only for one path. What it names outside its
 * worktree, git store and fleetd's own files for it (`fleetdOwn`) is left out, wherever it is. */
export function needs(n: Needs): Share[] {
  const out = new Map<string, boolean>();
  const add = (p: string | undefined, rw: boolean) => {
    if (!p || !isAbsolute(p)) return;
    const path = real(p);
    out.set(path, (out.get(path) ?? false) || rw);
  };
  const own = (p: string | undefined, rw: boolean) => {
    if (p && isAbsolute(p) && fleetdOwn(n.node, n.session, p)) add(p, rw);
  };
  add(n.cwd, true);
  add(gitCommonDir(n.cwd), true);
  for (const p of n.rw ?? []) add(p, true);
  for (const p of n.ro ?? []) add(p, false);
  for (const k of TMP_VARS) own(n.env[k], true);
  for (const a of n.argv) for (const p of pathsIn(a)) own(p, false);
  for (const v of Object.values(n.env)) if (v) for (const p of pathsIn(v)) own(p, false);
  // A program on PATH that links elsewhere (agent-browser's, into its package): what it links to, read-only too. And a
  // fleetd wrapper there (agent-device's, cargo's): its tool's install dir, the `bin` dir's parent, and the dirs it
  // names (the Android SDK). Each only where it is fleetd's own.
  for (const d of pathsIn(n.env.PATH ?? "")) {
    if (!fleetdOwn(n.node, n.session, d)) continue;
    for (const target of linkedFrom(d)) own(dirname(target), false);
    const named = wrapped(d);
    if (named.length && d.endsWith(`${sep}bin`)) own(dirname(d), false);
    for (const p of named) own(p, false);
  }
  // agent-device's session home and state, which it writes: made now, or a share missing at boot is never mounted.
  for (const k of DEVICE_DIRS) {
    const p = n.env[k];
    if (!p || !isAbsolute(p) || !fleetdOwn(n.node, n.session, p)) continue;
    try {
      mkdirSync(p, { recursive: true, mode: 0o700 });
    } catch {}
    add(p, true);
  }
  return [...out].map(([path, rw]) => ({ path, rw })).filter((s) => !guestOwn(s.path));
}

/** The view for `shares`: each is kept only when a shorter one doesn't already show it as it needs. */
export function viewOf(shares: Share[]): View {
  const view: View = { shares: [] };
  for (const s of [...shares].sort((a, b) => a.path.length - b.path.length)) {
    if (shows(view, s)) continue;
    view.shares.push(s);
  }
  return view;
}

/** Whether `view` shows each of `shares` as it needs: a box booted with it can run them. A record from before D557,
 * which shared the home whole, never does: its session's next start boots a box that doesn't. */
export const covers = (view: View, shares: Share[]) => view.home === undefined && shares.every((s) => shows(view, s));

const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/**
 * The shell lines that assemble `view` at `at` (an empty dir) and then exec `exec`: run as root of a user and mount
 * namespace of their own (`unshare --user --map-root-user --mount`), so every mount is that namespace's alone. The
 * view's own dirs (the path down to each share) are a small tmpfs of virtiofsd's: the guest makes its sockets there
 * (the node's own `node.sock`, at its path in the node's home, which no share holds), and what else it writes there
 * stays in it, never on this machine's disk, a megabyte at most. Run by bash.
 */
export function mountScript(view: View, at: string, exec: string[]): string {
  const v = (p: string) => q(at + p);
  const lines = ["set -e", `mount -t tmpfs -o mode=0755,size=1m fleetd-view ${q(at)}`];
  for (const s of [...view.shares].sort((a, b) => a.path.length - b.path.length)) {
    if (!existsSync(s.path)) continue;
    const dir = statSync(s.path).isDirectory();
    if (dir) lines.push(`mkdir -p ${v(s.path)}`);
    else lines.push(`mkdir -p ${q(at + dirname(s.path))}`, `[ -e ${v(s.path)} ] || : > ${v(s.path)}`);
    lines.push(`mount --rbind ${q(s.path)} ${v(s.path)}`);
    if (!s.rw) lines.push(`mount -o remount,bind,ro ${v(s.path)}`);
  }
  lines.push(`exec ${exec.map(q).join(" ")}`);
  return `${lines.join("\n")}\n`;
}
