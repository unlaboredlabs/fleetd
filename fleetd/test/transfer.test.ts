// `fleetd export` and `fleetd import` between two throwaway hubs (hub/transfer): what a hub's own tools answer is the
// same on the hub the file loads into; the file never holds a secret in the clear or a hub's own key; a damaged file, a
// newer one and a hub that has data each change nothing.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { publish } from "../src/hub/artifacts/index.ts";
import { chat } from "../src/hub/chat/index.ts";
import { claim } from "../src/hub/intake/attachments.ts";
import { answer } from "../src/hub/checklist/calls.ts";
import type { LeadCall, LeadCaller } from "../src/hub/leads/seams.ts";
import { people } from "../src/hub/people/store.ts";
import { MIGRATIONS } from "../src/gen/migrations.ts";
import { store } from "../src/hub/store/hub_store.ts";
import { migrate } from "../src/hub/store/migrations.ts";
import { TaskRecords } from "../src/hub/tasks/records.ts";
import { TransferError } from "../src/hub/transfer/format.ts";
import { checkExport, importHub } from "../src/hub/transfer/import.ts";
import { SECRET_TABLES } from "../src/hub/transfer/tables.ts";
import { loadOrCreateBoxKey, openSealed, publicKeyOf, seal } from "../src/shared/sealed_box.ts";
import type { ProjectRef, ProjectSummary, Task } from "../src/shared/contracts.ts";
import { AT, entriesOf, exportOf, importInto, open, type Opened, PASS, place, type Place, rewritten, rowsOf, stateOf, textOf } from "./transfer-kit.ts";

const M = "devbox";
const PROJECT: ProjectRef = { machineId: M, projectId: "p1" };
const ISO = new Date(AT).toISOString();
const SESSION = "B0123456789abcdef0123456789abcdef";
const b64 = (b: Uint8Array | string) => Buffer.from(b).toString("base64");

/** The values that must never be readable in a file: each is planted in the hub, sealed as the hub seals it. */
const CANARY = {
  password: "canary-password-Qq11",
  env: "canary-env-Zz22",
  appKey: "canary-app-private-key-Kk33",
  webhook: "canary-webhook-secret-Ww44",
  token: "canary-github-token-Tt55",
  link: "canary-hub-link-key-Ll66",
  relay: "canary-push-relay-key-Rr77",
  oauth: "canary-mcp-client-secret-Oo88",
};

const places: Place[] = [];
const opened: Opened[] = [];
const newPlace = () => {
  const p = place();
  places.push(p);
  return p;
};
const start = async (p: Place) => {
  const k = await open(p);
  opened.push(k);
  return k;
};
const stop = (k: Opened) => {
  k.close();
  opened.splice(opened.indexOf(k), 1);
};
afterEach(() => {
  for (const k of opened.splice(0)) k.close();
  for (const p of places.splice(0)) p.done();
});

/** A hub that was just set up and started once: its owner, one paired device, nothing else. */
async function fresh(): Promise<{ p: Place; key: string }> {
  const p = newPlace();
  const k = await start(p);
  const { key } = k.device();
  stop(k);
  return { p, key };
}

