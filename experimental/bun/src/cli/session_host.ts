// `fleetd session-host …`: a session's host stays the Rust binary's (src/node/runner/host.ts). A Bun-built fleetd hands
// the whole command to it, found as the node finds it (findHelper), so `fleetd session-host stop-all` (machine remove)
// and anything else that starts a host through `fleetd` work on a Bun-only install. execve, not a child: the host's pid,
// session and signals stay its own, as when the Rust binary is run directly.
import { dlopen, FFIType, ptr } from "bun:ffi";
import { findHelper, NO_HELPER } from "../node/runner/helper.ts";

/** Set while this command looks for a host: findHelper tries each candidate, and a Bun build it tries then refuses at
 * once rather than looking in turn (two Bun builds on PATH would otherwise try each other without end). */
export const LOOKING = "FLEETD_SESSION_HOST_LOOKUP";

const cstring = (s: string) => Buffer.from(`${s}\0`, "utf8");

/** Replaces this process with `bin`, run with `argv` (its first the name it runs as) and `env`; returns only when that
 * fails. */
function execve(bin: string, argv: string[], env: string[]): void {
  const libc = dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
    execve: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  });
  const path = cstring(bin);
  const list = (strings: Buffer[]) => {
    const pointers = new BigUint64Array(strings.length + 1);
    strings.forEach((s, i) => (pointers[i] = BigInt(ptr(s))));
    return pointers;
  };
  const args = argv.map(cstring);
  const vars = env.map(cstring);
  libc.symbols.execve(ptr(path), ptr(list(args)), ptr(list(vars)));
}

export function run(argv: string[]): number {
  const missing = () => (process.stderr.write(`fleetd: ${NO_HELPER}\n`), 1);
  if (process.env[LOOKING] !== undefined) return missing();
  process.env[LOOKING] = "1";
  const bin = findHelper();
  delete process.env[LOOKING];
  if (bin === undefined) return missing();
  const env = Object.entries(process.env).flatMap(([k, v]) => (v === undefined ? [] : [`${k}=${v}`]));
  execve(bin, ["fleetd", "session-host", ...argv], env);
  process.stderr.write(`fleetd: cannot run ${bin} session-host\n`);
  return 1;
}
