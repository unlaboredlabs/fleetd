// The one-team-vault migration (src/hub/store/migrations/<ts>_one_team_vault.sql, then migrate.ts `copyTeamVars` once
// the key is open) on a hub's rows from before it, sealed under its real root key: hub and project logins, cards and
// addresses join the team vault (a clashing label gets its project's name); a one-person hub's own items join it and its
// variables go to each live project without one; on a hub with more people, only what was shared or paid with moves,
// and the rest is set aside for its owner. Nothing is deleted, every value opens as before, and an older export loaded
// with `fleetd import` ends the same.
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS } from "../src/gen/migrations.ts";
import { migrate } from "../src/hub/store/migrations.ts";
import { checkExport } from "../src/hub/transfer/import.ts";
import { sealItem } from "../src/hub/vault/crypto.ts";
import { scopeKey } from "../src/hub/vault/item.ts";
import { VaultKeys } from "../src/hub/vault/keys.ts";
import { copyTeamVars } from "../src/hub/vault/migrate.ts";
import { summary } from "../src/hub/vault/items.ts";
import { olderExportOf } from "./project_names_kit.ts";
import { AT, importInto, open, type Opened, place, type Place } from "./transfer-kit.ts";

const TEAM = MIGRATIONS.findIndex((m) => m.name.endsWith("_one_team_vault"));
const M = "devbox";
const ID = (n: number) => `V${n.toString(16).padStart(32, "0")}`;
const ADA = "p_ada";
const BO = "p_bo";

type Old = {
  kind: "login" | "card" | "address" | "env";
  scope: "person" | "project" | "order" | "hub";
  person?: string;
  project?: string;
  env?: string;
  label: string;
  value: Record<string, string>;
  by?: string;
  deleted?: boolean;
};
type Seed = {
  people: { id: string; removed?: boolean }[];
  projects: { id: string; title: string; archived?: boolean; card?: number }[];
  items: Old[];
  shares?: [item: number, project: string][];
};

const places: Place[] = [];
const opened: Opened[] = [];
afterEach(() => {
  for (const k of opened.splice(0)) k.close();
  for (const p of places.splice(0)) p.done();
});

