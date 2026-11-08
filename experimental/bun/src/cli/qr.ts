// A QR code for a terminal (crates/fleetd/src/cli/pair.rs `terminal_qr`): byte mode, error correction L, the smallest
// version that fits, the mask with the lowest penalty, drawn in Unicode half-blocks two rows a line with a 4-module
// quiet zone. Light modules are drawn, so it reads on a dark terminal as dark-on-light.

// Per version (1-40) at level L: error correction codewords per block, and the number of blocks.
const ECC_L = [7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30];
const BLOCKS_L = [1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25];

function rawModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}
const dataCodewords = (ver: number) => Math.floor(rawModules(ver) / 8) - ECC_L[ver - 1]! * BLOCKS_L[ver - 1]!;

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j]!, root);
      if (j + 1 < degree) result[j] = result[j]! ^ result[j + 1]!;
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    divisor.forEach((coef, i) => (result[i] = result[i]! ^ gfMul(coef, factor)));
  }
  return result;
}

function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const num = Math.floor(ver / 7) + 2;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (num * 2 - 2)) * 2;
  const result = [6];
  for (let pos = ver * 4 + 10; result.length < num; pos -= step) result.splice(1, 0, pos);
  return result;
}

// Segments as the qrcode crate (0.14) picks them: its parser's runs of numeric, alphanumeric and byte characters,
// then its greedy merge of neighbours while merging is no longer, then the smallest version that holds them.
const NUMERIC = 0;
const ALNUM = 1;
const BYTE = 2;
const MODE_BITS = [1, 2, 4];
type Segment = { mode: number; begin: number; end: number };

const lengthBits = (mode: number, ver: number) =>
  ver <= 9 ? [10, 9, 8][mode]! : ver <= 26 ? [12, 11, 16][mode]! : [14, 13, 16][mode]!;
const dataBits = (mode: number, n: number) =>
  mode === NUMERIC ? Math.floor((n * 10 + 2) / 3) : mode === ALNUM ? Math.floor((n * 11 + 1) / 2) : n * 8;
const encodedLen = (s: Segment, ver: number) => 4 + lengthBits(s.mode, ver) + dataBits(s.mode, s.end - s.begin);

function alnumDigit(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 65 && c <= 90) return c - 55;
  return { 32: 36, 36: 37, 37: 38, 42: 39, 43: 40, 45: 41, 46: 42, 47: 43, 58: 44 }[c] ?? 0;
}

/** The crate's character classes, for the bytes of ASCII text: 1 symbol, 2 numeric, 3 alpha, else byte. */
function charSet(c: number): number {
  if ([0x20, 0x24, 0x25, 0x2a, 0x2b, 0x2d, 0x2e, 0x2f, 0x3a].includes(c)) return 1;
  if (c >= 0x30 && c <= 0x39) return 2;
  if (c >= 0x41 && c <= 0x5a) return 3;
  return 9;
}

function parseSegments(bytes: number[]): Segment[] {
  // Non-ASCII text (whose Kanji states the CLI's links never reach) is one byte segment.
  if (bytes.some((b) => b >= 0x80)) return bytes.length === 0 ? [] : [{ mode: BYTE, begin: 0, end: bytes.length }];
  const out: Segment[] = [];
  type State = "init" | "numeric" | "alpha" | "byte";
  let state: State = "init";
  let begin = 0;
  const next = (cs: number): State => (cs === 2 ? "numeric" : cs === 1 || cs === 3 ? "alpha" : "byte");
  for (let i = 0; i <= bytes.length; i++) {
    const cs = i === bytes.length ? 0 : charSet(bytes[i]!);
    const to: State = cs === 0 ? "init" : next(cs);
    let push: number | undefined;
    if (state === "numeric" && cs !== 2) push = NUMERIC;
    else if (state === "alpha" && cs !== 1 && cs !== 3) push = ALNUM;
    else if (state === "byte" && cs !== 9) push = BYTE;
    // Alpha takes symbols, byte takes anything but symbol, numeric and alpha.
    const stay: boolean = (state === "alpha" && (cs === 1 || cs === 3)) || (state === "numeric" && cs === 2) || (state === "byte" && cs === 9);
    if (push !== undefined) {
      out.push({ mode: push, begin, end: i });
      begin = i;
    }
    state = stay ? state : to;
  }
  return out;
}

function optimize(segments: Segment[], ver: number): Segment[] {
  const out: Segment[] = [];
  const first = segments[0];
  if (first === undefined) return out;
  let last: Segment = first;
  let lastSize = encodedLen(last, ver);
  for (const seg of segments.slice(1)) {
    const size = encodedLen(seg, ver);
    const merged: Segment = { mode: Math.max(last.mode, seg.mode), begin: last.begin, end: seg.end };
    const mergedSize = encodedLen(merged, ver);
    if (lastSize + size >= mergedSize) [last, lastSize] = [merged, mergedSize];
    else {
      out.push(last);
      [last, lastSize] = [seg, size];
    }
  }
  out.push(last);
  return out;
}

function layout(bytes: number[]): [number, Segment[]] | undefined {
  const segments = parseSegments(bytes);
  for (const group of [9, 26, 40]) {
    const opt = optimize(segments, group);
    const total = opt.reduce((a, s) => a + encodedLen(s, group), 0);
    if (total <= dataCodewords(group) * 8) {
      let ver = 1;
      while (dataCodewords(ver) * 8 < total) ver++;
      return [ver, opt];
    }
  }
  return undefined;
}

