// A local VM's guest, set up once by `fleetd sandbox-guest` before it serves anything. Its system is its image's alone
// (D557: nothing of this machine's own dirs or home is in a box): the guest adds the agent's user to the image's
// /etc/passwd at this machine's ids, with the home the node gave the box (its kernel line's fleetd.user, .uid, .gid
// and .home), then sets the kernel's limits as this machine has them, and watches for the guest running out of memory.
// It runs in sandbox-guest's own process, by mount(2) and plain writes, never a program.
import { dlopen, FFIType, ptr, read } from "bun:ffi";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Marks a guest set up already. */
const SET_UP = "/run/fleetd/set-up";

const MS_REMOUNT = 32;
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

/** The image's /etc/passwd and /etc/group with the agent's user in them: `name` at `uid` and `gid`, its home `home`,
 * in place of any the image had at that id or name (Ubuntu's own `ubuntu` is 1000). A group at `gid` is kept. */
export function withUser(passwd: string, group: string, u: GuestAccount): { passwd: string; group: string } {
  const lines = (text: string) => text.split("\n").filter((l) => l.trim());
  const users = lines(passwd).filter((l) => {
    const [name, , uid] = l.split(":");
    return name !== u.name && Number(uid) !== u.uid;
  });
  users.push(`${u.name}:x:${u.uid}:${u.gid}:fleetd agent:${u.home}:/bin/bash`);
  let groups = lines(group);
  if (!groups.some((l) => Number(l.split(":")[2]) === u.gid)) {
    groups = groups.filter((l) => l.split(":")[0] !== u.name);
    groups.push(`${u.name}:x:${u.gid}:`);
  }
  return { passwd: `${users.join("\n")}\n`, group: `${groups.join("\n")}\n` };
}

export type GuestAccount = { name: string; uid: number; gid: number; home: string };

/** The agent's user from the kernel line, when it names a whole one. */
export function guestAccount(env: Record<string, string | undefined>): GuestAccount | undefined {
  const uid = Number(env.FLEETD_GUEST_UID);
  const gid = Number(env.FLEETD_GUEST_GID);
  const home = env.FLEETD_GUEST_HOME;
  const name = env.FLEETD_GUEST_USER && /^[a-z_][a-z0-9_-]{0,31}$/u.test(env.FLEETD_GUEST_USER) ? env.FLEETD_GUEST_USER : "agent";
  if (!env.FLEETD_GUEST_UID || !Number.isInteger(uid) || uid <= 0 || !Number.isInteger(gid) || gid < 0 || !home?.startsWith("/") || /[:\n]/u.test(home)) return undefined;
  return { name, uid, gid, home };
}

/** In a local VM, once: the agent's user in the image's /etc, then the kernel's limits (`tune`). What it did, in a
 * line, or undefined elsewhere: a hosted box, and a guest that isn't the VM's own (its init started it as root, with
 * the kernel's FLEETD_GUEST_UID), such as a test's stand-in an agent in the box runs. */
export function setUpGuest(env: Record<string, string | undefined> = process.env, etc = "/etc"): string | undefined {
  if (process.getuid?.() !== 0 || !env.FLEETD_GUEST_UID || existsSync(SET_UP)) return undefined;
  const user = guestAccount(env);
  if (user) {
    const text = (f: string) => {
      try {
        return readFileSync(join(etc, f), "utf8");
      } catch {
        return "";
      }
    };
    const out = withUser(text("passwd"), text("group"), user);
    writeFileSync(join(etc, "passwd"), out.passwd);
    writeFileSync(join(etc, "group"), out.group);
  }
  tune(env);
  mkdirSync("/run/fleetd", { recursive: true });
  writeFileSync(SET_UP, "");
  return user ? `the agent runs as ${user.name} (${user.uid}), its home ${user.home}` : "the agent runs at its ids alone, with no user named";
}

/** What a local VM's guest sets once: ping for every user, this machine's umask and inotify limits, and the guest's
 * own helpers out of its OOM killer's reach, so an agent that runs the VM out of memory loses its own processes, never
 * the box's link. What it starts goes back to the default (`asUser`). */
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
