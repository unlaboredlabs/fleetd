// The workspace's audit log (hub/audit): each kind lands with who did it, members and agent keys can't read it, the
// CLI's CSV is the app's for the same rows, and a page stays quick over a year of rows.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditCsv } from "../../app/desktop/src/shared/auditCsv.ts";
import { start } from "../src/hub/audit/loops.ts";
import { auditLog, AUDIT_KEEP_MS } from "../src/hub/audit/store.ts";
import type { Hub } from "../src/hub/api/hub.ts";
import type { RouteContext } from "../src/hub/http/route.ts";
import { pair } from "../src/hub/pair/http.ts";
import { people } from "../src/hub/people/store.ts";
import { events } from "../src/hub/store/events.ts";
import { store } from "../src/hub/store/hub_store.ts";
import { vault } from "../src/hub/vault/index.ts";
import { auditCommand, timeArg } from "../src/cli/audit.ts";
import type { AuditEvent, AuditListOutput, ProjectSummary } from "../src/shared/contracts.ts";
import { refusal, testHub } from "./people-kit.ts";
import { PROJECT as VAULT_BOT, vaultHub } from "./vault-kit.ts";
import { testHub as fileHub } from "./hub-helpers.ts";

const URL_ = "http://devbox.example.ts.net:4790";
const BOT = { machineId: "lab-a", projectId: "p1" };

function rig() {
  // A home of its own: Updates' settings are a file in it, never in the tree the tests run from.
  const t = testHub({ url: URL_, home: mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "audit-")) });
  store(t.hub).projectsUpsertMany(BOT.machineId, [
    { ...BOT, title: "Shop", workspaceRoot: "/srv/shop", lastActivityAt: new Date(t.clock.ms).toISOString(), threads: { failed: 0, idle: 0, running: 0, waiting: 0 } } as unknown as ProjectSummary,
  ]);
  start(t.hub);
  const ownerId = people(t.hub).list(false)[0]!.personId;
  const owner = t.device(undefined, ownerId, "desk");
  const list = (input: Record<string, unknown> = {}) => t.call<AuditListOutput>(owner, "audit_list", input);
  return { ...t, ownerId, owner, list };
}

async function redeem(hub: Hub, code: string, deviceName: string) {
  const req = new Request(`${URL_}/pair`, { method: "POST", body: JSON.stringify({ code, deviceName }) });
  const res = (await pair(req, { hub, ip: "100.64.0.1", params: {} } as unknown as RouteContext)) as Response;
  const { key } = (await res.json()) as { key: string };
  return hub.auth.verify(key);
}

const brief = (e: AuditEvent) => [e.kind, e.actor.kind, e.actor.name, e.bot?.name ?? null, e.outcome, e.summary];

test("people, invites and devices land with whoever did them, newest first", async () => {
  const k = rig();
  const ownerName = people(k.hub).get(k.ownerId)!.name;
  const out = await k.call<{ code: string; person: { personId: string } }>(k.owner, "invite_create", { name: "Alice" });
  const alice = await redeem(k.hub, out.code, "Alice's laptop");
  const aliceId = alice.person!.personId;
  await k.call(k.owner, "person_set", { personId: aliceId, role: "admin" });
  const phone = k.device([{ role: "operate", machines: "*" }], aliceId, "Alice's phone");
  await k.call(alice, "device_revoke", { keyId: phone.keyId });
  await k.call(k.owner, "person_remove", { personId: aliceId });
  const { events: rows } = await k.list();
  expect(rows.map(brief).reverse()).toEqual([
    ["invite.created", "person", ownerName, null, "ok", "Invited Alice as member"],
    ["person.joined", "person", "Alice", null, "ok", "Alice joined the workspace on Alice's laptop"],
    ["device.added", "person", "Alice", null, "ok", "Added the device Alice's laptop"],
    ["person.role", "person", ownerName, null, "ok", "Changed Alice's role from member to admin"],
    ["device.revoked", "person", "Alice", null, "ok", "Signed out device Alice's phone"],
    ["person.removed", "person", ownerName, null, "ok", "Removed Alice from the workspace"],
  ]);
  expect(rows.every((r, i) => i === 0 || r.n < rows[i - 1]!.n)).toBe(true);
  expect(rows.find((r) => r.kind === "person.joined")?.actor.personId).toBe(aliceId);
  // A row keeps the name it had: Alice is gone, her rows still name her.
  expect(rows.filter((r) => r.actor.name === "Alice").length).toBe(3);
});

