// `npm run factory -- [scenario…]` (in tests/lab): W9's "done when" on a project that isn't fleetd. Each scenario
// gets a hub, a node and a generated project of its own (kit.ts, project.ts), with an offline claude stand-in, so it
// needs no network, no GitHub and no claude login, and runs in CI. FLEETD_BIN (default the release build) is the
// fleetd under test. The run dir is FLEETD_FACTORY_DIR, else a new one under the temp dir; it is removed after a pass
// and kept, with its logs, after a failure or with FLEETD_FACTORY_KEEP=1.
//
// Scenarios still to come, each waiting on the PRs it proves: ledger (#408 #419 #423 #430), the rest of throughput
// (#414 #425 #432 #429 and the fair-share PR), the rest of self-healing (#426 and PR5), metrics (#416 #421 #428).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { log, ok } from "../harness.ts";
import { withFactory } from "./kit.ts";
import { selfHealing } from "./selfHealing.ts";
import { throughput } from "./throughput.ts";

const SCENARIOS = [
  { name: "throughput", run: throughput },
  { name: "self-healing", run: selfHealing },
] as const;

async function main() {
  const wanted = process.argv.slice(2);
  const unknown = wanted.filter((w) => !SCENARIOS.some((s) => s.name === w));
  if (unknown.length > 0) throw new Error(`unknown scenario ${unknown.join(", ")}; known: ${SCENARIOS.map((s) => s.name).join(", ")}`);
  const given = process.env.FLEETD_FACTORY_DIR;
  const root = given === undefined ? fs.mkdtempSync(path.join(os.tmpdir(), "fleetd-factory-")) : path.resolve(given);
  if (given !== undefined) fs.rmSync(root, { recursive: true, force: true });
  let failed = true;
  try {
    for (const scenario of SCENARIOS.filter((s) => wanted.length === 0 || wanted.includes(s.name))) {
      log(`--- ${scenario.name}`);
      await withFactory(path.join(root, scenario.name), scenario.run);
      ok(`scenario ${scenario.name} passed`);
    }
    failed = false;
    log("PASS");
  } finally {
    if (failed || process.env.FLEETD_FACTORY_KEEP === "1") log(`run dir kept: ${root} (logs/ in each scenario's dir)`);
    else fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  log(`FAIL ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exitCode = 1;
});
