// A person's chat search (chat_find over the chats' index, hub/chat/find.ts), chat_history around a message, and the
// chat's pinned messages (chat_message_pins, chat_message_pin): the index kept as messages are written, edited,
// streamed and removed, filled for the messages from before it, the filters, paging and count; pins the same for every
// app, live, and a pinned message that is later gone.
import { afterAll, expect, test } from "bun:test";
import { Registry } from "../src/hub/api/registry.ts";
import { chat } from "../src/hub/chat/index.ts";
import { fillStep, timeTags, unfilled } from "../src/hub/chat/find.ts";
import { firstLine, hitText, holds, indexedText, marksOf, parseWords } from "../src/hub/chat/find_rules.ts";
import { serve, stop } from "../src/hub/http/index.ts";
import { build } from "../src/hub/serve/index.ts";
import { registerAll } from "../src/hub/serve/areas.ts";
import { sha256 } from "../src/hub/auth/allows.ts";
import type { HubDb } from "../src/hub/store/db.ts";
import type { NewMessage } from "../src/hub/chat/rules.ts";
import type { Hub } from "../src/hub/api/hub.ts";
import type { AttachmentRef, ProjectRef } from "../src/shared/contracts.ts";
import { events } from "../src/hub/store/events.ts";
import { FakeApp } from "./fake-app.ts";
import { hubHome } from "./helpers.ts";
import { caller, PROJECT, testHub } from "./hub-helpers.ts";

const ADA = { personId: "p_aaaaaaaa", name: "Ada" };
const BEN = { personId: "p_bbbbbbbb", name: "Ben" };
const OTHER: ProjectRef = { machineId: PROJECT.machineId, projectId: "p2" };

function setup() {
  const t = testHub();
  const tools = new Registry();
  registerAll(tools);
  for (const p of [ADA, BEN]) {
    t.hub.db.conn.query("INSERT INTO people (person_id, name, role, created_ms) VALUES (?, ?, 'member', 0)").run(p.personId, p.name);
  }
  const call = async (key: ReturnType<typeof caller>, tool: string, input: unknown) => {
    const out = (await tools.call(t.hub, key, tool, input)) as { output?: any; error?: { kind: string; error?: { code: string; message: string }; message?: string } };
    if (out.error) throw new Error(`${out.error.error?.code ?? out.error.kind}: ${out.error.error?.message ?? out.error.message}`);
    return out.output;
  };
  let minute = 0;
  const say = (text: string, o: NewMessage & { r?: ProjectRef; at?: string } = {}) => {
    const { r, at, ...rest } = o;
    const createdMs = at ? Date.parse(at) : Date.parse("2026-10-01T00:00:00Z") + 60_000 * minute++;
    return chat(t.hub).add(r ?? PROJECT, { author: "human", text, createdMs, ...rest }).message;
  };
  return { ...t, call, say };
}

const ada = caller("operate", true, ADA);
const reader = caller("read");
const find = (call: ReturnType<typeof setup>["call"], input: Record<string, unknown>) => call(reader, "chat_find", { projectRef: PROJECT, ...input });
const texts = (out: { hits: { text: string }[] }) => out.hits.map((h) => h.text);
const image: AttachmentRef = { attachmentId: "at_1", name: "screen.png", mime: "image/png", bytes: 10 };
const pdf: AttachmentRef = { attachmentId: "at_2", name: "invoice.pdf", mime: "application/pdf", bytes: 10 };

