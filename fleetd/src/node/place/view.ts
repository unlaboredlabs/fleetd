// What a session's VM sees of this machine: its files at the same paths as here, through one virtiofs share (`view`, a
// dir whose top-level dirs the guest's init binds at `/<name>`). The person's home is shared whole and writable, as a
// plain process has it, but fleetd's own folders in it (the fleetd dir, the node's home: the hub's database, the vault,
// keys, other sessions' files, the node's own socket) are hidden, and only what the session runs with is put back: its
// worktree, git dir and scratch writable, its session files, the fleetd binary, the update hold, its order's variables
// and the tools on its PATH read-only. This machine's own system dirs (/usr, /etc, /opt and the /bin, /lib… beside
// them) are a second share (`host`), read-only, which the guest lays over its image's (../sandbox/system.ts): a tool
// installed in the home that links this machine's libraries finds them in the box.
//
// The view is assembled by bind mounts in a user and mount namespace of its own, where virtiofsd then serves it: nothing
// is mounted on this machine, and nothing needs root.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
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

/** The guest's own top-level dirs: a path there is never put back by itself (the guest's system is this machine's own
 * system dirs over its image's, HOST_SYSTEM). */
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

/** Where the links in dir `d` lead, each resolved; nothing for a system dir, whose links are the guest's. */
function linkedFrom(d: string): string[] {
  if (guestOwn(real(d))) return [];
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
  // A program on PATH that links elsewhere (agent-browser's, into its package): what it links to, read-only too.
  for (const d of pathsIn(n.env.PATH ?? "")) for (const target of linkedFrom(d)) add(dirname(target), false);
  // The order's variables are re-read before each command, and renewed (GH_TOKEN) by writing a new file in their dir.
  // Its dir is made now when it isn't there yet (no variable set so far): a share missing at boot is never mounted,
  // and a variable set later would never reach the box.
  const envFile = n.env.CLAUDE_ENV_FILE;
  if (envFile)
    for (const p of sourced(envFile)) {
      try {
        mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
      } catch {}
      add(dirname(p), false);
    }
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

/** This machine's system dirs a box's guest lays over its image's own (../sandbox/system.ts), read-only. */
export const HOST_SYSTEM = ["usr", "etc", "opt", "bin", "sbin", "lib", "lib32", "lib64", "libx32"] as const;

/** One of this machine's system dirs: a dir, or a link (merged /usr's /bin → usr/bin) to `link`. */
export type SystemDir = { name: string; link?: string };

/** This machine's system dirs, as they are here. */
export function hostSystem(root = "/"): SystemDir[] {
  return HOST_SYSTEM.flatMap((name) => {
    const path = join(root, name);
    try {
      const st = lstatSync(path);
      if (st.isSymbolicLink()) return [{ name, link: readlinkSync(path) }];
      return st.isDirectory() ? [{ name }] : [];
    } catch {
      return [];
    }
  });
}

/** Where this machine's system dirs are shared from: a dir of the box's, served by a virtiofsd of its own (`exec`). */
export type SystemShare = { at: string; exec: string[] };

/**
 * The shell lines that assemble `view` at `at` (an empty dir) and then exec `exec`: run as root of a user and mount
 * namespace of their own (`unshare --user --map-root-user --mount`), so every mount is that namespace's alone. With
 * `sys`, this machine's system dirs are assembled at `sys.at` too, read-only, and served by `sys.exec` beside `exec`:
 * a share of their own, which never changes under the box, so the guest caches it as long as it likes. Run by bash.
 */
export function mountScript(view: View, at: string, exec: string[], sys?: SystemShare, system: SystemDir[] = hostSystem()): string {
  const v = (p: string) => q(at + p);
  const lines = ["set -e", `mount -t tmpfs -o mode=0755 fleetd-view ${q(at)}`];
  lines.push(`mkdir -p ${v(view.home)}`, `mount --rbind ${q(view.home)} ${v(view.home)}`);
  const h = (p: string) => q(`${sys!.at}${p}`);
  if (sys) {
    // Each one read-only at `<sys.at>/<name>`; a link stays the link it is here.
    lines.push(`mount -t tmpfs -o mode=0755 fleetd-system ${h("")}`);
    for (const d of system) {
      if (d.link !== undefined) lines.push(`ln -s ${q(d.link)} ${h(`/${d.name}`)}`);
      else lines.push(`mkdir -p ${h(`/${d.name}`)}`, `mount --rbind ${q(`/${d.name}`)} ${h(`/${d.name}`)}`, `mount -o remount,bind,ro ${h(`/${d.name}`)}`);
    }
  }
  for (const hidden of [...view.hidden].sort((a, b) => a.length - b.length)) {
    // Hidden in the system dirs too, where one is there (it never is unless fleetd's dir was put in one).
    if (sys && system.some((d) => d.link === undefined && under(hidden, `/${d.name}`)))
      lines.push(`[ ! -d ${h(hidden)} ] || mount -t tmpfs -o mode=0700 fleetd-hidden ${h(hidden)}`);
    if (!guestOwn(hidden)) lines.push(`mkdir -p ${v(hidden)}`, `mount -t tmpfs -o mode=0700 fleetd-hidden ${v(hidden)}`);
  }
  for (const s of [...view.shares].sort((a, b) => a.path.length - b.path.length)) {
    if (!existsSync(s.path)) continue;
    const dir = statSync(s.path).isDirectory();
    if (dir) lines.push(`mkdir -p ${v(s.path)}`);
    else lines.push(`mkdir -p ${q(at + dirname(s.path))}`, `[ -e ${v(s.path)} ] || : > ${v(s.path)}`);
    lines.push(`mount --rbind ${q(s.path)} ${v(s.path)}`);
    if (!s.rw) lines.push(`mount -o remount,bind,ro ${v(s.path)}`);
  }
  if (!sys) lines.push(`exec ${exec.map(q).join(" ")}`);
  else {
    // Both run, and the first to end takes the other with it (bash's `wait -n`): a box missing a share ends, never
    // hangs on it.
    lines.push(`${sys.exec.map(q).join(" ")} &`, "h=$!", `${exec.map(q).join(" ")} &`, "w=$!", "wait -n || true", 'kill "$h" "$w" 2>/dev/null', "exit 1");
  }
  return `${lines.join("\n")}\n`;
}
