// `node behaviour.ts [--impl bun[=<bin>]]… [--target <module>] [--areas] [--two-hubs] [--only <suite>,…]`: black-box tests
// against each build given (two builds of fleetd, say, before and after a change), pass/fail side by side. An impl's
// binary defaults to its impls.json `bin`. Every suite but blackbox runs on a team of the target (target.ts): a hub of
// the build, or what `--target` makes. Suites:
// - factory:<scenario>: the factory lab's scenarios (tests/lab/factory, CI's), a node of the binary, offline claude;
// - blackbox: fleetd/test/blackbox and the session host's tests, on the binary (FLEETD_BIN). They start hubs of their
//   own, so with --target they are skipped;
// - contract: contract.ts, every wire shape the apps read checked against app/desktop/src/shared/contracts/schema, one
//   row per check, plus the surface (MCP tools, ready's features, snapshot keys) diffed between the builds;
// - isolation: isolation.ts, the two-team cases made from the tool list. Skipped, with their count, on a target that
//   makes one team, as a hub build does (--two-hubs: on two hubs of the build, which checks the cases themselves).
// `--areas` (areas.ts) runs contract and isolation on the tools the target lists, with no node: the factory rows,
// which need one, are skipped.
// Not here: testLab.ts's `demo`, which needs the real claude, a login and GitHub (run it by hand with FLEETD_BIN).
// Writes results/<impl>/behaviour.json for each; exit 0 only when every suite passed on every implementation. A row
// that was skipped says why, there and in the table, and the last line counts them.
import fs from "node:fs";
import path from "node:path";
import { SCENARIOS } from "../lab/factory/scenarios.ts";
import { arg, has, HERE, impls, REPO, round, scratch, timed, writeResult } from "./lib.ts";

interface Suite {
  readonly name: string;
  readonly command: (bin: string, dir: string, impl: string) => string;
  /** Why it can't run on a target a module makes. */
  readonly hubBuildOnly?: string;
  /** Why it can't run with `--areas`. */
  readonly needsNode?: string;
}
const targetModule = arg("--target", "COMPARE_TARGET");
const on = (bin: string, impl: string) => `--impl ${impl} --bin '${bin}'${targetModule === undefined ? "" : ` --target '${path.resolve(targetModule)}'`}${has("--areas") ? " --areas" : ""}`;
const SUITES: ReadonlyArray<Suite> = [
  ...SCENARIOS.map((s) => ({ name: `factory:${s.name}`, command: (bin: string, dir: string, impl: string) => `node '${path.join(HERE, "factory.ts")}' ${s.name} --dir '${dir}/r' ${on(bin, impl)}`, needsNode: "--areas: a scenario drives a node, and none joins" })),
  { name: "blackbox", command: (bin: string) => `cd '${REPO}/fleetd' && FLEETD_BIN='${bin}' bun test test/blackbox test/node/session_host.test.ts`, hubBuildOnly: "these tests start hubs of the binary themselves" },
  { name: "contract", command: (bin, dir, impl) => `node '${path.join(HERE, "contract.ts")}' ${on(bin, impl)} --json '${dir}/contract.json'` },
  { name: "isolation", command: (bin, dir, impl) => `node '${path.join(HERE, "isolation.ts")}' ${on(bin, impl)}${has("--two-hubs") ? " --two-hubs" : ""} --json '${dir}/isolation.json'` },
];

const given = process.argv.flatMap((a, i) => (process.argv[i - 1] === "--impl" ? [a] : []));
const known = impls();
const targets = (given.length === 0 ? ["bun"] : given).map((spec) => {
  const [name, bin] = spec.split("=") as [string, string | undefined];
  const resolved = path.resolve(bin ?? path.join(REPO, known[name]?.bin ?? ""));
  if (!fs.existsSync(resolved)) throw new Error(`${name}: ${resolved} does not exist; build it or give --impl ${name}=<bin>`);
  return { name, bin: resolved };
});
const onlyAt = process.argv.indexOf("--only");
const only = onlyAt >= 0 ? process.argv[onlyAt + 1]!.split(",") : undefined;
const suites = SUITES.filter((s) => only === undefined || only.some((o) => s.name === o || s.name.startsWith(`${o}:`)));

