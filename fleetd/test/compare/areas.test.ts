// `--areas` (tests/compare/areas.ts) proven on a stand-in that lists only the decisions tools, with McpTools.json's own
// schemas, as a service that serves some areas lists only theirs: the two-team cases are made of exactly those tools,
// seeded through them and the target's own hook, and catch a search that leaks; the contract's output check runs on
// exactly the listed tools and fails one the contract lacks and an answer that doesn't decode. And on one that lists
// only the people tools: the contract calls each, and the ones that take away run last on what the run made.
import { randomBytes } from "node:crypto";
import { expect, test } from "bun:test";
import mcpToolsText from "../../../app/desktop/src/shared/contracts/schema/McpTools.json" with { type: "text" };
import { areasContract, areasTwoTeams } from "../../../tests/compare/areas.ts";
import { Refusal, standIn, type StandInTeam, type StandInTool } from "../../../tests/compare/standIn.ts";
import type { Team } from "../../../tests/compare/target.ts";
import { reportLines } from "../../../tests/compare/twoTeams.ts";
import { openSealed, publicKeyOf } from "../../src/shared/sealed_box_core.ts";

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

/**
 * The project tools under the hub's own rules, with no node linked (projects/discover.ts, repos.ts, remove.ts):
 * project_add answers not_found for a machine the team has no row for and machine_offline for one it has;
 * project_repo_add answers machine_offline; project_remove forgets a project whose machine has no row, erasing its
 * decisions, and answers machine_offline while the machine is known; machine_remove removes a known machine and its
 * projects, offline as it is. The target's seed (`seeded`) puts project m1/p1, with a decision of its own, on machine
 * m1, which has a row (`machine`) or not. The two removals are listed first.
 * `calls` is every call, in order.
 */
function projectTools(seeded: "none" | "machine" | "gone") {
  const at = "2026-01-01T00:00:00.000Z";
  const calls: Array<string> = [];
  const machines = new Set<string>();
  const projects: Array<{ machineId: string; projectId: string }> = [];
  const decisions: Array<Record<string, any>> = [];
  const project = (given: { machineId: string; projectId: string }) => {
    const found = projects.find((p) => p.machineId === given.machineId && p.projectId === given.projectId);
    if (found === undefined) throw new Refusal("not_found", `No project ${given.machineId}/${given.projectId}.`);
    return found;
  };
  const offline = (machineId: string) => new Refusal("machine_offline", `Machine ${machineId} is offline.`);
  const tool = (name: string, readOnly: boolean, type: string, run: (given: any) => unknown): StandInTool => ({
    name,
    readOnly,
    input: input(`${type}Input`),
    output: {},
    run: (_team, given) => {
      calls.push(name);
      return run(given);
    },
  });
  const tools = [
    tool("machine_remove", false, "MachineRemove", (given) => {
      if (!machines.delete(given.machineId)) throw new Refusal("not_found", `No machine ${given.machineId}.`);
      projects.splice(0, projects.length, ...projects.filter((p) => p.machineId !== given.machineId));
      return { machineId: given.machineId, steps: [], revoked: 0 };
    }),
    tool("project_remove", false, "ProjectRemove", (given) => {
      const removed = project(given);
      if (machines.has(removed.machineId)) throw offline(removed.machineId);
      projects.splice(projects.indexOf(removed), 1);
      decisions.splice(0, decisions.length, ...decisions.filter((d) => d.scope.kind === "global"));
      return { ok: true };
    }),
    tool("project_add", false, "ProjectAdd", (given) => {
      if (!machines.has(given.machineId)) throw new Refusal("not_found", `No machine ${given.machineId}.`);
      throw offline(given.machineId);
    }),
    tool("project_repo_add", false, "ProjectRepoAdd", (given) => {
      throw offline(project(given).machineId);
    }),
    tool("decisions_record", false, "DecisionsRecord", (given) => {
      const decision = { decisionId: `D${decisions.length + 1}`, key: given.key, scope: given.scope, value: given.value, why: given.why, source: "human", state: "active", at };
      decisions.push(decision);
      return { decision };
    }),
    tool("decisions_overturn", false, "DecisionsOverturn", (given) => {
      const decision = decisions.find((d) => d.decisionId === given.decisionId);
      if (decision === undefined) throw new Refusal("not_found", `No decision ${given.decisionId}.`);
      decision.state = "overturned";
      return { overturned: decision };
    }),
    tool("project_get", true, "ProjectGet", () => ({ projects: projects.map((p) => ({ ...p, title: "areas", workspaceRoot: "/srv/areas", threads: [], lastActivityAt: at })) })),
  ];
  const seed = async () => {
    if (seeded === "none") return;
    if (seeded === "machine") machines.add("m1");
    projects.push({ machineId: "m1", projectId: "p1" });
    decisions.unshift({ decisionId: "D0", key: "areas.project", scope: { kind: "project", projectRef: { machineId: "m1", projectId: "p1" } }, value: "the project's", why: "seeded", source: "human", state: "active", at });
  };
  return { tools, calls, seed };
}

