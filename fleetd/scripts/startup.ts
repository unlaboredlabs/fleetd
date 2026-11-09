// CLI cold start: the mean wall time of `<binary> <args>` over many runs from one shell loop (Bun.spawnSync's own
// timing undercounts a fast binary), in a scratch FLEETD_HOME, never ~/.fleetd.
// `bun scripts/startup.ts <binary> [args…]` (default `version`); RUNS sets how many.
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const [bin, ...rest] = process.argv.slice(2);
if (!bin) throw new Error("usage: bun scripts/startup.ts <binary> [args…]");
const args = rest.length > 0 ? rest : ["version"];
const home = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-startup-"));
const runs = Number(process.env.RUNS ?? 50);
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const line = [bin, ...args].map(quote).join(" ");
const loop = (n: number) => `i=0; while [ $i -lt ${n} ]; do ${line} >/dev/null 2>&1; i=$((i+1)); done`;
try {
  const env = { ...process.env, FLEETD_HOME: home };
  Bun.spawnSync(["/bin/sh", "-c", loop(3)], { env });
  const t = performance.now();
  Bun.spawnSync(["/bin/sh", "-c", loop(runs)], { env });
  const ms = (performance.now() - t) / runs;
  console.log(`${bin} ${args.join(" ")}: ${ms.toFixed(2)} ms a run (${runs} runs)`);
} finally {
  rmSync(home, { recursive: true, force: true });
}
