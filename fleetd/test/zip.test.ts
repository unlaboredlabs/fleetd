// hub/intake/zip.ts, the zip reader the hub's Office text and the hosted service's .apk reads share: an entry's bytes,
// stored or deflated, and its text as those bytes decoded.
import { expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { ENTRY_MAX, Zip } from "../src/hub/intake/zip.ts";

/** An archive of entries, each deflated (method 8) or kept as it is (any other); `zeros` is a body of that many 0 bytes. */
function archive(files: { name: string; method: number; body?: Uint8Array; zeros?: number }[]): Uint8Array {
  const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
  const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
  const pieces: (number[] | Uint8Array | number)[] = [];
  const central: number[] = [];
  let at = 0;
  for (const f of files) {
    const plain = f.body ?? new Uint8Array(0);
    const data = f.method === 8 ? deflateRawSync(plain) : plain;
    const size = f.zeros ?? data.length;
    const name = [...new TextEncoder().encode(f.name)];
    const header = (sig: number[], isCentral: boolean) => [
      ...sig,
      ...(isCentral ? u16(20) : []),
      ...u16(20),
      ...u16(0),
      ...u16(f.method),
      ...new Array(8).fill(0),
      ...u32(size),
      ...u32(f.zeros ?? plain.length),
      ...u16(name.length),
      ...u16(0),
      ...(isCentral ? [...new Array(10).fill(0), ...u32(at)] : []),
      ...name,
    ];
    const local = header([0x50, 0x4b, 0x03, 0x04], false);
    central.push(...header([0x50, 0x4b, 0x01, 0x02], true));
    pieces.push(local, f.zeros ?? data);
    at += local.length + size;
  }
  pieces.push([...central, 0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, ...u16(files.length), ...u16(files.length), ...u32(central.length), ...u32(at), ...u16(0)]);
  // One buffer, its zero bodies left as allocated: the pages nothing writes stay untouched.
  const out = new Uint8Array(pieces.reduce<number>((n, p) => n + (typeof p === "number" ? p : p.length), 0));
  let to = 0;
  for (const p of pieces) {
    if (typeof p !== "number") out.set(p, to);
    to += typeof p === "number" ? p : p.length;
  }
  return out;
}

test("an entry's bytes, stored or deflated; its text is those bytes decoded", async () => {
  const apk = new Uint8Array(Array.from({ length: 4096 }, (_, i) => (i * 31 + 7) & 0xff));
  const zip = Zip.open(
    archive([
      { name: "app-debug.apk", method: 0, body: apk },
      { name: "classes.dex", method: 8, body: apk },
      { name: "notes.txt", method: 8, body: new TextEncoder().encode("Café build 42\n") },
    ]),
  )!;
  expect(zip.names()).toEqual(["app-debug.apk", "classes.dex", "notes.txt"]);
  expect(await zip.bytes("app-debug.apk")).toEqual(apk);
  expect(await zip.bytes("classes.dex")).toEqual(apk);
  expect(await zip.bytes("missing.apk")).toBeUndefined();
  expect(await zip.read("missing.apk")).toBeUndefined();
  for (const name of zip.names()) {
    expect(await zip.read(name)).toBe(new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(await zip.bytes(name)));
  }
  expect(await zip.read("notes.txt")).toBe("Café build 42\n");
});

test("an entry it can't read is undefined, and one past ENTRY_MAX stops there as read does", async () => {
  // Deflate that isn't, and a method the reader doesn't know (bzip2).
  const bad = archive([
    { name: "broken", method: 8 },
    { name: "bzip2", method: 12, body: new Uint8Array([1, 2, 3]) },
  ]);
  bad.set([0xff, 0xff], 30 + "broken".length);
  const zip = Zip.open(bad)!;
  expect(zip.names()).toEqual(["broken", "bzip2"]);
  for (const name of zip.names()) {
    expect(await zip.bytes(name)).toBeUndefined();
    expect(await zip.read(name)).toBeUndefined();
  }

  // A stored entry one byte past the cap: its bytes are the first ENTRY_MAX, a view on the archive, never a copy.
  const big = Zip.open(archive([{ name: "big.apk", method: 0, zeros: ENTRY_MAX + 1 }]))!;
  expect((await big.bytes("big.apk"))?.length).toBe(ENTRY_MAX);
});