test("search finds a message far older than the loaded page, newest first, a page at a time with a count", async () => {
  const { call, say, done } = setup();
  const old = say("The staging password rotates on Fridays");
  for (let i = 0; i < 300; i++) say(`daily standup ${i}`, { author: "lead" });
  const page = await call(reader, "chat_history", { projectRef: PROJECT, limit: 100 });
  expect(page.messages.some((m: { messageId: string }) => m.messageId === old.messageId)).toBe(false);
  const out = await find(call, { words: "FRIDAY staging" });
  expect(out.hits.map((h: { messageId: string }) => h.messageId)).toEqual([old.messageId]);
  expect(out).toMatchObject({ more: false, count: 1 });
  expect(out.hits[0]).toMatchObject({ seq: old.seq, author: "human", text: "The staging password rotates on Fridays", marks: [[4, 11], [32, 38]] });
  // Pages of 20, newest first; the count is on the first page only.
  const first = await find(call, { words: "standup" });
  expect([first.hits.length, first.hits[0].text, first.more, first.count]).toEqual([20, "daily standup 299", true, 300]);
  const second = await find(call, { words: "standup", before: first.hits[19].messageId });
  expect([second.hits[0].text, second.count]).toEqual(["daily standup 279", undefined]);
  const small = await find(call, { words: "standup", limit: 5 });
  expect(texts(small)).toEqual([299, 298, 297, 296, 295].map((i) => `daily standup ${i}`));
  done();
});

test("words match a word's start in any order, case and accent; a quoted phrase matches exactly", async () => {
  const { call, say, done } = setup();
  say("We redeployed the café's hub");
  const deploy = say("Deploying the new hub now");
  say("hub deploy notes");
  expect(texts(await find(call, { words: "deplo" }))).toEqual(["hub deploy notes", "Deploying the new hub now"]);
  expect(texts(await find(call, { words: "HUB deploy" }))).toEqual(["hub deploy notes", "Deploying the new hub now"]);
  expect(texts(await find(call, { words: "cafe" }))).toEqual(["We redeployed the café's hub"]);
  expect(texts(await find(call, { words: '"the new hub"' }))).toEqual(["Deploying the new hub now"]);
  expect(texts(await find(call, { words: '"new hu"' }))).toEqual([]);
  expect(texts(await find(call, { words: '"hub deploy" notes' }))).toEqual(["hub deploy notes"]);
  // Inside a word is no hit.
  expect(texts(await find(call, { words: "ployed" }))).toEqual([]);
  const hit = (await find(call, { words: '"the new" HUB' })).hits[0];
  expect(hit.messageId).toBe(deploy.messageId);
  expect(hit.marks.map(([s, e]: [number, number]) => hit.text.slice(s, e))).toEqual(["the new", "hub"]);
  done();
});

test("filters: who wrote it, a time range or a day, and what it holds, each alone and together", async () => {
  const { call, say, done } = setup();
  say("release notes for v2", { person: ADA, at: "2026-10-01T09:00:00Z" });
  say("release is out https://example.com/v2", { author: "lead", at: "2026-10-02T09:00:00Z" });
  say("release screenshot", { person: BEN, attachments: [image], at: "2026-10-03T09:00:00Z" });
  say("release invoice", { person: BEN, attachments: [pdf], at: "2026-10-04T09:00:00Z" });
  const pr = say("release fix in #1865", { author: "lead", at: "2026-10-05T09:00:00Z" });
  say("release review github.com/acme/shop/pull/12", { author: "agent", at: "2026-10-06T09:00:00Z" });
  say("release in another bot", { r: OTHER, at: "2026-10-06T10:00:00Z" });
  const of = async (input: Record<string, unknown>) => texts(await find(call, { words: "release", ...input }));
  expect(await of({ author: "lead" })).toEqual(["release fix in #1865", "release is out https://example.com/v2"]);
  expect(await of({ personId: BEN.personId })).toEqual(["release invoice", "release screenshot"]);
  expect(await of({ since: "2026-10-02T00:00:00Z", until: "2026-10-04T00:00:00Z" })).toEqual(["release screenshot", "release is out https://example.com/v2"]);
  expect(await of({ since: "2026-10-05T00:00:00Z" })).toHaveLength(2);
  expect(await of({ until: "2026-10-01T09:00:00Z" })).toEqual([]);
  expect(await of({ has: ["link"] })).toEqual(["release is out https://example.com/v2"]);
  expect(await of({ has: ["image"] })).toEqual(["release screenshot"]);
  expect(await of({ has: ["file"] })).toEqual(["release invoice"]);
  expect(await of({ has: ["pr"] })).toEqual(["release review github.com/acme/shop/pull/12", "release fix in #1865"]);
  expect(await of({ has: ["pr"], author: "lead" })).toEqual(["release fix in #1865"]);
  await call(ada, "chat_message_pin", { projectRef: PROJECT, messageId: pr.messageId, pinned: true });
  expect(await of({ has: ["pinned"] })).toEqual(["release fix in #1865"]);
  // A filter alone, with no words: a day's messages, or a person's.
  expect(texts(await find(call, { since: "2026-10-03T00:00:00Z", until: "2026-10-04T00:00:00Z" }))).toEqual(["release screenshot"]);
  expect((await find(call, { personId: ADA.personId })).count).toBe(1);
  expect(await find(call, { words: "  !! " })).toEqual({ hits: [], more: false, count: 0 });
  done();
});

