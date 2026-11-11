// `node factory.ts <scenario> [--dir <new dir>] [--impl <name>] [--bin <fleetd>] [--target <module>]`: one of the
// factory lab's scenarios (tests/lab/factory/scenarios.ts) on a team of the target: a node of the fleetd under test
// joins that team with a generated project and the offline claude stand-in, and the scenario runs as CI's does. On
// the hub build this is what `npm run factory` in tests/lab runs, the hub reached through the target. Exit 0 when the
// scenario passed.
import path from "node:path";
import { withFactory } from "../lab/factory/kit.ts";
import { SCENARIOS } from "../lab/factory/scenarios.ts";
import { openTarget } from "./hubBuild.ts";
import { arg, scratch } from "./lib.ts";

const scenario = SCENARIOS.find((s) => s.name === process.argv[2]);
if (scenario === undefined) throw new Error(`usage: node factory.ts <${SCENARIOS.map((s) => s.name).join("|")}>`);
const { target } = await openTarget();
// Short: the node's socket is a few levels below it, within SUN_LEN.
const dir = path.join(arg("--dir") ?? scratch("fy"), scenario.name);
try {
  await withFactory(dir, scenario.run, { hub: await target.team(dir) });
  console.log(`PASS ${scenario.name} on ${target.name}`);
} catch (e) {
  console.log(`FAIL ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\nrun dir kept: ${dir} (logs/)`);
  process.exitCode = 1;
} finally {
  await target.close();
}