/** Fills the hub with one of every kind an export carries, through its tools and the stores its agents write through. */
async function fill(p: Place, k: Opened) {
  const { hub, call } = k;
  const boxPub = publicKeyOf(loadOrCreateBoxKey(p.home));
  const sealed = (value: string) => seal(boxPub, Buffer.from(value));
  const me = k.device().caller;
  const bo = people(hub).create("Bo", "member");
  const boDevice = k.device(bo.personId, "bo-phone", [{ role: "operate", machines: "*" }]).caller;

  store(hub).machineUpsert({ machineId: M, name: "Dev box", nodeVersion: "1", status: "online", lastSeenAt: ISO, boxPubKey: b64(boxPub) } as never, "node-pub-key");
  store(hub).projectsUpsertMany(M, [
    { ...PROJECT, title: "Shop", workspaceRoot: "/srv/shop", lastActivityAt: ISO, threads: { failed: 0, idle: 0, running: 0, waiting: 0 } } as unknown as ProjectSummary,
  ]);
  await call(me, "project_settings_set", { ...PROJECT, avatarColor: "sage" });
  await call(me, "prompt_set", { id: "lead.voice", scope: "global", text: "Be brief." });

  const lead: LeadCaller = { projectRef: PROJECT, by: `lead:${M}/p1`, agent: { kind: "lead" } };
  chat(hub).add(PROJECT, { author: "human", text: "Ship dark mode this week.", request: "r1" });
  chat(hub).add(PROJECT, { author: "lead", text: "On it: one order, two agents.", source: "lead:t1:m1" });

  const n = hub.db.conn.query<{ n: number }, [string, string]>("INSERT INTO workstreams (machine_id, project_id, state, data) VALUES (?, ?, 'open', '{}') RETURNING n").get(M, "p1")!.n;
  const order = { workstreamId: `W${n}`, projectRef: PROJECT, title: "Dark mode", source: { channel: "app", by: "human" }, state: "open", createdAt: ISO, updatedAt: ISO };
  hub.db.conn.query("UPDATE workstreams SET data = ? WHERE n = ?").run(JSON.stringify(order), n);
  const task = TaskRecords.create(hub.db.conn, {
    taskId: "T0",
    projectRef: PROJECT,
    workstreamId: order.workstreamId,
    title: "Dark mode: the settings screen",
    kind: "write",
    prompt: "Add the switch.",
    state: "done",
    attempt: 1,
    createdAt: ISO,
    endedAt: ISO,
    result: { tail: "Done: the switch is in.", prUrl: "https://github.com/acme/shop/pull/7" },
  } as unknown as Task);

  await call(me, "decisions_record", { key: "db.engine", scope: { kind: "project", projectRef: PROJECT }, value: "Postgres for orders", why: "joins" });
  await call(me, "decisions_record", { key: "ui.accent", scope: { kind: "global" }, value: "Neutral accent" });
  answer(hub, lead, { op: "checklist", items: [{ text: "Dark mode", state: "doing", link: { workstreamId: order.workstreamId } }, { text: "Release notes" }] } as LeadCall);
  await call(me, "memory_set", { scope: "project", projectRef: PROJECT, text: "- The shop's tests need Postgres 16.\n" });
  await call(me, "memory_set", { scope: "user", text: "- Prefers short updates.\n" });
  const skill = "---\nname: deploy\ndescription: Ships the shop.\n---\n\n# deploy\n\nRun make ship.\n";
  await call(me, "skill_set", { scope: "project", projectRef: PROJECT, name: "deploy", text: skill, create: true });
  await call(me, "skill_set", { scope: "project", projectRef: PROJECT, name: "deploy", text: skill.replace("make ship", "make ship-it"), why: "renamed" });
  publish(hub, lead, { op: "artifact_publish", name: "sweep-report", title: "Sweep", content: "# one" } as LeadCall);
  publish(hub, lead, { op: "artifact_publish", name: "sweep-report", title: "Sweep", content: "# two\n\nMore." } as LeadCall);
  const notes = "The shop's notes, line by line.\n".repeat(2000);
  const attachment = await call<{ attachmentId: string }>(me, "attachment_put", { name: "notes.txt", mime: "text/plain", dataB64: b64(notes) });
  // As a chat message's file is: the project's, past the unused-upload cleanup.
  claim(hub, [attachment.attachmentId as never], PROJECT);
  const automation = await call(me, "automation_create", { projectRef: PROJECT, name: "Morning sweep", prompt: "Sweep the dependencies.", schedule: { cron: "0 7 * * *", tz: "Europe/Berlin" }, clientRequestId: "req-1" });

  // The vault's items, as an app saves them: sealed to the hub's box key on the way in, then under its root key.
  const sealToHub = (fields: unknown) => b64(seal(boxPub, Buffer.from(JSON.stringify(fields))));
  const login = await call<{ item: { itemId: string } }>(me, "vault_save", { kind: "login", label: "Shop", sites: ["shop.example"], sealed: sealToHub({ username: "ada", password: CANARY.password }) });
  const env = await call<{ item: { itemId: string } }>(me, "vault_save", { kind: "env", scope: "project", ...PROJECT, envName: "API_KEY", sealed: sealToHub({ value: CANARY.env }) });

  // What the hub seals to its own box key, a row of each table that holds one.
  const db = hub.db.conn;
  db.query("INSERT INTO github_app (id, data, sealed_key, sealed_client_secret, sealed_webhook_secret) VALUES (1, ?, ?, NULL, ?)").run(
    JSON.stringify({ appId: 42, slug: "shop-fleetd" }),
    sealed(CANARY.appKey),
    sealed(CANARY.webhook),
  );
  db.query("INSERT INTO github_accounts (person_id, data, sealed_access, access_expires_ms) VALUES (?, ?, ?, ?)").run(k.owner.personId, JSON.stringify({ login: "ada" }), sealed(CANARY.token), AT + 3600_000);
  db.query("INSERT INTO hub_links (link_id, machine_id, project_id, label, url, sealed, cursor, state, created_ms) VALUES ('L1', ?, 'p1', 'Other hub', 'https://other.example', ?, 0, 'ok', ?)").run(M, sealed(CANARY.link), AT);
  db.query("INSERT INTO push_relay (id, url, key_sealed) VALUES (1, 'https://relay.example', ?)").run(b64(sealed(CANARY.relay)));
  db.query("INSERT INTO mcp_oauth (machine_id, project_id, name, data, state) VALUES (?, 'p1', 'linear', ?, NULL)").run(
    M,
    JSON.stringify({ issuer: "https://linear.example", client: { id: "c1", sealedSecret: b64(sealed(CANARY.oauth)) } }),
  );

  // A browser session's recording, and one still live whose folder stays behind.
  const session = (id: string, state: string) =>
    db.query("INSERT INTO browser_sessions (session_id, machine_id, project_id, started_ms, state, bytes, data) VALUES (?, ?, 'p1', ?, ?, 11, ?)").run(
      id,
      M,
      AT,
      state,
      JSON.stringify({ sessionId: id, projectRef: PROJECT, state, threadId: "t-lead", startedAt: ISO, purpose: "Check the shop" }),
    );
  session(SESSION, "recorded");
  mkdirSync(join(p.home, "browser", SESSION), { recursive: true });
  writeFileSync(join(p.home, "browser", SESSION, "video.webm"), "video bytes");
  writeFileSync(join(p.home, "browser", SESSION, "steps.jsonl"), '{"step":1}\n');
  // What an export leaves in the home: half an upload, and a file a save was still writing.
  mkdirSync(join(p.home, "attachments", "uploads"), { recursive: true });
  writeFileSync(join(p.home, "attachments", "uploads", "u1.part"), "half");
  writeFileSync(join(p.home, "memory", "half.md.tmp"), "half");

  return { me, bo, boDevice, order, task, attachment, automation, login, env, notes };
}

