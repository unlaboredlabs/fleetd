// A session's signal fence (`fence`): a signal sent from inside an agent's or a lead's session reaches only that
// session's own processes. On 2026-11-21 an agent's cleanup loop (`ps -eo pid= --ppid <pid>`, which `-e` turns into
// every process) sent SIGTERM to all of the user's processes, `systemd --user` included, and the manager stopped the
// hub, the node and every agent with it.
//
// Landlock's signal scope (LANDLOCK_SCOPE_SIGNAL, Linux 6.12+, Landlock ABI 6) on the session host, before it starts
// claude: every process the session starts inherits the domain, a setsid or a double fork included, and may signal
// only processes of that domain (kill, pidfd_send_signal, a tty's SIGIO; ptrace too). Nothing else changes: every
// process stays visible (ps, pgrep, /proc), and files, network, sockets and long-running processes are as before. The
// node, outside the domain, still signals the session, and so does systemd when it stops the session's scope. Landlock
// needs no_new_privs, so a setuid or file-capability program (sudo, newuidmap, a setuid sandbox helper) doesn't raise
// privileges inside a session; Chrome and Electron use their namespace sandbox, which works.
//
// The domain is set on the calling thread, which is the one Bun spawns from, and on all the host's threads where the
// kernel can (LANDLOCK_RESTRICT_SELF_TSYNC, ABI 8). A kernel without it (older Linux, Landlock off) or a Mac leaves the
// session unfenced, and the host starts anyway: the host's log says why.
import { dlopen, FFIType, ptr } from "bun:ffi";

/** The first Landlock ABI with LANDLOCK_SCOPE_SIGNAL. */
export const SIGNAL_ABI = 6;
const TSYNC_ABI = 8;

// <linux/landlock.h>; the syscall numbers are the same on every architecture.
const SYS_CREATE_RULESET = 444n;
const SYS_RESTRICT_SELF = 446n;
const CREATE_RULESET_VERSION = 1n;
const SCOPE_SIGNAL = 2n;
const RESTRICT_SELF_TSYNC = 8n;
const PR_SET_NO_NEW_PRIVS = 38;

export type Fenced = { fenced: true; abi: number } | { fenced: false; why: string };

type Libc = {
  syscall: (n: bigint, a: bigint, b: bigint, c: bigint) => bigint;
  prctl: (option: number, a: bigint, b: bigint, c: bigint, d: bigint) => number;
  close: (fd: number) => number;
};

function libc(): Libc {
  const { symbols } = dlopen("libc.so.6", {
    syscall: { args: [FFIType.i64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i64 },
    prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
  });
  return symbols as unknown as Libc;
}

/** The kernel's Landlock ABI, 0 where there is none (an older kernel, Landlock not among its LSMs, not Linux). */
export function landlockAbi(c: Libc | undefined = linuxLibc()): number {
  if (!c) return 0;
  const abi = Number(c.syscall(SYS_CREATE_RULESET, 0n, 0n, CREATE_RULESET_VERSION));
  return abi > 0 ? abi : 0;
}

const linuxLibc = () => {
  if (process.platform !== "linux") return undefined;
  try {
    return libc();
  } catch {
    return undefined;
  }
};

/** Puts this process in a Landlock domain that scopes signals, so it and everything it starts from now on may signal
 * only each other. Once per process, before the session's first spawn. Never throws. */
export function fence(): Fenced {
  if (process.platform !== "linux") return { fenced: false, why: `${process.platform} has no Landlock` };
  const c = linuxLibc();
  if (!c) return { fenced: false, why: "libc could not be loaded" };
  const abi = landlockAbi(c);
  if (abi < SIGNAL_ABI) return { fenced: false, why: abi === 0 ? "this kernel has no Landlock" : `this kernel's Landlock (ABI ${abi}) can't scope signals: Linux 6.12 or later can` };
  if (c.prctl(PR_SET_NO_NEW_PRIVS, 1n, 0n, 0n, 0n) !== 0) return { fenced: false, why: "no_new_privs could not be set" };
  // struct landlock_ruleset_attr { handled_access_fs, handled_access_net, scoped }: no access rights handled, so files
  // and network are as they were; only signals are scoped.
  const attr = new BigUint64Array([0n, 0n, SCOPE_SIGNAL]);
  const fd = c.syscall(SYS_CREATE_RULESET, BigInt(ptr(attr)), BigInt(attr.byteLength), 0n);
  if (fd < 0n) return { fenced: false, why: "the kernel refused a Landlock ruleset" };
  const flags = abi >= TSYNC_ABI ? RESTRICT_SELF_TSYNC : 0n;
  const done = c.syscall(SYS_RESTRICT_SELF, fd, flags, 0n);
  c.close(Number(fd));
  return done === 0n ? { fenced: true, abi } : { fenced: false, why: "the kernel refused landlock_restrict_self" };
}
