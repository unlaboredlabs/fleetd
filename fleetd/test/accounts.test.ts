// Ports crates/fleetd/src/hub/claude_accounts/tests.rs and onepassword/tests.rs against a fake node link.
import { expect, test } from "bun:test";
import { registerAll } from "../src/hub/serve/areas.ts";
import { Hub } from "../src/hub/api/hub.ts";
import { type Caller, Registry } from "../src/hub/api/registry.ts";
import { CONNECT_REFUSAL, Setup, type Whose, whoseForLead, whoseForTask } from "../src/hub/claude_accounts/index.ts";
import { bring } from "../src/hub/cloud/claude.ts";
import { fakeNodePort, type Link } from "../src/hub/cloud/node.ts";
import { Outbox } from "../src/hub/cloud/outbox.ts";
import { forTask as opForTask } from "../src/hub/onepassword/index.ts";
import { store } from "../src/hub/store/hub_store.ts";
import { HubDb } from "../src/hub/store/db.ts";
import type { ClaudeRunsOn, ClaudeSubscription, HubRole } from "../src/shared/contracts.ts";

const sub = (machines: string[]): ClaudeSubscription => ({
  sealedOn: machines.map((machineId) => ({ machineId, fingerprint: "ab12cd34" })),
  connectedAt: "2026-11-08T10:00:00.000Z",
});
const api = (machines: string[]) => ({ ...sub(machines), updatedAt: "2026-11-08T10:00:00.000Z" });
const team = (over: Partial<Record<"hubApi" | "subscriptions" | "choices" | "members", unknown>> = {}) =>
  new Setup(
    over.hubApi as never,
    { membersUseHubApi: (over.members as boolean | undefined) ?? true },
    (over.subscriptions as Map<string, ClaudeSubscription>) ?? new Map(),
    (over.choices as Map<string, "subscription" | "hub_api">) ?? new Map(),
    "p_aaaaaaaa",
    new Map<string, HubRole>([
      ["p_aaaaaaaa", "owner"],
      ["p_dddddddd", "admin"],
      ["p_bbbbbbbb", "member"],
      ["p_cccccccc", "member"],
    ]),
  );
const person = (id: string): Whose => ({ person: id });
const account = (who: string): ClaudeRunsOn =>
  who === "hub" ? { kind: "account", account: { kind: "hub" } } : { kind: "account", account: { kind: "person", personId: who } };
const refused = (r: ClaudeRunsOn) => (r.kind === "refused" ? r.message : `not refused: ${r.kind}`);

test("with nothing set up every machine keeps its own login", () => {
  for (const whose of [{ hub: true } as Whose, person("p_aaaaaaaa"), person("p_bbbbbbbb")]) {
    expect(team().runsOn(whose, "lab")).toEqual({ kind: "machine_login" });
  }
  expect(team({ choices: new Map([["p_bbbbbbbb", "subscription"]]) }).runsOn(person("p_bbbbbbbb"), "lab")).toEqual({
    kind: "machine_login",
  });
});

test("an order runs on its starter's account and never on anyone else's subscription", () => {
  const subs = new Map([
    ["p_aaaaaaaa", sub(["lab"])],
    ["p_cccccccc", sub(["lab"])],
  ]);
  const choices = new Map<string, "subscription" | "hub_api">();
  let setup = team({ subscriptions: subs, choices });
  expect(setup.runsOn(person("p_cccccccc"), "lab")).toEqual(account("p_cccccccc"));
  expect(refused(setup.runsOn(person("p_bbbbbbbb"), "lab"))).toBe(CONNECT_REFUSAL);
  expect(setup.runsOn({ hub: true }, "lab")).toEqual(account("p_aaaaaaaa"));
  setup = team({ subscriptions: subs, choices, hubApi: api(["lab"]) });
  expect(setup.runsOn(person("p_bbbbbbbb"), "lab")).toEqual(account("hub"));
  expect(setup.runsOn({ hub: true }, "lab")).toEqual(account("hub"));
  expect(setup.runsOn(person("p_cccccccc"), "lab")).toEqual(account("p_cccccccc"));
  choices.set("p_cccccccc", "hub_api");
  expect(setup.runsOn(person("p_cccccccc"), "lab")).toEqual(account("hub"));
  choices.set("p_bbbbbbbb", "subscription");
  expect(refused(setup.runsOn(person("p_bbbbbbbb"), "lab"))).toBe(CONNECT_REFUSAL);
});

