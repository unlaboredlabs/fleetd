// Exclusive time: which interval owns each instant of a lane. The node gives a run's
// spans their exclusive time with it and fills the rest with `runner.other`; the hub cuts lanes into tiles for the
// critical path with the same rule, so the numbers agree.

/** An interval that competes for the instants it covers; the higher rank owns, then the later start, then the later claim. */
export type Claim = { start: number; end: number; rank: number };

/** One piece of the cut: `owner` is the index of the winning claim, undefined where no claim covers `[start, end)`. */
export type Tile = { owner?: number; start: number; end: number };

/** Cuts `[from, to)` into tiles, adjacent pieces with the same owner merged; they cover it exactly. */
export function tile(claims: Claim[], from: number, to: number): Tile[] {
  if (to <= from) return [];
  // (time, is_start, index): ends sort before starts at the same instant.
  const edges: [number, number, number][] = [];
  claims.forEach((c, i) => {
    const s = Math.max(c.start, from);
    const e = Math.min(c.end, to);
    if (s < e) {
      edges.push([s, 1, i]);
      edges.push([e, 0, i]);
    }
  });
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const key = (i: number) => {
    const c = claims[i] as Claim;
    return [c.rank, Math.max(c.start, from), i];
  };
  const better = (a: number, b: number) => {
    const [x, y] = [key(a), key(b)];
    for (let k = 0; k < 3; k++) if ((x[k] as number) !== (y[k] as number)) return (x[k] as number) > (y[k] as number);
    return false;
  };
  const active: number[] = [];
  const out: Tile[] = [];
  const push = (owner: number | undefined, start: number, end: number) => {
    if (start >= end) return;
    const last = out[out.length - 1];
    if (last && last.owner === owner && last.end === start) last.end = end;
    else out.push(owner === undefined ? { start, end } : { owner, start, end });
  };
  const owner = () => (active.length === 0 ? undefined : active.reduce((a, b) => (better(a, b) ? a : b)));
  let at = from;
  let i = 0;
  while (i < edges.length) {
    const t = (edges[i] as [number, number, number])[0];
    push(owner(), at, t);
    at = t;
    while (i < edges.length && (edges[i] as [number, number, number])[0] === t) {
      const [, start, idx] = edges[i] as [number, number, number];
      if (start) active.push(idx);
      else {
        const p = active.indexOf(idx);
        if (p >= 0) {
          active[p] = active[active.length - 1] as number;
          active.pop();
        }
      }
      i++;
    }
  }
  push(owner(), at, to);
  return out;
}

/** Each claim's exclusive time under `tile`, and the uncovered time. */
export function exclusive(claims: Claim[], from: number, to: number): { excl: number[]; uncovered: number } {
  const excl = claims.map(() => 0);
  let uncovered = 0;
  for (const t of tile(claims, from, to)) {
    if (t.owner === undefined) uncovered += t.end - t.start;
    else excl[t.owner] = (excl[t.owner] as number) + t.end - t.start;
  }
  return { excl, uncovered };
}
