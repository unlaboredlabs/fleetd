// Seal and open timings for 1 KB, 1 MB and 16 MB boxes: `bun scripts/bench-sealed-box.ts [--libsodium <path>] [KB...]`.
// With --libsodium (a libsodium.so, e.g. /usr/lib/x86_64-linux-gnu/libsodium.so.23), it times native libsodium too and
// checks, at every size, that each side opens what the other sealed.
import { dlopen, FFIType, ptr } from "bun:ffi";
import { openSealed, publicKeyOf, seal, SEAL_OVERHEAD } from "../src/shared/sealed_box.ts";

const args = process.argv.slice(2);
const lib = args[0] === "--libsodium" ? args.splice(0, 2)[1] : undefined;
const sizes = args.length ? args.map((s) => Number(s) * 1024) : [1024, 1 << 20, 16 << 20];
const secret = crypto.getRandomValues(new Uint8Array(32));
const pub = publicKeyOf(secret);

const sodium = lib
  ? dlopen(lib, {
      sodium_init: { args: [], returns: FFIType.i32 },
      crypto_box_seal: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
      crypto_box_seal_open: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
    }).symbols
  : null;
sodium?.sodium_init();
const nativeSeal = (plain: Uint8Array) => {
  const out = new Uint8Array(plain.length + SEAL_OVERHEAD);
  // ptr() refuses an empty array; libsodium reads none of it then anyway.
  const from = plain.length ? plain : new Uint8Array(1);
  if (sodium!.crypto_box_seal(ptr(out), ptr(from), plain.length, ptr(pub)) !== 0) throw new Error("libsodium didn't seal");
  return out;
};
const nativeOpen = (sealed: Uint8Array) => {
  const out = new Uint8Array(Math.max(1, sealed.length - SEAL_OVERHEAD));
  if (sodium!.crypto_box_seal_open(ptr(out), ptr(sealed), sealed.length, ptr(pub), ptr(secret)) !== 0) return null;
  return out.subarray(0, sealed.length - SEAL_OVERHEAD);
};

function time(f: () => unknown, budgetMs: number): number {
  f();
  const runs: number[] = [];
  const start = performance.now();
  while (runs.length < 3 || (performance.now() - start < budgetMs && runs.length < 200)) {
    const t = performance.now();
    f();
    runs.push(performance.now() - t);
  }
  runs.sort((a, b) => a - b);
  return runs[runs.length >> 1]!;
}

const fmt = (n: number, ms: number) =>
  `${ms.toFixed(3).padStart(9)} ms (${(n / 1048576 / (ms / 1000)).toFixed(1).padStart(6)} MB/s)`;
for (const n of sizes) {
  const plain = new Uint8Array(n);
  for (let at = 0; at < n; at += 65536) crypto.getRandomValues(plain.subarray(at, at + 65536));
  const sealed = seal(pub, plain);
  const label = (n >= 1 << 20 ? `${n >> 20} MB` : `${n >> 10} KB`).padStart(6);
  const [s, o] = [time(() => seal(pub, plain), 2000), time(() => openSealed(secret, sealed), 2000)];
  console.log(`${label}  bun        seal ${fmt(n, s)}  open ${fmt(n, o)}`);
  if (!sodium) continue;
  const native = nativeSeal(plain);
  if (!Buffer.from(nativeOpen(sealed)!).equals(plain) || !Buffer.from(openSealed(secret, native)!).equals(plain)) {
    throw new Error(`${label}: bun and libsodium don't open each other's boxes`);
  }
  const [ns, no] = [time(() => nativeSeal(plain), 2000), time(() => nativeOpen(native), 2000)];
  console.log(`${label}  libsodium  seal ${fmt(n, ns)}  open ${fmt(n, no)}`);
}
if (sodium) console.log("bun and libsodium opened each other's boxes at every size");