test("the members switch turns the hub's API off for members only", () => {
  const setup = team({ hubApi: api(["lab"]), members: false, subscriptions: new Map([["p_cccccccc", sub(["lab"])]]) });
  const bob = setup.runsOn(person("p_bbbbbbbb"), "lab");
  expect(bob.kind === "refused" && bob.message).toBe(CONNECT_REFUSAL);
  expect(bob.kind === "refused" && bob.fix).toContain("Members may not use the hub's API");
  expect(setup.runsOn(person("p_cccccccc"), "lab")).toEqual(account("p_cccccccc"));
  expect(setup.runsOn(person("p_dddddddd"), "lab")).toEqual(account("hub"));
  expect(setup.runsOn(person("p_aaaaaaaa"), "lab")).toEqual(account("hub"));
  expect(setup.runsOn({ hub: true }, "lab")).toEqual(account("hub"));
  expect([setup.mayUseHubApi("p_bbbbbbbb"), setup.mayUseHubApi("p_dddddddd")]).toEqual([false, true]);
});

test("a way missing from the machine gives way to one there, or refuses the work there", () => {
  const subs = new Map([
    ["p_cccccccc", sub(["mac"])],
    ["p_aaaaaaaa", sub(["lab"])],
  ]);
  const choices = new Map<string, "subscription" | "hub_api">();
  let setup = team({ hubApi: api(["lab"]), subscriptions: subs, choices });
  expect(setup.runsOn(person("p_cccccccc"), "lab")).toEqual(account("hub"));
  choices.set("p_cccccccc", "subscription");
  expect(refused(setup.runsOn(person("p_cccccccc"), "lab"))).toContain("isn't on lab");
  expect(setup.runsOn(person("p_cccccccc"))).toEqual(account("p_cccccccc"));
  setup = team({ hubApi: api(["mac"]), subscriptions: subs, choices });
  expect(setup.runsOn({ hub: true }, "lab")).toEqual(account("p_aaaaaaaa"));
  subs.delete("p_aaaaaaaa");
  expect(refused(setup.runsOn({ hub: true }, "lab"))).toContain("hub's API key isn't on lab");
  // Only members' subscriptions: leads keep the machines' own login.
  const members = team({ subscriptions: new Map([["p_cccccccc", sub(["lab"])]]) });
  expect(members.runsOn({ hub: true }, "lab")).toEqual({ kind: "machine_login" });
  expect(refused(members.runsOn(person("p_aaaaaaaa"), "lab"))).toBe(CONNECT_REFUSAL);
});

/** A node link that answers session calls the way a node does, and records them. */
class FakeLink implements Link {
  calls: [string, Record<string, unknown>][] = [];
  online = new Set<string>(["lab", "mac"]);
  caps = new Set(["claude_accounts", "onepassword", "onepassword_cards"]);
  answer: (m: string, call: Record<string, unknown>) => Record<string, unknown> = (_m, call) => {
    switch (call.op) {
      case "claude_account_secret":
      case "onepassword_token":
        return call.set || call.sealed ? { kind: "saved", fingerprint: "ab12cd34" } : { kind: "saved" };
      case "claude_account_test":
        return { kind: "claude_account_tested", ok: true };
      case "onepassword_test":
        return { kind: "onepassword_tested", vaults: ["Private"] };
      case "onepassword_cards":
        return { kind: "onepassword_carded", cards: [{ ref: "op://Private/Visa", title: "Visa", vault: "Private" }] };
      default:
        throw new Error(`unexpected ${String(call.op)}`);
    }
  };
  async request(m: string, frame: Record<string, unknown>) {
    const call = frame.call as Record<string, unknown>;
    this.calls.push([m, call]);
    return { id: "1", result: { ok: this.answer(m, call) } };
  }
  can = (_m: string, cap: string) => this.caps.has(cap);
  linkId = (m: string) => (this.online.has(m) ? `L-${m}` : undefined);
}

