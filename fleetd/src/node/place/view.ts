// What a session's VM sees of this machine: its files at the same paths as here, through one virtiofs share (`view`, a
// dir whose top-level dirs the guest's init binds at `/<name>`). The person's home is shared whole and writable, as a
// plain process has it, but fleetd's own folders in it (the fleetd dir, the node's home: the hub's database, the vault,
// keys, other sessions' files, the node's own socket) are hidden, and only what the session runs with is put back: its
// worktree, git dir and scratch writable, its session files, the fleetd binary, the update hold, its order's variables
// and the tools on its PATH read-only. Paths in the guest's own system dirs (/usr, /etc…) are the guest's.
//
// The view is assembled by bind mounts in a user and mount namespace of its own, where virtiofsd then serves it: nothing
// is mounted on this machine, and nothing needs root.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";

/** One path put back in the view, at the same path. */
export type Share = { path: string; rw: boolean };

export type View = {
  /** The person's home, shared whole and writable. */
  home: string;
  /** fleetd's folders in it (or elsewhere), hidden: an empty dir in the view. */
  hidden: string[];
  /** What is put back, each at its own path. */
  shares: Share[];
};

/** The guest's own top-level dirs: a path there is the guest's, never this machine's. */
const SYSTEM = new Set(["bin", "boot", "dev", "etc", "lib", "lib32", "lib64", "libx32", "opt", "proc", "root", "run", "sbin", "sys", "tmp", "usr", "var"]);

export const under = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

const top = (path: string) => path.split(sep)[1] ?? "";

/** Whether `path` is the guest's own (its system dirs), so the view never holds it. */
export const guestOwn = (path: string) => SYSTEM.has(top(path)) || path === "/";

/** Whether the view shows `path` as `rw` asks. */
export function shows(view: View, need: Share): boolean {
  const p = need.path;
  if (guestOwn(p)) return true;
  // Put back explicitly: the deepest share holding it decides.
  const holding = view.shares.filter((s) => under(p, s.path)).sort((a, b) => b.path.length - a.path.length)[0];
  if (holding) return holding.rw || !need.rw;
  if (view.hidden.some((h) => under(p, h))) return false;
  return under(p, view.home);
}

/** What a session's command needs to see: its cwd and scratch writable, and every path it names read-only. */
export type Needs = {
  cwd: string;
  /** The command's whole environment. */
  env: Record<string, string | undefined>;
  /** Its program and arguments. */
  argv: string[];
  /** Writable besides the cwd (claude's `--add-dir`s). */
  rw?: string[];
  /** Read-only besides what argv and env name (the session's files, the update hold). */
  ro?: string[];
};

const TMP_VARS = ["TMPDIR", "TMP", "TEMP", "CLAUDE_CODE_TMPDIR"];

const real = (p: string) => normalize(resolve(p)).replace(/\/+$/u, "") || "/";

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
function pathsIn(value: string): string[] {
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

/** The files a sourced env file names in single quotes (the order's variables, secrets/env.ts orderEnvFile). */
function sourced(file: string): string[] {
  try {
    return [...readFileSync(file, "utf8").matchAll(/'(\/[^']+)'/gu)].map((m) => m[1]!);
  } catch {
    return [];
  }
}

/** The shares a command needs, each once: writable wins over read-only for one path. */
export function needs(n: Needs): Share[] {
  const out = new Map<string, boolean>();
  const add = (p: string | undefined, rw: boolean) => {
    if (!p || !isAbsolute(p)) return;
    const path = real(p);
    out.set(path, (out.get(path) ?? false) || rw);
  };
  add(n.cwd, true);
  add(gitCommonDir(n.cwd), true);
  for (const p of n.rw ?? []) add(p, true);
  for (const k of TMP_VARS) add(n.env[k], true);
  add(n.env.CLAUDE_CONFIG_DIR, true);
  for (const p of n.ro ?? []) add(p, false);
  for (const a of n.argv) for (const p of pathsIn(a)) add(p, false);
  for (const v of Object.values(n.env)) if (v) for (const p of pathsIn(v)) add(p, false);
  // The order's variables are re-read before each command, and renewed (GH_TOKEN) by writing a new file in their dir.
  const envFile = n.env.CLAUDE_ENV_FILE;
  if (envFile) for (const p of sourced(envFile)) add(dirname(p), false);
  return [...out].map(([path, rw]) => ({ path, rw })).filter((s) => !guestOwn(s.path));
}

/** A share that would hold a hidden dir (the fleetd dir named by a variable, say) is never made. */
const holdsHidden = (view: View, s: Share) => view.hidden.some((h) => under(h, s.path));

/** The view for `shares`: each is put back only when the home share doesn't already show it as it needs. */
export function viewOf(home: string, hidden: string[], shares: Share[]): View {
  const view: View = { home: real(home), hidden: [...new Set(hidden.map(real))], shares: [] };
  for (const s of [...shares].sort((a, b) => a.path.length - b.path.length)) {
    if (holdsHidden(view, s) || shows(view, s)) continue;
    view.shares.push(s);
  }
  return view;
}

/** Whether `view` shows each of `shares` as it needs: a box booted with it can run them. */
export const covers = (view: View, shares: Share[]) => shares.every((s) => holdsHidden(view, s) || shows(view, s));

const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/**
 * The shell lines that assemble `view` at `at` (an empty dir) and then exec `exec`: run as root of a user and mount
 * namespace of their own (`unshare --user --map-root-user --mount`), so every mount is that namespace's alone.
 */
export function mountScript(view: View, at: string, exec: string[]): string {
  const v = (p: string) => q(at + p);
  const lines = ["set -e", `mount -t tmpfs -o mode=0755 fleetd-view ${q(at)}`];
  lines.push(`mkdir -p ${v(view.home)}`, `mount --rbind ${q(view.home)} ${v(view.home)}`);
  for (const h of [...view.hidden].sort((a, b) => a.length - b.length)) lines.push(`mkdir -p ${v(h)}`, `mount -t tmpfs -o mode=0700 fleetd-hidden ${v(h)}`);
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
