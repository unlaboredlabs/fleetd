// How a version reads (`edge_stamp`, `version_shown`). The app's twin is
// `versionLabel` (app/desktop/src/shared/updates.ts).
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** An Edge build's version split around its channel: `[base, rest]` of `<base>-edge.<rest>` (or `-nightly.`). */
export function edgeStamp(version: string): [string, string] | undefined {
  for (const mark of ["-edge.", "-nightly."]) {
    const at = version.indexOf(mark);
    if (at >= 0) return [version.slice(0, at), version.slice(at + mark.length)];
  }
  return undefined;
}

/** `0.0.0-edge.202610261056+1b563d7` reads "Edge · Oct 26, 10:56 UTC · 1b563d7"; any other version is itself. */
export function versionLabel(raw: string): string {
  let version = raw.trim();
  if (version.startsWith("v")) version = version.slice(1);
  const plus = version.indexOf("+");
  const [bare, build] = plus >= 0 ? [version.slice(0, plus), version.slice(plus + 1)] : [version, ""];
  const split = edgeStamp(bare);
  const numeric = (s: string) => /^[0-9]+$/.test(s);
  const stamp = split && split[0].split(".").length === 3 && split[0].split(".").every(numeric) && split[1].length === 12 && numeric(split[1]) ? split[1] : undefined;
  if (!stamp) return bare;
  const month = MONTHS[Number(stamp.slice(4, 6)) - 1];
  if (!month) return bare;
  const day = stamp.slice(6, 8).replace(/^0+/, "");
  let label = `Edge · ${month} ${day}, ${stamp.slice(8, 10)}:${stamp.slice(10, 12)} UTC`;
  if (build.length >= 7 && /^[0-9a-fA-F]+$/.test(build)) label += ` · ${build.slice(0, 7).toLowerCase()}`;
  return label;
}

/** How output names a version: its label, and the raw version after it when they differ. */
export function versionShown(version: string): string {
  const label = versionLabel(version);
  return label === version.trim() ? label : `${label} (${version.trim()})`;
}

/**
 * How two versions order (lib.rs `version_cmp`): by their numbers, then a release over its prereleases, prereleases
 * part by part. Undefined across channels (an edge build and a tagged one), and for 0.0.0, a local build.
 */
export function versionCmp(a: string, b: string): -1 | 0 | 1 | undefined {
  const parse = (raw: string): [number[], string | undefined] | undefined => {
    let v = raw.trim();
    if (v.startsWith("v")) v = v.slice(1);
    const plus = v.indexOf("+");
    const bare = plus >= 0 ? v.slice(0, plus) : v;
    const dash = bare.indexOf("-");
    let core = bare;
    let pre: string | undefined;
    if (dash >= 0) {
      const p = bare.slice(dash + 1);
      if (p === "") return undefined;
      core = bare.slice(0, dash);
      // Renamed, the same series: an edge build orders as the nightly of its stamp.
      pre = p.startsWith("edge") ? `nightly${p.slice(4)}` : p;
    }
    const nums = core.split(".");
    if (nums.length !== 3 || !nums.every((n) => /^[0-9]+$/.test(n))) return undefined;
    return [nums.map(Number), pre];
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return undefined;
  const nightly = (p: string | undefined) => p?.startsWith("nightly") ?? false;
  const zero = (n: number[]) => n.every((d) => d === 0);
  if ((zero(x[0]) && x[1] === undefined) || (zero(y[0]) && y[1] === undefined) || nightly(x[1]) !== nightly(y[1])) return undefined;
  const sign = (d: number) => (d < 0 ? -1 : d > 0 ? 1 : 0) as -1 | 0 | 1;
  for (let i = 0; i < 3; i++) if (x[0][i] !== y[0][i]) return sign(x[0][i]! - y[0][i]!);
  const [p, q] = [x[1], y[1]];
  if (p === undefined && q === undefined) return 0;
  if (p === undefined) return 1;
  if (q === undefined) return -1;
  const ps = p.split(".");
  const qs = q.split(".");
  for (let i = 0; ; i++) {
    const [s, t] = [ps[i], qs[i]];
    if (s === undefined && t === undefined) return 0;
    if (s === undefined) return -1;
    if (t === undefined) return 1;
    const [sn, tn] = [/^[0-9]+$/.test(s) ? Number(s) : undefined, /^[0-9]+$/.test(t) ? Number(t) : undefined];
    const d = sn !== undefined && tn !== undefined ? sign(sn - tn) : sn !== undefined ? -1 : tn !== undefined ? 1 : s < t ? -1 : s > t ? 1 : 0;
    if (d !== 0) return d;
  }
}

/** `have` is `want`, or as new or newer on the same channel: never moved to `want`, which would be backwards. */
export const atLeast = (have: string, want: string) => have === want || (versionCmp(have, want) ?? -1) >= 0;
