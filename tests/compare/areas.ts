// `--areas`: the suite on a target that serves some areas of the hub, not all of it (a service built a module at a
// time), and joins no machine. No node joins and no project is added: a team is seeded through the tools the target
// lists (SEEDS) and the target's own `seed` (target.ts) for what no listed tool makes, and every check is made of
// exactly the tools it lists. isolation.ts runs the two-team cases this way, contract.ts the output-schema check.
// Imports nothing but ./mcp.ts and ./twoTeams.ts, and fleetd's sealed boxes when a seed needs them: fleetd's own tests
// run it against the stand-in (standIn.ts).
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Answer, openSession, type Session, type Tool } from "./mcp.ts";
import type { Target, Team } from "./target.ts";
import { type Contract, harvest, type Ids, idsIn, inputFrom, type Reads, readIds, type Report, runTwoTeams } from "./twoTeams.ts";

/** A 1×1 PNG: a file the hub keeps, and a picture it crops. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
/** The repo the seeded work is claimed on: no project holds it, and both teams claim on it. */
const REPO = "https://github.com/example/areas";

/** What a seed's input is made from besides its mark: the ids the seeds before it made, and the session it is made on. */
interface Seeding {
  readonly made: Ids;
  readonly as: Session;
}

/**
 * fleetd's `crypto_box_seal`: from this checkout, else from the fleetd package installed in a node_modules directory
 * above a copy of tests/compare (a service's suite runs such a copy, with the pinned package, which exports it; a copy
 * in the system's temp directory reaches no package). Node strips no types under node_modules, so the package's file
 * is read, stripped and loaded as it is: it imports nothing but node:crypto.
 */