test("the project tools under the hub's rules: project_remove runs last, and what a machine does answers machine_offline", async () => {
  const run = async (seeded: "none" | "machine" | "gone") => {
    const { tools, calls, seed } = projectTools(seeded);
    const target = await standIn({ only: tools });
    try {
      const team = await target.team("");
      const checks = await areasContract({ ...team, seed }, doc, required);
      return { rows: checks.map((c) => `${c.skipped !== undefined ? "skip" : c.ok ? "pass" : "FAIL"} ${c.name}${c.ok ? "" : `: ${c.detail}`}`), calls };
    } finally {
      await target.close();
    }
  };
  // The project on a machine that joined once and is offline now: every project tool has its answer.
  const onMachine = await run("machine");
  expect(onMachine.rows).toEqual([
    "pass GET /healthz is 200",
    "pass MCP tools/list answers",
    "pass MCP decisions_record decodes as decisions_record.output",
    "pass MCP project_get decodes as project_get.output",
    "pass MCP project_add answers machine_offline, as no node joins",
    "pass MCP project_repo_add answers machine_offline, as no node joins",
    "pass MCP decisions_overturn decodes as decisions_overturn.output",
    "pass MCP project_remove answers machine_offline, as no node joins",
    "pass MCP machine_remove decodes as machine_remove.output",
  ]);
  expect(onMachine.calls.slice(-2)).toEqual(["project_remove", "machine_remove"]);

  // A project whose machine the team has no row for can be removed, but nothing can be added on that machine: a
  // target's seed puts its project on a machine it knows.
  expect((await run("gone")).rows.filter((r) => r.includes("project_"))).toEqual([
    "pass MCP project_get decodes as project_get.output",
    'FAIL MCP project_add: {"code":"not_found","message":"No machine m1."}',
    "pass MCP project_repo_add answers machine_offline, as no node joins",
    "pass MCP project_remove decodes as project_remove.output",
  ]);

  // No machine and no project: nothing to call them on, and nothing is taken away.
  expect((await run("none")).rows.filter((r) => r.includes("project_"))).toEqual([
    "pass MCP project_get decodes as project_get.output",
    "skip MCP project_add",
    "skip MCP project_repo_add",
    "skip MCP project_remove",
  ]);
});

/**
 * The vault, push, time and skill tools as the hub answers them, with no node: vault_status gives the hub's box key and
 * vault_save and vault_unlock open what is sealed to it; push_device_register takes a 32-byte key and remembers whether
 * pushes were on; time_spans keeps the `since` it was asked; skill_install's fetch from outside fails. `opened` is what
 * the vault opened, `calls` every call in order (with whether pushes were on, for a register).
 */