test("a bot's safety settings and the workspace's settings are rows on the bot by name; a member's refused change is one too", async () => {
  const k = rig();
  const ownerName = people(k.hub).get(k.ownerId)!.name;
  await k.call(k.owner, "cap_set", { project: { projectRef: BOT, maxAgents: 3 } });
  const bob = people(k.hub).create("Bob", "member");
  const bobDevice = k.device([{ role: "operate", machines: "*" }], bob.personId, "Bob's laptop");
  await refusal(k.call(bobDevice, "hub_update_settings", { auto: true }));
  await k.call(k.owner, "hub_update_settings", { auto: false });
  const { events: rows } = await k.list();
  expect(rows.map(brief).reverse()).toEqual([
    ["bot.settings", "person", ownerName, "Shop", "ok", "Set max agents to 3"],
    ["workspace.settings", "person", "Bob", null, "refused", "Tried to change how the workspace updates"],
    ["workspace.settings", "person", ownerName, null, "ok", "Changed how the workspace updates"],
  ]);
  expect(rows.find((r) => r.kind === "bot.settings")?.bot).toEqual({ ...BOT, name: "Shop" });
});

test("vault uses, merges and approvals answered come from what the workspace already records", async () => {
  const k = rig();
  const at = k.clock.ms;
  const v = vault(k.hub);
  v.used({ atMs: at, itemId: "vi_1", action: "reveal", outcome: "ok", personId: k.ownerId, data: { label: "Stripe login" } });
  const fill = v.used({ atMs: at, itemId: "vi_1", action: "fill", outcome: "pending", personId: k.ownerId, ...BOT, threadId: "t1", data: { label: "Stripe login", site: "stripe.com" } });
  // A pending fill isn't a row until it settles.
  expect((await k.list({ kind: "vault" })).events.length).toBe(1);
  v.audit.settle(fill, "ok", {});
  v.usedEvent(fill, { ...v.audit.get(fill)!, outcome: "ok" });
  v.used({ atMs: at, itemId: "vi_1", action: "fill_refused", outcome: "refused", ...BOT, threadId: "t1", data: { label: "Stripe login", site: "evil.example" } });
  events(k.hub).append({ at: new Date(at).toISOString(), type: "pr.merged", ...BOT, summary: "Merged", data: { prNumber: 12, repo: "acme/shop" } });
  const ownerName = people(k.hub).get(k.ownerId)!.name;
  const vaultRows = (await k.list({ kind: "vault" })).events.map(brief).reverse();
  expect(vaultRows).toEqual([
    ["vault.revealed", "person", ownerName, null, "ok", 'Showed "Stripe login"'],
    ["vault.filled", "agent", `${ownerName}'s agent`, "Shop", "ok", 'Filled "Stripe login" on stripe.com'],
    ["vault.refused", "agent", "An agent", "Shop", "refused", 'Was refused a fill of "Stripe login" on evil.example'],
  ]);
  expect((await k.list({ kind: "pr.merged" })).events.map(brief)).toEqual([
    ["pr.merged", "workspace", "fleetd's merge train", "Shop", "ok", "Merged #12 into acme/shop"],
  ]);
  // Filters: by bot, by person, by time.
  expect((await k.list({ projectId: BOT.projectId })).events.length).toBe(3);
  expect((await k.list({ personId: k.ownerId })).events.length).toBe(2);
  expect((await k.list({ since: new Date(at + 1).toISOString() })).events.length).toBe(0);
});

test("only an owner's or admin's own device reads the log: members and agent keys are refused", async () => {
  const k = rig();
  const bob = people(k.hub).create("Bob", "member");
  const member = k.device([{ role: "operate", machines: "*" }], bob.personId, "Bob's laptop");
  expect((await refusal(k.call(member, "audit_list"))).code).toBe("forbidden");
  expect((await refusal(k.call(k.agent(), "audit_list"))).code).toBe("forbidden");
  const admin = people(k.hub).create("Ann", "admin");
  expect((await k.call<AuditListOutput>(k.device(undefined, admin.personId, "Ann's laptop"), "audit_list")).events).toEqual([]);
});

test("fleetd audit --csv is the app's export of the same rows, and the plain list filters by name", async () => {
  const t = fileHub();
  try {
    const log = auditLog(t.hub);
    for (let i = 0; i < 7; i++) {
      log.write({
        atMs: t.clock.ms + i * 60_000,
        kind: i % 2 === 0 ? "vault.revealed" : "bot.settings",
        actor: { kind: "person", personId: "p_aaaaaaaa", name: "Ada, \"the owner\"" },
        bot: { ...BOT, name: "Shop" },
        target: "=SUM(A1)",
        summary: `Row ${i}`,
      });
    }
    const page = log.list({ limit: 500 });
    const now = t.clock.ms + 3_600_000;
    const cli = auditCommand(["--csv"], t.home, now);
    expect(cli.code).toBe(0);
    expect(cli.stdout).toBe(auditCsv(page.events));
    expect(cli.stdout.split("\r\n")[1]).toContain('"Ada, ""the owner"""');
    expect(cli.stdout).toContain(",'=SUM(A1),");
    const plain = auditCommand(["--bot", "shop", "--kind", "vault", "--since", "2h"], t.home, now);
    expect(plain.stdout.trim().split("\n").length).toBe(4);
    expect(plain.stdout.split("\n")[0]).toContain("Row 6");
    expect(auditCommand(["--since", "soon"], t.home, now).code).toBe(2);
    expect(auditCommand(["--person", "Nobody"], t.home, now).stderr).toContain("no person named Nobody");
  } finally {
    t.done();
  }
});

