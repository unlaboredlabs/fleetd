// macOS's half of ./index.ts (clock.rs `asleep_ns`): the sleep
// inhibitor is an IOPMAssertion (`PreventUserIdleSystemSleep`, shown by `pmset -g assertions`), which the kernel drops
// with the process, and time asleep is mach_continuous_time (which counts sleep) less mach_absolute_time (which
// doesn't). The frameworks are opened with bun:ffi only on macOS, the first time they're needed.
import { dlopen, FFIType, ptr } from "bun:ffi";

const IOKIT = "/System/Library/Frameworks/IOKit.framework/IOKit";
const CORE_FOUNDATION = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
const LIBSYSTEM = "/usr/lib/libSystem.B.dylib";
const UTF8 = 0x0800_0100;
const LEVEL_ON = 255;

type Power = {
  create: (kind: unknown, level: number, name: unknown, id: unknown) => number;
  release: (id: number) => number;
  cfString: (alloc: null, text: unknown, encoding: number) => unknown;
  cfRelease: (s: unknown) => void;
};

let power: Power | null | undefined;
function powerApi(): Power | null {
  if (power !== undefined) return power;
  try {
    const iokit = dlopen(IOKIT, {
      IOPMAssertionCreateWithName: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      IOPMAssertionRelease: { args: [FFIType.u32], returns: FFIType.i32 },
    }).symbols;
    const cf = dlopen(CORE_FOUNDATION, {
      CFStringCreateWithCString: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.ptr },
      CFRelease: { args: [FFIType.ptr], returns: FFIType.void },
    }).symbols;
    power = {
      create: iokit.IOPMAssertionCreateWithName as Power["create"],
      release: iokit.IOPMAssertionRelease as Power["release"],
      cfString: cf.CFStringCreateWithCString as Power["cfString"],
      cfRelease: cf.CFRelease as Power["cfRelease"],
    };
  } catch {
    power = null;
  }
  return power;
}

const cString = (text: string) => Buffer.from(`${text.replaceAll("\0", "")}\0`, "utf8");

/** An IOPMAssertion that keeps the Mac from idle sleep, named `why`; undefined when none can be had. */
export function assertion(why: string): { release(): void } | undefined {
  const api = powerApi();
  if (!api) return undefined;
  const kind = api.cfString(null, ptr(cString("PreventUserIdleSystemSleep")), UTF8);
  const name = api.cfString(null, ptr(cString(why)), UTF8);
  const id = new Uint32Array(1);
  const status = kind && name ? api.create(kind, LEVEL_ON, name, ptr(id)) : -1;
  for (const s of [kind, name]) if (s) api.cfRelease(s);
  if (status !== 0) return undefined;
  const held = id[0]!;
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      api.release(held);
    },
  };
}

type Clocks = { continuous: () => bigint; absolute: () => bigint; numer: bigint; denom: bigint };
let clocks: Clocks | null | undefined;
function clockApi(): Clocks | null {
  if (clocks !== undefined) return clocks;
  try {
    const sys = dlopen(LIBSYSTEM, {
      mach_continuous_time: { args: [], returns: FFIType.u64 },
      mach_absolute_time: { args: [], returns: FFIType.u64 },
      mach_timebase_info: { args: [FFIType.ptr], returns: FFIType.i32 },
    }).symbols;
    const base = new Uint32Array(2);
    if (sys.mach_timebase_info(ptr(base)) !== 0 || base[1] === 0) throw new Error("no timebase");
    clocks = {
      continuous: () => BigInt(sys.mach_continuous_time() as bigint | number),
      absolute: () => BigInt(sys.mach_absolute_time() as bigint | number),
      numer: BigInt(base[0]!),
      denom: BigInt(base[1]!),
    };
  } catch {
    clocks = null;
  }
  return clocks;
}

/** Time asleep since boot in ns, as one raw reading (short by the gap between the two reads), or undefined. */
export function asleepNs(): number | undefined {
  const api = clockApi();
  if (!api) return undefined;
  // The continuous clock first: the absolute one read after it can only make the difference short, never long.
  const continuous = api.continuous();
  const absolute = api.absolute();
  return Number(((continuous - absolute) * api.numer) / api.denom);
}