function setup() {
  const hub = new Hub({ home: "", listen: { host: "127.0.0.1", port: 0 } }, HubDb.memory(), { now: () => Date.parse("2026-11-08T10:00:00Z") });
  const link = new FakeLink();
  hub.area("node_port", () => fakeNodePort(link));
  const at = "2026-11-08T10:00:00.000Z";
  for (const m of ["lab", "mac"]) {
    store(hub).machineUpsert({ machineId: m, name: m, nodeVersion: "1", status: "online", lastSeenAt: at } as never);
  }
  const people: [string, string, string][] = [
    ["p_aaaaaaaa", "Ann", "owner"],
    ["p_bbbbbbbb", "Bob", "member"],
  ];
  for (const [id, name, role] of people) {
    hub.db.conn.query("INSERT INTO people (person_id, name, role, created_ms) VALUES (?, ?, ?, 0)").run(id, name, role);
  }
  const tools = new Registry();
  registerAll(tools);
  const device = (personId: string, role: "admin" | "operate"): Caller => ({
    keyId: `k_${personId}`,
    name: `${personId}-desk`,
    prefix: "fld_x",
    grants: [{ role, machines: "*" }],
    createdAt: at,
    kind: "human",
    person: { personId, name: personId },
  });
  const call = async (caller: Caller, tool: string, input: unknown) => {
    const r = await tools.call(hub, caller, tool, input);
    if ("error" in r) throw r.error.kind === "tool" ? r.error.error : new Error(r.error.kind);
    return r.output as Record<string, unknown>;
  };
  return { hub, link, call, ann: device("p_aaaaaaaa", "admin"), bob: device("p_bbbbbbbb", "operate") };
}

const SEALED = Buffer.alloc(60, 1).toString("base64");

test("only admins set the hub's API, and its key reaches the nodes sealed, never the hub", async () => {
  const { hub, link, call, ann, bob } = setup();
  await expect(call(bob, "claude_hub_api_set", { sealed: [{ machineId: "lab", sealed: SEALED }] })).rejects.toMatchObject({
    code: "forbidden",
  });
  await expect(call(ann, "claude_hub_api_set", {})).rejects.toMatchObject({ message: "The hub has no API key to keep." });
  const out = await call(ann, "claude_hub_api_set", {
    sealed: [
      { machineId: "lab", sealed: SEALED },
      { machineId: "gone", sealed: SEALED },
    ],
    endpoint: "https://llm.example/v1",
  });
  expect((out.hubApi as { sealedOn: unknown }).sealedOn).toEqual([{ machineId: "lab", fingerprint: "ab12cd34" }]);
  expect(out.missingOn).toEqual(["mac"]);
  expect(out.next).toContain("Machine gone is offline.");
  expect(link.calls).toEqual([["lab", { op: "claude_account_secret", account: { kind: "hub" }, set: { sealed: SEALED, endpoint: "https://llm.example/v1" } }]]);
  const rows = JSON.stringify(hub.db.all("SELECT * FROM claude_accounts"));
  expect(rows).not.toContain(SEALED);
  // An endpoint change alone keeps the key each machine holds.
  await call(ann, "claude_hub_api_set", { endpoint: "https://llm.example/v2" });
  expect(link.calls.at(-1)).toEqual(["lab", { op: "claude_account_secret", account: { kind: "hub" }, set: { endpoint: "https://llm.example/v2" } }]);
  const tested = await call(ann, "claude_account_test", { account: "hub_api" });
  expect(tested.test).toEqual({ at: "2026-11-08T10:00:00.000Z", machineId: "lab", ok: true });
  const got = await call(bob, "claude_accounts_get", {});
  expect([got.leadsRunOn, got.people, (got.me as { mayUseHubApi: boolean }).mayUseHubApi]).toEqual([account("hub"), [], true]);
  expect(((await call(ann, "claude_accounts_get", {})).people as unknown[]).length).toBe(2);
  await call(ann, "claude_hub_api_remove", {});
  expect(link.calls.at(-1)).toEqual(["lab", { op: "claude_account_secret", account: { kind: "hub" } }]);
  expect(hub.db.all("SELECT * FROM claude_accounts")).toEqual([]);
});

