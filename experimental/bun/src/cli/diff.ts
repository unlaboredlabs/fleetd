// A unified diff, line for line as the diffy crate (0.5) writes `create_patch(original, modified)` for
// `fleetd prompts diff`: Myers' middle-snake diff of lines, diffy's compaction, hunks with 3 lines of context, headers
// `--- original` / `+++ modified`, and "\ No newline at end of file" after a last line without one.

type Range = { start: number; end: number };
type DiffRange = { kind: "equal"; a: Range; b: Range } | { kind: "delete"; a: Range } | { kind: "insert"; b: Range };

/** Lines with their `\n`; a last line without one is kept as it is. */
function lineSplit(text: string): string[] {
  const out: string[] = [];
  let at = 0;
  while (at < text.length) {
    const nl = text.indexOf("\n", at);
    const end = nl < 0 ? text.length : nl + 1;
    out.push(text.slice(at, end));
    at = end;
  }
  return out;
}

const len = (r: Range) => r.end - r.start;

function myers(a: number[], b: number[]): DiffRange[] {
  const maxD = (n: number, m: number) => Math.ceil((n + m) / 2) + 1;
  const size = maxD(a.length, b.length);
  const vf = new Int32Array(2 * size + 2);
  const vb = new Int32Array(2 * size + 2);
  const off = size;
  const out: DiffRange[] = [];

  const prefix = (x: Range, y: Range) => {
    let n = 0;
    while (n < len(x) && n < len(y) && a[x.start + n] === b[y.start + n]) n++;
    return n;
  };
  const suffix = (x: Range, y: Range) => {
    let n = 0;
    while (n < len(x) && n < len(y) && a[x.end - 1 - n] === b[y.end - 1 - n]) n++;
    return n;
  };

  const middleSnake = (x: Range, y: Range): [number, number] => {
    const n = len(x);
    const m = len(y);
    const delta = n - m;
    const odd = (delta & 1) === 1;
    vf[off + 1] = 0;
    vb[off + 1] = 0;
    const dMax = maxD(n, m);
    for (let d = 0; d < dMax; d++) {
      for (let k = d; k >= -d; k -= 2) {
        let px = k === -d || (k !== d && vf[off + k - 1]! < vf[off + k + 1]!) ? vf[off + k + 1]! : vf[off + k - 1]! + 1;
        let py = px - k;
        const [x0, y0] = [px, py];
        if (px <= n && py <= m && py >= 0) {
          const adv = prefix({ start: x.start + px, end: x.end }, { start: y.start + py, end: y.end });
          px += adv;
          py += adv;
        }
        vf[off + k] = px;
        if (odd && Math.abs(k - delta) <= d - 1 && vf[off + k]! + vb[off - (k - delta)]! >= n) return [x0, y0];
      }
      for (let k = d; k >= -d; k -= 2) {
        let px = k === -d || (k !== d && vb[off + k - 1]! < vb[off + k + 1]!) ? vb[off + k + 1]! : vb[off + k - 1]! + 1;
        let py = px - k;
        const [x0, y0] = [px, py];
        if (px < n && py < m) {
          const adv = suffix({ start: x.start, end: x.start + n - px }, { start: y.start, end: y.start + m - py });
          px += adv;
          py += adv;
        }
        vb[off + k] = px;
        if (!odd && Math.abs(k - delta) <= d && vb[off + k]! + vf[off - (k - delta)]! >= n) return [n - px, m - py];
        void x0;
        void y0;
      }
    }
    throw new Error("unable to find a middle snake");
  };

  const conquer = (x: Range, y: Range) => {
    const p = prefix(x, y);
    if (p > 0) out.push({ kind: "equal", a: { start: x.start, end: x.start + p }, b: { start: y.start, end: y.start + p } });
    x = { start: x.start + p, end: x.end };
    y = { start: y.start + p, end: y.end };
    const s = suffix(x, y);
    const tail: DiffRange = { kind: "equal", a: { start: x.end - s, end: x.end }, b: { start: y.end - s, end: y.end } };
    x = { start: x.start, end: x.end - s };
    y = { start: y.start, end: y.end - s };
    if (len(x) === 0 && len(y) === 0) {
      // nothing between
    } else if (len(x) === 0) out.push({ kind: "insert", b: y });
    else if (len(y) === 0) out.push({ kind: "delete", a: x });
    else {
      const [sx, sy] = middleSnake(x, y);
      conquer({ start: x.start, end: x.start + sx }, { start: y.start, end: y.start + sy });
      conquer({ start: x.start + sx, end: x.end }, { start: y.start + sy, end: y.end });
    }
    if (s > 0) out.push(tail);
  };
  conquer({ start: 0, end: a.length }, { start: 0, end: b.length });
  return out;
}