test("the index follows the chat: a streamed message once final, an edit, a removal; and fills what came before it", async () => {
  const { hub, call, say, done } = setup();
  const { message } = chat(hub).add(PROJECT, { author: "lead", text: "", streaming: true, createdMs: Date.parse("2026-10-01T00:00:00Z") });
  chat(hub).append(message, "half a ");
  expect(texts(await find(call, { words: "half" }))).toEqual([]);
  chat(hub).finish(chat(hub).byId(message.messageId)!, "half a migration plan");
  expect(texts(await find(call, { words: "migration" }))).toEqual(["half a migration plan"]);
  const gone = say("a typo thta stays");
  hub.db.conn.query("UPDATE chat_messages SET data = json_set(data, '$.text', 'a typo fixed') WHERE n = ?").run(Number(gone.messageId.slice(1)));
  expect(texts(await find(call, { words: "thta" }))).toEqual([]);
  expect(texts(await find(call, { words: "fixed" }))).toEqual(["a typo fixed"]);
  hub.db.conn.query("DELETE FROM chat_messages WHERE n = ?").run(Number(gone.messageId.slice(1)));
  expect(texts(await find(call, { words: "typo" }))).toEqual([]);
  // A chat from before the index: it fills from the newest down, saying so until it is done.
  for (let i = 0; i < 25; i++) say(`archived note ${i}`);
  emptyIndex(hub.db);
  const during = await find(call, { words: "archived" });
  expect([during.hits.length, during.indexing]).toEqual([0, true]);
  expect(fillStep(hub.db.conn, 10)).toBe(true);
  const part = await find(call, { words: "archived" });
  expect([part.hits[0].text, part.count, part.indexing]).toEqual(["archived note 24", 10, true]);
  while (fillStep(hub.db.conn, 10));
  expect(unfilled(hub.db.conn)).toBe(1);
  const all = await find(call, { words: "archived" });
  expect([all.count, all.indexing]).toEqual([25, undefined]);
  expect(texts(await find(call, { words: "migration" }))).toEqual(["half a migration plan"]);
  done();
});

