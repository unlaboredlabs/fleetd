// Who is calling the node's socket: the kernel's word for
// the caller's pid (SO_PEERCRED on Linux, LOCAL_PEERPID on macOS, through bun:ffi on the socket's fd), then its
// ancestry and environment: /proc on Linux, the kernel's own calls on macOS (proc_pidinfo and sysctl KERN_PROCARGS2),
// which has no /proc. Never what the caller claims.
import { dlopen, FFIType, ptr } from "bun:ffi";
import { readFileSync } from "node:fs";
import type { PeerSession } from "./channel.ts";

/** Set in every runner child's environment to its spawn's marker. */
export const SESSION_MARKER = "FLEETD_RUNNER_SESSION";

export { identify, type Caller, type PeerSession } from "./channel.ts";

let libc: { symbols: { getsockopt: (...a: unknown[]) => number } } | undefined | null;
function getsockopt() {
  if (libc === undefined) {
    try {
      libc = dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
        getsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      }) as unknown as typeof libc;
    } catch {
      libc = null;
    }
  }
  return libc;
}

/** The pid of the process at the other end of a connected unix socket's `fd`. */
export function peerPid(fd: number | undefined): number | undefined {
  const lib = getsockopt();
  if (fd === undefined || !lib) return undefined;
  if (process.platform === "linux") {
    // struct ucred { pid_t pid; uid_t uid; gid_t gid; }, SOL_SOCKET 1, SO_PEERCRED 17.
    const cred = new Int32Array(3);
    const len = new Uint32Array([12]);
    return lib.symbols.getsockopt(fd, 1, 17, ptr(cred), ptr(len)) === 0 && cred[0]! > 0 ? cred[0] : undefined;
  }
  // SOL_LOCAL 0, LOCAL_PEERPID 2.
  const pid = new Int32Array(1);
  const len = new Uint32Array([4]);
  return lib.symbols.getsockopt(fd, 0, 2, ptr(pid), ptr(len)) === 0 && pid[0]! > 0 ? pid[0] : undefined;
}

/** macOS's libSystem calls for another process's parent and environment; null where they can't be had. */
let darwin:
  | { symbols: { proc_pidinfo: (...a: unknown[]) => number; sysctl: (...a: unknown[]) => number } }
  | undefined
  | null;
function libSystem() {
  if (darwin === undefined) {
    try {
      darwin = dlopen("/usr/lib/libSystem.B.dylib", {
        proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
        sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
      }) as unknown as typeof darwin;
    } catch {
      darwin = null;
    }
  }
  return darwin;
}

/** PROC_PIDTBSDINFO's `struct proc_bsdinfo`: 136 bytes, its pid the 4th uint32 and its parent's the 5th. */
const BSDINFO = 3;
const BSDINFO_SIZE = 136;

/** A process's parent on macOS (proc_pidinfo PROC_PIDTBSDINFO). */
export function darwinParentOf(pid: number): number | undefined {
  const lib = libSystem();
  if (!lib) return undefined;
  const info = new Uint32Array(BSDINFO_SIZE / 4);
  if (lib.symbols.proc_pidinfo(pid, BSDINFO, 0, ptr(info), BSDINFO_SIZE) !== BSDINFO_SIZE || info[3] !== pid) return undefined;
  return info[4];
}

/** The most a process's arguments and environment take on macOS (ARG_MAX). */
const ARGS_MAX = 1 << 20;

/** A process's environment on macOS, from sysctl KERN_PROCARGS2: its argc, its executable's path, then its argv and
 * its environment, each NUL-terminated. Only another process of the node's own user is readable, and macOS gives no
 * environment for its own binaries (`/bin/sh`, `/bin/sleep`): such a detached child reads as outside every session. */
export function darwinEnvOf(pid: number): string[] | undefined {
  const lib = libSystem();
  if (!lib) return undefined;
  // CTL_KERN 1, KERN_PROCARGS2 49.
  const mib = new Int32Array([1, 49, pid]);
  const buf = new Uint8Array(ARGS_MAX);
  const size = new BigUint64Array([BigInt(ARGS_MAX)]);
  if (lib.symbols.sysctl(ptr(mib), 3, ptr(buf), ptr(size), null, 0) !== 0) return undefined;
  return procArgsEnv(buf.subarray(0, Number(size[0])));
}

/** KERN_PROCARGS2's environment: past argc, the executable's path and its padding, and the argc arguments. */
export function procArgsEnv(raw: Uint8Array): string[] {
  if (raw.length < 4) return [];
  const argc = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getInt32(0, true);
  let at = 4;
  const next = () => {
    const end = raw.indexOf(0, at);
    const s = new TextDecoder("latin1").decode(raw.subarray(at, end < 0 ? raw.length : end));
    at = end < 0 ? raw.length : end + 1;
    return s;
  };
  next();
  while (at < raw.length && raw[at] === 0) at++;
  for (let i = 0; i < argc && at < raw.length; i++) next();
  const env: string[] = [];
  while (at < raw.length) {
    const s = next();
    if (s === "") break;
    env.push(s);
  }
  return env;
}

/** A process's parent, from its `/proc/<pid>/stat`, or macOS's word for it. */
export function parentOf(pid: number): number | undefined {
  if (process.platform === "darwin") return darwinParentOf(pid);
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
    const ppid = Number(fields[1]);
    return Number.isFinite(ppid) ? ppid : undefined;
  } catch {
    return undefined;
  }
}

/** `pid`'s SESSION_MARKER value. */
export function markerOf(pid: number): string | undefined {
  try {
    const prefix = `${SESSION_MARKER}=`;
    const env = process.platform === "darwin" ? (darwinEnvOf(pid) ?? []) : readFileSync(`/proc/${pid}/environ`, "latin1").split("\0");
    return env.find((v) => v.startsWith(prefix))?.slice(prefix.length);
  } catch {
    return undefined;
  }
}

/** The session `pid` belongs to: the nearest of itself and its ancestors that is a session's claude in `roots`; failing
 * that, the session its marker names (a detached child), else outside every session. */
export function peerSession(pid: number, roots: Map<number, string>, parent = parentOf): PeerSession {
  const seen = new Set<number>();
  for (let at: number | undefined = pid; at !== undefined && at > 1 && !seen.has(at); at = parent(at)) {
    seen.add(at);
    const session = roots.get(at);
    if (session !== undefined) return { kind: "session", session };
  }
  const marker = markerOf(pid);
  return marker ? { kind: "detached", session: marker.split(".")[0]! } : { kind: "outside" };
}