type Filled = Awaited<ReturnType<typeof fill>>;

/** What the hub's own read tools answer about everything `fill` made, by a line naming each. */
async function answers(k: Opened, f: Filled, as = k.device().caller) {
  const reads: [string, unknown][] = [
    ["project_get", { ...PROJECT }],
    ["project_settings_get", { ...PROJECT }],
    ["prompt_get", { id: "lead.voice" }],
    ["chat_history", { projectRef: PROJECT }],
    ["workstream_list", { ...PROJECT }],
    ["orders_board", { projectRef: PROJECT }],
    ["order_get", { workstreamId: f.order.workstreamId }],
    ["tasks_list", { projectRef: PROJECT }],
    ["task_get", { taskId: f.task.taskId }],
    ["decisions_list", { projectRef: PROJECT }],
    ["decisions_search", { query: "postgres" }],
    ["checklist_get", { projectRef: PROJECT }],
    ["memory_get", { projectRef: PROJECT }],
    ["skills_list", { projectRef: PROJECT }],
    ["skill_get", { origin: "project", projectRef: PROJECT, name: "deploy" }],
    ["artifacts_list", { projectRef: PROJECT }],
    ["artifact_get", { projectRef: PROJECT, name: "sweep-report" }],
    ["artifact_get", { projectRef: PROJECT, name: "sweep-report", version: 1 }],
    ["attachment_get", { attachmentId: f.attachment.attachmentId, projectRef: PROJECT }],
    ["automation_list", { projectRef: PROJECT }],
    ["people_list", {}],
    ["vault_list", {}],
    ["vault_get", { itemId: f.login.item.itemId }],
    ["vault_get", { itemId: f.env.item.itemId }],
    ["browser_sessions", { projectRef: PROJECT }],
  ];
  const out: Record<string, unknown> = {};
  for (const [tool, input] of reads) out[`${tool} ${JSON.stringify(input)}`] = await k.call(as, tool, input);
  // Device sign-ins aren't carried: the people and their roles are.
  const { devices, thisDevice, ...peopleList } = out["people_list {}"] as Record<string, unknown>;
  out["people_list {}"] = peopleList;
  return out;
}