test("a date filter finds a message by its own time, read in late with an early one; a message being written is in no search", async () => {
  const { hub, call, say, done } = setup();
  for (let i = 0; i < 30; i++) say(`live note ${i}`, { at: `2026-10-${String(1 + (i % 28)).padStart(2, "0")}T12:00:00Z` });
  // An old order read in after the live messages: a later number, an early time.
  say("order from long ago", { history: "order", at: "2025-03-04T09:00:00Z" });
  const day = { since: "2025-03-04T00:00:00Z", until: "2025-03-05T00:00:00Z" };
  expect(texts(await find(call, day))).toEqual(["order from long ago"]);
  expect(texts(await find(call, { words: "order", until: "2025-06-01T00:00:00Z" }))).toEqual(["order from long ago"]);
  expect(texts(await find(call, { since: "2025-01-01T00:00:00Z", until: "2025-12-31T00:00:00Z" }))).toEqual(["order from long ago"]);
  expect((await find(call, { since: "2026-10-01T00:00:00Z" })).count).toBe(30);
  // A streamed reply on its way: no search lists it, a date alone either, until it is final.
  const { message } = chat(hub).add(PROJECT, { author: "lead", text: "", streaming: true, createdMs: Date.parse("2025-03-04T10:00:00Z") });
  chat(hub).append(message, "order notes so far");
  expect(texts(await find(call, day))).toEqual(["order from long ago"]);
  expect(texts(await find(call, { words: "notes" }))).toEqual([]);
  chat(hub).finish(chat(hub).byId(message.messageId)!, "order notes, done");
  expect(texts(await find(call, day))).toEqual(["order notes, done", "order from long ago"]);
  done();
});

test("a date filter's index words cover every day of its range, then months, then none", () => {
  const d = Date.parse;
  expect(timeTags(d("2026-10-14T00:00:00Z"), d("2026-10-15T00:00:00Z"))).toEqual(["d20261014"]);
  expect(timeTags(d("2026-10-14T22:00:00Z"), d("2026-10-16T01:00:00Z"))).toEqual(["d20261014", "d20261015", "d20261016"]);
  expect(timeTags(d("2025-11-20T00:00:00Z"), d("2026-02-01T00:00:00Z"))).toEqual(["u202511", "u202512", "u202601"]);
  expect(timeTags(d("2000-01-01T00:00:00Z"), d("2026-01-01T00:00:00Z"))).toBeUndefined();
  expect(timeTags(undefined, d("2026-01-01T00:00:00Z"))).toBeUndefined();
});

/** The index as a hub from before it has it: empty, every message still to fill. */
function emptyIndex(db: HubDb) {
  db.conn.run("DELETE FROM chat_find");
  db.conn.run("UPDATE chat_find_built SET below = (SELECT MAX(n) + 1 FROM chat_messages)");
}

test("chat_history around a message opens the chat there, with more on both sides", async () => {
  const { call, say, done } = setup();
  const ms = Array.from({ length: 200 }, (_, i) => say(`line ${i}`));
  const out = await call(reader, "chat_history", { projectRef: PROJECT, around: ms[100]!.messageId, limit: 11 });
  expect(out.messages.map((m: { text: string }) => m.text)).toEqual(Array.from({ length: 11 }, (_, i) => `line ${95 + i}`));
  expect([out.moreBefore, out.moreAfter]).toEqual([true, true]);
  const start = await call(reader, "chat_history", { projectRef: PROJECT, around: ms[1]!.messageId, limit: 10 });
  expect([start.messages[0].text, start.messages.length, start.moreBefore, start.moreAfter]).toEqual(["line 0", 7, false, true]);
  await expect(call(reader, "chat_history", { projectRef: PROJECT, around: ms[1]!.messageId, before: 3 })).rejects.toThrow("invalid");
  const elsewhere = say("not here", { r: OTHER });
  await expect(call(reader, "chat_history", { projectRef: PROJECT, around: elsewhere.messageId })).rejects.toThrow("not_found");
  done();
});