test("a cloud machine is handed the hub's http:// endpoint at its tunnel's loopback port; others as it is", async () => {
  const { hub, link, call, ann } = setup();
  hub.db.conn.run("INSERT INTO node_keys (machine_id, pub_key, pool) VALUES ('mac', 'k', 1)");
  await call(ann, "claude_hub_api_set", {
    sealed: [
      { machineId: "lab", sealed: SEALED },
      { machineId: "mac", sealed: SEALED },
    ],
    endpoint: "http://100.104.249.49:8317/v1",
  });
  expect(link.calls).toEqual([
    ["lab", { op: "claude_account_secret", account: { kind: "hub" }, set: { sealed: SEALED, endpoint: "http://100.104.249.49:8317/v1" } }],
    ["mac", { op: "claude_account_secret", account: { kind: "hub" }, set: { sealed: SEALED, endpoint: "http://127.0.0.1:47901/v1" } }],
  ]);
  // Its catch-up as it wakes sets the same.
  expect(await bring(hub, "mac")).toEqual({ current: { kind: "hub" } });
  expect(link.calls.at(-1)).toEqual(["mac", { op: "claude_account_secret", account: { kind: "hub" }, set: { endpoint: "http://127.0.0.1:47901/v1" } }]);
  // An https:// one names a host its certificate must match: handed as it is.
  await call(ann, "claude_hub_api_set", { endpoint: "https://llm.example/v1" });
  expect(link.calls.at(-1)).toEqual(["mac", { op: "claude_account_secret", account: { kind: "hub" }, set: { endpoint: "https://llm.example/v1" } }]);
});

test("a person connects their own subscription; a sleeping cloud machine forgets it as it wakes", async () => {
  const { hub, link, call, bob } = setup();
  hub.db.conn.run("INSERT INTO node_keys (machine_id, pub_key, pool) VALUES ('mac', 'k', 1)");
  const out = await call(bob, "claude_subscription_set", {
    sealed: [
      { machineId: "lab", sealed: SEALED },
      { machineId: "mac", sealed: SEALED },
    ],
  });
  expect((out.me as { runsOn: ClaudeRunsOn }).runsOn).toEqual(account("p_bbbbbbbb"));
  await call(bob, "claude_choice_set", { choice: "hub_api" });
  expect((await call(bob, "claude_accounts_get", {})).me).toMatchObject({ choice: "hub_api" });
  link.online.delete("mac");
  await call(bob, "claude_subscription_remove", {});
  expect(link.calls.at(-1)).toEqual(["lab", { op: "claude_account_secret", account: { kind: "person", personId: "p_bbbbbbbb" } }]);
  expect(new Outbox(hub.db).list("mac")).toEqual([[1, { kind: "claude_forget", account: { kind: "person", personId: "p_bbbbbbbb" } }]]);
  expect(hub.db.all<{ type: string }>("SELECT type FROM events").map((e) => e.type)).toEqual(["people.changed"]);
  // An agent key never connects one.
  const agent = { ...bob, kind: undefined, person: undefined } as Caller;
  await expect(call(agent, "claude_subscription_set", { sealed: [{ machineId: "lab", sealed: SEALED }] })).rejects.toMatchObject({ code: "forbidden" });
});