describe("a hub's export into a fresh hub", () => {
  test("the hub's own tools answer the same on the hub it loads into", async () => {
    const from = newPlace();
    const a = await start(from);
    const f = await fill(from, a);
    const before = await answers(a, f, f.me);

    // The hub runs on while it is exported.
    const exported = await exportOf(from);
    expect(exported).toMatchObject({ secrets: true, skipped: [], machines: [{ machineId: M, name: "Dev box" }] });
    expect(exported.files).toEqual([
      { area: "attachments", files: 1, bytes: 64_000 },
      { area: "recordings", files: 2, bytes: 22 },
      { area: "memory", files: 2, bytes: 62 },
      { area: "skills", files: 1, bytes: 79 },
      { area: "prompts", files: 1, bytes: expect.any(Number) },
    ]);

    const { p: to, key } = await fresh();
    const loaded = await importInto(to, from.file);
    expect(loaded).toMatchObject({ secrets: true, skipped: [], machines: [{ machineId: M, name: "Dev box" }], rows: exported.rows, files: exported.files });
    expect(loaded.people.map((x) => [x.name, x.role])).toEqual([[a.owner.name, "owner"], ["Bo", "member"]]);
    expect(readdirSync(to.home).filter((n) => n.startsWith(".import-"))).toEqual([]);

    const b = await start(to);
    // The device this hub paired before the import is the owner's who came with it.
    const me = b.hub.auth.verify(key);
    expect(me.person?.personId).toBe(a.owner.personId);
    expect(b.owner.personId).toBe(a.owner.personId);
    const after = await answers(b, f, me);
    for (const name of Object.keys(before)) expect({ name, answer: after[name] }).toEqual({ name, answer: before[name] });

    // The picture's bytes and the recording's files are where the hub reads them.
    expect(new Uint8Array(readFileSync(join(to.home, "browser", SESSION, "video.webm")))).toEqual(new Uint8Array(Buffer.from("video bytes")));
    expect(existsSync(join(to.home, "attachments", "uploads"))).toBe(false);
    expect(existsSync(join(to.home, "memory", "half.md.tmp"))).toBe(false);

    // The vault's items open under this hub's own root key, and what was sealed to the old hub's box key opens with
    // this hub's.
    const open = (id: string) => b.v.store.open(b.v.store.get(id)!);
    expect(open(f.login.item.itemId)).toMatchObject({ username: "ada", password: CANARY.password });
    expect(open(f.env.item.itemId)).toMatchObject({ value: CANARY.env });
    expect(b.v.store.keysCheck().every((x) => x.ok) && b.v.store.consistent()).toBe(true);
    const box = loadOrCreateBoxKey(to.home);
    const plain = (boxed: Uint8Array | string) => Buffer.from(openSealed(box, typeof boxed === "string" ? new Uint8Array(Buffer.from(boxed, "base64")) : new Uint8Array(boxed))!).toString();
    const row = <T>(sql: string) => b.hub.db.all<T>(sql)[0]!;
    const app = row<{ sealed_key: Uint8Array; sealed_client_secret: null; sealed_webhook_secret: Uint8Array }>("SELECT * FROM github_app");
    expect([plain(app.sealed_key), app.sealed_client_secret, plain(app.sealed_webhook_secret)]).toEqual([CANARY.appKey, null, CANARY.webhook]);
    expect(plain(row<{ sealed_access: Uint8Array }>("SELECT sealed_access FROM github_accounts").sealed_access)).toBe(CANARY.token);
    expect(plain(row<{ sealed: Uint8Array }>("SELECT sealed FROM hub_links").sealed)).toBe(CANARY.link);
    expect(plain(row<{ key_sealed: string }>("SELECT key_sealed FROM push_relay").key_sealed)).toBe(CANARY.relay);
    const oauth = JSON.parse(row<{ data: string }>("SELECT data FROM mcp_oauth").data) as { issuer: string; client: { id: string; sealedSecret: string } };
    expect([oauth.issuer, oauth.client.id, plain(oauth.client.sealedSecret)]).toEqual(["https://linear.example", "c1", CANARY.oauth]);

    // Machines aren't carried: the one the projects are keyed by is there offline, with no key to link with.
    expect(b.hub.db.all<{ data: string }>("SELECT data FROM machines").map((m) => JSON.parse(m.data))).toEqual([{ machineId: M, name: "Dev box", nodeVersion: "1", status: "offline", lastSeenAt: ISO }]);
    expect(b.hub.db.all("SELECT * FROM node_keys")).toEqual([]);
    // Nor are keys: the only one is this hub's own device.
    expect(b.hub.db.all<{ name: string }>("SELECT name FROM agent_keys").map((x) => x.name)).toEqual(["laptop"]);
    // The numbers go on from where the old hub's were.
    const next = b.hub.db.conn.query<{ n: number }, []>("INSERT INTO workstreams (machine_id, project_id, state, data) VALUES ('devbox', 'p1', 'open', '{}') RETURNING n").get()!.n;
    expect(`W${next}`).toBe(`W${Number(f.order.workstreamId.slice(1)) + 1}`);
  });

  test("the file holds no secret in the clear and neither hub's own keys", async () => {
    const from = newPlace();
    const a = await start(from);
    await fill(from, a);
    await exportOf(from);
    const text = await textOf(from.file);
    const raw = readFileSync(from.file).toString("latin1");
    for (const [name, value] of Object.entries(CANARY)) {
      expect({ name, found: text.includes(value) || raw.includes(value) || text.includes(b64(value)) }).toEqual({ name, found: false });
    }
    expect(text).not.toContain(PASS);
    const keys: [string, Uint8Array][] = [
      ["the box key", loadOrCreateBoxKey(from.home)],
      ["the vault's root key", a.v.keys.active().key],
    ];
    for (const [name, key] of keys) {
      const forms = [b64(key), b64(key).replace(/=+$/, ""), Buffer.from(key).toString("hex"), Buffer.from(key).toString("latin1")];
      expect({ name, found: forms.some((form) => text.includes(form) || raw.includes(form)) }).toEqual({ name, found: false });
    }
    // What an export keeps of them: the items' and the rows' places, each value under the export's key.
    expect(text).toContain('"key_id":"export"');
    expect(text).toContain('"sealed_key":{"$sealed":"');
    expect(text).not.toContain(`"key_id":"${a.v.keys.active().id}"`);
    const paths = (await entriesOf(from.file)).map(([path]) => path);
    expect(paths[0]).toBe("fleetd-export.json");
    expect(paths.slice(-2)).toEqual(["manifest.json", "manifest.sha256"]);
    expect(paths.filter((path) => /agent_keys|node_keys|pair_codes|push_devices|vault_keys|enroll_tokens/.test(path))).toEqual([]);
  });

  test("without the secrets: export leaves them out, and import says what it didn't load", async () => {
    const from = newPlace();
    const a = await start(from);
    const f = await fill(from, a);
    const bare = join(from.dir, "export-bare.tar");
    expect(await exportOf(from, { secrets: false, file: bare })).toMatchObject({ secrets: false });
    const { header, manifest } = await checkExport(bare);
    expect(header.secrets).toBeUndefined();
    expect(manifest.secretsLeftOut).toBe(true);
    expect(manifest.tables.map((t) => t.name).filter((t) => SECRET_TABLES.includes(t))).toEqual([]);
    expect((await textOf(bare)).includes("$sealed")).toBe(false);
    const one = await fresh();
    expect(await importInto(one.p, bare)).toMatchObject({ secrets: false, skipped: ["the secrets, which the export was written without"] });

    // A whole export, loaded by someone who doesn't have its passphrase.
    await exportOf(from);
    const two = await fresh();
    const loaded = await importInto(two.p, from.file, { secrets: false });
    expect(loaded).toMatchObject({ secrets: false, skipped: ["the secrets: vault items, the GitHub App's keys, connected accounts and hub links"] });
    const b = await start(two.p);
    expect(b.hub.db.all("SELECT 1 FROM vault_items UNION ALL SELECT 1 FROM github_app UNION ALL SELECT 1 FROM hub_links")).toEqual([]);
    expect((await b.call(b.device().caller, "decisions_list", { projectRef: PROJECT })).decisions.map((d: { key: string }) => d.key)).toEqual(["db.engine"]);
    expect((await b.call(b.device().caller, "task_get", { taskId: f.task.taskId })).task.title).toBe("Dark mode: the settings screen");
  });
});

