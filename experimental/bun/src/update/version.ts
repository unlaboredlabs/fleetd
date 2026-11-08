// How a version reads (crates/fleetd/src/lib.rs `version_label`, `edge_stamp`, `version_shown`). The app's twin is
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