/** diffy's compaction: each edit shifted up, then down, merging edits that meet. */
function compact(d: DiffRange[], a: number[], b: number[]) {
  const seq = (r: DiffRange): [number[], Range] => (r.kind === "insert" ? [b, r.b] : r.kind === "delete" ? [a, r.a] : [a, r.a]);
  const commonSuffix = (xs: number[], x: Range, ys: number[], y: Range) => {
    let n = 0;
    while (n < len(x) && n < len(y) && xs[x.end - 1 - n] === ys[y.end - 1 - n]) n++;
    return n;
  };
  const commonPrefix = (xs: number[], x: Range, ys: number[], y: Range) => {
    let n = 0;
    while (n < len(x) && n < len(y) && xs[x.start + n] === ys[y.start + n]) n++;
    return n;
  };
  const isEmpty = (r: DiffRange) => (r.kind === "equal" ? len(r.a) === 0 : r.kind === "delete" ? len(r.a) === 0 : len(r.b) === 0);
  const size = (r: DiffRange) => (r.kind === "insert" ? len(r.b) : len(r.a));
  const shift = (r: DiffRange, n: number) => {
    if (r.kind !== "insert") r.a = { start: r.a.start + n, end: r.a.end + n };
    if (r.kind !== "delete") r.b = { start: r.b.start + n, end: r.b.end + n };
  };
  const growDown = (r: DiffRange, n: number) => {
    if (r.kind !== "insert") r.a = { start: r.a.start, end: r.a.end + n };
    if (r.kind !== "delete") r.b = { start: r.b.start, end: r.b.end + n };
  };
  const growUp = (r: DiffRange, n: number) => {
    if (r.kind !== "insert") r.a = { start: r.a.start - n, end: r.a.end };
    if (r.kind !== "delete") r.b = { start: r.b.start - n, end: r.b.end };
  };
  const shrinkBack = (r: DiffRange, n: number) => growDown(r, -n);
  const shrinkFront = (r: DiffRange, n: number) => growUp(r, -n);

  const up = (p: number): number => {
    while (p > 0) {
      const cur = d[p]!;
      const prev = d[p - 1]!;
      if (prev.kind === "equal" && cur.kind !== "equal") {
        const [xs, x] = seq(cur);
        const [ys, y] = cur.kind === "insert" ? [a, prev.a] : [b, prev.b];
        const n = commonSuffix(xs, x, ys, y);
        if (n !== 0) {
          const next = d[p + 1];
          if (next?.kind === "equal") growUp(next, n);
          else {
            const eq: DiffRange =
              cur.kind === "insert"
                ? { kind: "equal", a: { start: prev.a.end - n, end: prev.a.end }, b: { start: x.end - n, end: x.end } }
                : { kind: "equal", a: { start: x.end - n, end: x.end }, b: { start: prev.b.end - n, end: prev.b.end } };
            d.splice(p + 1, 0, eq);
          }
          shift(cur, -n);
          shrinkBack(prev, n);
          if (isEmpty(prev)) {
            d.splice(p - 1, 1);
            p--;
          }
        } else if (isEmpty(prev)) {
          d.splice(p - 1, 1);
          p--;
        } else break;
      } else if (prev.kind !== "equal" && cur.kind !== "equal" && prev.kind !== cur.kind) {
        [d[p - 1], d[p]] = [cur, prev];
        p--;
      } else if (prev.kind === cur.kind && cur.kind !== "equal") {
        growDown(prev, size(cur));
        d.splice(p, 1);
        p--;
      } else throw new Error("range to shift must be either Insert or Delete");
    }
    return p;
  };

  const down = (p: number): number => {
    while (p + 1 < d.length) {
      const cur = d[p]!;
      const next = d[p + 1]!;
      if (next.kind === "equal" && cur.kind !== "equal") {
        const [xs, x] = seq(cur);
        const [ys, y] = cur.kind === "insert" ? [a, next.a] : [b, next.b];
        const n = commonPrefix(xs, x, ys, y);
        if (n !== 0) {
          const prev = p > 0 ? d[p - 1] : undefined;
          if (prev?.kind === "equal") growDown(prev, n);
          else {
            const eq: DiffRange =
              cur.kind === "insert"
                ? { kind: "equal", a: { start: next.a.start, end: next.a.start + n }, b: { start: x.start, end: x.start + n } }
                : { kind: "equal", a: { start: x.start, end: x.start + n }, b: { start: next.b.start, end: next.b.start + n } };
            d.splice(p, 0, eq);
            p++;
          }
          shift(d[p]!, n);
          shrinkFront(d[p + 1]!, n);
          if (isEmpty(d[p + 1]!)) d.splice(p + 1, 1);
        } else if (isEmpty(next)) d.splice(p + 1, 1);
        else break;
      } else if (next.kind !== "equal" && cur.kind !== "equal" && next.kind !== cur.kind) {
        [d[p], d[p + 1]] = [next, cur];
        p++;
      } else if (next.kind === cur.kind && cur.kind !== "equal") {
        growDown(cur, size(next));
        d.splice(p + 1, 1);
      } else throw new Error("range to shift must be either Insert or Delete");
    }
    return p;
  };

  for (const kind of ["delete", "insert"] as const) {
    for (let p = 0; p < d.length; p++) {
      if (d[p]!.kind === kind) p = down(up(p));
    }
  }
}

