// What a new head changed against the approved head it rebases (crates/fleetd/src/hub/reviews/rebase.rs), read from
// three diffs: the approved head's own patch, the new head's, and what the base gained in between. The PR's own changes
// are compared block by block (each run of removed and added lines) by their lines and their place. Pure.

/** How a new head's patch stands against the approved head's. */
export type Rebase = { kind: "unchanged" } | { kind: "conflicts"; files: string[] } | { kind: "changed" };

type Block = { old: [number, number]; neu: [number, number]; body: string[] };
type File = { header: string[]; blocks: Block[] };

/** Rust's `str::lines`: split on \n, a trailing \r dropped, no last empty line. */
function lines(text: string): string[] {
  const out = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (out.at(-1) === "") out.pop();
  return out;
}

/** A diff's files by their `diff --git` line. */
function files(diff: string): Map<string, File> {
  const out = new Map<string, File>();
  let at: string | undefined;
  const index: [string, string][] = [];
  let pos: [number, number, boolean] | undefined;
  for (const line of lines(diff)) {
    if (line.startsWith("diff --git ")) {
      at = line.slice("diff --git ".length);
      if (!out.has(at)) out.set(at, { header: [], blocks: [] });
      pos = undefined;
      continue;
    }
    const file = at === undefined ? undefined : out.get(at);
    if (!file) continue;
    if (line.startsWith("@@ ")) {
      const sides = line.slice(3).split(" ");
      pos = [first(sides[0]?.startsWith("-") ? sides[0].slice(1) : undefined), first(sides[1]?.startsWith("+") ? sides[1].slice(1) : undefined), false];
      continue;
    }
    if (!pos) {
      if (line.startsWith("index ")) index.push([at ?? "", line]);
      else file.header.push(line);
      continue;
    }
    const change = line.startsWith("-") || line.startsWith("+");
    if (change && !pos[2]) file.blocks.push({ old: [pos[0], 0], neu: [pos[1], 0], body: [] });
    if (change || (line.startsWith("\\") && pos[2])) {
      const block = file.blocks.at(-1)!;
      block.body.push(line);
      if (line.startsWith("-")) {
        block.old[1]++;
        pos[0]++;
      } else if (line.startsWith("+")) {
        block.neu[1]++;
        pos[1]++;
      }
      pos[2] = true;
    } else if (!line.startsWith("\\")) {
      pos[0]++;
      pos[1]++;
      pos[2] = false;
    }
  }
  for (const [name, line] of index) {
    const f = out.get(name);
    if (f && f.blocks.length === 0) f.header.push(line);
  }
  return out;
}

/** The first line of a hunk side, `start,length`: an empty side's start is the line before it. */
function first(side: string | undefined): number {
  const s = side ?? "";
  const comma = s.indexOf(",");
  const [start, len] = comma < 0 ? [s, "1"] : [s.slice(0, comma), s.slice(comma + 1)];
  const n = /^\d+$/.test(start) ? Number(start) : 0;
  return len === "0" ? n + 1 : n;
}

/** Whether two blocks' lines overlap or abut, as git's merge conflicts on. */
const touch = (a: [number, number], b: [number, number]) => a[0] <= b[0] + b[1] && b[0] <= a[0] + a[1];

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * How `own`, the new head's patch, stands against `reviewed`, the approved head's, given `base`, the diff from the
 * approved head's base to the new head's.
 */
export function compare(reviewedDiff: string, ownDiff: string, baseDiff: string): Rebase {
  const reviewed = files(reviewedDiff);
  const own = files(ownDiff);
  const base = files(baseDiff);
  const none: File = { header: [], blocks: [] };
  const conflicts: string[] = [];
  // Rust walks the BTreeMaps in key order.
  const ordered = [...[...reviewed.keys()].sort(), ...[...own.keys()].filter((n) => !reviewed.has(n)).sort()];
  for (const name of ordered) {
    const r = reviewed.get(name) ?? none;
    const o = own.get(name) ?? none;
    const main = base.get(name) ?? none;
    const touched = (b: Block) => main.blocks.some((m) => touch(b.old, m.old));
    // Where each approved block the base left alone sits now: moved by the base's blocks above it.
    const spots = r.blocks.map((b) => {
      const shift = main.blocks.filter((m) => m.old[0] + m.old[1] < b.old[0]).reduce((n, m) => n + m.neu[1] - m.old[1], 0);
      const spot = Math.max(b.old[0] + shift, 0);
      return touched(b) ? undefined : spot;
    });
    const kept = r.blocks.map(() => false);
    const added: Block[] = [];
    for (const b of o.blocks) {
      const i = r.blocks.findIndex((rb, j) => !kept[j] && spots[j] === b.old[0] && same(rb.body, b.body));
      if (i >= 0) kept[i] = true;
      else added.push(b);
    }
    const stray = spots.some((s, i) => s !== undefined && !kept[i]);
    const touchedAny = spots.some((s) => s === undefined);
    const headersSame = same(r.header, o.header);
    if (headersSame && added.length === 0 && !stray && !touchedAny) continue;
    const resolved = !stray && (headersSame || base.has(name)) && added.every((b) => main.blocks.some((m) => touch(b.old, m.neu)));
    if (!resolved) return { kind: "changed" };
    conflicts.push(pathOf(name));
  }
  return conflicts.length === 0 ? { kind: "unchanged" } : { kind: "conflicts", files: conflicts };
}

/** The path a `diff --git a/<path> b/<path>` line names, its new side. */
function pathOf(name: string): string {
  const at = name.lastIndexOf(" b/");
  return at < 0 ? name : name.slice(at + 3);
}