function outsideTools(opts: { relayListed: boolean }) {
  const at = "2026-01-01T00:00:00.000Z";
  const secret = new Uint8Array(randomBytes(32));
  const calls: Array<string> = [];
  const opened: Array<unknown> = [];
  const since: Array<string> = [];
  let relayOn = true;
  const phones: Array<Record<string, unknown>> = [];
  const open = (sealed: string) => {
    const plain = openSealed(secret, new Uint8Array(Buffer.from(sealed, "base64")));
    if (plain === null) throw new Refusal("invalid", "The value wasn't sealed to this hub's key.");
    const fields = JSON.parse(Buffer.from(plain).toString("utf8")) as unknown;
    opened.push(fields);
    return fields;
  };
  const status = { hubBoxKey: Buffer.from(publicKeyOf(secret)).toString("base64"), keyMode: "file", locked: false, keyMissing: false, recoverySaved: false, migration: "none" };
  const tool = (name: string, readOnly: boolean, type: string, run: (given: any) => unknown): StandInTool => ({
    name,
    readOnly,
    input: input(`${type}Input`),
    output: {},
    run: (_team, given) => {
      calls.push(name);
      return run(given);
    },
  });
  const tools = [
    tool("vault_status", true, "VaultStatus", () => status),
    tool("vault_save", false, "VaultSave", (given) => {
      open(given.sealed);
      return { item: { itemId: "v1", kind: given.kind, label: given.envName } };
    }),
    tool("vault_unlock", false, "VaultUnlock", (given) => (open(given.sealed), status)),
    ...(opts.relayListed ? [tool("push_relay_set", false, "PushRelaySet", (given) => ((relayOn = given.url !== ""), { key: false, default: false }))] : []),
    tool("push_device_register", false, "PushDeviceRegister", (given) => {
      if (Buffer.from(given.publicKey, "base64").length !== 32) throw new Refusal("invalid", "publicKey isn't an X25519 public key.");
      calls.push(`relay ${relayOn ? "on" : "off"}`);
      const device = { deviceId: `pd_aaaaaaa${"bcdefgh"[phones.length]}`, platform: given.platform, name: given.name, createdAt: at };
      phones.push(device);
      return { device, relay: relayOn };
    }),
    tool("push_devices_list", true, "PushDevicesList", () => ({ devices: phones, relay: relayOn })),
    tool("push_device_remove", false, "PushDeviceRemove", (given) => {
      const device = phones.find((p) => p.deviceId === given.deviceId);
      if (device === undefined) throw new Refusal("not_found", `No phone ${given.deviceId}.`);
      phones.splice(phones.indexOf(device), 1);
      return { device };
    }),
    tool("time_spans", true, "TimeSpans", (given) => (since.push(given.since), { spans: [], coverage: {} })),
    tool("skill_install", false, "SkillInstall", (given) => {
      if (String(given.source).includes(".invalid")) throw new Refusal("failed", "git fetch: could not resolve host");
      return { installed: [] };
    }),
    tool("skill_update", false, "SkillUpdate", () => ({ updated: false })),
  ];
  return { tools, calls, opened, since };
}

test("sealed vault seeds, a phone only after pushes are off and removed last, time from the given clock, and fetches from outside", async () => {
  const run = async (relayListed: boolean) => {
    const made = outsideTools({ relayListed });
    const target = await standIn({ only: made.tools });
    try {
      const checks = await areasContract(await target.team(""), doc, required, () => Date.parse("2026-01-02T00:00:00.000Z"));
      return { ...made, rows: checks.map((c) => `${c.skipped !== undefined ? "skip" : c.ok ? "pass" : "FAIL"} ${c.name}${c.ok ? "" : `: ${c.detail}`}`) };
    } finally {
      await target.close();
    }
  };
  const on = await run(true);
  expect(on.rows.filter((r) => !r.startsWith("pass")).map((r) => r.split(":")[0])).toEqual(["skip MCP skill_update"]);
  expect(on.rows).toContain("pass MCP skill_install answers failed: the fetch from outside is refused, as a run reaches nothing outside");
  // Sealed to the hub's key, as the vault opens it: an env item's value and a passphrase, each with the run's mark.
  expect(on.opened).toEqual([{ value: "contract value 1" }, { passphrase: "contract" }]);
  // The phone is registered once pushes are off, and the phone the run made goes last.
  expect(on.calls.slice(on.calls.indexOf("push_relay_set"), on.calls.indexOf("push_relay_set") + 3)).toEqual(["push_relay_set", "push_device_register", "relay off"]);
  expect(on.calls.at(-1)).toBe("push_device_remove");
  // The time reads cover the day before the clock the run is given.
  expect([...new Set(on.since)]).toEqual(["2026-01-01T00:00:00.000Z"]);

  // With no way to turn pushes off, no phone is registered, and no made-up one is sent in its stead.
  const off = await run(false);
  expect(off.calls).not.toContain("push_device_register");
  expect(off.rows).toContain("skip MCP push_device_register");
});

