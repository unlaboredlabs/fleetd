// A local VM's system dirs: this machine's own, read-only, over the image's. The node shares its /usr, /etc, /opt and
// the /bin, /lib… beside them in a virtiofs share of their own, tag `host` (../place/view.ts mountScript), which never
// changes under the box, so the guest caches it as long as it likes (virtiofsd's --cache=always): re-checking each
// library and PATH lookup with the host, as the home's share does, made a test suite of many short processes 45% slower.
// Before it serves anything, `fleetd sandbox-guest` mounts the share read-only at HOST_SHARE, then each dir at its own
// path as an overlay: this machine's dir on top, the image's under it
// (/run/fleetd/lower, where the init keeps the read-only image), and a private writable layer in the guest's memory.
// So a program installed in the home that links this machine's libraries (a Postgres built for the host's ICU, say)
// runs in the box as it does here, what the image adds that this machine lacks (Playwright's browsers, tini, socat)
// stays, and a box writes anywhere and leaves nothing. A link (merged /usr's /bin → usr/bin) is made the link it is
// here.
//
// It runs in sandbox-guest's own process, by mount(2), never a program: between one dir and the next, a program's
// loader and libraries would be half the host's and half the image's. The guest's own /etc/resolv.conf, hosts and
// hostname (its network, set by the init) are written again over this machine's.
import { dlopen, FFIType, ptr, read } from "bun:ffi";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOST_SYSTEM } from "../place/view.ts";

/** The virtiofs tag of the share of this machine's system dirs, and where the guest mounts it. */
export const HOST_TAG = "host";
export const HOST_SHARE = "/run/fleetd/host";
/** Where the init keeps the read-only image (sandbox/image/init.sh). */
export const IMAGE_ROOT = "/run/fleetd/lower";
/** The writable layers' tmpfs. */
const LAYERS = "/run/fleetd/system";
/** The guest's own files in /etc, kept over this machine's. */
const OWN = ["resolv.conf", "hosts", "hostname"];

/** One step: an overlay at `/<name>` (lowers, top first), or `/<name>` made a link to `link`. */
export type Step = { name: string; lower: string[] } | { name: string; link: string };

/** What the share holds, as `plan` reads it. */
export type Entry = { name: string; link?: string };

/**
 * The steps for the share's `entries`, dirs first (/usr before anything else), then links: a link like /lib64 →
 * usr/lib may name a path only this machine's /usr has. `imageHas` says whether the image has a dir of that name.
 */
export function plan(entries: Entry[], imageHas: (name: string) => boolean, share = HOST_SHARE, image = IMAGE_ROOT): Step[] {
  const known = entries.filter((e) => (HOST_SYSTEM as readonly string[]).includes(e.name));
  const dirs = known.filter((e) => e.link === undefined).sort((a, b) => Number(b.name === "usr") - Number(a.name === "usr"));
  const links = known.filter((e): e is Entry & { link: string } => e.link !== undefined);
  return [
    ...dirs.map((e) => ({ name: e.name, lower: [join(share, e.name), ...(imageHas(e.name) ? [join(image, e.name)] : [])] })),
    ...links.map((e) => ({ name: e.name, link: e.link })),
  ];
}

/** The share's entries as the guest sees them. */
export function entriesOf(share: string): Entry[] {
  return readdirSync(share).flatMap((name) => {
    const path = join(share, name);
    const st = lstatSync(path);
    if (st.isSymbolicLink()) return [{ name, link: readlinkSync(path) }];
    return st.isDirectory() ? [{ name }] : [];
  });
}

const MS_REMOUNT = 32;
const MS_RDONLY = 1;
const MS_NOSUID = 2;
const MS_NODEV = 4;

type Libc = {
  symbols: {
    mount: (src: unknown, target: unknown, type: unknown, flags: number, data: unknown) => number;
    clock_settime: (clock: number, ts: unknown) => number;
    __errno_location: () => number;
  };
};
let libc: Libc | undefined;

function lib(): Libc {
  libc ??= dlopen("libc.so.6", {
    mount: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    clock_settime: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    __errno_location: { args: [], returns: FFIType.ptr },
  }) as never;
  return libc!;
}

const errno = () => read.i32(lib().symbols.__errno_location() as never, 0);

/** The guest's clock (CLOCK_REALTIME) set to `ms`, Unix milliseconds: a local VM has no clock of its own, and its
 * init sets it from the kernel line in whole seconds, a second or so behind by the time anything runs (make then
 * calls every file it just wrote "in the future"). */
export function setClock(ms: number): void {
  const ts = new BigInt64Array([BigInt(Math.floor(ms / 1000)), BigInt(Math.round((ms % 1000) * 1e6))]);
  if (lib().symbols.clock_settime(0, ptr(ts)) !== 0) throw new Error(`clock_settime failed (errno ${errno()})`);
}

