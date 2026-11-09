// Files for hub/intake's tests: PNGs, zip archives and Office documents built byte by byte, and a hub on a fresh home.
import { deflateRawSync, deflateSync } from "node:zlib";
import { Hub } from "../src/hub/api/hub.ts";
import { HubDb } from "../src/hub/store/db.ts";
import { tempHome } from "./helpers.ts";

/** A hub whose home is a fresh directory under $TMPDIR, and its clock. */
export function intakeHub(now = 1_792_000_000_000) {
  const home = tempHome();
  const clock = { ms: now, now: () => clock.ms };
  const hub = new Hub({ home: home.dir, listen: { host: "127.0.0.1", port: 0 } }, HubDb.memory(), clock);
  return { hub, clock, home };
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** A PNG of `w` × `h` whose pixel at (x, y) is `px(x, y)` (RGB, or RGBA with `alpha`). */
export function png(w: number, h: number, px: (x: number, y: number) => number[], alpha = false): Uint8Array {
  const ch = alpha ? 4 : 3;
  const raw = new Uint8Array(h * (w * ch + 1));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(px(x, y).slice(0, ch), y * (w * ch + 1) + 1 + x * ch);
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, w);
  view.setUint32(4, h);
  ihdr[8] = 8;
  ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", new Uint8Array()),
  ]);
}

/** Noise, so neither the PNG nor the JPEG of it is tiny. */
export const noisy = (x: number, y: number) => {
  const n = (Math.imul(x, 2_654_435_761) ^ Math.imul(y, 40_503)) >>> 0;
  return [n & 0xff, (n >> 8) & 0xff, (x + y) & 0xff, 0xff];
};

/** A zip archive of `files`, each deflated, as Office writes one. */
export function zip(files: [string, string][]): Uint8Array {
  const out: number[] = [];
  const central: number[] = [];
  const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
  const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
  for (const [name, body] of files) {
    const plain = new TextEncoder().encode(body);
    const data = [...deflateRawSync(plain)];
    const offset = out.length;
    const nameBytes = [...new TextEncoder().encode(name)];
    const header = (sig: number[], isCentral: boolean) => [
      ...sig,
      ...(isCentral ? u16(20) : []),
      ...u16(20),
      ...u16(0),
      ...u16(8),
      ...new Array(8).fill(0),
      ...u32(data.length),
      ...u32(plain.length),
      ...u16(nameBytes.length),
      ...u16(0),
      ...(isCentral ? [...new Array(10).fill(0), ...u32(offset)] : []),
      ...nameBytes,
    ];
    out.push(...header([0x50, 0x4b, 0x03, 0x04], false), ...data);
    central.push(...header([0x50, 0x4b, 0x01, 0x02], true));
  }
  const at = out.length;
  out.push(...central, 0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, ...u16(files.length), ...u16(files.length), ...u32(central.length), ...u32(at), ...u16(0));
  return new Uint8Array(out);
}

export function docx(paragraphs: string[]): Uint8Array {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join("");
  return zip([
    ["[Content_Types].xml", "<Types/>"],
    ["word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`],
  ]);
}