type Row = { ok: boolean; wallMs: number; skipped?: string; log: string };
const table = new Map<string, Map<string, Row>>();
const surfaces = new Map<string, Record<string, unknown>>();
for (const t of targets) {
  for (const suite of suites) {
    // Short: the factory's node socket is a few levels below it, within SUN_LEN.
    const dir = scratch("b");
    const logFile = path.join(dir, "log.txt");
    console.log(`${t.name} ${suite.name} …`);
    const row = (name: string, ok: boolean, wallMs = 0, skipped?: string) => {
      if (!table.has(name)) table.set(name, new Map());
      table.get(name)!.set(t.name, { ok, wallMs, ...(skipped === undefined ? {} : { skipped }), log: logFile });
    };
    const skipped = (targetModule !== undefined ? suite.hubBuildOnly : undefined) ?? (has("--areas") ? suite.needsNode : undefined);
    if (skipped !== undefined) {
      row(suite.name, true, 0, skipped);
      console.log(`  skipped: ${skipped}`);
      continue;
    }
    const r = timed(suite.command(t.bin, dir, t.name), { cwd: REPO, env: { FLEETD_BIN: t.bin }, logFile });
    row(suite.name, r.code === 0, r.wallMs);
    console.log(`  ${r.code === 0 ? "pass" : "FAIL"} in ${(r.wallMs / 1000).toFixed(1)} s${r.code === 0 ? "" : `; log: ${logFile}`}`);
    // A suite that checks many things says each in <suite>.json: a row apiece.
    const each = path.join(dir, `${suite.name}.json`);
    if (fs.existsSync(each)) {
      const out = JSON.parse(fs.readFileSync(each, "utf8")) as { checks: Array<{ name: string; ok: boolean; skipped?: string }>; surface?: Record<string, unknown> };
      for (const c of out.checks) {
        row(`${suite.name}: ${c.name}`, c.ok, 0, c.skipped);
        if (c.skipped !== undefined) console.log(`  skipped ${c.name}: ${c.skipped}`);
      }
      if (out.surface !== undefined) surfaces.set(t.name, out.surface);
    }
  }
}

const names = targets.map((t) => t.name);
const width = Math.max(...[...table.keys()].map((k) => k.length));
console.log(`\n${"suite".padEnd(width)}  ${names.map((n) => n.padEnd(12)).join("")}`);
for (const [suite, cells] of table) {
  const cell = (n: string) => {
    const c = cells.get(n);
    return (c === undefined ? "-" : `${c.skipped !== undefined ? "skip" : c.ok ? "pass" : "FAIL"}${c.wallMs > 0 ? ` ${round(c.wallMs / 1000, 0)}s` : ""}`).padEnd(12);
  };
  console.log(`${suite.padEnd(width)}  ${names.map(cell).join("")}`);
}
// What one implementation has and another lacks: MCP tools, ready's features, the snapshot's keys, event types.
const [first, ...rest] = names;
for (const other of rest) {
  const a = surfaces.get(first!) ?? {};
  const b = surfaces.get(other) ?? {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const xs = new Set((a[key] as Array<string> | undefined) ?? []);
    const ys = new Set((b[key] as Array<string> | undefined) ?? []);
    const onlyA = [...xs].filter((x) => !ys.has(x));
    const onlyB = [...ys].filter((y) => !xs.has(y));
    if (onlyA.length + onlyB.length > 0) console.log(`surface ${key}: only ${first}: ${onlyA.join(", ") || "-"}; only ${other}: ${onlyB.join(", ") || "-"}`);
  }
}
for (const t of targets) {
  const rows = Object.fromEntries([...table].flatMap(([suite, cells]) => (cells.has(t.name) ? [[suite, (({ log: _, ...row }) => row)(cells.get(t.name)!)]] : [])));
  const all = Object.values(rows);
  const skipped = all.filter((r) => r.skipped !== undefined).length;
  console.log(`${t.name}: ${all.length} rows: ${all.filter((r) => r.ok).length - skipped} pass, ${all.filter((r) => !r.ok).length} FAIL, ${skipped} skipped`);
  writeResult(t.name, "behaviour", { suites: rows, surface: surfaces.get(t.name) }, t.bin);
}
process.exitCode = [...table.values()].every((cells) => [...cells.values()].every((c) => c.ok)) ? 0 : 1;