const sealing = async (): Promise<(publicKey: Uint8Array, plain: Uint8Array) => Uint8Array> => {
  type Core = { seal: (publicKey: Uint8Array, plain: Uint8Array) => Uint8Array };
  const here = "../../fleetd/src/shared/sealed_box_core.ts";
  try {
    return ((await import(here)) as Core).seal;
  } catch (inCheckout) {
    try {
      // Node's own, imported here: only Node runs a copy, and Bun, which runs this checkout, lacks it.
      const { stripTypeScriptTypes } = (await import("node:module")) as unknown as { stripTypeScriptTypes: (code: string) => string };
      const file = fileURLToPath(import.meta.resolve("fleetd/shared/sealed_box_core"));
      const js = stripTypeScriptTypes(fs.readFileSync(file, "utf8"));
      return ((await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`)) as Core).seal;
    } catch (packaged) {
      throw new Error(`fleetd's sealed box is in neither this checkout (${String(inCheckout)}) nor an installed fleetd package (${String(packaged)})`);
    }
  }
};

/** `fields` as JSON sealed to the hub's box key (vault_status's hubBoxKey), in base64; undefined when it isn't read. */
async function sealedToHub(as: Session, fields: unknown): Promise<string | undefined> {
  const status = await as.call("vault_status", {});
  const key = (status.body as { hubBoxKey?: unknown } | null)?.hubBoxKey;
  if (status.isError || typeof key !== "string") return undefined;
  const seal = await sealing();
  return Buffer.from(seal(new Uint8Array(Buffer.from(key, "base64")), new TextEncoder().encode(JSON.stringify(fields)))).toString("base64");
}

/**
 * The writes that seed a team, made when the target lists their tool: the `n`th of each, `mark` in every text
 * (undefined: not made, for want of what it needs). Each is a write the hub refuses with only its required fields, or
 * makes something a read has nothing to show without. `needs`: tools it can't be made without, which the target must
 * list too; when it doesn't, the tool isn't called at all, and says so.
 */
const SEEDS: ReadonlyArray<readonly [tool: string, input: (mark: string, n: number, seeding: Seeding) => unknown, needs?: ReadonlyArray<string>]> = [
  // Global: with no node there is no project to scope it to.
  ["decisions_record", (mark, n) => ({ key: `isolation.seed-${n}`, value: `${mark} decision ${n}`, why: mark, scope: { kind: "global" } })],
  // A person and their invite: a new person needs a name.
  ["invite_create", (mark, n) => ({ name: `${mark} person ${n}`, role: "member" })],
  // A file, and the caller's picture made of another, put for it alone: setting a picture takes its file, which
  // attachment_get would then not find, and person_avatar_get has nothing to answer until one is set. The picture's
  // file is put when attachment_put is listed (a seed of it made a file).
  ["attachment_put", (mark, n) => ({ name: `${mark} ${n}.png`, mime: "image/png", dataB64: PNG })],
  ["attachment_part", () => ({ dataB64: PNG })],
  [
    "person_avatar_set",
    async (mark, n, { made, as }) => {
      if (!made.has("AttachmentId")) return undefined;
      const own = await as.call("attachment_put", { name: `${mark} picture ${n}.png`, mime: "image/png", dataB64: PNG });
      const attachmentId = (own.body as { attachmentId?: unknown } | null)?.attachmentId;
      if (own.isError || typeof attachmentId !== "string") throw new Error(`attachment_put, for the picture: ${JSON.stringify(own.body)}`);
      return { attachmentId };
    },
  ],
  // The caller's own name: a write a read key may make, so listed as read-only, and it needs the name.
  ["person_name_set", (mark, n) => ({ name: `${mark} name ${n}` })],
  // The caller's pins, chat sections and sidebar order, each a whole list that replaces the last: writes a read key
  // may make, listed as read-only, which take only their list (empty: the run's chats are none of them).
  ["chat_pins_set", () => ({ pins: [] })],
  ["chat_sections_set", () => ({ sections: [] })],
  ["sidebar_order_set", () => ({ order: [] })],
  // The hub-wide text of a prompt: saving needs the text.
  ["prompt_set", (mark, n) => ({ id: "lead.voice", scope: "global", text: `${mark} voice ${n}` })],
  // A claim, on a repo rather than a project: it names one or the other.
  ["work_claim", (mark, n) => ({ title: `${mark} work ${n}`, repo: REPO })],
  // The team's cap on agents at once: setting nothing is refused.
  ["cap_set", (_mark, n) => ({ cap: 10 + n })],
  // A profile of the run's own, on a model the hub offers (profiles_list names them: a made-up model is refused), named
  // after the mark as a profile name may be.
  [
    "profile_create",
    async (mark, n, { as }) => {
      const list = await as.call("profiles_list", {});
      const model = (list.body as { models?: Array<{ id?: unknown }> } | null)?.models?.[0]?.id;
      const name = `${mark.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 24) || "areas"}-${n}`;
      return list.isError || typeof model !== "string" ? undefined : { name, note: `${mark} profile ${n}`, model, effort: "high" };
    },
    ["profiles_list"],
  ],
  // A value sealed to the hub's key, which vault_status gives: an env item in the caller's vault (an env item's label is
  // its name, so the mark is in its value, which only a reveal shows), and the vault's unlock (any passphrase opens one
  // that has none).
  [
    "vault_save",
    async (mark, n, { as }) => {
      const sealed = await sealedToHub(as, { value: `${mark} value ${n}` });
      return sealed === undefined ? undefined : { kind: "env", scope: "person", envName: `AREAS_SEED_${n}`, sealed };
    },
    ["vault_status"],
  ],
  [
    "vault_unlock",
    async (mark, _n, { as }) => {
      const sealed = await sealedToHub(as, { passphrase: mark });
      return sealed === undefined ? undefined : { sealed };
    },
    ["vault_status"],
  ],
  // A phone, after pushes are turned off (an empty relay URL), and only then: nothing the run makes may reach a real
  // relay. Its key is any 32 bytes, as an X25519 public key is.
  ["push_relay_set", () => ({ url: "" })],
  ["push_device_register", (mark, n) => ({ platform: "ios", token: `areas-${n}`, name: `${mark} phone ${n}`, publicKey: randomBytes(32).toString("base64") }), ["push_relay_set"]],
];

/** The tools whose seed `listed` can't make, with what it lacks: never called with a made-up input in its stead. */
const unseedable = (listed: ReadonlyArray<Tool>) =>
  new Map(
    SEEDS.filter(([tool]) => listed.some((t) => t.name === tool)).flatMap(([tool, , needs]) => {
      const lacks = (needs ?? []).filter((need) => !listed.some((t) => t.name === need));
      return lacks.length === 0 ? [] : [[tool, lacks] as const];
    }),
  );

/**
 * The writes that take away what other calls need, called after every other write and in this order: an automation
 * (automation_delete), a phone (push_device_remove), a profile (profile_delete), a project and all it holds, its
 * decisions among them (project_remove), a person (person_remove), an invite and the person it brought who never
 * joined (invite_revoke), a device (device_revoke), and last of all a machine and all it holds, its projects among them
 * (machine_remove). Each is given only what the run made, never what the team held before it seeded (the caller, the
 * device it calls from, the default profile): what the target seeded (the automation, the project, its machine), the
 * phone, the profile and the person and invite the seeds made, and a spare device of the caller's, made for
 * device_revoke.
 */
const LAST = ["automation_delete", "push_device_remove", "profile_delete", "project_remove", "person_remove", "invite_revoke", "device_revoke", "machine_remove"];

/**
 * LAST's writes whose id is a number, which no read hands the suite as an id: each takes what a seed made from that
 * seed's answer. profile_delete deletes the profile the profile_create seed made, never the hub's default.
 */
const FROM_SEEDS: Readonly<Record<string, (seeded: ReadonlyArray<{ tool: string; answer: Answer }>) => unknown>> = {
  profile_delete: (seeded) => {
    const id = seeded.filter((s) => s.tool === "profile_create").map((s) => (s.answer.body as { profile?: { id?: unknown } } | null)?.profile?.id).find((id) => typeof id === "number");
    return id === undefined ? undefined : { id };
  },
};

/**
 * Writes whose work is done on a machine, which no node is here to do, so `machine_offline` is a meaningful answer (and
 * for a secret sealed to machines, the hub's failed "No machine took it."): the ones below, each called on the machine
 * (and project) the team's reads turn up with what else it needs, project_remove (LAST), which the hub refuses so
 * while the project's machine is known and offline, and machine_screens_set, which its node takes. A target's seed
 * puts its project on such a machine: one that joined once and is offline now. With no machine to name they aren't
 * called.
 */
const OFFLINE_ANSWERS = ["project_add", "project_repo_add", "project_remove", "claude_subscription_set", "onepassword_set", "machine_screens_set"];

/** A person's secret sealed for the machine the reads turn up, as a real box (to a key of the run's own: no machine opens it). */
const sealedForMachine = async (ids: Ids, secret: string) => {
  if (!ids.has("MachineId")) return undefined;
  const seal = await sealing();
  const sealed = Buffer.from(seal(new Uint8Array(randomBytes(32)), new TextEncoder().encode(secret))).toString("base64");
  return { sealed: [{ machineId: ids.get("MachineId")![0], sealed }] };
};
const ON_MACHINE: ReadonlyArray<readonly [tool: string, input: (ids: Ids, tool: Tool) => unknown]> = [
  ["project_add", (ids) => (ids.has("MachineId") ? { machineId: ids.get("MachineId")![0], path: "/srv/areas/added" } : undefined)],
  ["project_repo_add", (ids, tool) => ((input) => (input === undefined ? undefined : { ...(input as object), path: "/srv/areas/repo" }))(inputFrom(tool, ids))],
  // The caller's Claude token and 1Password service account token, each kept only by a machine online that takes it.
  ["claude_subscription_set", (ids) => sealedForMachine(ids, "areas-claude-token")],
  ["onepassword_set", (ids) => sealedForMachine(ids, "areas-1password-token")],
];

/** Tools a run with no machine and one hub can't call at all, by why (reads among them). */
const NOT_HERE: Readonly<Record<string, string>> = {
  claude_hub_api_set: "not called: it seals the key to each machine, which takes it only while online, and no node joins",
  hub_link_add: "not called: the other hub must answer a hello before the link is kept, and the run has no second hub to link to",
  claude_account_test:
    "not called: a machine holding the account tests it, and no node joins, so no machine holds one (claude_hub_api_set and claude_subscription_set keep a secret only on a machine online)",
  onepassword_test: "not called: a machine holding the 1Password token tests it, and no node joins, so no machine holds one",
  onepassword_cards: "not called: a machine holding the 1Password token lists them, and no node joins, so no machine holds one",
  vault_import: "not called: a machine holding the person's 1Password token reads 1Password, and no node joins, so no machine holds one",
  screen_open: "not called: it needs a node that hosts screens, and no node joins",
  screen_end: "not called: it ends a person's screen, which only screen_open on a node makes",
  pr_get: "not called: it reads a pull request from GitHub, which a run doesn't reach",
  pr_files: "not called: it reads a pull request from GitHub, which a run doesn't reach",
  pr_diff: "not called: it reads a pull request from GitHub, which a run doesn't reach",
  skill_update: "not called: it fetches from outside, and only a skill installed from outside, which no run can install, has a source to fetch",
};

/**
 * Writes that fetch from outside, which a run never reaches: each is called well-formed on a source at a host that
 * never resolves (.invalid), and its refusal of the fetch, `failed` or `invalid`, is its answer.
 */
const OUTSIDE: Readonly<Record<string, unknown>> = {
  skill_install: { scope: "global", source: "https://areas.invalid/skills.git" },
};

/**
 * Writes that take more than ids, which made-up text can't stand in for: each is given the ids the team's reads turn
 * up (the seeds' first) and the rest here. vault_reveal reveals the vault_save seed's env item, whose only field is
 * `value`, sealed to a reply key: any 32 bytes, as an X25519 public key is.
 */
const BESIDE_IDS: Readonly<Record<string, () => Record<string, unknown>>> = {
  vault_reveal: () => ({ fields: ["value"], replyKey: randomBytes(32).toString("base64") }),
};

/**
 * Reads that take more than ids, `now` the run's clock: every seeded decision's text holds "decision", the work is on
 * REPO, and the time reads and the metrics cover the day before `now`.
 */
export const reads = (now: number): Reads => {
  const since = new Date(now - 86_400_000).toISOString();
  return [
    ["decisions_search", { query: "decision" }],
    ["work_list", { repo: REPO }],
    ["time_spans", { scope: { kind: "fleet" }, since }],
    ["time_breakdown", { scope: { kind: "fleet" }, since }],
    ["time_insights", { scope: { kind: "fleet" }, since }],
    ["metrics_get", { since, tz: "UTC" }],
  ];
};

export const session = async (team: Team): Promise<Session> => openSession(team.url, await team.key({ name: "areas", role: "admin", human: true }));

/** Seeds a team `times` over, `mark` in every text: SEEDS through the tools `listed` holds, then the target's own. */
export async function seed(team: Team, as: Session, listed: ReadonlyArray<Tool>, contract: Contract, mark: string, times: number): Promise<Array<{ tool: string; answer: Answer }>> {
  const made: Array<{ tool: string; answer: Answer }> = [];
  for (let n = 1; n <= times; n++) {
    const lacking = unseedable(listed);
    for (const [tool, input] of SEEDS.filter(([tool]) => listed.some((t) => t.name === tool) && !lacking.has(tool))) {
      const given = await input(mark, n, { made: idsIn(made, contract), as });
      if (given === undefined) continue;
      const answer = await as.call(tool, given);
      if (answer.isError) throw new Error(`${tool}: ${JSON.stringify(answer.body)}`);
      made.push({ tool, answer });
    }
  }
  await team.seed?.(mark, times);
  return made;
}

/**
 * The two-team cases on `target`: team A (made) seeded once and its ids read, then team B made and seeded twice with
 * `canary`. `now` is the clock the time reads are asked from.
 */
export async function areasTwoTeams(target: Target, teamA: Team, contract: Contract, canary: string, dir: string, now: () => number = Date.now): Promise<Report> {
  const READS = reads(now());
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
 * the other writes with the team's own ids, as one may retire what was read (ON_MACHINE's on a machine, NOT_HERE's not
 * at all), then LAST's on what the run made. `now` is the clock the time reads are asked from.
 */
export async function areasContract(team: Team, contract: Contract, valid: (tool: string, body: unknown) => string | undefined, now: () => number = Date.now): Promise<Array<AreaCheck>> {
  const READS = reads(now());
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
    // The hub answers a secret no machine took (all offline) as failed "No machine took it.", else machine_offline.
    const offline = answers
      .map((a) => (a.isError ? (a.body as { code?: unknown; message?: unknown } | null) : null))
      .find((body) => body?.code === "machine_offline" || (body?.code === "failed" && String(body?.message).startsWith("No machine took it")));
    if (ok.length === 0 && offline && OFFLINE_ANSWERS.includes(tool)) return checks.push({ name: `MCP ${tool} answers ${String(offline.code)}, as no node joins`, ok: true });
    if (ok.length === 0) return checks.push({ name: `MCP ${tool}`, ok: false, detail: JSON.stringify(answers[0]?.body) });
    const why = ok.map((a) => valid(tool, a.body)).find((w) => w !== undefined);
    checks.push({ name: `MCP ${tool} decodes as ${tool}.output`, ok: why === undefined, ...(why === undefined ? {} : { detail: why }) });
  };
  const before = await readIds(as, contract, READS);
  const seeded = await seed(team, as, known, contract, "contract", 1);
  if (known.some((t) => t.name === "device_revoke")) await team.key({ name: "areas-spare", role: "admin", human: true });
  const done = new Set(seeded.map((s) => s.tool));
  for (const tool of done) decoded(tool, seeded.filter((s) => s.tool === tool).map((s) => s.answer));
  for (const [tool, lacks] of unseedable(known)) {
    done.add(tool);
    checks.push({ name: `MCP ${tool}`, ok: true, skipped: `not called: its seed needs ${lacks.join(", ")}, which the team doesn't list` });
  }
  // A tool a seed calls is a write, read-only as it may be listed (a picture is set with a read key): called among the
  // reads, with nothing, it would undo its seed.
  const read = await harvest(as, known.filter((t) => !done.has(t.name)), contract, READS, idsIn(seeded, contract));
  for (const tool of known.filter((t) => t.annotations?.readOnlyHint === true && !done.has(t.name))) {
    done.add(tool.name);
    if (tool.name in NOT_HERE) {
      checks.push({ name: `MCP ${tool.name}`, ok: true, skipped: NOT_HERE[tool.name]! });
      continue;
    }
    const answers = read.answers.filter((r) => r.tool === tool.name).map((r) => r.answer);
    if (answers.length === 0) checks.push({ name: `MCP ${tool.name}`, ok: true, skipped: "not called: none of the ids it needs turned up in the team's reads" });
    else decoded(tool.name, answers);
  }
  for (const tool of known.filter((t) => !done.has(t.name) && !LAST.includes(t.name))) {
    const onMachine = ON_MACHINE.find(([name]) => name === tool.name);
    if (tool.name in NOT_HERE) {
      checks.push({ name: `MCP ${tool.name}`, ok: true, skipped: NOT_HERE[tool.name]! });
      continue;
    }
    if (tool.name in OUTSIDE) {
      const answer = await as.call(tool.name, OUTSIDE[tool.name]);
      const code = (answer.body as { code?: unknown } | null)?.code;
      if (answer.isError && (code === "failed" || code === "invalid")) checks.push({ name: `MCP ${tool.name} answers ${code}: the fetch from outside is refused, as a run reaches nothing outside`, ok: true });
      else checks.push({ name: `MCP ${tool.name}`, ok: false, detail: `a source at a host that never resolves was answered: ${JSON.stringify(answer.body)}` });
      continue;
    }
    if (onMachine !== undefined) {
      const input = await onMachine[1](read.bag, tool);
      if (input === undefined) {
        checks.push({ name: `MCP ${tool.name}`, ok: true, skipped: "not called: it needs a machine, no node joins, and the target seeded none" });
        continue;
      }
      decoded(tool.name, [await as.call(tool.name, input)]);
      continue;
    }
    const input = inputFrom(tool, read.bag);
    const beside = BESIDE_IDS[tool.name]?.();
    if (input === undefined) checks.push({ name: `MCP ${tool.name}`, ok: true, skipped: "not called: none of the ids it needs turned up in the team's reads" });
    else decoded(tool.name, [await as.call(tool.name, beside === undefined ? input : { ...(input as object), ...beside })]);
  }
  const made = new Map([...read.bag].map(([kind, ids]) => [kind, ids.filter((id) => !before.get(kind)?.includes(id))] as const).filter(([, ids]) => ids.length > 0));
  for (const tool of LAST.flatMap((name) => known.filter((t) => t.name === name))) {
    const input = tool.name in FROM_SEEDS ? FROM_SEEDS[tool.name]!(seeded) : inputFrom(tool, made);
    if (input !== undefined) decoded(tool.name, [await as.call(tool.name, input)]);
    else if (inputFrom(tool, read.bag) === undefined) checks.push({ name: `MCP ${tool.name}`, ok: true, skipped: "not called: none of the ids it needs turned up in the team's reads" });
    else checks.push({ name: `MCP ${tool.name}`, ok: false, detail: "not called: the team holds only ids it had before the run, and the run made none for it to take away (the seed that would is not listed)" });
  }
  return checks;
}