test("pins: a person pins and unpins any message, newest first; a pinned message that is gone leaves the list whole", async () => {
  const { hub, clock, call, say, done } = setup();
  const a = say("deploy key is in the vault", { person: ADA });
  const b = say("Shipped v2.\nDetails below", { author: "lead" });
  const c = say("", { attachments: [pdf], person: BEN });
  const pin = (who: ReturnType<typeof caller>, m: { messageId: string }, pinned = true) =>
    call(who, "chat_message_pin", { projectRef: PROJECT, messageId: m.messageId, pinned });
  await pin(ada, a);
  clock.ms += 1000;
  await pin(caller("operate", true, BEN), b);
  clock.ms += 1000;
  const out = await pin(ada, c);
  expect(out.pins.map((p: { text: string }) => p.text)).toEqual(["invoice.pdf", "Shipped v2.", "deploy key is in the vault"]);
  expect(out.pins[1]).toMatchObject({ messageId: b.messageId, seq: b.seq, author: "lead", pinnedBy: BEN, pinnedAt: "2026-11-08T10:00:01.000Z" });
  expect(out.pins[2]).toMatchObject({ person: ADA, pinnedBy: ADA });
  // Pinning again keeps who and when; unpinning what isn't pinned is no change.
  clock.ms += 1000;
  expect((await pin(caller("operate", true, BEN), a)).pins[2]).toMatchObject({ pinnedBy: ADA, pinnedAt: "2026-11-08T10:00:00.000Z" });
  await pin(ada, a, false);
  expect((await pin(ada, a, false)).pins).toHaveLength(2);
  // The message goes: the list leaves it out, and the next write drops its row.
  hub.db.conn.query("DELETE FROM chat_messages WHERE n = ?").run(Number(b.messageId.slice(1)));
  expect((await call(reader, "chat_message_pins", { projectRef: PROJECT })).pins.map((p: { messageId: string }) => p.messageId)).toEqual([c.messageId]);
  await pin(ada, a);
  const rows = hub.db.conn.query("SELECT COUNT(*) AS k FROM chat_message_pins").get() as { k: number };
  expect(rows.k).toBe(2);
  // Refusals: a message of another chat, an agent's key, a reader, the cap.
  await expect(pin(ada, say("x", { r: OTHER }))).rejects.toThrow("not_found");
  await expect(pin(caller("operate"), a)).rejects.toThrow("forbidden");
  await expect(pin(caller("read", true, ADA), a)).rejects.toThrow("forbidden");
  for (let i = 0; i < 48; i++) await pin(ada, say(`pin ${i}`));
  await expect(pin(ada, say("one too many"))).rejects.toThrow("invalid: This chat already has 50 pinned messages.");
  done();
});

test("hit lines: one line around the first match, marks inside it, a file's name for a message with no text", () => {
  const long = `${"word ".repeat(80)}the needle is here ${"tail ".repeat(80)}`;
  const { text, marks } = hitText(long, undefined, parseWords("needle"));
  expect([...text].length).toBe(160);
  expect(text.startsWith("…") && text.endsWith("…")).toBe(true);
  expect(text.slice(marks[0]![0], marks[0]![1])).toBe("needle");
  // A match near a long message's end stays whole and near the line's start, where a two-line preview still shows it:
  // the line ends at the message's end, never cut inside the match.
  const late = `${"word ".repeat(40)}Shall I give it to a writer?`;
  const end = hitText(late, undefined, parseWords("writer"));
  expect(end.text.startsWith("…") && end.text.endsWith("writer?")).toBe(true);
  expect(end.text.slice(end.marks[0]![0], end.marks[0]![1])).toBe("writer");
  expect(end.marks[0]![0]).toBeLessThanOrEqual(1 + 160 / 3);
  expect(hitText("", [pdf], parseWords("x"))).toEqual({ text: "invoice.pdf", marks: [] });
  expect(hitText("a\n\n  b   c", undefined, [])).toEqual({ text: "a b c", marks: [] });
  // Marks are in the text's own code units, past accents and wide characters.
  const s = "🚀 Café CAFE";
  expect(marksOf(s, parseWords("cafe")).map(([a, b]) => s.slice(a, b))).toEqual(["Café", "CAFE"]);
  expect(parseWords('chat_find "a b" "open')).toEqual([
    { tokens: ["chat", "find"], prefix: true },
    { tokens: ["a", "b"], prefix: false },
    { tokens: ["open"], prefix: false },
  ]);
  expect(holds({ text: "see HTTPS://x.dev and #12", attachments: [image, pdf] })).toEqual(["link", "image", "file", "pr"]);
  expect(holds({ text: "issue # 12, no link" })).toEqual([]);
});