test("vault_reveal reveals the seeded env item's value to a 32-byte reply key, as the hub's rules allow", async () => {
  const secret = new Uint8Array(randomBytes(32));
  const status = { hubBoxKey: Buffer.from(publicKeyOf(secret)).toString("base64"), keyMode: "file", locked: false, keyMissing: false, recoverySaved: false, migration: "none" };
  const items = new Map<string, { kind: string; fields: Record<string, string> }>();
  const asked: Array<Record<string, unknown>> = [];
  // The hub's rules (hub/vault): a kind reveals only its own fields (an env item's is `value`), to an X25519 key.
  const FIELDS: Record<string, Array<string>> = { env: ["value"], login: ["username", "password", "otp"] };
  const tools: Array<StandInTool> = [
    { name: "vault_status", readOnly: true, input: input("VaultStatusInput"), output: {}, run: () => status },
    {
      name: "vault_save",
      readOnly: false,
      input: input("VaultSaveInput"),
      output: {},
      run: (_team, given) => {
        const fields = JSON.parse(Buffer.from(openSealed(secret, new Uint8Array(Buffer.from(given.sealed, "base64")))!).toString("utf8")) as Record<string, string>;
        const itemId = `V${String(items.size + 1).padStart(32, "0")}`;
        items.set(itemId, { kind: given.kind, fields });
        return { item: { itemId, kind: given.kind, label: given.envName } };
      },
    },
    {
      name: "vault_reveal",
      readOnly: false,
      input: input("VaultRevealInput"),
      output: {},
      run: (_team, given) => {
        asked.push(given);
        const item = items.get(given.itemId);
        if (item === undefined) throw new Refusal("not_found", `No item ${given.itemId}.`);
        const bad = (given.fields as Array<string>).find((f) => !FIELDS[item.kind]!.includes(f));
        if (bad !== undefined) throw new Refusal("invalid", `A ${item.kind} has no field ${bad}.`);
        if (Buffer.from(given.replyKey, "base64").length !== 32) throw new Refusal("invalid", "replyKey: expected a 32-byte X25519 public key");
        return { sealed: Buffer.from(randomBytes(64)).toString("base64") };
      },
    },
  ];
  const target = await standIn({ only: tools });
  try {
    const checks = await areasContract(await target.team(""), doc, required);
    expect(checks.find((c) => c.name.includes("vault_reveal"))).toEqual({ name: "MCP vault_reveal decodes as vault_reveal.output", ok: true });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.fields).toEqual(["value"]);
    expect(Buffer.from(String(asked[0]!.replyKey), "base64")).toHaveLength(32);
  } finally {
    await target.close();
  }
});

test("the caller's picture is made of a file of its own, so the file the run put is still there for attachment_get", async () => {
  // The hub's rules (intake/attachments.ts, people/avatar.ts): files are numbered F1, F2…; setting a picture takes its
  // file, which nothing finds after; attachment_get reads a file in a project.
  const files = new Map<string, { name: string; mime: string; dataB64: string }>();
  let picture: string | undefined;
  let put = 0;
  const at = "2026-01-01T00:00:00.000Z";
  const tools: Array<StandInTool> = [
    {
      name: "attachment_put",
      readOnly: false,
      input: input("AttachmentPutInput"),
      output: {},
      run: (_team, given) => {
        const attachmentId = `F${++put}`;
        files.set(attachmentId, { name: given.name, mime: given.mime, dataB64: given.dataB64 });
        return { attachmentId, bytes: Buffer.from(given.dataB64, "base64").length, sha256: "0".repeat(64) };
      },
    },
    {
      name: "person_avatar_set",
      readOnly: true,
      input: input("PersonAvatarSetInput"),
      output: {},
      run: (_team, given) => {
        if (given.attachmentId !== undefined) {
          if (!files.delete(given.attachmentId)) throw new Refusal("not_found", `No attachment ${given.attachmentId}.`);
          picture = given.attachmentId;
        }
        return { person: { personId: "p_aaaaaaaa", name: "owner", role: "owner", createdAt: at } };
      },
    },
    { name: "project_get", readOnly: true, input: input("ProjectGetInput"), output: {}, run: () => ({ projects: [{ machineId: "m1", projectId: "p1", title: "areas", workspaceRoot: "/srv/areas", threads: [], lastActivityAt: at }] }) },
    {
      name: "attachment_get",
      readOnly: true,
      input: input("AttachmentGetInput"),
      output: {},
      run: (_team, given) => {
        const file = files.get(given.attachmentId);
        if (file === undefined) throw new Refusal("not_found", `No attachment ${given.attachmentId} in this project.`);
        return { attachmentId: given.attachmentId, name: file.name, mime: file.mime, bytes: Buffer.from(file.dataB64, "base64").length, dataB64: file.dataB64 };
      },
    },
  ];
  const target = await standIn({ only: tools });
  try {
    const checks = await areasContract(await target.team(""), doc, required);
    expect(checks.filter((c) => c.name.includes("attachment_get") || c.name.includes("person_avatar_set"))).toEqual([
      { name: "MCP person_avatar_set decodes as person_avatar_set.output", ok: true },
      { name: "MCP attachment_get decodes as attachment_get.output", ok: true },
    ]);
    expect(picture).toBeDefined();
    expect(files.has(picture!)).toBe(false);
  } finally {
    await target.close();
  }
});