test("timeArg reads 7d, 24h, 30m, dates and times", () => {
  const now = Date.parse("2026-11-26T12:00:00Z");
  expect(timeArg("7d", now)).toBe("2026-11-19T12:00:00.000Z");
  expect(timeArg("30m", now)).toBe("2026-11-26T11:30:00.000Z");
  expect(timeArg("2026-11-01", now)).toBe("2026-11-01T00:00:00.000Z");
  expect(timeArg("later", now)).toBeUndefined();
});

test("a year of rows: every filtered page is quick, and rows past a year go", () => {
  const t = testHub();
  const log = auditLog(t.hub);
  const start = t.clock.ms - AUDIT_KEEP_MS;
  const day = 86_400_000;
  const kinds = ["vault.filled", "pr.merged", "bot.settings", "person.joined", "approval.answered", "vault.revealed"];
  const insert = t.hub.db.conn.query(
    "INSERT INTO audit_log (at_ms, kind, actor_kind, person_id, actor_name, machine_id, project_id, bot_name, outcome, summary) VALUES (?, ?, 'person', ?, ?, 'm', ?, ?, 'ok', 'x')",
  );
  // 400 rows a day for a year (146,000), across 20 people and 30 bots.
  const total = 365 * 400;
  t.hub.db.conn.transaction(() => {
    for (let i = 0; i < total; i++) {
      const p = i % 20;
      const b = (i * 7) % 30;
      insert.run(start + Math.floor((i / total) * 365 * day) + 1, kinds[i % kinds.length]!, `p_${p}`, `Person ${p}`, `bot${b}`, `Bot ${b}`);
    }
  })();
  const filters = [
    {},
    { personId: "p_3" },
    { projectId: "bot11" },
    { kind: "vault" },
    { kind: "person.joined", personId: "p_3" },
    { since: new Date(t.clock.ms - 30 * day).toISOString(), until: new Date(t.clock.ms - 29 * day).toISOString() },
    { until: new Date(start + 10 * day).toISOString(), projectId: "bot5" },
    { personId: "nobody" },
  ];
  for (const f of filters) {
    const t0 = performance.now();
    const page = log.list({ ...f, limit: 100 });
    const ms = performance.now() - t0;
    expect([JSON.stringify(f), ms < 50]).toEqual([JSON.stringify(f), true]);
    if (f.personId !== "nobody") expect(page.events.length).toBe(100);
    if (page.events.length > 0) {
      const next = log.list({ ...f, limit: 100, before: page.events.at(-1)!.n });
      expect(next.events[0]!.n).toBeLessThan(page.events.at(-1)!.n);
    }
  }
  t.clock.advance(30 * day);
  expect(log.sweep(t.clock.ms)).toBeGreaterThan(10_000);
});

test("a bot's card is named as Payments names it, and a fill's row is stamped when it settles, in time order", async () => {
  const k = vaultHub();
  try {
    start(k.hub);
    const card = await k.call<{ item: { itemId: string } }>(k.ownerDevice, "vault_save", {
      kind: "card",
      label: "Visa (Personal)",
      sealed: k.sealToHub({ number: "4242424242424242", month: "04", year: "2031", cvc: "123", name: "Ada" }),
    });
    await k.call(k.ownerDevice, "project_card_set", { ...VAULT_BOT, card: `vault:${card.item.itemId}` });
    const log = auditLog(k.hub);
    expect(log.list({ kind: "bot.settings" }).events.map((e) => e.summary)).toEqual(["Set the bot's card to Visa (Personal) ••4242"]);
    // A fill begun an hour ago and settled now is a row of now: a "since" of the last minute finds it.
    const begun = k.clock.now() - 3_600_000;
    const fill = k.v.used({ atMs: begun, itemId: card.item.itemId, action: "fill", outcome: "pending", ...VAULT_BOT, threadId: "t1", data: { label: "Visa (Personal)", site: "shop.example" } });
    k.v.audit.settle(fill, "ok", {});
    k.v.usedEvent(fill, { ...k.v.audit.get(fill)!, outcome: "ok" });
    const recent = log.list({ kind: "vault.filled", since: new Date(k.clock.now() - 60_000).toISOString() }).events;
    expect(recent.map((e) => [e.summary, Date.parse(e.at)])).toEqual([['Filled "Visa (Personal)" on shop.example', k.clock.now()]]);
  } finally {
    k.done();
  }
});