// Two apps of the bot over the real socket: one pins, the other hears it and reads the same list; a key without the
// bot's machine hears nothing and is refused.
const home = hubHome();
const served = build(home.dir, { host: "127.0.0.1", port: 0 });
const server = serve(served.hub, served.tools, 0);
const url = `ws://127.0.0.1:${server.port}/app`;
afterAll(async () => {
  served.hub.shutdown.abort();
  await stop(server);
  served.hub.db.close();
  home.done();
});

function humanKey(hub: Hub, person: { personId: string; name: string }, machines: "*" | string[]): string {
  const key = `fld_${person.personId.replace(/[^a-z]/g, "").padEnd(52, "a").slice(0, 52)}`;
  hub.db.conn.query("INSERT OR IGNORE INTO people (person_id, name, role, created_ms) VALUES (?, ?, 'member', 0)").run(person.personId, person.name);
  hub.db.conn
    .query("INSERT INTO agent_keys (key_id, hash, prefix, name, grants, created_ms, kind, person_id) VALUES (?, ?, ?, ?, ?, 0, 'human', ?)")
    .run(`key_${person.personId}`, sha256(key), key.slice(0, 10), `${person.name}'s phone`, JSON.stringify([{ role: "operate", machines }]), person.personId);
  return key;
}

async function open(key: string) {
  const app = new FakeApp(url);
  await app.send({ t: "auth", key });
  const ready = await app.tag("ready");
  return { app, ready };
}