test("1Password: a person's token is kept as fingerprints, tested, listed and forgotten", async () => {
  const { hub, link, call, bob } = setup();
  const saved = await call(bob, "onepassword_set", { sealed: [{ machineId: "lab", sealed: SEALED }] });
  expect(saved.token).toEqual({ sealedOn: [{ machineId: "lab", fingerprint: "ab12cd34" }], savedAt: "2026-11-08T10:00:00.000Z" });
  expect(saved.missingOn).toEqual(["mac"]);
  expect(link.calls[0]).toEqual(["lab", { op: "onepassword_token", personId: "p_bbbbbbbb", sealed: SEALED }]);
  const tested = await call(bob, "onepassword_test", {});
  expect(tested.test).toEqual({ at: "2026-11-08T10:00:00.000Z", machineId: "lab", ok: true, vaults: ["Private"] });
  expect(((await call(bob, "onepassword_get", {})).token as { lastTest: unknown }).lastTest).toEqual(tested.test);
  const cards = await call(bob, "onepassword_cards", {});
  expect(cards).toEqual({ machineId: "lab", cards: [{ ref: "op://Private/Visa", title: "Visa", vault: "Private" }] });
  await expect(call(bob, "onepassword_test", { machineId: "mac" })).rejects.toMatchObject({ message: "mac doesn't hold it." });
  // A shared project pays only with a token of its own.
  store(hub).projectsUpsertMany("lab", [
    { machineId: "lab", projectId: "p1", title: "P1", workspaceRoot: "/w", lastActivityAt: "2026-11-08T10:00:00.000Z", threads: { running: 0, total: 0 } } as never,
  ]);
  await expect(call(bob, "onepassword_cards", { project: { machineId: "lab", projectId: "p1" } })).rejects.toMatchObject({
    code: "invalid",
  });
  // Bob's Navi on lab falls back on his token; a task of nobody's order doesn't.
  hub.db.conn.run("INSERT INTO project_settings (machine_id, project_id, only_me, owner_person) VALUES ('lab', 'p1', 1, 'p_bbbbbbbb')");
  expect(opForTask(hub.db, { machineId: "lab", projectId: "p1" }, undefined, "lab")).toBe("p_bbbbbbbb");
  expect(opForTask(hub.db, { machineId: "lab", projectId: "p2" }, undefined, "lab")).toBeUndefined();
  expect(whoseForLead(hub.db, setupOf(hub), { machineId: "lab", projectId: "p1" })).toEqual({ person: "p_bbbbbbbb" });
  await call(bob, "onepassword_remove", {});
  expect(link.calls.at(-1)).toEqual(["lab", { op: "onepassword_token", personId: "p_bbbbbbbb" }]);
  expect(await call(bob, "onepassword_get", {})).toEqual({});
});

test("whose work a task is: its order's starter, while they are on the hub", () => {
  const { hub } = setup();
  hub.db.conn.run(`INSERT INTO workstreams (n, machine_id, project_id, state, data) VALUES (3, 'lab', 'p2', 'open', '{"startedBy":{"personId":"p_bbbbbbbb","name":"Bob"}}')`);
  hub.db.conn.run(`INSERT INTO workstreams (n, machine_id, project_id, state, data) VALUES (4, 'lab', 'p2', 'open', '{"startedBy":{"personId":"p_zzzzzzzz","name":"Gone"}}')`);
  const s = setupOf(hub);
  expect(whoseForTask(hub.db, s, { machineId: "lab", projectId: "p2" }, "W3")).toEqual({ person: "p_bbbbbbbb" });
  expect(whoseForTask(hub.db, s, { machineId: "lab", projectId: "p2" }, "W4")).toEqual({ hub: true });
});

import { ClaudeAccountStore } from "../src/hub/claude_accounts/index.ts";

const setupOf = (hub: Hub) => new ClaudeAccountStore(hub.db).setup();
