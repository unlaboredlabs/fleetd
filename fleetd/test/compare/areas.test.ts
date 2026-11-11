// `--areas` (tests/compare/areas.ts) proven on a stand-in that lists only the decisions tools, with McpTools.json's own
// schemas, as a service that serves some areas lists only theirs: the two-team cases are made of exactly those tools,
// seeded through them and the target's own hook, and catch a search that leaks; the contract's output check runs on
// exactly the listed tools and fails one the contract lacks and an answer that doesn't decode. And on one that lists
// only the people tools: the contract calls each, and the ones that take away run last on what the run made.
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

/**
 * The people tools over one owner, as the hub keeps them: every key the team hands out is a device of its owner (`mint`),
 * and a revoked one is refused; a new person needs a name; the only owner is never removed; a removed person is
 * unknown to person_set; revoking an invite takes its person, who never joined, with it. The writes that take
 * something away are listed before person_set, as a list may have them.
 */
function peopleTools() {
  const at = "2026-01-01T00:00:00.000Z";
  let made = 0;
  const id = (prefix: string) => `${prefix}_${String(++made).padStart(8, "a").replace(/\d/gu, (d) => "abcdefghij"[Number(d)]!)}`;
  const owner: Record<string, any> = { personId: id("p"), name: "owner", role: "owner", createdAt: at };
  const people = [owner];
  const devices = new Map<string, { keyId: string; revoked: boolean }>();
  const invites: Array<Record<string, any>> = [];
  const refOf = (p: Record<string, any>) => ({ personId: p.personId, name: p.name });
  const mint = (key: string) => devices.set(key, { keyId: id("key"), revoked: false });
  const info = (keyId: string) => ({ keyId, name: "areas", prefix: "fld_aaaaaa", grants: [{ machines: "*", role: "admin" }], createdAt: at, kind: "human", person: refOf(owner) });
  const person = (personId: string) => {
    const found = people.find((p) => p.personId === personId && p.removedAt === undefined);
    if (found === undefined) throw new Refusal("not_found", `No person ${personId}.`);
    return found;
  };
  const tool = (name: string, readOnly: boolean, type: string, run: (given: any, key: string) => unknown): StandInTool => ({
    name,
    readOnly,
    input: input(`${type}Input`),
    output: {},
    run: (_team, given, _all, key) => {
      if (devices.get(key)?.revoked !== false) throw new Refusal("forbidden", "This key was revoked.");
      return run(given, key);
    },
  });
  const tools = [
    tool("people_list", true, "PeopleList", (_given, key) => ({
      people,
      devices: [...devices.values()].filter((d) => !d.revoked).map((d) => info(d.keyId)),
      invites: invites.filter((i) => i.state === "open"),
      me: owner.personId,
      thisDevice: devices.get(key)!.keyId,
    })),
    tool("invite_create", false, "InviteCreate", (given) => {
      if (given.name === undefined) throw new Refusal("invalid", "A new person needs a name.");
      const invited = { personId: id("p"), name: given.name, role: given.role ?? "member", createdAt: at };
      people.push(invited);
      const invite = { inviteId: id("inv"), createdBy: refOf(owner), person: refOf(invited), state: "open", createdAt: at, expiresAt: at };
      invites.push(invite);
      return { invite, code: "ABCD-EFGH", link: "fleetd://pair", hubUrl: "http://127.0.0.1" };
    }),
    tool("device_revoke", false, "DeviceRevoke", (given) => {
      const device = [...devices.values()].find((d) => d.keyId === given.keyId && !d.revoked);
      if (device === undefined) throw new Refusal("not_found", `No device ${given.keyId}.`);
      device.revoked = true;
      return { device: info(device.keyId) };
    }),
    tool("person_remove", false, "PersonRemove", (given) => {
      const removed = person(given.personId);
      if (removed.role === "owner") throw new Refusal("invalid", `${removed.name} is the hub's only owner.`);
      removed.removedAt = at;
      for (const i of invites.filter((i) => i.person.personId === removed.personId && i.state === "open")) i.state = "revoked";
      return { person: removed, revoked: 0 };
    }),
    tool("invite_revoke", false, "InviteRevoke", (given) => {
      const invite = invites.find((i) => i.inviteId === given.inviteId);
      if (invite === undefined) throw new Refusal("not_found", `No invite ${given.inviteId}.`);
      if (invite.state === "open") {
        invite.state = "revoked";
        person(invite.person.personId).removedAt = at;
      }
      return { invite };
    }),
    tool("person_set", false, "PersonSet", (given) => ({ person: Object.assign(person(given.personId), given.name === undefined ? {} : { name: given.name }) })),
  ];
  return { tools, mint };
}

test("the people tools: a new person is seeded, and what takes away runs last on what the run made, never the caller", async () => {
  const { tools, mint } = peopleTools();
  const target = await standIn({ only: tools });
  try {
    const team = await target.team("");
    const minting: Team = { ...team, key: async (opts) => ((key) => (mint(key), key))(await team.key(opts)) };
    const checks = await areasContract(minting, doc, required);
    expect(checks.map((c) => `${c.ok ? "pass" : "FAIL"} ${c.name}${c.ok ? "" : `: ${c.detail}`}`)).toEqual([
      "pass GET /healthz is 200",
      "pass MCP tools/list answers",
      "pass MCP invite_create decodes as invite_create.output",
      "pass MCP people_list decodes as people_list.output",
      "pass MCP person_set decodes as person_set.output",
      "pass MCP person_remove decodes as person_remove.output",
      "pass MCP invite_revoke decodes as invite_revoke.output",
      "pass MCP device_revoke decodes as device_revoke.output",
    ]);
  } finally {
    await target.close();
  }
});
