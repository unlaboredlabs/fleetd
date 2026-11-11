// `node isolation.ts [--impl <name>] [--bin <fleetd>] [--target <module>] [--areas] [--two-hubs] [--json <file>]`: one team
// can't reach another's data. The two-team cases (twoTeams.ts) are made from the target's own tools/list: every tool
// that takes an id is called with team A's key and team B's ids and must answer as it answers an id nobody holds.
//
// They run on a target that makes two teams. Each team gets a fleet (a node of the build under test, a project, an
// order, a writer, a decision, an automation, an invite), team B more of each, so B holds ids A lacks, and with a
// canary in every text of B's. Team A's ids are read before team B is made: what A holds then is its own.
// On a target that makes one team, as a self-hosted hub does, there is no second team to ask about: the cases are
// made and counted and the row is skipped, saying how many. `--two-hubs` runs them on two hubs of the build, which
// checks the cases, not the hub (hubBuild.ts).
//
// `--areas`, for a target that serves some areas and joins no machine (areas.ts): no fleet, each team seeded through
// the tools the target lists and its own `seed`, and the cases made of exactly those tools.
//
// The rows under LATER are a hosted service's other isolation checks. They need more than an address and two teams,
// so they are named here and skipped with what they need. Exit 0 unless a case failed.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type Factory, withFactory } from "../lab/factory/kit.ts";
import { openTarget } from "./hubBuild.ts";
import { areasTwoTeams } from "./areas.ts";
import { arg, has, REPO, scratch } from "./lib.ts";
import { openSession, type Session } from "./mcp.ts";
import type { Team } from "./target.ts";
import { type Contract, readIds, type Report, reportLines, runTwoTeams, twoTeamCases } from "./twoTeams.ts";

const LATER: ReadonlyArray<readonly [name: string, needs: string]> = [
  ["every table is kept to its team by a policy", "the service's database, which a target doesn't give"],
  ["one team's events never reach another's sockets, on two instances", "a target that says which instance serves a team"],
  ["one team's vault items and objects don't open under another's key", "the service's stored rows and object store, which a target doesn't give"],
];

interface Check {
  readonly name: string;
  readonly ok: boolean;
  /** Why it didn't run. */
  readonly skipped?: string;
  readonly detail?: string;
}

const { name, target } = await openTarget();
const contract = JSON.parse(fs.readFileSync(path.join(REPO, "app/desktop/src/shared/contracts/schema/McpTools.json"), "utf8")) as Contract;
const session = async (team: Team): Promise<Session> => openSession(team.url, await team.key({ name: "isolation", role: "admin", human: true }));

/** An order with a writer under it, a decision, an automation and an invite, `times` over, each text carrying `mark`. */
async function seed(f: Factory, admin: Session, mark: string, times: number) {
  for (let n = 1; n <= times; n++) {
    const w = f.workstream(`${mark} order ${n}.`);
    const task = f.spawnWriter(w, `${mark} writer ${n}`, `${mark}\nlab-run: true\n`);
    await f.waitTask(task.taskId as string, ["done"], 60_000);
    const writes: Array<[string, Record<string, unknown>]> = [
      ["decisions_record", { key: `isolation.seed-${n}`, value: `${mark} decision ${n}`, why: mark, scope: { kind: "project", projectRef: f.ref } }],
      ["automation_create", { projectRef: f.ref, name: `${mark} automation ${n}`, prompt: mark, clientRequestId: `seed-${n}` }],
      ["invite_create", { name: `${mark} guest ${n}` }],
    ];
    for (const [tool, input] of writes) {
      const made = await admin.call(tool, input);
      if (made.isError) throw new Error(`${tool}: ${JSON.stringify(made.body)}`);
    }
  }
}

const cases: { check?: Check; report?: Report } = {};
const dir = scratch(`iso-${name}`);
try {
  const a = await target.team(path.join(dir, "a"));
  if (target.teams < 2) {
    const made = twoTeamCases(await (await session(a)).tools());
    const tools = new Set(made.map((c) => c.tool)).size;
    cases.check = { name: "two-team cases", ok: true, skipped: `${made.length} cases over ${tools} tools not run: ${target.name} makes one team` };
  } else if (has("--areas")) {
    cases.report = await areasTwoTeams(target, a, contract, `canary-${randomBytes(6).toString("hex")}`, dir);
  } else {
    const canary = `canary-${randomBytes(6).toString("hex")}`;
    await withFactory(
      path.join(dir, "a"),
      async (fa) => {
        const asA = await session(a);
        await seed(fa, asA, "team A's", 1);
        const own = await readIds(asA, contract);
        const b = await target.team(path.join(dir, "b"));
        await withFactory(
          path.join(dir, "b"),
          async (fb) => {
            const asB = await session(b);
            await seed(fb, asB, canary, 2);
            cases.report = await runTwoTeams({ a: asA, b: asB, contract, own, canaries: [canary] });
          },
          { hub: b, machine: "factory-b" },
        );
      },
      { hub: a },
    );
  }
  if (cases.report !== undefined) {
    const failed = cases.report.cases.filter((c) => c.verdict === "fail");
    cases.check = { name: "two-team cases", ok: failed.length === 0, detail: reportLines(cases.report)[0]!.replace("two-team cases: ", "") };
  }
} catch (e) {
  cases.check = { name: "two-team cases", ok: false, detail: (e instanceof Error ? (e.stack ?? e.message) : String(e)).trim() };
} finally {
  await target.close();
}

const checks: Array<Check> = [cases.check!, ...LATER.map(([later, needs]) => ({ name: later, ok: true, skipped: `not written here: needs ${needs}` }))];
if (cases.report !== undefined) for (const line of reportLines(cases.report)) console.log(line);
for (const c of checks) console.log(`${c.skipped !== undefined ? "skip" : c.ok ? "pass" : "FAIL"} ${c.name}${c.skipped !== undefined ? `: ${c.skipped}` : c.detail === undefined ? "" : `: ${c.detail}`}`);
const out = arg("--json");
if (out !== undefined) fs.writeFileSync(out, `${JSON.stringify({ impl: name, checks, report: cases.report }, null, 2)}\n`);
const skipped = checks.filter((c) => c.skipped !== undefined).length;
console.log(`${checks.filter((c) => c.ok).length - skipped} of ${checks.length} isolation checks passed, ${skipped} skipped`);
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
