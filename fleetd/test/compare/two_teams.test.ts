// The two-team cases (tests/compare/twoTeams.ts) proven where no service with two teams runs: against the stand-in
// (tests/compare/standIn.ts), which keeps its teams apart, and against the same stand-in leaking on purpose. Then held
// to the hub's real tool list: every tool that takes an id gets a case, and each case's input is one the hub's own
// decoder takes, so a case is never an input the hub would turn away at the door.
import { expect, test } from "bun:test";
import mcpToolsText from "../../../app/desktop/src/shared/contracts/schema/McpTools.json" with { type: "text" };
import { openSession, type Tool } from "../../../tests/compare/mcp.ts";
import { type Leak, Refusal, standIn, type StandInTool } from "../../../tests/compare/standIn.ts";
import { fromPattern, reportLines, runTwoTeams, twoTeamCases } from "../../../tests/compare/twoTeams.ts";
import { decodeInput } from "../../src/hub/api/decode.ts";
import { inputSchema } from "../../src/hub/mcp/endpoint.ts";

/** Two teams on a stand-in, A made first; the cases run with A's key against B's ids. */
async function run(opts: { leak?: Leak; tools?: ReadonlyArray<StandInTool> } = {}) {
  const target = await standIn(opts);
  try {
    const a = await target.team("");
    const b = await target.team("");
    const session = async (team: typeof a) => openSession(team.url, await team.key({ name: "cases", role: "admin" }));
    return await runTwoTeams({ a: await session(a), b: await session(b), contract: target.contract, canaries: [target.data(b).canary] });
  } finally {
    await target.close();
  }
}
const failed = (report: Awaited<ReturnType<typeof run>>) => report.cases.filter((c) => c.verdict === "fail");

test("a target that keeps its teams apart passes every case", async () => {
  const report = await run();
  expect(report.cases.map((c) => `${c.tool} (${c.ids}): ${c.verdict}`).sort()).toEqual([
    // A box number both teams have is no probe, but B's second box is: with B's thing, then each with A's own.
    "box_things (BoxId: A's, ThingId: B's): pass",
    "box_things (BoxId: B's, ThingId: A's): pass",
    "box_things (BoxId: B's, ThingId: B's): pass",
    "note_get (NoteName: B's): pass",
    // A name B uses is free in A: note_set makes A's own note of that name, as it does for a name nobody uses.
    "note_set (NoteName: B's): pass",
    "thing_get (ThingId: B's): pass",
    "thing_rename (ThingId: B's): pass",
  ]);
  expect(report.noIds).toEqual(["team_get", "boxes_list", "things_list", "notes_list"]);
  expect(report.unprobed).toEqual({});
  expect(report.shared).toEqual({ BoxId: ["B1"], NoteName: ["welcome"] });
  expect(report.reads).toBeGreaterThan(4);
  expect(reportLines(report)[0]).toBe("two-team cases: 7 over 5 of 9 tools: 7 pass, 0 FAIL, 0 weak (proved little: the unknown id itself was refused as invalid input, say)");
});

test("a tool that returns team B's row to team A fails its case", async () => {
  const fails = failed(await run({ leak: "row" }));
  expect(fails.map((c) => c.tool)).toContain("thing_get");
  expect(fails.find((c) => c.tool === "thing_get")?.detail).toContain("where an unknown id gets");
  // Nothing that never looks a thing up is blamed for it.
  expect(fails.map((c) => c.tool).filter((t) => t.startsWith("note"))).toEqual([]);
});

test("a tool that answers forbidden for team B's id, where an unknown one gets not_found, fails its case", async () => {
  const fails = failed(await run({ leak: "forbidden" }));
  expect(fails.find((c) => c.tool === "thing_get")?.detail).toBe('body.code is "forbidden" where an unknown id gets "not_found"; body.message is "Thing <ThingId> belongs to another team." where an unknown id gets "No thing <ThingId>."');
  expect(reportLines(await run({ leak: "forbidden" })).some((l) => l.startsWith("  FAIL thing_get (ThingId: B's): "))).toBe(true);
});

test("a list that holds team B's rows fails, though it takes no id", async () => {
  expect(failed(await run({ leak: "list" }))).toEqual([{ tool: "things_list", ids: "A's own", verdict: "fail", detail: "team A's own read holds team B's data (its canary)" }]);
});

test("a tool added to the list is covered with no case written for it", async () => {
  const peek = (leaks: boolean): StandInTool => ({
    name: "thing_peek",
    readOnly: true,
    input: { type: "object", properties: { thingId: { $ref: "#/$defs/ThingId" } }, required: ["thingId"] },
    output: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
    run: (team, input, all) => {
      const found = (leaks ? all : [team]).flatMap((t) => t.things).find((t) => t.thingId === input.thingId);
      if (found === undefined) throw new Refusal("not_found", `No thing ${input.thingId}.`);
      return { title: found.title };
    },
  });
  const honest = await run({ tools: [peek(false)] });
  expect(honest.cases.filter((c) => c.tool === "thing_peek")).toEqual([{ tool: "thing_peek", ids: "ThingId: B's", verdict: "pass" }]);
  expect(failed(honest)).toEqual([]);
  expect(failed(await run({ tools: [peek(true)] })).map((c) => c.tool)).toEqual(["thing_peek"]);
});