test("a profile of the run's own on a model the hub offers, deleted last, never the default; a token no machine takes", async () => {
  const at = "2026-01-01T00:00:00.000Z";
  const calls: Array<string> = [];
  const models = [{ id: "claude-sonnet-5-5", fast: false }];
  const profiles: Array<Record<string, any>> = [{ id: 1, name: "high", note: "", model: "claude-sonnet-5-5", effort: "high", fast: false, default: true, updatedAt: at }];
  const profile = (id: number) => {
    const found = profiles.find((p) => p.id === id);
    if (found === undefined) throw new Refusal("not_found", `No profile ${id}.`);
    return found;
  };
  // The hub's rules (projects/profiles.ts, claude_accounts/tools.ts): a model the hub offers; the default is never
  // deleted; a token sealed to machines is kept only by one online, and none is.
  const tool = (name: string, readOnly: boolean, type: string, run: (given: any) => unknown): StandInTool => ({
    name,
    readOnly,
    input: input(`${type}Input`),
    output: {},
    run: (_team, given) => {
      calls.push(`${name} ${JSON.stringify(given.id ?? given.name ?? "")}`);
      return run(given);
    },
  });
  const tools = [
    tool("profile_delete", false, "ProfileDelete", (given) => {
      if (profile(given.id).default) throw new Refusal("invalid", "high is the default: every review and helper call runs on it.");
      profiles.splice(profiles.indexOf(profile(given.id)), 1);
      return { ok: true };
    }),
    tool("profiles_list", true, "ProfilesList", () => ({ profiles, models, modelsFrom: "builtin", efforts: ["low", "medium", "high"] })),
    tool("profile_create", false, "ProfileCreate", (given) => {
      if (!models.some((m) => m.id === given.model)) throw new Refusal("invalid", `${given.model} is not among the models this hub offers.`);
      const made = { id: profiles.length + 1, name: given.name, note: given.note, model: given.model, effort: given.effort, fast: false, default: false, updatedAt: at };
      profiles.push(made);
      return { profile: made };
    }),
    tool("profile_update", false, "ProfileUpdate", (given) => ({ profile: profile(given.id) })),
    tool("project_get", true, "ProjectGet", () => ({ projects: [{ machineId: "m1", projectId: "p1", title: "areas", workspaceRoot: "/srv/areas", threads: [], lastActivityAt: at }] })),
    tool("claude_subscription_set", false, "ClaudeSubscriptionSet", (given) => {
      const seals = given.sealed as Array<{ machineId: string; sealed: string }>;
      if (seals.some((s) => Buffer.from(s.sealed, "base64").length < 48)) throw new Refusal("invalid", "each seal is { machineId, sealed }, sealed a sealed box in standard base64.");
      throw new Refusal("failed", `No machine took it. ${seals.map((s) => `${s.machineId} is offline.`).join(" ")}`);
    }),
    tool("claude_account_test", false, "ClaudeAccountTest", () => {
      throw new Refusal("not_found", "The hub has no API key.");
    }),
    tool("onepassword_set", false, "OnePasswordSet", (given) => {
      const seals = given.sealed as Array<{ machineId: string; sealed: string }>;
      if (seals.some((s) => Buffer.from(s.sealed, "base64").length < 48)) throw new Refusal("invalid", "each seal is { machineId, sealed }, sealed a sealed box in standard base64.");
      throw new Refusal("failed", "No machine took it. m1 is offline.");
    }),
    tool("onepassword_test", false, "OnePasswordTest", () => {
      throw new Refusal("not_found", "You have no 1Password token saved.");
    }),
  ];
  const target = await standIn({ only: tools });
  try {
    const checks = await areasContract(await target.team(""), doc, required);
    const rows = checks.filter((c) => /profile|claude|onepassword/u.test(c.name)).map((c) => `${c.skipped !== undefined ? "skip" : c.ok ? "pass" : "FAIL"} ${c.name}${c.ok ? "" : `: ${c.detail}`}`);
    expect(rows).toEqual([
      "pass MCP profile_create decodes as profile_create.output",
      "pass MCP profiles_list decodes as profiles_list.output",
      "pass MCP profile_update decodes as profile_update.output",
      "pass MCP claude_subscription_set answers failed, as no node joins",
      "skip MCP claude_account_test",
      "pass MCP onepassword_set answers failed, as no node joins",
      "skip MCP onepassword_test",
      "pass MCP profile_delete decodes as profile_delete.output",
    ]);
    // The run's own profile, on the model the hub listed, and deleted last; the default stays.
    expect(calls.filter((c) => c.startsWith("profile_create"))).toEqual(['profile_create "contract-1"']);
    expect(calls.at(-1)).toBe("profile_delete 2");
    expect(profiles.map((p) => p.name)).toEqual(["high"]);
  } finally {
    await target.close();
  }
});