test("an export an older fleetd wrote: its rows go through the migrations it hadn't run", async () => {
  // A hub as it was before `project_setup_changes`: two tables and a column younger than it.
  const cut = MIGRATIONS.findIndex((m) => m.name === "202611111541_project_setup_changes");
  const from = newPlace();
  rmSync(join(from.home, "hub.sqlite"));
  const old = new Database(join(from.home, "hub.sqlite"), { create: true, strict: true });
  migrate(old, MIGRATIONS.slice(0, cut));
  old.query("INSERT INTO people (person_id, name, role, created_ms) VALUES ('p_ada', 'Ada', 'owner', ?)").run(AT);
  old.query("INSERT INTO decisions (key, scope_kind, scope_id, state, source, at_ms, data) VALUES ('ui.accent', 'global', '', 'active', 'human', ?, ?)").run(
    AT,
    JSON.stringify({ decisionId: "D1", key: "ui.accent", scope: { kind: "global" }, value: "Neutral accent", state: "active", source: "human", at: ISO }),
  );
  old.close();
  expect(await exportOf(from, { secrets: false })).toMatchObject({ skipped: [] });
  const { manifest } = await checkExport(from.file);
  expect(manifest.schema.at(-1)?.name).toBe(MIGRATIONS[cut - 1]!.name);
  expect(manifest.tables.some((t) => t.name === "project_setup_changes")).toBe(false);

  const { p: to } = await fresh();
  expect(await importInto(to, from.file)).toMatchObject({ skipped: ["the secrets, which the export was written without"] });
  const b = await start(to);
  expect(b.owner).toMatchObject({ personId: "p_ada", name: "Ada" });
  expect(b.hub.db.all<{ key: string }>("SELECT key FROM decisions")).toEqual([{ key: "ui.accent" }]);
  // The hub keeps its own schema: every migration, the younger tables there and empty.
  expect(b.hub.db.all<{ name: string }>("SELECT name FROM migrations_applied ORDER BY name").map((m) => m.name)).toEqual(MIGRATIONS.map((m) => m.name));
  expect(b.hub.db.all("SELECT proposed FROM project_setup_clones")).toEqual([]);
});

