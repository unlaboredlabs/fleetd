// `node report.ts [<a> <b>] [--out <file.md>]`: two builds' result sets (results/<a>/, results/<b>/) as one markdown report: build and check times, the behaviour suites pass/fail side by side, then
// every runtime bench's numbers with b/a. A summary ({n, median, p90, …}) shows as its median and p90; a bench only
// one side has run shows "-" for the other. Prints the markdown, and writes it with --out.
import fs from "node:fs";
import path from "node:path";
import { arg, RESULTS } from "./lib.ts";

const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !all[i - 1]?.startsWith("--"));
const [a, b] = positional;
if (a === undefined || b === undefined) throw new Error("usage: node report.ts <a> <b> [--out <file.md>]");
const root = arg("--results", "COMPARE_OUT") ?? RESULTS;
type Json = Record<string, any>;
const load = (impl: string) => {
  const dir = path.join(root, impl);
  if (!fs.existsSync(dir)) return {} as Record<string, Json>;
  return Object.fromEntries(fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => [f.replace(/\.json$/u, ""), JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Json]));
};
const A = load(a);
const B = load(b);
const lines: Array<string> = [];
const out = (s = "") => lines.push(s);

const fmt = (x: unknown): string => {
  if (x === undefined || x === null) return "-";
  if (typeof x === "number") return Number.isNaN(x) ? "-" : Math.abs(x) >= 100 ? Math.round(x).toLocaleString("en-US") : String(Math.round(x * 100) / 100);
  if (typeof x === "boolean") return x ? "pass" : "**FAIL**";
  return String(x);
};
const isSummary = (x: unknown): x is { median: number; p90: number; n: number } => typeof x === "object" && x !== null && "median" in x && "n" in x;
const ratio = (x: unknown, y: unknown) => (typeof x === "number" && typeof y === "number" && x !== 0 && !Number.isNaN(x) && !Number.isNaN(y) ? `${(y / x).toFixed(2)}×` : "");
const seconds = (ms: unknown) => (typeof ms === "number" ? Math.round(ms / 100) / 10 : undefined);

/** Every number under `x` as [path, value]; a summary is one row (its median, with its p90 beside). */
const leaves = (x: unknown, prefix = ""): Array<[string, number | boolean | string, string?]> => {
  if (isSummary(x)) return [[prefix, x.median, `p90 ${fmt(x.p90)}, n ${x.n}${"first" in x ? `, first run ${fmt(x.first)}` : ""}`]];
  if (typeof x === "number" || typeof x === "boolean") return [[prefix, x]];
  if (Array.isArray(x) || typeof x !== "object" || x === null) return [];
  return Object.entries(x).flatMap(([k, v]) => leaves(v, prefix === "" ? k : `${prefix}.${k}`));
};

out(`# fleetd: ${a} vs ${b}`);
out();
const machine = (A.size ?? A.build ?? Object.values(A)[0])?.machine as Json | undefined;
if (machine !== undefined) out(`Measured on ${machine.cpus} × ${machine.cpuModel}, ${machine.memGb} GB, Linux ${machine.kernel}. ${a}: ${(A.size ?? Object.values(A)[0])?.version ?? "?"}; ${b}: ${(B.size ?? Object.values(B)[0])?.version ?? "not measured yet"}. Load average at each bench is in its JSON.`);
out();

out("## Build and check");
out();
out(`| step | CPUs (N) | ${a} clean (s) | ${b} clean (s) | ${a} one-file edit (s) | ${b} one-file edit (s) |`);
out("|---|---|---|---|---|---|");
// One build-j<N>.json per CPU count measured: each runs on N pinned CPUs with every tool's parallelism set to N.
const builds = [...new Set([...Object.keys(A), ...Object.keys(B)].filter((k) => /^build-j\d+$/u.test(k)))].sort((x, y) => Number(x.slice(7)) - Number(y.slice(7)));
const time = (r: Json | undefined) => seconds(r?.runMs ?? r?.toolMs ?? r?.wallMs);
for (const file of builds) {
  const steps = new Set([...Object.keys(A[file]?.data.steps ?? {}), ...Object.keys(B[file]?.data.steps ?? {})]);
  for (const s of steps) {
    const x = A[file]?.data.steps?.[s] as Json | undefined;
    const y = B[file]?.data.steps?.[s] as Json | undefined;
    out(`| ${s} | ${file.slice(7)} | ${fmt(time(x?.clean ?? x?.warm))} | ${fmt(time(y?.clean ?? y?.warm))} | ${fmt(time(x?.incremental))} | ${fmt(time(y?.incremental))} |`);
  }
}
out();
out("Each side runs on the same N CPUs (taskset); `test` is the suite's run on its finished build.");
out();

out("## Behaviour");
out();
out(`| suite | ${a} | ${b} |`);
out("|---|---|---|");
const suites = new Set([...Object.keys(A.behaviour?.data.suites ?? {}), ...Object.keys(B.behaviour?.data.suites ?? {})]);
const cell = (r: Json | undefined) => (r === undefined ? "-" : typeof r.skipped === "string" ? `skipped: ${r.skipped}` : `${fmt(r.ok as boolean)}${r.wallMs > 0 ? ` (${fmt(seconds(r.wallMs))} s)` : ""}`);
for (const s of suites) out(`| ${s} | ${cell(A.behaviour?.data.suites?.[s])} | ${cell(B.behaviour?.data.suites?.[s])} |`);
out();

if (A.desktop !== undefined || B.desktop !== undefined) {
  out("## Desktop app against the hub");
  out();
  out(`| step | ${a} | ${b} |`);
  out("|---|---|---|");
  const rows = (r: Json | undefined) => new Map(((r?.data.steps ?? []) as Array<Json>).map((s) => [s.step as string, s]));
  const [x, y] = [rows(A.desktop), rows(B.desktop)];
  for (const s of new Set([...x.keys(), ...y.keys()])) {
    if (s.startsWith("console errors")) continue;
    const c = (r: Json | undefined) => (r === undefined ? "-" : `${fmt(r.ok as boolean)}${r.findings ? ` (${r.findings} QA findings)` : ""}`);
    out(`| ${s} | ${c(x.get(s))} | ${c(y.get(s))} |`);
  }
  out();
}

const RUNTIME = ["size", "startup", "hub-ready", "idle", "sessions", "fanout", "sql", "weaknet", "soak"];
for (const bench of RUNTIME) {
  const x = A[bench]?.data;
  const y = B[bench]?.data;
  if (x === undefined && y === undefined) continue;
  out(`## ${bench}`);
  out();
  out(`| measure | ${a} | ${b} | ${b}/${a} | spread |`);
  out("|---|---|---|---|---|");
  const xs = new Map(leaves(bench === "soak" ? { ...x, memory: undefined } : x).map(([k, v, note]) => [k, { v, note }]));
  const ys = new Map(leaves(bench === "soak" ? { ...y, memory: undefined } : y).map(([k, v, note]) => [k, { v, note }]));
  for (const k of new Set([...xs.keys(), ...ys.keys()])) {
    if (k === "benchWallS" || k.endsWith(".n")) continue;
    const p = xs.get(k);
    const q = ys.get(k);
    out(`| ${k} | ${fmt(p?.v)} | ${fmt(q?.v)} | ${ratio(p?.v, q?.v)} | ${[p?.note, q?.note].filter(Boolean).join(" / ")} |`);
  }
  out();
}

const text = lines.join("\n");
console.log(text);
const file = arg("--out");
if (file !== undefined) fs.writeFileSync(file, `${text}\n`);