/** mount(2), throwing with its errno. */
function mount(source: string, target: string, type: string, flags: number, data: string): void {
  const l = lib();
  // Held here for the call: a pointer alone doesn't keep its buffer.
  const args = [source, target, type, data].map((s) => Buffer.from(`${s}\0`));
  if (l.symbols.mount(ptr(args[0]!), ptr(args[1]!), ptr(args[2]!), flags, ptr(args[3]!)) === 0) return;
  throw new Error(`mount ${type} at ${target} failed (errno ${errno()})`);
}

/** How a step is done: mount(2) on the guest's root, or a test's stand-in. `layers` holds the writable layers,
 * `prepare` makes it. */
export type Doer = { root: string; layers: string; prepare: () => void; overlay: (target: string, lower: string[], upper: string, work: string) => void };

const realDoer: Doer = {
  root: "/",
  layers: LAYERS,
  prepare: () => {
    mkdirSync(LAYERS, { recursive: true });
    mount("fleetd-system", LAYERS, "tmpfs", MS_NOSUID | MS_NODEV, "mode=0755");
  },
  // nosuid: this machine's setuid programs (sudo, su, mount, pkexec) would run as the guest's root for the agent.
  overlay: (target, lower, upper, work) => mount("fleetd-system", target, "overlay", MS_NOSUID | MS_NODEV, `lowerdir=${lower.join(":")},upperdir=${upper},workdir=${work}`),
};

/** Overlay option strings take `:` and `,` as separators and `\` as an escape: a path with one can't be a layer. */
const plain = (p: string) => !/[:,\\]/u.test(p);

/** Does `steps` on the guest's root. Throws on the first that fails: a box half this machine's and half the image's is
 * no box to run an agent in. */
export function apply(steps: Step[], d: Doer = realDoer): void {
  const etc = join(d.root, "etc");
  const own = new Map(OWN.flatMap((name) => {
    try {
      return [[name, readFileSync(join(etc, name))] as const];
    } catch {
      return [];
    }
  }));
  d.prepare();
  for (const s of steps) {
    const at = join(d.root, s.name);
    if ("link" in s) {
      // A link at `/` is replaced by this machine's; a real dir there (an image without merged /usr) is left.
      let st;
      try {
        st = lstatSync(at);
      } catch {}
      if (st && !st.isSymbolicLink()) continue;
      if (st && readlinkSync(at) === s.link) continue;
      const next = `${at}.fleetd-new`;
      rmSync(next, { force: true });
      symlinkSync(s.link, next);
      renameSync(next, at);
      continue;
    }
    if (!s.lower.every(plain)) throw new Error(`can't layer ${s.lower.join(" over ")}: a path has : , or \\ in it`);
    const upper = join(d.layers, s.name, "up");
    const work = join(d.layers, s.name, "work");
    mkdirSync(upper, { recursive: true });
    mkdirSync(work, { recursive: true });
    // A dir this machine has and the image doesn't (lib32) is made on the root's own writable layer.
    if (!existsSync(at)) mkdirSync(at, { recursive: true });
    d.overlay(at, s.lower, upper, work);
  }
  for (const [name, bytes] of own) {
    rmSync(join(etc, name), { force: true });
    writeFileSync(join(etc, name), bytes);
  }
  // The guest is root over files this machine's user owns, and this machine's root's show as nobody's: git trusts
  // them all in a box, as the image's own /etc/gitconfig says, whatever this machine's says.
  const gitconfig = join(etc, "gitconfig");
  let text = "";
  try {
    text = readFileSync(gitconfig, "utf8");
  } catch {}
  if (!/^\s*directory\s*=\s*\*\s*$/mu.test(text)) writeFileSync(gitconfig, `${text}${text && !text.endsWith("\n") ? "\n" : ""}[safe]\n\tdirectory = *\n`);
}

/** In a local VM: mounts the share of this machine's system dirs and lays them over the image's, once. What it did,
 * in a line, or undefined elsewhere: a hosted box, and a guest that isn't the VM's own (its init started it as root,
 * with the kernel's FLEETD_GUEST_UID, which a node gives only with the share), such as a test's stand-in an agent in the
 * box runs. Throws when the share can't be mounted. */
export function layHostSystem(env: Record<string, string | undefined> = process.env): string | undefined {
  if (process.getuid?.() !== 0 || !env.FLEETD_GUEST_UID || existsSync(LAYERS)) return undefined;
  mkdirSync(HOST_SHARE, { recursive: true });
  mount(HOST_TAG, HOST_SHARE, "virtiofs", MS_RDONLY | MS_NOSUID | MS_NODEV, "");
  const steps = plan(entriesOf(HOST_SHARE), (name) => {
    try {
      return lstatSync(join(IMAGE_ROOT, name)).isDirectory();
    } catch {
      return false;
    }
  });
  apply(steps);
  tune();
  return `this machine's ${steps.map((s) => `/${s.name}`).join(", ")} over the image's`;
}

/** What a local VM's guest sets once: ping without a capability (this machine's ping loses its file capability over
 * the share), this machine's umask and inotify limits, and the guest's own helpers out of its OOM killer's reach, so an agent that runs the VM out of memory
 * loses its own processes, never the box's link. What it starts goes back to the default (`asUser`). */