/** A hub's database as it was before the migration, at `p`, with `seed`'s rows sealed under `p`'s root key. */
async function oldHub(s: Seed): Promise<Place> {
  const p = place();
  places.push(p);
  rmSync(join(p.home, "hub.sqlite"), { force: true });
  const db = new Database(join(p.home, "hub.sqlite"), { create: true, strict: true });
  migrate(db, MIGRATIONS.slice(0, TEAM));
  const keys = new VaultKeys(p.vaultDir, { scryptN: 1024 });
  await keys.load(true);
  const root = keys.active();
  for (const [i, x] of s.people.entries()) {
    db.query("INSERT INTO people (person_id, name, role, created_ms, removed_ms) VALUES (?, ?, ?, ?, ?)").run(x.id, x.id, i === 0 ? "owner" : "member", AT + i, x.removed ? AT + 10 : null);
  }
  for (const x of s.projects) {
    const data = { machineId: M, projectId: x.id, title: x.title, workspaceRoot: `/srv/${x.id}`, lastActivityAt: new Date(AT).toISOString() };
    db.query("INSERT INTO projects (machine_id, project_id, search, last_activity_at, data) VALUES (?, ?, ?, ?, ?)").run(M, x.id, x.title.toLowerCase(), data.lastActivityAt, JSON.stringify(data));
    db.query("INSERT INTO project_settings (machine_id, project_id, archived_ms, card_ref) VALUES (?, ?, ?, ?)").run(
      M,
      x.id,
      x.archived ? AT : null,
      x.card !== undefined ? `vault:${ID(x.card)}` : null,
    );
  }
  for (const [i, x] of s.items.entries()) {
    const row = {
      itemId: ID(i + 1),
      kind: x.kind,
      scope: x.scope,
      ...(x.person !== undefined ? { personId: x.person } : {}),
      ...(x.project !== undefined ? { machineId: M, projectId: x.project } : {}),
      version: 1,
    };
    const sealed = sealItem(root.key, root.id, { itemId: row.itemId, kind: x.kind, scopeKey: scopeKey(row), version: 1 }, new Uint8Array(Buffer.from(JSON.stringify(x.value))));
    db.query(
      `INSERT INTO vault_items (item_id, kind, scope, person_id, machine_id, project_id, workstream_id, env_name, label, meta, sealed, key_id, version,
         created_ms, created_by, updated_ms, updated_by, deleted_ms) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    ).run(
      row.itemId,
      x.kind,
      x.scope,
      x.person ?? null,
      x.project !== undefined ? M : null,
      x.project ?? null,
      x.env ?? null,
      x.label,
      JSON.stringify({ secret: x.kind === "env" ? true : undefined, source: { kind: "typed" } }),
      sealed,
      root.id,
      AT,
      x.by ?? x.person ?? ADA,
      AT,
      x.by ?? x.person ?? ADA,
      x.deleted ? AT : null,
    );
  }
  for (const [n, projectId] of s.shares ?? []) {
    db.query("INSERT INTO vault_shares (item_id, machine_id, project_id, by_person, at_ms) VALUES (?, ?, ?, ?, ?)").run(ID(n), M, projectId, BO, AT);
  }
  db.close();
  return p;
}

/** The hub on `p` started (its migrations run), the copies made as its start makes them. */
async function started(p: Place): Promise<Opened> {
  const k = await open(p);
  opened.push(k);
  copyTeamVars(k.hub);
  return k;
}

/** Every item as it reads after: where it is, its label, and its value opened under the hub's own key. */
function items(k: Opened) {
  return k.v.store
    .select("1", [])
    .concat(k.v.store.select("1", [], true))
    .map((r) => ({
      itemId: r.itemId,
      scope: r.scope,
      label: r.label,
      ...(r.personId !== undefined ? { personId: r.personId } : {}),
      ...(r.projectId !== undefined ? { projectId: r.projectId } : {}),
      ...(r.envName !== undefined ? { envName: r.envName } : {}),
      ...(r.deletedMs !== undefined ? { deleted: true } : {}),
      value: k.v.store.open(r),
    }))
    .sort((a, b) => (a.itemId + a.projectId < b.itemId + b.projectId ? -1 : 1));
}
const byId = (k: Opened) => new Map(items(k).filter((x) => /^V0+[0-9a-f]{1,2}$/.test(x.itemId)).map((x) => [x.itemId, x]));
const copies = (k: Opened) => items(k).filter((x) => !/^V0+[0-9a-f]{1,2}$/.test(x.itemId));

const LOGIN = { username: "ada", password: "planted-pw" };
const CARD = { number: "4242424242424242", month: "04", year: "2031" };
const HOME = { line1: "1 Main St", country: "US" };

test("the migration runs after every one before it", () => {
  expect(TEAM).toBeGreaterThan(0);
  expect(MIGRATIONS.slice(0, TEAM).every((m) => m.name < MIGRATIONS[TEAM]!.name)).toBe(true);
});

test("hub and project logins, cards and addresses join the team vault; a clashing label gets its project's name", async () => {
  const p = await oldHub({
    people: [{ id: ADA }, { id: BO }],
    projects: [{ id: "p1", title: "Storefront" }, { id: "p2", title: "Blog" }],
    items: [
      { kind: "login", scope: "hub", person: ADA, label: "Shop", value: LOGIN },
      { kind: "login", scope: "project", project: "p1", label: "shop", value: { password: "p1-pw" }, by: BO },
      { kind: "card", scope: "project", project: "p2", label: "Visa", value: CARD },
      { kind: "address", scope: "project", project: "p1", label: "Office", value: HOME },
      { kind: "address", scope: "project", project: "p2", label: "Office", value: { ...HOME, line1: "2 Side St" } },
      { kind: "env", scope: "project", project: "p1", env: "API_KEY", label: "API_KEY", value: { value: "planted-env" } },
      { kind: "login", scope: "project", project: "p2", label: "Shop", value: { password: "gone" }, deleted: true },
    ],
  });
  const k = await started(p);
  const got = byId(k);
  expect([...got.values()].map((x) => [x.itemId, x.scope, x.label, x.personId ?? null, x.projectId ?? null])).toEqual([
    [ID(1), "hub", "Shop", ADA, null],
    [ID(2), "hub", "shop (Storefront)", BO, null],
    [ID(3), "hub", "Visa", ADA, null],
    [ID(4), "hub", "Office (Storefront)", ADA, null],
    [ID(5), "hub", "Office (Blog)", ADA, null],
    [ID(6), "project", "API_KEY", null, "p1"],
    // In the trash: it moves too, its label as it was.
    [ID(7), "hub", "Shop", ADA, null],
  ]);
  expect(got.get(ID(2))!.value).toEqual({ password: "p1-pw" });
  expect(got.get(ID(5))!.value).toEqual({ ...HOME, line1: "2 Side St" });
  // Every project's work fills them now.
  expect(k.v.usable().map((r) => r.itemId).sort()).toEqual([ID(1), ID(2), ID(3), ID(4), ID(5)]);
  // Its creator changes it now; another member doesn't.
  const bo = { caller: { keyId: "k", grants: [{ role: "operate", machines: "*" }] } as never, person: BO, admin: false, human: true };
  expect([k.v.canEdit(bo, k.v.store.get(ID(2))!), k.v.canEdit(bo, k.v.store.get(ID(3))!)]).toEqual([true, false]);
  // No value was sealed again: the envelopes are the ones from before, read under the scope they were sealed with.
  expect(k.v.store.get(ID(2))!.sealedScope).toBe(`project:${M}/p1`);
  expect(k.v.store.get(ID(1))!.sealedScope).toBeUndefined();
  // The next write seals it under its new scope.
  k.v.store.update(k.v.store.get(ID(2))!, { kind: "login", scope: "hub", personId: BO, label: "shop (Storefront)", meta: k.v.store.get(ID(2))!.meta }, { password: "p1-pw" }, BO, AT);
  expect(k.v.store.get(ID(2))!.sealedScope).toBeUndefined();
  expect(k.v.store.open(k.v.store.get(ID(2))!)).toEqual({ password: "p1-pw" });
  expect(k.hub.db.all("SELECT name FROM sqlite_master WHERE name = 'vault_shares'")).toEqual([]);
});

test("one live person: their logins, cards and addresses join the team vault, their variables go to each live project without one", async () => {
  const p = await oldHub({
    people: [{ id: ADA }, { id: BO, removed: true }],
    projects: [{ id: "p1", title: "Storefront" }, { id: "p2", title: "Blog" }, { id: "p3", title: "Old", archived: true }, { id: "p4", title: "Docs" }],
    items: [
      { kind: "login", scope: "person", person: ADA, label: "Mail", value: LOGIN },
      { kind: "card", scope: "person", person: ADA, label: "Visa", value: CARD },
      { kind: "env", scope: "person", person: ADA, env: "OPENAI_KEY", label: "OPENAI_KEY", value: { value: "ada-key" } },
      { kind: "env", scope: "project", project: "p1", env: "OPENAI_KEY", label: "OPENAI_KEY", value: { value: "p1-key" } },
      // A removed person's: stays theirs, set aside.
      { kind: "login", scope: "person", person: BO, label: "Bo's", value: LOGIN },
    ],
  });
  const k = await started(p);
  const got = byId(k);
  expect([got.get(ID(1))!.scope, got.get(ID(2))!.scope, got.get(ID(5))!.scope]).toEqual(["hub", "hub", "person"]);
  // The row itself goes to the first project without the name; p1 keeps its own, the archived p3 gets none.
  expect([got.get(ID(3))!.scope, got.get(ID(3))!.projectId, got.get(ID(3))!.value]).toEqual(["project", "p2", { value: "ada-key" }]);
  expect(got.get(ID(4))!.value).toEqual({ value: "p1-key" });
  expect(copies(k).map((x) => [x.scope, x.projectId, x.envName, x.value])).toEqual([["project", "p4", "OPENAI_KEY", { value: "ada-key" }]]);
  expect(k.v.store.setting("team_vault_copies")).toBeUndefined();
  // Copied once: a second start makes no more.
  expect(copyTeamVars(k.hub)).toBe(0);
});

test("more people: what was shared or paid with joins the team vault, the rest is set aside for its owner", async () => {
  const p = await oldHub(multi());
  const k = await started(p);
  checkMulti(k);
});

/** A hub with two people: Bo's items shared, paid with or kept to himself, and one of Ada's. */
function multi(): Seed {
  return {
    people: [{ id: ADA }, { id: BO }],
    projects: [{ id: "p1", title: "Storefront" }, { id: "p2", title: "Blog", card: 2 }],
    items: [
      { kind: "login", scope: "person", person: BO, label: "Bo's shop", value: LOGIN },
      { kind: "card", scope: "person", person: BO, label: "Bo's Visa", value: CARD },
      { kind: "address", scope: "person", person: BO, label: "Bo's home", value: HOME },
      { kind: "env", scope: "person", person: BO, env: "BO_TOKEN", label: "BO_TOKEN", value: { value: "bo-tok" } },
      { kind: "env", scope: "project", project: "p2", env: "BO_TOKEN", label: "BO_TOKEN", value: { value: "p2-tok" } },
      { kind: "env", scope: "person", person: BO, env: "BO_PRIVATE", label: "BO_PRIVATE", value: { value: "bo-private" } },
      { kind: "login", scope: "person", person: ADA, label: "Ada's bank", value: LOGIN },
    ],
    shares: [
      [1, "p1"],
      [4, "p1"],
      [4, "p2"],
    ],
  };
}

function checkMulti(k: Opened) {
  const got = byId(k);
  expect([...got.values()].map((x) => [x.itemId, x.scope, x.personId ?? null, x.projectId ?? null])).toEqual([
    [ID(1), "hub", BO, null],
    [ID(2), "hub", BO, null],
    [ID(3), "person", BO, null],
    [ID(4), "project", null, "p1"],
    [ID(5), "project", null, "p2"],
    [ID(6), "person", BO, null],
    [ID(7), "person", ADA, null],
  ]);
  // p2 had a BO_TOKEN of its own: it keeps it, and gets no copy.
  expect(got.get(ID(5))!.value).toEqual({ value: "p2-tok" });
  expect(copies(k)).toEqual([]);
  // Set aside: only its owner lists it, and nothing fills or delivers it.
  const viewer = (person: string) => ({ caller: { keyId: "k", grants: [{ role: "admin", machines: "*" }] } as never, person, admin: true, human: true });
  const listed = (person: string) => k.v.store.select("scope = 'person'", []).filter((r) => k.v.canSee(viewer(person), r)).map((r) => r.itemId);
  expect(listed(BO)).toEqual([ID(3), ID(6)].sort());
  expect(listed(ADA)).toEqual([ID(7)]);
  expect(k.v.usable().map((r) => r.itemId).sort()).toEqual([ID(1), ID(2)]);
  expect(summary(k.hub, viewer(BO), k.v.store.get(ID(3))!)).toMatchObject({ scope: "person", canEdit: true });
  // Nothing was deleted, and every value opens as before.
  expect(got.get(ID(3))!.value).toEqual(HOME);
  expect(got.get(ID(6))!.value).toEqual({ value: "bo-private" });
  expect(got.get(ID(4))!.value).toEqual({ value: "bo-tok" });
}

test("an older export loaded with fleetd import ends as the hub would have", async () => {
  const from = await oldHub(multi());
  const older = await olderExportOf(from);
  const { manifest } = await checkExport(older);
  expect(manifest.tables.find((t) => t.name === "vault_shares")?.rows).toBe(3);
  const to = place();
  places.push(to);
  (await open(to)).close();
  const loaded = await importInto(to, older);
  expect(loaded.skipped).toEqual([]);
  const k = await started(to);
  checkMulti(k);
  const inPlace = await started(await oldHub(multi()));
  const shape = (x: Opened) => items(x).map(({ itemId, scope, label, personId, projectId, envName, value }) => ({ itemId, scope, label, personId, projectId, envName, value }));
  expect(shape(k)).toEqual(shape(inPlace));
});