type Edit = { old: Range; new: Range };

function editScript(solution: DiffRange[]): Edit[] {
  let [ia, ib] = [0, 0];
  const out: Edit[] = [];
  let script: Edit | undefined;
  for (const r of solution) {
    if (r.kind === "equal") {
      ia += len(r.a);
      ib += len(r.b);
      if (script) out.push(script);
      script = undefined;
    } else if (r.kind === "delete") {
      if (script) script.old.end += len(r.a);
      else script = { old: { start: ia, end: ia + len(r.a) }, new: { start: ib, end: ib } };
      ia += len(r.a);
    } else {
      if (script) script.new.end += len(r.b);
      else script = { old: { start: ia, end: ia }, new: { start: ib, end: ib + len(r.b) } };
      ib += len(r.b);
    }
  }
  if (script) out.push(script);
  return out;
}

/** `diffy::create_patch(original, modified)`, as text. */
export function createPatch(original: string, modified: string, context = 3): string {
  const l1 = lineSplit(original);
  const l2 = lineSplit(modified);
  const ids = new Map<string, number>();
  const id = (l: string) => {
    let n = ids.get(l);
    if (n === undefined) ids.set(l, (n = ids.size));
    return n;
  };
  const a = l1.map(id);
  const b = l2.map(id);
  const solution = myers(a, b);
  compact(solution, a, b);
  const script = editScript(solution);
  const calcEnd = (e1: number, e2: number): [number, number] => {
    const post = Math.min(context, Math.min(Math.max(0, l1.length - e1), Math.max(0, l2.length - e2)));
    return [e1 + post, e2 + post];
  };
  let out = "--- original\n+++ modified\n";
  for (let idx = 0; idx < script.length; idx++) {
    let s = script[idx]!;
    const start1 = Math.max(0, s.old.start - context);
    const start2 = Math.max(0, s.new.start - context);
    let [end1, end2] = calcEnd(s.old.end, s.new.end);
    const lines: [string, string][] = [];
    for (const l of l2.slice(start2, s.new.start)) lines.push([" ", l]);
    for (;;) {
      for (const l of l1.slice(s.old.start, s.old.end)) lines.push(["-", l]);
      for (const l of l2.slice(s.new.start, s.new.end)) lines.push(["+", l]);
      const next = script[idx + 1];
      if (next !== undefined) {
        const start1Next = Math.max(0, Math.min(next.old.start, l1.length - 1) - context);
        if (start1Next < end1) {
          for (let i1 = s.old.end, i2 = s.new.end; i1 < next.old.start && i2 < next.new.start; i1++, i2++) {
            if (l2[i2] !== undefined) lines.push([" ", l2[i2]!]);
          }
          [end1, end2] = calcEnd(next.old.end, next.new.end);
          s = next;
          idx++;
          continue;
        }
      }
      break;
    }
    for (const l of l2.slice(s.new.end, end2)) lines.push([" ", l]);
    const len1 = end1 - start1;
    const len2 = end2 - start2;
    const range = (start: number, n: number) => `${n > 0 ? start + 1 : start}${n === 1 ? "" : `,${n}`}`;
    out += `@@ -${range(start1, len1)} +${range(start2, len2)} @@\n`;
    for (const [sign, line] of lines) {
      out += sign === " " && line === "\n" ? line : `${sign}${line}`;
      if (!line.endsWith("\n")) out += "\n\\ No newline at end of file\n";
    }
  }
  return out;
}
