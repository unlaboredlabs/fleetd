// Who is calling the node's socket: the kernel's word for
// the caller's pid (SO_PEERCRED on Linux, LOCAL_PEERPID on macOS, through bun:ffi on the socket's fd), then its
// ancestry and environment. Never what the caller claims.
import { dlopen, FFIType, ptr } from "bun:ffi";
import { readFileSync } from "node:fs";

/** Set in every runner child's environment to its spawn's marker. */
export const SESSION_MARKER = "FLEETD_RUNNER_SESSION";

export type PeerSession = { kind: "session"; session: string } | { kind: "detached"; session: string } | { kind: "outside" };

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

/** A process's parent, from its `/proc/<pid>/stat`. */
export function parentOf(pid: number): number | undefined {
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
    const env = readFileSync(`/proc/${pid}/environ`, "latin1").split("\0");
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
