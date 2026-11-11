// `--areas`: the suite on a target that serves some areas of the hub, not all of it (a service built a module at a
// time), and joins no machine. No node joins and no project is added: a team is seeded through the tools the target
// lists (SEEDS) and the target's own `seed` (target.ts) for what no listed tool makes, and every check is made of
// exactly the tools it lists. isolation.ts runs the two-team cases this way, contract.ts the output-schema check.
// Imports nothing but ./mcp.ts and ./twoTeams.ts: fleetd's own tests run it against the stand-in (standIn.ts).
import path from "node:path";
import { type Answer, openSession, type Session, type Tool } from "./mcp.ts";
import type { Target, Team } from "./target.ts";
import { type Contract, harvest, inputFrom, type Reads, readIds, type Report, runTwoTeams } from "./twoTeams.ts";

/** The writes that seed a team, made when the target lists their tool: the `n`th of each, `mark` in every text. */
const SEEDS: ReadonlyArray<readonly [tool: string, input: (mark: string, n: number) => unknown]> = [
  // Global: with no node there is no project to scope it to.
  ["decisions_record", (mark, n) => ({ key: `isolation.seed-${n}`, value: `${mark} decision ${n}`, why: mark, scope: { kind: "global" } })],
];

/** Reads that take words, not only ids: every seeded decision's text holds "decision". */
export const READS: Reads = [["decisions_search", { query: "decision" }]];

export const session = async (team: Team): Promise<Session> => openSession(team.url, await team.key({ name: "areas", role: "admin", human: true }));

/** Seeds a team `times` over, `mark` in every text: SEEDS through the tools `listed` holds, then the target's own. */
export async function seed(team: Team, as: Session, listed: ReadonlyArray<Tool>, mark: string, times: number): Promise<Array<{ tool: string; answer: Answer }>> {
  const made: Array<{ tool: string; answer: Answer }> = [];
  for (let n = 1; n <= times; n++) {
    for (const [tool, input] of SEEDS.filter(([tool]) => listed.some((t) => t.name === tool))) {
      const answer = await as.call(tool, input(mark, n));
      if (answer.isError) throw new Error(`${tool}: ${JSON.stringify(answer.body)}`);
      made.push({ tool, answer });
    }
  }
  await team.seed?.(mark, times);
  return made;
}

/** The two-team cases on `target`: team A (made) seeded once and its ids read, then team B made and seeded twice with `canary`. */
export async function areasTwoTeams(target: Target, teamA: Team, contract: Contract, canary: string, dir: string): Promise<Report> {
  const a = await session(teamA);
  const listed = await a.tools();
  await seed(teamA, a, listed, "team A's", 1);
  const own = await readIds(a, contract, READS);
  const teamB = await target.team(path.join(dir, "b"));
  const b = await session(teamB);
  await seed(teamB, b, listed, canary, 2);
  return runTwoTeams({ a, b, contract, own, canaries: [canary], reads: READS });
}

export interface AreaCheck {
  readonly name: string;
  readonly ok: boolean;
  /** Why it didn't run. */
  readonly skipped?: string;
  readonly detail?: string;
}

/**
 * The contract on exactly the tools `team` lists: /healthz, tools/list, every listed tool known to the contract, and
 * each one's answer decoded as its `<tool>.output` (`valid` says why one doesn't, undefined when it does). The seeds'
 * writes first, then each read-only tool as the team's own reads call it (harvest: with the ids they turn up), then
 * the other writes with the team's own ids, last, as one may retire what was read.
 */
export async function areasContract(team: Team, contract: Contract, valid: (tool: string, body: unknown) => string | undefined): Promise<Array<AreaCheck>> {
  const checks: Array<AreaCheck> = [];
  const healthz = await fetch(`${team.url}/healthz`).then(
    (r) => r.status,
    (e: unknown) => String(e),
  );
  checks.push({ name: "GET /healthz is 200", ok: healthz === 200, detail: String(healthz) });
  const as = await session(team);
  const listed = await as.tools();
  checks.push({ name: "MCP tools/list answers", ok: listed.length > 0, detail: `${listed.length} tools` });
  const outputs = (contract.$defs.McpTools?.properties ?? {}) as Record<string, unknown>;
  const known = listed.filter((t) => `${t.name}.output` in outputs);
  for (const t of listed.filter((t) => !known.includes(t))) checks.push({ name: `MCP ${t.name} is in McpTools.json`, ok: false, detail: "the contract has no such tool" });

  const decoded = (tool: string, answers: ReadonlyArray<Answer>) => {
    const ok = answers.filter((a) => !a.isError);
    if (ok.length === 0) return checks.push({ name: `MCP ${tool}`, ok: false, detail: JSON.stringify(answers[0]?.body) });
    const why = ok.map((a) => valid(tool, a.body)).find((w) => w !== undefined);
    checks.push({ name: `MCP ${tool} decodes as ${tool}.output`, ok: why === undefined, ...(why === undefined ? {} : { detail: why }) });
  };
  const seeded = await seed(team, as, known, "contract", 1);
  const done = new Set(seeded.map((s) => s.tool));
  for (const tool of done) decoded(tool, seeded.filter((s) => s.tool === tool).map((s) => s.answer));
  const read = await harvest(as, known, contract, READS);
  for (const tool of known.filter((t) => t.annotations?.readOnlyHint === true)) {
    done.add(tool.name);
    const answers = read.answers.filter((r) => r.tool === tool.name).map((r) => r.answer);
    if (answers.length === 0) checks.push({ name: `MCP ${tool.name}`, ok: true, skipped: "not called: none of the ids it needs turned up in the team's reads" });
    else decoded(tool.name, answers);
  }
  for (const tool of known.filter((t) => !done.has(t.name))) {
    const input = inputFrom(tool, read.bag);
    if (input === undefined) checks.push({ name: `MCP ${tool.name}`, ok: true, skipped: "not called: none of the ids it needs turned up in the team's reads" });
    else decoded(tool.name, [await as.call(tool.name, input)]);
  }
  return checks;
}