test("a clock in the answer is not a difference, whichever call it ticks on", async () => {
  // Answers any id alike, with a clock that ticks on every second call: between the first two of a case, or the last two.
  const seen = (calls: number): StandInTool => ({
    name: "thing_seen",
    readOnly: false,
    input: { type: "object", properties: { thingId: { $ref: "#/$defs/ThingId" } }, required: ["thingId"] },
    output: { type: "object", properties: { at: { type: "integer" } }, required: ["at"] },
    run: () => ({ at: Math.floor(calls++ / 2) }),
  });
  for (const start of [0, 1]) {
    const report = await run({ tools: [seen(start)] });
    expect(report.cases.filter((c) => c.tool === "thing_seen")).toEqual([{ tool: "thing_seen", ids: "ThingId: B's", verdict: "pass" }]);
  }
});

test("a number team A comes to count up to itself is no longer team B's id", async () => {
  // Each team numbers its boxes from B1. box_add gives the caller its next one, so by box_peek team A has its own B2.
  const add: StandInTool = {
    name: "box_add",
    readOnly: false,
    input: { type: "object", properties: { label: { $ref: "#/$defs/NoteName" } }, required: ["label"] },
    output: { type: "object", properties: { boxRef: { $ref: "#/$defs/BoxRef" } }, required: ["boxRef"] },
    run: (team) => {
      team.boxes.push(`B${team.boxes.length + 1}`);
      return { boxRef: { boxId: team.boxes.at(-1) } };
    },
  };
  const peek: StandInTool = {
    name: "box_peek",
    readOnly: true,
    input: { type: "object", properties: { boxId: { $ref: "#/$defs/BoxId" } }, required: ["boxId"] },
    output: { type: "object", properties: { things: { type: "integer" } }, required: ["things"] },
    run: (team, input) => {
      if (!team.boxes.includes(input.boxId)) throw new Refusal("not_found", `No box ${input.boxId}.`);
      return { things: team.things.filter((t) => t.boxId === input.boxId).length };
    },
  };
  const report = await run({ tools: [add, peek] });
  expect(report.cases.filter((c) => c.tool === "box_peek")).toEqual([{ tool: "box_peek", ids: "BoxId: B's", verdict: "weak", detail: "team A came to hold the same BoxId itself during the run" }]);
  expect(failed(report)).toEqual([]);
});

const doc = JSON.parse(mcpToolsText) as { $defs: Record<string, any> };
const names = Object.keys(doc.$defs.McpTools.properties).filter((k) => k.endsWith(".input")).map((k) => k.slice(0, -".input".length));
const hubTools: Array<Tool> = names.map((name) => ({ name, inputSchema: inputSchema(doc, name) }));

test("every hub tool whose input can hold an id gets a case, and each case's input decodes", () => {
  const cases = twoTeamCases(hubTools);
  const covered = new Set(cases.map((c) => c.tool));
  // A tool's input can hold an id when one of the types it uses, however deep, is an …Id that is any string of a form
  // (SetupStepId is a list of step names).
  const takesId = hubTools.filter((t) => Object.entries<any>(t.inputSchema.$defs ?? {}).some(([type, def]) => type.endsWith("Id") && def.type === "string" && def.enum === undefined));
  expect(takesId.length).toBeGreaterThan(150);
  expect(takesId.map((t) => t.name).filter((n) => !covered.has(n))).toEqual([]);
  const refused: Array<string> = [];
  for (const c of cases) {
    try {
      decodeInput(c.tool, c.sample);
    } catch (e) {
      refused.push(`${c.tool}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  expect(refused).toEqual([]);
});

test("a hub tool added to the list gets its cases from its schema alone", () => {
  const added: Tool = {
    name: "task_frobnicate",
    inputSchema: { type: "object", properties: { taskId: { $ref: "#/$defs/TaskId" }, projectRef: { $ref: "#/$defs/ProjectRef" }, note: { type: "string" } }, required: ["taskId", "note"], $defs: doc.$defs },
  };
  expect(twoTeamCases([...hubTools, added]).filter((c) => c.tool === "task_frobnicate").map((c) => c.theirs)).toEqual([["TaskId", "MachineId", "ProjectId"], ["TaskId"], ["MachineId"], ["ProjectId"]]);
});

test("an id nobody holds is made from the id's own pattern", () => {
  for (const [type, def] of Object.entries(doc.$defs)) {
    if (typeof def.pattern !== "string") continue;
    const pattern = new RegExp(def.pattern, "u");
    expect([type, fromPattern(def.pattern) !== undefined && pattern.test(fromPattern(def.pattern)!)]).toEqual([type, true]);
    expect([type, pattern.test(fromPattern(def.pattern, true)!)]).toEqual([type, true]);
  }
  expect(fromPattern("^T[1-9][0-9]*$", true)).not.toBe(fromPattern("^T[1-9][0-9]*$", true));
});