function tune(env: Record<string, string | undefined> = process.env): void {
  const set = (path: string, value: string) => {
    try {
      writeFileSync(path, value);
    } catch {}
  };
  set("/proc/sys/net/ipv4/ping_group_range", "0 2147483647");
  // This machine's umask and inotify limits (../place/microvm.ts hostLike), from the kernel's command line.
  const whole = (v: string | undefined) => (v && /^\d+$/u.test(v) ? v : undefined);
  const watches = whole(env.FLEETD_GUEST_WATCHES);
  const instances = whole(env.FLEETD_GUEST_INSTANCES);
  if (watches) set("/proc/sys/fs/inotify/max_user_watches", watches);
  if (instances) set("/proc/sys/fs/inotify/max_user_instances", instances);
  if (env.FLEETD_GUEST_UMASK && /^0?[0-7]{3}$/u.test(env.FLEETD_GUEST_UMASK)) process.umask(Number.parseInt(env.FLEETD_GUEST_UMASK, 8));
  set("/proc/self/oom_score_adj", "-1000");
  // /tmp and /dev/shm are the guest's memory: the kernel's default (half of it each) let an agent filling both run the
  // guest out of memory. The agent's own temp files ($TMPDIR) are its scratch dir on this machine's disk.
  for (const [at, size] of [["/tmp", "1g"], ["/dev/shm", "512m"]] as const) {
    try {
      mount("tmpfs", at, "tmpfs", MS_REMOUNT | MS_NOSUID | MS_NODEV, `size=${size}`);
    } catch {}
  }
  for (const name of ["socat", "tini"]) for (const pid of pidsOf(name)) set(`/proc/${pid}/oom_score_adj`, "-1000");
}

/** The guest's processes running `name` (its init's helpers, in a VM no agent has started anything in yet). */
function pidsOf(name: string): number[] {
  return readdirSync("/proc").flatMap((d) => {
    if (!/^\d+$/u.test(d)) return [];
    try {
      return readFileSync(`/proc/${d}/comm`, "utf8").trim() === name ? [Number(d)] : [];
    } catch {
      return [];
    }
  });
}

/** Where a local VM's guest says its kernel ran out of memory, for the agent's next tool call (OOM_HOOK). */
export const OOM_NOTE = "/run/fleetd/oom";

/** The hook claude runs after each tool call in a local VM: the guest's word that it ran out of memory, once, as the
 * tool call's feedback (exit 2), where the agent otherwise saw only "Killed". A shell test, a few ms a call. */
export const OOM_HOOK = `f=${OOM_NOTE}; [ -s "$f" ] || exit 0; s="\${TMPDIR:-/tmp}/.fleetd-oom-seen"; cmp -s "$f" "$s" 2>/dev/null && exit 0; cp "$f" "$s" 2>/dev/null; cat "$f" >&2; exit 2`;

/** The kernel's OOM kills so far (/proc/vmstat oom_kill). */
const oomKills = (): number => Number(/^oom_kill (\d+)$/mu.exec(readFileSync("/proc/vmstat", "utf8"))?.[1] ?? 0);

/** The line for the agent from the kernel's last OOM kill (dmesg's `Killed process <pid> (<name>) ... anon-rss:<kB>`). */
export function oomLine(dmesg: string, memGiB: number, at: string): string {
  const kills = [...dmesg.matchAll(/Killed process (\d+) \(([^)]*)\)[^\n]*?anon-rss:(\d+)kB/gu)];
  const last = kills.at(-1);
  const what = last ? `${last[2]} (pid ${last[1]}, ${(Number(last[3]) / 2 ** 20).toFixed(1)} GB)` : "a process";
  return `fleetd: this VM ran out of its ${memGiB} GiB of memory at ${at}, and its kernel killed ${what}. Run less at once (fewer build jobs or test workers, -j 1), or ask for "vmMemoryGiB" to be raised in this machine's node.json (VMs are ${memGiB} GiB here).\n`;
}

/** In a local VM: watches the kernel's OOM kills and writes the last one's line to OOM_NOTE, readable by the agent. */
export function watchOom(env: Record<string, string | undefined> = process.env, everyMs = 2_000): void {
  const memGiB = Number(env.FLEETD_GUEST_MEM) || 0;
  if (process.getuid?.() !== 0 || !env.FLEETD_GUEST_UID || !memGiB) return;
  let seen: number;
  try {
    seen = oomKills();
  } catch {
    return;
  }
  const timer = setInterval(() => {
    try {
      const now = oomKills();
      if (now <= seen) return;
      seen = now;
      const dmesg = Bun.spawnSync(["dmesg"], { stdout: "pipe", stderr: "ignore" }).stdout.toString();
      writeFileSync(OOM_NOTE, oomLine(dmesg, memGiB, new Date().toISOString().slice(11, 19)), { mode: 0o644 });
    } catch {}
  }, everyMs);
  timer.unref?.();
}