// On the cloud (2026-11-22) a hit read "…CSV, two rows"} ``` All three are done: the [QA report](artifact:q…": the
// lead's message as it is stored, its file block's JSON and a link's target, not what the chat shows.
test("a hit, a pin and the index read a message as the chat shows it: a block by its words, a link by its label", () => {
  const text = '```fleetd-block\n{"v":1,"kind":"file","attachmentId":"F3","caption":"QA CSV, two rows"}\n```\n\nAll three are done: the [QA report](artifact:qa-report) is **published**.';
  const hit = hitText(text, undefined, parseWords("published"));
  expect(hit.text).toBe("QA CSV, two rows All three are done: the QA report is published.");
  expect(hit.text.slice(...hit.marks[0]!)).toBe("published");
  expect(firstLine({ text })).toBe("QA CSV, two rows");
  expect(indexedText({ text })).not.toMatch(/attachmentId|artifact:|fleetd-block|[{}*`]/);
  // A block with no words of its own says what it is; code a person wrote stays as written.
  expect(hitText('```fleetd-block\n{"v":1,"kind":"diff","patch":"x"}\n```', undefined, []).text).toBe("A diff");
  expect(hitText("run `bun test` again", undefined, []).text).toBe("run `bun test` again");
  // Bold marks go, but not underscores in code or inside a word.
  expect(hitText("fix **this** and __that__ in `__init__.py`, not my__var__name", undefined, []).text).toBe("fix this and that in `__init__.py`, not my__var__name");
});

test("the index holds the words the chat shows: a block's JSON or a link's target finds nothing, its words do, and the fill redoes old rows so", async () => {
  const { call, say, hub, done } = setup();
  const file = '```fleetd-block\n{"v":1,"kind":"file","attachmentId":"F3","caption":"QA CSV, two rows"}\n```\n\nAll three are done: the [QA report](artifact:qa-report) is **published**.';
  say(file, { author: "lead" });
  say('```fleetd-block\n{"v":1,"kind":"diff","patch":"x"}\n```', { author: "lead" });
  // A streamed message is indexed by what it shows once it is final.
  const { message } = chat(hub).add(PROJECT, { author: "lead", text: "", streaming: true, createdMs: Date.parse("2026-10-02T00:00:00Z") });
  chat(hub).finish(chat(hub).byId(message.messageId)!, "see [the PR](https://github.com/acme/app/pull/12)");
  const found = async (words: string) => texts(await find(call, { words }));
  for (const hidden of ["attachmentId", "artifact", "fleetd", "github", "acme", "patch"]) expect(await found(hidden)).toEqual([]);
  expect(await found("CSV published")).toEqual(["QA CSV, two rows All three are done: the QA report is published."]);
  expect(await found("diff")).toEqual(["A diff"]);
  expect(await found("PR")).toEqual(["see the PR"]);
  // Rows indexed before this (their stored text) are filled again from the newest down, as the migration asks.
  hub.db.conn.run("UPDATE chat_find SET text = 'attachmentId artifact github'");
  expect((await found("github")).length).toBe(3);
  hub.db.conn.run("UPDATE chat_find_built SET below = (SELECT MAX(n) + 1 FROM chat_messages)");
  while (fillStep(hub.db.conn, 2));
  expect(await found("github")).toEqual([]);
  expect(await found("diff")).toEqual(["A diff"]);
  done();
});

test("a pin reaches every open app of the bot live; a person without the bot is refused and hears nothing", async () => {
  const hub = served.hub;
  const r: ProjectRef = { machineId: "devbox", projectId: "shop" };
  const m = chat(hub).add(r, { author: "lead", text: "the launch checklist", createdMs: Date.parse("2026-10-01T00:00:00Z") }).message;
  const one = await open(humanKey(hub, { personId: "p_cccccccc", name: "Ann" }, "*"));
  const two = await open(humanKey(hub, { personId: "p_dddddddd", name: "Bob" }, ["devbox"]));
  const out = await open(humanKey(hub, { personId: "p_eeeeeeee", name: "Cy" }, ["other-box"]));
  expect(one.ready.features).toContain("chat_find_pins");
  const cursor = events(hub).head();
  for (const { app } of [two, out]) await app.send({ t: "events", cursor });
  await one.app.send({ t: "call", id: "p", tool: "chat_message_pin", input: { projectRef: r, messageId: m.messageId, pinned: true } });
  expect(await one.app.next((f) => f.id === "p")).toMatchObject({ t: "result", output: { pins: [{ messageId: m.messageId, pinnedBy: { name: "Ann" } }] } });
  const heard = await two.app.next((f) => f.t === "event" && f.type === "chat.message_pins");
  expect(heard).toMatchObject({ machineId: "devbox", projectId: "shop", data: { projectRef: r, messageId: m.messageId, pinned: true, by: { personId: "p_cccccccc", name: "Ann" } } });
  await two.app.send({ t: "call", id: "l", tool: "chat_message_pins", input: { projectRef: r } });
  expect(await two.app.next((f) => f.id === "l")).toMatchObject({ output: { pins: [{ messageId: m.messageId, text: "the launch checklist" }] } });
  await two.app.send({ t: "call", id: "u", tool: "chat_message_pin", input: { projectRef: r, messageId: m.messageId, pinned: false } });
  await two.app.next((f) => f.id === "u");
  // Ann's app, which didn't subscribe to events before, reads the list empty again.
  await one.app.send({ t: "call", id: "l2", tool: "chat_message_pins", input: { projectRef: r } });
  expect(await one.app.next((f) => f.id === "l2")).toMatchObject({ output: { pins: [] } });
  for (const [id, tool, input] of [
    ["x1", "chat_message_pins", { projectRef: r }],
    ["x2", "chat_find", { projectRef: r, words: "launch" }],
    ["x3", "chat_message_pin", { projectRef: r, messageId: m.messageId, pinned: true }],
  ] as const) {
    await out.app.send({ t: "call", id, tool, input });
    expect(await out.app.next((f) => f.id === id)).toMatchObject({ t: "error", code: "forbidden" });
  }
  expect(out.app.frames.some((f) => f.t === "event" && f.type === "chat.message_pins")).toBe(false);
  for (const { app } of [one, two, out]) app.close();
});
