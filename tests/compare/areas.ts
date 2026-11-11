// `--areas`: the suite on a target that serves some areas of the hub, not all of it (a service built a module at a
// time), and joins no machine. No node joins and no project is added: a team is seeded through the tools the target
// lists (SEEDS) and the target's own `seed` (target.ts) for what no listed tool makes, and every check is made of
// exactly the tools it lists. isolation.ts runs the two-team cases this way, contract.ts the output-schema check.
// Imports nothing but ./mcp.ts and ./twoTeams.ts: fleetd's own tests run it against the stand-in (standIn.ts).
import path from "node:path";
import { type Answer, openSession, type Session, type Tool } from "./mcp.ts";
import type { Target, Team } from "./target.ts";
import { type Contract, harvest, type Ids, idsIn, inputFrom, type Reads, readIds, type Report, runTwoTeams } from "./twoTeams.ts";

/** A 1×1 PNG: a file the hub keeps, and a picture it crops. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
/** The repo the seeded work is claimed on: no project holds it, and both teams claim on it. */
const REPO = "https://github.com/example/areas";

/**
 * The writes that seed a team, made when the target lists their tool: the `n`th of each, `mark` in every text, given
 * the ids the seeds before it made (undefined: not made, for want of them). Each is a write the hub refuses with only
 * its required fields, or makes something a read has nothing to show without.
 */
const SEEDS: ReadonlyArray<readonly [tool: string, input: (mark: string, n: number, made: Ids) => unknown]> = [
  // Global: with no node there is no project to scope it to.
  ["decisions_record", (mark, n) => ({ key: `isolation.seed-${n}`, value: `${mark} decision ${n}`, why: mark, scope: { kind: "global" } })],
  // A person and their invite: a new person needs a name.
  ["invite_create", (mark, n) => ({ name: `${mark} person ${n}`, role: "member" })],
  // A file, and the caller's picture made of it (which takes the file): person_avatar_get has nothing to answer until
  // one is set.
  ["attachment_put", (mark, n) => ({ name: `${mark} ${n}.png`, mime: "image/png", dataB64: PNG })],
  ["attachment_part", () => ({ dataB64: PNG })],
  ["person_avatar_set", (_mark, _n, made) => (made.has("AttachmentId") ? { attachmentId: made.get("AttachmentId")!.at(-1) } : undefined)],
  // The caller's own name: a write a read key may make, so listed as read-only, and it needs the name.
  ["person_name_set", (mark, n) => ({ name: `${mark} name ${n}` })],
  // The hub-wide text of a prompt: saving needs the text.
  ["prompt_set", (mark, n) => ({ id: "lead.voice", scope: "global", text: `${mark} voice ${n}` })],
  // A claim, on a repo rather than a project: it names one or the other.
  ["work_claim", (mark, n) => ({ title: `${mark} work ${n}`, repo: REPO })],
  // The team's cap on agents at once: setting nothing is refused.
  ["cap_set", (_mark, n) => ({ cap: 10 + n })],
];

/**
 * The writes that take away what other calls need, called after every other write and in this order: a person
 * (person_remove), an invite and the person it brought who never joined (invite_revoke), a device (device_revoke). Each
 * is given only ids the run made, never one the team held before it seeded (the caller, the device it calls from): the
 * person and invite a seed invited, and a spare device of the caller's, made for device_revoke.
 */
const LAST = ["person_remove", "invite_revoke", "device_revoke"];

/** Reads that take words, not only ids: every seeded decision's text holds "decision", and the work is on REPO. */
export const READS: Reads = [
  ["decisions_search", { query: "decision" }],
  ["work_list", { repo: REPO }],
];

export const session = async (team: Team): Promise<Session> => openSession(team.url, await team.key({ name: "areas", role: "admin", human: true }));

/** Seeds a team `times` over, `mark` in every text: SEEDS through the tools `listed` holds, then the target's own. */
export async function seed(team: Team, as: Session, listed: ReadonlyArray<Tool>, contract: Contract, mark: string, times: number): Promise<Array<{ tool: string; answer: Answer }>> {
  const made: Array<{ tool: string; answer: Answer }> = [];
  for (let n = 1; n <= times; n++) {
    for (const [tool, input] of SEEDS.filter(([tool]) => listed.some((t) => t.name === tool))) {
      const given = input(mark, n, idsIn(made, contract));
      if (given === undefined) continue;
      const answer = await as.call(tool, given);
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
  await seed(teamA, a, listed, contract, "team A's", 1);
  const own = await readIds(a, contract, READS);
  const teamB = await target.team(path.join(dir, "b"));
  const b = await session(teamB);
  await seed(teamB, b, listed, contract, canary, 2);
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
 * the other writes with the team's own ids, as one may retire what was read, then LAST's on what the run made.
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
  const before = await readIds(as, contract, READS);
  const seeded = await seed(team, as, known, contract, "contract", 1);
  if (known.some((t) => t.name === "device_revoke")) await team.key({ name: "areas-spare", role: "admin", human: true });
  const done = new Set(seeded.map((s) => s.tool));
  for (const tool of done) decoded(tool, seeded.filter((s) => s.tool === tool).map((s) => s.answer));
  // A tool a seed calls is a write, read-only as it may be listed (a picture is set with a read key): called among the
  // reads, with nothing, it would undo its seed.
  const read = await harvest(as, known.filter((t) => !done.has(t.name)), contract, READS, idsIn(seeded, contract));
  for (const tool of known.filter((t) => t.annotations?.readOnlyHint === true && !done.has(t.name))) {
    done.add(tool.name);
    const answers = read.answers.filter((r) => r.tool === tool.name).map((r) => r.answer);
    if (answers.length === 0) checks.push({ name: `MCP ${tool.name}`, ok: true, skipped: "not called: none of the ids it needs turned up in the team's reads" });
    else decoded(tool.name, answers);
  }
  for (const tool of known.filter((t) => !done.has(t.name) && !LAST.includes(t.name))) {
    const input = inputFrom(tool, read.bag);
    if (input === undefined) checks.push({ name: `MCP ${tool.name}`, ok: true, skipped: "not called: none of the ids it needs turned up in the team's reads" });
    else decoded(tool.name, [await as.call(tool.name, input)]);
  }
  const made = new Map([...read.bag].map(([kind, ids]) => [kind, ids.filter((id) => !before.get(kind)?.includes(id))] as const).filter(([, ids]) => ids.length > 0));
  for (const tool of LAST.flatMap((name) => known.filter((t) => t.name === name))) {
    const input = inputFrom(tool, made);
    if (input === undefined) checks.push({ name: `MCP ${tool.name}`, ok: false, detail: "not called: the run made nothing for it to take away (the seed that would is not listed)" });
    else decoded(tool.name, [await as.call(tool.name, input)]);
  }
  return checks;
}