/** The QR's modules, true for dark; undefined when `text` is too long for any version. */
export function encode(text: string): boolean[][] | undefined {
  const bytes = [...new TextEncoder().encode(text)];
  const found = layout(bytes);
  if (found === undefined) return undefined;
  const [ver, segments] = found;
  const bits: number[] = [];
  const put = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  for (const seg of segments) {
    const chunk = bytes.slice(seg.begin, seg.end);
    put(MODE_BITS[seg.mode]!, 4);
    put(chunk.length, lengthBits(seg.mode, ver));
    if (seg.mode === NUMERIC) {
      for (let i = 0; i < chunk.length; i += 3) {
        const part = chunk.slice(i, i + 3);
        put(part.reduce((a, b) => a * 10 + (b - 48), 0), part.length * 3 + 1);
      }
    } else if (seg.mode === ALNUM) {
      for (let i = 0; i < chunk.length; i += 2) {
        const part = chunk.slice(i, i + 2);
        put(part.reduce((a, b) => a * 45 + alnumDigit(b), 0), part.length * 5 + 1);
      }
    } else for (const b of chunk) put(b, 8);
  }
  const capacity = dataCodewords(ver) * 8;
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

  // Error correction, then the blocks interleaved.
  const numBlocks = BLOCKS_L[ver - 1]!;
  const eccLen = ECC_L[ver - 1]!;
  const raw = Math.floor(rawModules(ver) / 8);
  const shortBlocks = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const divisor = rsDivisor(eccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < shortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < shortBlocks) dat.push(0);
    blocks.push([...dat, ...ecc]);
  }
  const codewords: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= shortBlocks) codewords.push(block[i]!);
    });
  }

  const size = ver * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => {
    modules[y]![x] = dark;
    fixed[y]![x] = true;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const finder = (x: number, y: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) set(xx, yy, d !== 2 && d !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const align = alignmentPositions(ver);
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) set(align[i]! + dx, align[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  const drawFormat = (mask: number) => {
    const fmt = (1 << 3) | mask; // level L is 01
    let rem = fmt;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const b = ((fmt << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((b >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  drawFormat(0);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const b = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((b >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const c = Math.floor(i / 3);
      set(a, c, dark);
      set(c, a, dark);
    }
  }
  // The codewords in their zigzag.
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fixed[y]![x] && i < codewords.length * 8) {
          modules[y]![x] = ((codewords[i >>> 3]! >>> (7 - (i & 7))) & 1) !== 0;
          i++;
        }
      }
    }
  }
  const masked = (mask: number) => {
    const out = modules.map((row) => [...row]);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (fixed[y]![x]) continue;
        const flip = [
          (x + y) % 2 === 0,
          y % 2 === 0,
          x % 3 === 0,
          (x + y) % 3 === 0,
          (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
          ((x * y) % 2) + ((x * y) % 3) === 0,
          (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
          (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
        ][mask]!;
        if (flip) out[y]![x] = !out[y]![x];
      }
    }
    return out;
  };
  let best: boolean[][] | undefined;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    drawFormat(mask);
    const m = masked(mask);
    const p = penalty(m);
    if (p < bestPenalty) [best, bestPenalty] = [m, p];
  }
  return best;
}

/** The qrcode crate's penalty: runs, 2x2 blocks, finder look-alikes (light past the edge) and its own balance rule. */
function penalty(m: boolean[][]): number {
  const size = m.length;
  let result = 0;
  const lines = [...m, ...m.map((_, x) => m.map((row) => row[x]!))];
  const PATTERN = [true, false, true, true, true, false, true];
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) result += run - 2;
        run = 1;
      }
    }
    for (let j = 0; j + 7 <= size; j++) {
      if (!PATTERN.every((d, k) => line[j + k] === d)) continue;
      const dark = (k: number) => k >= 0 && k < size && line[k] === true;
      const before = [j - 4, j - 3, j - 2, j - 1].some(dark);
      const after = [j + 7, j + 8, j + 9, j + 10].some(dark);
      if (!before || !after) result += 40;
    }
  }
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = m[y]![x];
      if (c === m[y]![x + 1] && c === m[y + 1]![x] && c === m[y + 1]![x + 1]) result += 3;
    }
  }
  const dark = m.reduce((a, row) => a + row.filter(Boolean).length, 0);
  const ratio = Math.floor((dark * 200) / (size * size));
  return result + Math.abs(ratio - 100);
}

/** `text` as a QR in half-blocks, light modules drawn; undefined when it doesn't fit a QR. */
export function terminalQr(text: string): string | undefined {
  const m = encode(text);
  if (m === undefined) return undefined;
  const quiet = 4;
  const size = m.length + quiet * 2;
  const light = (x: number, y: number) => {
    const [mx, my] = [x - quiet, y - quiet];
    return !(mx >= 0 && my >= 0 && mx < m.length && my < m.length && m[my]![mx]);
  };
  const rows: string[] = [];
  for (let y = 0; y < size; y += 2) {
    let line = "";
    for (let x = 0; x < size; x++) {
      const top = light(x, y);
      const bottom = y + 1 < size && light(x, y + 1);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    rows.push(line);
  }
  return rows.join("\n");
}
