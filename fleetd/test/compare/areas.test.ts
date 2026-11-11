// `--areas` (tests/compare/areas.ts) proven on a stand-in that lists only the decisions tools, with McpTools.json's own
// schemas, as a service that serves some areas lists only theirs: the two-team cases are made of exactly those tools,
// seeded through them and the target's own hook, and catch a search that leaks; the contract's output check runs on
// exactly the listed tools and fails one the contract lacks and an answer that doesn't decode.
import { expect, test } from "bun:test";
import mcpToolsText from "../../../app/desktop/src/shared/contracts/schema/McpTools.json" with { type: "text" };
import { areasContract, areasTwoTeams } from "../../../tests/compare/areas.ts";
import { Refusal, standIn, type StandInTeam, type StandInTool } from "../../../tests/compare/standIn.ts";
import type { Team } from "../../../tests/compare/target.ts";
import { reportLines } from "../../../tests/compare/twoTeams.ts";

const doc = JSON.parse(mcpToolsText) as { $defs: Record<string, any> };
const input = (type: string) => ({ ...doc.$defs[type], $defs: doc.$defs });

/** decisions_record and decisions_search over each team's own decisions, numbered per team (D1 in each). */
function decisionTools(opts: { searchLeaks?: boolean; badRecord?: boolean } = {}): Array<StandInTool> {
  const kept = new Map<StandInTeam, Array<Record<string, unknown>>>();
  const of = (team: StandInTeam) => kept.get(team) ?? (kept.set(team, []), kept.get(team)!);
  return [
    {
      name: "decisions_record",
      readOnly: false,
      input: input("DecisionsRecordInput"),
      output: {},
      run: (team, given) => {
        if (given.scope?.kind !== "global") throw new Refusal("not_found", "No such project.");
        const decision = { decisionId: `D${of(team).length + 1}`, key: given.key, scope: given.scope, value: given.value, why: given.why, source: "human", state: "active", at: "2026-01-01T00:00:00.000Z" };
        of(team).push(decision);
        return opts.badRecord === true ? { made: decision } : { decision };
      },
    },
    {
      name: "decisions_search",
      readOnly: true,
      input: input("DecisionsSearchInput"),
      output: {},
      run: (team, given, all) => ({ decisions: (opts.searchLeaks === true ? all : [team]).flatMap(of).filter((d) => String(d.value).includes(given.query)) }),
    },
  ];
}

/** Says what an answer lacks of its `<tool>.output`'s required properties: enough to show which answers are checked. */
const required = (tool: string, body: unknown) => {
  const ref = doc.$defs.McpTools.properties[`${tool}.output`]?.$ref as string | undefined;
  if (ref === undefined) return "no schema";
  const missing = ((doc.$defs[ref.split("/").at(-1)!].required ?? []) as Array<string>).filter((k) => typeof body !== "object" || body === null || !(k in body));
  return missing.length === 0 ? undefined : `lacks ${missing.join(", ")}`;
};

async function twoTeams(tools: Array<StandInTool>, hook?: Array<string>) {
  const target = await standIn({ only: tools });
  const seeding = (team: Team): Team => (hook === undefined ? team : { ...team, seed: async (mark, times) => void hook.push(`${mark} ×${times}`) });
  const made = { ...target, team: async (dir: string) => seeding(await target.team(dir)) };
  try {
    return await areasTwoTeams(made, await made.team(""), doc, "canary-areas", "");
  } finally {
    await target.close();
  }
}

test("on a target that lists only the decisions tools, the cases are those tools', seeded through them", async () => {
  const hook: Array<string> = [];
  const report = await twoTeams(decisionTools(), hook);
  expect(report.tools).toBe(2);
  // Team B's second decision's key is one team A lacks, asked under each scope that holds an id: no project or
  // workstream exists, so each is refused as an unknown key's is.
  expect(report.cases).toEqual([
    { tool: "decisions_record", ids: "DecisionKey: B's, MachineId: made up, ProjectId: made up", verdict: "pass" },
    { tool: "decisions_record", ids: "DecisionKey: B's, WorkstreamId: made up", verdict: "pass" },
  ]);
  expect(report.reads).toBeGreaterThan(0);
  expect(report.shared).toEqual({ DecisionId: ["D1"], DecisionKey: ["isolation.seed-1"] });
  // Team A once with its own mark, team B twice with the canary, beside the tool seeds.
  expect(hook).toEqual(["team A's ×1", "canary-areas ×2"]);
});

test("a search that returns another team's decisions fails, though it takes no id", async () => {
  const report = await twoTeams(decisionTools({ searchLeaks: true }));
  expect(report.cases.filter((c) => c.verdict === "fail")).toEqual([{ tool: "decisions_search", ids: "A's own", verdict: "fail", detail: "team A's own read holds team B's data: a DecisionId, a DecisionKey, its canary" }]);
  expect(reportLines(report)[0]).toContain("1 FAIL");
});

test("the contract checks exactly the listed tools' answers", async () => {
  const run = async (tools: Array<StandInTool>) => {
    const target = await standIn({ only: tools });
    try {
      return (await areasContract(await target.team(""), doc, required)).map((c) => `${c.skipped !== undefined ? "skip" : c.ok ? "pass" : "FAIL"} ${c.name}${c.ok ? "" : `: ${c.detail}`}`);
    } finally {
      await target.close();
    }
  };
  expect(await run(decisionTools())).toEqual([
    "pass GET /healthz is 200",
    "pass MCP tools/list answers",
    "pass MCP decisions_record decodes as decisions_record.output",
    "pass MCP decisions_search decodes as decisions_search.output",
  ]);

  const frob: StandInTool = { name: "decisions_frob", readOnly: true, input: { type: "object", properties: {} }, output: {}, run: () => ({}) };
  expect(await run([...decisionTools({ badRecord: true }), frob])).toEqual([
    "pass GET /healthz is 200",
    "pass MCP tools/list answers",
    "FAIL MCP decisions_frob is in McpTools.json: the contract has no such tool",
    "FAIL MCP decisions_record decodes as decisions_record.output: lacks decision",
    "pass MCP decisions_search decodes as decisions_search.output",
  ]);
});
