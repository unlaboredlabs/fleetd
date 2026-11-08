// flock(2) on a file, through libc: the build slots' and queue tickets' locks, the same kernel locks the Rust
// binary's `File::lock` and `try_lock` take, so a Bun and a Rust build-slot wait for each other.
import { dlopen, FFIType } from "bun:ffi";

const LOCK_EX = 2;
const LOCK_NB = 4;

let libc: { symbols: { flock: (fd: number, op: number) => number } } | undefined;
function lib() {
  libc ??= dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  }) as never;
  return libc!;
}

/** Blocks until `fd` holds an exclusive lock. */
export function lock(fd: number) {
  if (lib().symbols.flock(fd, LOCK_EX) !== 0) throw new Error("flock failed");
}

/** True when `fd` now holds an exclusive lock, false when another holds one. */
export function tryLock(fd: number): boolean {
  if (lib().symbols.flock(fd, LOCK_EX | LOCK_NB) === 0) return true;
  return false;
}
