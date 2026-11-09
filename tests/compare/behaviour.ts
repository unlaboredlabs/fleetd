// `node behaviour.ts --impl rust[=<bin>] --impl bun[=<bin>] [--only <suite>,…]`: the same black-box tests against each
// implementation, pass/fail side by side. An impl's binary defaults to its impls.json `bin`. Suites:
// - factory:<scenario>: the factory lab (tests/lab/factory, CI's), hub and node of the binary, offline claude;
// - cargo:<test>: crates/fleetd's integration tests that run the binary (FLEETD_BIN, else the build's own), built once
//   before any suite so their time is the tests' alone;
// - contract: contract.ts, every wire shape the apps read checked against crates/fleetd-contracts/schema, one row per
//   check, plus the surface (MCP tools, ready's features, snapshot keys) diffed between the implementations.
// Not here: testLab.ts's `demo`, which needs the real claude, a login and GitHub (run it by hand with FLEETD_BIN).
// Writes results/<impl>/behaviour.json for each; exit 0 only when every suite passed on every implementation.
import fs from "node:fs";
import path from "node:path";
import { HERE, impls, REPO, round, scratch, timed, writeResult } from "./lib.ts";

const CARGO_TESTS = ["closed_pipe", "home_isolation", "session_host"];

interface Suite {
  readonly name: string;
  readonly command: (bin: string, dir: string, impl: string) => string;
}
const SUITES: ReadonlyArray<Suite> = [
  ...["throughput", "self-healing", "lead-wake"].map((s) => ({ name: `factory:${s}`, command: (_: string, dir: string) => `FLEETD_FACTORY_DIR='${dir}/r' node '${REPO}/tests/lab/factory/run.ts' ${s}` })),
  ...CARGO_TESTS.map((t) => ({ name: `cargo:${t}`, command: () => `cargo test -q -p fleetd --test ${t}` })),
  { name: "contract", command: (bin, dir, impl) => `node '${path.join(HERE, "contract.ts")}' --impl ${impl} --bin '${bin}' --json '${dir}/contract.json'` },
];

const given = process.argv.flatMap((a, i) => (process.argv[i - 1] === "--impl" ? [a] : []));
const known = impls();
const targets = (given.length === 0 ? ["rust"] : given).map((spec) => {
  const [name, bin] = spec.split("=") as [string, string | undefined];
  const resolved = path.resolve(bin ?? path.join(REPO, known[name]?.bin ?? ""));
  if (!fs.existsSync(resolved)) throw new Error(`${name}: ${resolved} does not exist; build it or give --impl ${name}=<bin>`);
  return { name, bin: resolved };
});
const onlyAt = process.argv.indexOf("--only");
const only = onlyAt >= 0 ? process.argv[onlyAt + 1]!.split(",") : undefined;
const suites = SUITES.filter((s) => only === undefined || only.some((o) => s.name === o || s.name.startsWith(`${o}:`)));

// The cargo suites' test binaries are built once, here and untimed, so their rows time the tests alone: a cold build is
// minutes, and the same row on a warm target/ would read as an implementation a hundred times faster.
if (suites.some((s) => s.name.startsWith("cargo:"))) {
  const logFile = path.join(scratch("b-build"), "log.txt");
  console.log("building the cargo suites' tests …");
  const built = timed(`cargo test -q -p fleetd --no-run ${CARGO_TESTS.map((t) => `--test ${t}`).join(" ")}`, { cwd: REPO, logFile });
  if (built.code !== 0) throw new Error(`building the cargo suites' tests failed; log: ${logFile}`);
}

type Row = { ok: boolean; wallMs: number; log: string };
const table = new Map<string, Map<string, Row>>();
const surfaces = new Map<string, Record<string, unknown>>();
for (const t of targets) {
  for (const suite of suites) {
    // Short: the factory's node socket is a few levels below it, within SUN_LEN.
    const dir = scratch("b");
    const logFile = path.join(dir, "log.txt");
    console.log(`${t.name} ${suite.name} …`);
    const r = timed(suite.command(t.bin, dir, t.name), { cwd: REPO, env: { FLEETD_BIN: t.bin }, logFile });
    const row = (name: string, ok: boolean, wallMs = 0) => {
      if (!table.has(name)) table.set(name, new Map());
      table.get(name)!.set(t.name, { ok, wallMs, log: logFile });
    };
    row(suite.name, r.code === 0, r.wallMs);
    console.log(`  ${r.code === 0 ? "pass" : "FAIL"} in ${(r.wallMs / 1000).toFixed(1)} s${r.code === 0 ? "" : `; log: ${logFile}`}`);
    const contract = path.join(dir, "contract.json");
    if (suite.name === "contract" && fs.existsSync(contract)) {
      const out = JSON.parse(fs.readFileSync(contract, "utf8")) as { checks: Array<{ name: string; ok: boolean }>; surface: Record<string, unknown> };
      for (const c of out.checks) row(`contract: ${c.name}`, c.ok);
      surfaces.set(t.name, out.surface);
    }
  }
}

const names = targets.map((t) => t.name);
const width = Math.max(...[...table.keys()].map((k) => k.length));
console.log(`\n${"suite".padEnd(width)}  ${names.map((n) => n.padEnd(12)).join("")}`);
for (const [suite, cells] of table) {
  const cell = (n: string) => {
    const c = cells.get(n);
    return (c === undefined ? "-" : `${c.ok ? "pass" : "FAIL"}${c.wallMs > 0 ? ` ${round(c.wallMs / 1000, 0)}s` : ""}`).padEnd(12);
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
  const rows = Object.fromEntries([...table].flatMap(([suite, cells]) => (cells.has(t.name) ? [[suite, { ok: cells.get(t.name)!.ok, wallMs: cells.get(t.name)!.wallMs }]] : [])));
  writeResult(t.name, "behaviour", { suites: rows, surface: surfaces.get(t.name) }, t.bin);
}
process.exitCode = [...table.values()].every((cells) => [...cells.values()].every((c) => c.ok)) ? 0 : 1;