const refusal = async (p: Promise<unknown>): Promise<TransferError> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof TransferError) return e;
    throw e;
  }
  throw new Error("expected a refusal");
};

describe("an import that can't go through changes nothing", () => {
  /** A filled hub's export, and a fresh hub with its state before anything is tried on it. */
  async function pair() {
    const from = newPlace();
    const a = await start(from);
    await fill(from, a);
    await exportOf(from);
    const { p: to } = await fresh();
    return { from, to, before: stateOf(to) };
  }

  test("one byte changed anywhere in the file: every checksum is checked before the hub is touched", async () => {
    const { from, to, before } = await pair();
    const good = readFileSync(from.file);
    const entries = await entriesOf(from.file);
    // One byte inside each kind of entry, by where it starts: the header, a table's part, a file, the manifest and its
    // checksum, and the tar's own header of an entry.
    const offsets: [string, number][] = [];
    let at = 0;
    for (const [path, bytes] of entries) {
      const kind = path.startsWith("tables/") ? "a table's part" : path.startsWith("files/") ? "a file" : path;
      if (!offsets.some(([k]) => k === kind)) offsets.push([kind, at + 512 + Math.floor(bytes.length / 2)]);
      at += 512 + Math.ceil(bytes.length / 512) * 512;
    }
    offsets.push(["an entry's tar header", 512 + Math.ceil(entries[0]![1].length / 512) * 512 + 130]);
    expect(offsets.map(([k]) => k)).toEqual(["fleetd-export.json", "a table's part", "a file", "manifest.json", "manifest.sha256", "an entry's tar header"]);
    for (const [kind, offset] of offsets) {
      const bad = Buffer.from(good);
      bad[offset]! ^= 0x01;
      const file = join(from.dir, `export-bad-${offset}.tar`);
      writeFileSync(file, bad);
      const e = await refusal(importInto(to, file));
      // A header that no longer reads as one is a file that isn't an export; anything else is damage.
      if (kind === "fleetd-export.json") expect(["damaged", "not_an_export"]).toContain(e.reason);
      else expect({ kind, reason: e.reason, line: e.message.endsWith("Nothing was changed; export the hub again.") }).toEqual({ kind, reason: "damaged", line: true });
      expect({ kind, state: stateOf(to) }).toEqual({ kind, state: before });
    }
  });

  test("a file that changes after it was checked: the rows staged so far are thrown away", async () => {
    const { from, to, before } = await pair();
    const checked = await checkExport(from.file);
    const entries = await entriesOf(from.file);
    // The last table's part, so every table before it is already staged when the change is met.
    let at = 0;
    let offset = 0;
    for (const [path, bytes] of entries) {
      if (path.startsWith("files/") && offset === 0) offset = at - 300;
      at += 512 + Math.ceil(bytes.length / 512) * 512;
    }
    for (const where of [offset, readFileSync(from.file).length - 2000]) {
      const bad = Buffer.from(readFileSync(from.file));
      bad[where]! ^= 0x01;
      const file = join(from.dir, `export-late-${where}.tar`);
      writeFileSync(file, bad);
      expect((await refusal(importHub({ file, home: to.home, checked }))).reason).toBe("damaged");
      expect(stateOf(to)).toEqual(before);
    }
    // The file as it was still loads.
    expect((await importInto(to, from.file)).rows).toBeGreaterThan(20);
  });

  test("a newer format version is refused with the line that says to update fleetd", async () => {
    const { from, to, before } = await pair();
    const newer = join(from.dir, "export-newer.tar");
    await rewritten(from.file, newer, { header: (h) => void Object.assign(h, { version: 2, fleetd: "9.0.0", somethingNew: true }) });
    const e = await refusal(importInto(to, newer));
    expect(e.reason).toBe("newer");
    expect(e.message).toBe("That export is format version 2, written by fleetd 9.0.0; this fleetd reads up to version 1. Update fleetd (fleetd update), then import it again.");
    expect(stateOf(to)).toEqual(before);
  });

  test("a hub's database a newer fleetd migrated is refused the same way", async () => {
    const { from, to, before } = await pair();
    const newer = join(from.dir, "export-newer-schema.tar");
    await rewritten(from.file, newer, { manifest: (m) => void m.schema.push({ name: "209901010000_from_the_future", sha256: "0".repeat(64) }) });
    const e = await refusal(importInto(to, newer));
    expect(e.reason).toBe("newer");
    expect(e.message).toBe(
      "That export was written by fleetd 1.2.3, which is newer than this one (this fleetd lacks its migration 209901010000_from_the_future). Update fleetd (fleetd update), then import it again.",
    );
    expect(stateOf(to)).toEqual(before);
  });

  test("a hub that already has data is refused, and says what it has", async () => {
    const { from, before } = await pair();
    // The hub the export came from, and a hub with one decision: neither is fresh.
    const own = stateOf(from);
    const e = await refusal(importInto(from, from.file));
    expect(e.reason).toBe("refused");
    expect(e.message).toStartWith("This hub already has data (projects, chat messages, orders, tasks, ");
    expect(e.message).toEndWith("An export loads into a fresh hub only, before any project is added or machine with projects joins. Nothing was changed.");
    expect(stateOf(from)).toEqual(own);

    const { p: used } = await fresh();
    const k = await start(used);
    await k.call(k.device().caller, "decisions_record", { key: "a.b", scope: { kind: "global" }, value: "x" });
    stop(k);
    const state = stateOf(used);
    expect((await refusal(importInto(used, from.file))).message).toStartWith("This hub already has data (decisions).");
    expect(stateOf(used)).toEqual(state);

    const { p: invited } = await fresh();
    const k2 = await start(invited);
    people(k2.hub).create("Cy", "member");
    stop(k2);
    expect((await refusal(importInto(invited, from.file))).message).toStartWith("This hub already has data (people).");
    expect(before.rows.people).toHaveLength(1);
  });

  test("the wrong passphrase opens nothing", async () => {
    const { from, to, before } = await pair();
    await expect(importInto(to, from.file, { passphrase: "not the passphrase" })).rejects.toThrow("wrong passphrase");
    expect(stateOf(to)).toEqual(before);
  });
});

test("every carried table's rows arrive as they left", async () => {
  const from = newPlace();
  const a = await start(from);
  await fill(from, a);
  stop(a);
  await exportOf(from);
  const { p: to } = await fresh();
  await importInto(to, from.file);
  const [was, is] = [rowsOf(from.home), rowsOf(to.home)];
  // What differs by design: the secrets (sealed again to the new hub's keys, checked above), the machine (offline, no
  // key), and what an export leaves out.
  const differs = ["github_accounts", "github_app", "hub_links", "mcp_oauth", "push_relay", "vault_items", "machines", "vault_settings"];
  const left = ["agent_keys", "node_keys", "vault_keys", "migrations_applied"];
  for (const table of Object.keys(was)) {
    if (differs.includes(table) || left.includes(table)) continue;
    expect({ table, rows: is[table] }).toEqual({ table, rows: was[table] });
  }
  for (const table of differs.filter((t) => t !== "vault_settings")) expect({ table, rows: is[table]?.length }).toEqual({ table, rows: was[table]?.length });
  expect(is.node_keys).toEqual([]);
  expect(is.migrations_applied).toEqual(was.migrations_applied);
});
