// A project's lead calls and what the hub keeps of it: reading back through its chat (recall_tests.rs), its confirm step,
// its purchases and card (purchases.rs), the erase of a deleted one (inbox/tests.rs), and the hooks approvals reaches.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectRef } from "../src/shared/contracts.ts";
import { ToolError } from "../src/shared/errors.ts";
import { CAP_NO_ASK_FILL } from "../src/shared/node_link.ts";
import { Hub } from "../src/hub/api/hub.ts";
import { approvals } from "../src/hub/approvals/index.ts";
import { chat } from "../src/hub/chat/index.ts";
import type { CallerAgent, LeadCaller } from "../src/hub/lead_calls/types.ts";
import { link } from "../src/hub/link/server.ts";
import * as confirm from "../src/hub/project_lead/confirm.ts";
import * as erase from "../src/hub/project_lead/erase.ts";
import { projectHooks } from "../src/hub/project_lead/hooks.ts";
import { start } from "../src/hub/project_lead/loops.ts";
import * as purchases from "../src/hub/project_lead/purchases.ts";
import * as recall from "../src/hub/project_lead/recall.ts";
import * as kept from "../src/hub/project_lead/store.ts";
import { HubDb } from "../src/hub/store/db.ts";
import { events } from "../src/hub/store/events.ts";
import { store } from "../src/hub/store/hub_store.ts";
import { tempHome } from "./helpers.ts";
import { AT, key, kit, project } from "./work-kit.ts";

const ref = (projectId: string): ProjectRef => ({ machineId: "devbox", projectId });
const lead = (r: ProjectRef, agent: CallerAgent = { kind: "lead" }): LeadCaller => ({ projectRef: r, by: `lead:devbox/${r.projectId}`, agent });

function setup() {
  const k = kit();
  for (const id of ["inbox", "work", "storefront"]) project(k.hub, ref(id));
  return k;
}

const say = (hub: Hub, r: ProjectRef, author: "human" | "lead", text: string, at: string) =>
  chat(hub).add(r, { author, text, createdMs: Date.parse(at) }).message.messageId;

/** The call's result, or its refusal's code and message. */
async function call(f: () => unknown): Promise<Record<string, any> | [string, string]> {
  try {
    return (await f()) as Record<string, any>;
  } catch (error) {
    if (error instanceof ToolError) return [error.code, error.message + (error.fix ? ` ${error.fix}` : "")];
    throw error;
  }
}
const recalled = (hub: Hub, r: ProjectRef, c: Record<string, unknown>, agent?: CallerAgent) =>
  call(() => recall.answer(hub, lead(r, agent), c as never));
const texts = (out: Record<string, any> | [string, string]) => (out as { messages: { text: string }[] }).messages.map((m) => m.text);
const ids = (out: Record<string, any> | [string, string]) => (out as { messages: { messageId: string }[] }).messages.map((m) => m.messageId);

test("a project finds what the person said long before its recent chat, and reads around it", async () => {
  const { hub } = setup();
  const inbox = ref("inbox");
  say(hub, inbox, "human", "who was that dentist again?", "2026-10-14T09:00:00Z");
  const hit = say(hub, inbox, "human", "My dentist is Dr. Okafor on Elm Street, Saturdays only.", "2026-10-14T09:01:00Z");
  say(hub, inbox, "lead", "noted: Dr. Okafor, Saturdays", "2026-10-14T09:02:00Z");
  for (let i = 0; i < 150; i++) say(hub, inbox, "lead", `morning brief ${i}`, "2026-10-20T08:00:00Z");
  expect(chat(hub).page(inbox, undefined, undefined, 100).messages.some((m) => m.text.includes("Okafor"))).toBe(false);
  // Any case, any order, every word.
  const out = (await recalled(hub, inbox, { op: "chat_search", words: "elm OKAFOR" })) as Record<string, any>;
  expect(ids(out)).toEqual([hit]);
  expect([out.messages[0].author, out.messages[0].at, out.more]).toEqual(["human", "2026-10-14T09:01:00.000Z", undefined]);
  expect(out.next).toContain("chat_read");
  const none = (await recalled(hub, inbox, { op: "chat_search", words: "okafor dermatologist" })) as Record<string, any>;
  expect([ids(none), none.next.includes("fewer or other words")]).toEqual([[], true]);
  // The messages around it, oldest first.
  const around = (await recalled(hub, inbox, { op: "chat_read", messageId: hit, before: 1, after: 2 })) as Record<string, any>;
  expect(texts(around)).toEqual([
    "who was that dentist again?",
    "My dentist is Dr. Okafor on Elm Street, Saturdays only.",
    "noted: Dr. Okafor, Saturdays",
    "morning brief 0",
  ]);
  expect([around.moreBefore, around.moreAfter]).toEqual([false, true]);
  // Five each way when not told.
  expect(texts(await recalled(hub, inbox, { op: "chat_read", messageId: hit })).length).toBe(7);
});

test("hits come a page at a time, newest first", async () => {
  const { hub } = setup();
  const inbox = ref("inbox");
  for (let i = 0; i < 45; i++) {
    say(hub, inbox, "human", `groceries list ${i}`, AT);
    say(hub, inbox, "lead", "ok", AT);
  }
  const page = (before?: string) => recalled(hub, inbox, { op: "chat_search", words: "groceries", ...(before ? { before } : {}) });
  const first = (await page()) as Record<string, any>;
  expect([texts(first).length, texts(first)[0], first.more]).toEqual([20, "groceries list 44", true]);
  const last = ids(first).at(-1)!;
  expect(first.next).toContain(last);
  const second = await page(last);
  expect([texts(second)[0], texts(second).length]).toEqual(["groceries list 24", 20]);
  const third = (await page(ids(second).at(-1))) as Record<string, any>;
  expect(texts(third)).toEqual([4, 3, 2, 1, 0].map((i) => `groceries list ${i}`));
  expect(third.more).toBeUndefined();
  // LIKE's own signs are only letters here.
  say(hub, inbox, "human", "a 100% refund", AT);
  expect(texts(await recalled(hub, inbox, { op: "chat_search", words: "0%" }))).toEqual(["a 100% refund"]);
  expect(ids(await recalled(hub, inbox, { op: "chat_search", words: "groceries_list" }))).toEqual([]);
});

test("a date range keeps to its days", async () => {
  const { hub } = setup();
  const inbox = ref("inbox");
  for (const [text, at] of [
    ["passport renewal form", "2026-10-01T12:00:00Z"],
    ["passport photo booked", "2026-10-15T00:00:00Z"],
    ["passport arrived", "2026-10-15T23:59:00Z"],
    ["passport in the drawer", "2026-10-16T00:00:00Z"],
  ] as const) {
    say(hub, inbox, "human", text, at);
  }
  const search = (q: Record<string, unknown>) => recalled(hub, inbox, { op: "chat_search", words: "passport", ...q });
  expect(texts(await search({ from: "2026-10-15", to: "2026-10-15" }))).toEqual(["passport arrived", "passport photo booked"]);
  expect(texts(await search({ from: "2026-10-15T12:00:00Z" }))).toEqual(["passport in the drawer", "passport arrived"]);
  expect(texts(await search({ to: "2026-10-14" }))).toEqual(["passport renewal form"]);
  const [code, why] = (await search({ from: "last tuesday" })) as [string, string];
  expect(code).toBe("invalid");
  expect(why).toContain("2026-10-20");
});

test("only a lead reads back, and only its own chat", async () => {
  const { hub } = setup();
  const inbox = ref("inbox");
  const mine = say(hub, inbox, "human", "the wifi password is on the fridge", AT);
  const theirs = say(hub, ref("work"), "human", "the wifi at the office", AT);
  const code = say(hub, ref("storefront"), "human", "wifi page copy", AT);
  const out = await recalled(hub, inbox, { op: "chat_search", words: "wifi" });
  expect(ids(out)).toEqual([mine]);
  for (const other of [theirs, code]) {
    expect(((await recalled(hub, inbox, { op: "chat_read", messageId: other })) as string[])[0]).toBe("not_found");
    expect(((await recalled(hub, inbox, { op: "chat_search", words: "wifi", before: other })) as string[])[0]).toBe("not_found");
  }
  // A coding project's lead reads back its own chat too (D310), never the project's.
  expect(ids(await recalled(hub, ref("storefront"), { op: "chat_search", words: "wifi" }))).toEqual([code]);
  // Nor has a person's shell in the project's folder, nor a task.
  for (const agent of [{ kind: "person" }, { kind: "task", taskId: "T3" }] as CallerAgent[]) {
    expect(((await recalled(hub, inbox, { op: "chat_read", messageId: mine }, agent)) as string[])[0]).toBe("forbidden");
  }
  // An archived project's lead works with nothing.
  kept.setArchived(hub.db.conn, inbox, 1);
  expect(((await recalled(hub, inbox, { op: "chat_search", words: "wifi" })) as string[])[0]).toBe("forbidden");
});

test("a confirm step that ran tells the lead to click once", async () => {
  const { hub } = setup();
  const step = { op: "confirm_step", site: "lupa.example", button: "Complete reservation", does: "Books a table" };
  expect(await call(() => confirm.answer(hub, lead(ref("inbox")), step as never))).toEqual({
    next: 'Let through: click "Complete reservation" now, once, on lupa.example. Then say in the chat what the page answered.',
    button: "Complete reservation",
  });
  expect(((await call(() => confirm.answer(hub, lead(ref("inbox"), { kind: "task", taskId: "T1" }), step as never))) as string[])[0]).toBe("forbidden");
});

const shopping = (domain: string) => ({
  op: "purchase_open",
  sessionId: "s1",
  page: "checkout",
  purchase: { shop: { domain, name: "Lamp Shop" }, total: { amount: "40.00", currency: "EUR" }, items: [{ name: "Blue lamp" }] },
});

test("a purchase is recorded with no ask, filled once, and its fill is a quiet line", async () => {
  const { hub, ok, refused } = setup();
  const inbox = ref("inbox");
  const caps = (link(hub) as unknown as { capabilities: Map<string, Set<string>> }).capabilities;
  caps.set("devbox", new Set([CAP_NO_ASK_FILL]));
  // The card is kept in the project's settings row, which a project has (store.rs `set_card` only updates it).
  kept.put(hub.db.conn, inbox, { keyId: "k1", name: "desk" }, 0);
  const buy = (c: Record<string, unknown>) => call(() => purchases.answer(hub, lead(inbox), c as never));
  expect(await buy(shopping("www.coinbase.com"))).toEqual([
    "forbidden",
    "Blocked by fleetd: an assistant never trades, even with your approval. Tell the person what you wanted to do; they place the trade themselves. don't buy it another way; tell the person what you wanted to do",
  ]);
  expect(((await buy(shopping("lamps.example"))) as string[])[1]).toContain("You have no card to pay with.");
  // Only a person picks the card.
  expect(await refused(key("operate"), "project_card_set", { ...inbox, card: "op://Personal/Visa" })).toBe("forbidden");
  const set = await ok(key("operate", { human: true }), "project_card_set", { ...inbox, card: "op://Personal/Visa" });
  expect(set).toEqual({ card: { ref: "op://Personal/Visa" }, next: "The project pays with Visa (Personal) from now on, with no ask at each purchase." });
  const opened = (await buy(shopping("lamps.example"))) as Record<string, any>;
  expect([opened.state, opened.next]).toEqual(["approved", "recorded, with no ask (D310): fill the card now with purchase_fill, on this checkout"]);
  const claimed = await buy({ op: "purchase_claim", requestId: opened.requestId, sessionId: "s1" });
  expect(claimed).toEqual({ requestId: opened.requestId, domain: "lamps.example", card: "op://Personal/Visa" });
  // A purchase fills once.
  expect(((await buy({ op: "purchase_claim", requestId: opened.requestId, sessionId: "s1" })) as string[])[0]).toBe("forbidden");
  const filled = await buy({ op: "purchase_filled", requestId: opened.requestId, ok: true, typed: true, message: "card in" });
  expect(filled).toEqual({ requestId: opened.requestId, state: "ran" });
  expect(chat(hub).page(inbox, undefined, undefined, 10).messages.map((m) => [m.author, m.text])).toContainEqual([
    "system",
    "Paid 40.00 EUR at Lamp Shop with Visa (Personal)",
  ]);
  const log = await ok(key("read"), "project_purchases", inbox);
  expect([log.card, log.purchases.length, log.purchases[0].state, log.purchases[0].note, log.next]).toEqual([
    { ref: "op://Personal/Visa" },
    1,
    "ran",
    "card filled into the checkout: card in",
    undefined,
  ]);
  // No card: the log says how to pick one, and a task's session never buys.
  await ok(key("operate", { human: true }), "project_card_set", inbox);
  expect((await ok(key("read"), "project_purchases", inbox)).next).toContain("No card yet");
  expect(((await call(() => purchases.answer(hub, lead(inbox, { kind: "task", taskId: "T1" }), shopping("lamps.example") as never))) as string[])[0]).toBe(
    "forbidden",
  );
  expect(await refused(key("read"), "project_purchases", ref("nowhere"))).toBe("not_found");
});

test("a secure input from 1Password fills once with no ask, and one the person types is theirs", async () => {
  const { hub } = setup();
  const inbox = ref("inbox");
  (link(hub) as unknown as { capabilities: Map<string, Set<string>> }).capabilities.set("devbox", new Set([CAP_NO_ASK_FILL]));
  const step = (c: Record<string, unknown>) => call(() => purchases.answer(hub, lead(inbox), c as never));
  const field = { site: { domain: "passport.gov.example", name: "Passport office" }, target: "#number", label: "passport number", why: "the renewal form" };
  const opened = (await step({ op: "secure_input_open", sessionId: "s1", input: { ...field, ref: "op://Personal/Passport/number" } })) as Record<string, any>;
  expect(opened.state).toBe("approved");
  expect(await step({ op: "secure_input_claim", requestId: opened.requestId, sessionId: "s1" })).toEqual({
    requestId: opened.requestId,
    domain: "passport.gov.example",
    target: "#number",
    ref: "op://Personal/Passport/number",
  });
  expect(await step({ op: "secure_input_filled", requestId: opened.requestId, ok: true, typed: true, message: "in" })).toEqual({ requestId: opened.requestId, state: "ran" });
  // One the person types waits for them, and the node never claims it.
  const typed = (await step({ op: "secure_input_open", sessionId: "s1", input: field })) as Record<string, any>;
  expect(typed.state).toBe("open");
  expect(((await step({ op: "secure_input_claim", requestId: typed.requestId, sessionId: "s1" })) as string[])[0]).toBe("invalid");
});

test("a deleted project is erased once the hub sees it gone, its removal kept without its name", () => {
  const home = tempHome();
  try {
    const hub = new Hub({ home: home.dir, listen: { host: "127.0.0.1", port: 0 } }, HubDb.memory(), { now: () => Date.parse(AT) });
    const r = ref("p-secret-diary");
    project(hub, r, { title: "Secret diary" });
    kept.put(hub.db.conn, r, { keyId: "k1", name: "desk" }, 0);
    chat(hub).add(r, { author: "human", text: "my dentist is Dr Lee" });
    const memory = join(home.dir, "memory", "devbox", "p-secret-diary");
    mkdirSync(memory, { recursive: true });
    writeFileSync(join(memory, "MEMORY.md"), "- dentist: Dr Lee");
    const from = events(hub).head();
    const event = (type: "project.settings" | "project.removed", summary: string) =>
      events(hub).append({ at: AT, type, machineId: "devbox", projectId: r.projectId, summary, data: { title: "Secret diary" } });
    event("project.settings", "Secret diary renamed");
    const marks = () => (hub.db.conn.query("SELECT COUNT(*) AS n FROM project_erases").get() as { n: number }).n;
    erase.asked(hub, r);
    // Its node still has it, as far as the hub knows: nothing is erased yet.
    expect(erase.finishPending(hub)).toBe(0);
    expect([chat(hub).page(r, undefined, undefined, 10).messages.length, marks(), existsSync(memory)]).toEqual([1, 1, true]);
    // The node's project_removed: the hub finishes the erase.
    store(hub).projectRemove(r);
    event("project.removed", 'Project "Secret diary" on devbox was removed');
    expect(erase.finishPending(hub)).toBe(1);
    expect([chat(hub).page(r, undefined, undefined, 10).messages.length, marks(), existsSync(memory)]).toEqual([0, 0, false]);
    const left = events(hub).page(from).events.filter((e) => e.projectId === r.projectId || JSON.stringify(e).includes(r.projectId));
    expect(left.map((e) => e.type)).toEqual(["project.removed"]);
    const removed = JSON.stringify(left[0]);
    expect(removed).toContain("p-secret-diary");
    expect(removed).not.toContain("Secret diary");
    // A hub-wide key is never a project's.
    expect(() => erase.erase(hub, { machineId: "", projectId: "x" })).toThrow();
  } finally {
    home.done();
  }
});

test("what an older hub left of a deleted project is pruned, and a live one is never touched", () => {
  const { hub } = setup();
  const gone = ref("gone");
  hub.db.conn.run(
    "INSERT INTO project_sites (machine_id, project_id, site, allowed_ms, allowed_by) VALUES ('devbox', 'gone', 'a.example', 0, 'x'), ('devbox', 'inbox', 'b.example', 0, 'x')",
  );
  chat(hub).add(gone, { author: "human", text: "left behind" });
  expect(erase.pruneOrphans(hub)).toBe(1);
  expect(hub.db.conn.query("SELECT project_id FROM project_sites").all()).toEqual([{ project_id: "inbox" }]);
  expect(erase.pruneOrphans(hub)).toBe(0);
});

test("approvals reach the project's hooks once the inbox area starts", async () => {
  const { hub } = setup();
  const inbox = ref("inbox");
  const hooks = approvals(hub).deps.hooks;
  // Before: approvals' safe defaults.
  expect(hooks.shellRefused("rm -rf /")).toBeUndefined();
  start(hub);
  try {
    expect(projectHooks(hub)).toBeDefined();
    expect(hooks.shellRefused("rm -rf /")).toContain("Refused by fleetd");
    expect(hooks.siteVisit("WebFetch", { url: "https://www.example.org/x" })).toBe("example.org");
    expect(hooks.floor({ tool: "mcp__bank__transfer_funds" })).toContain("never moves money");
    expect(hooks.visitCarriesData({ url: "https://x.example/?to=sam@friends.example" })).toBe(true);
    expect(hooks.alwaysAsks({ tool: "t", summary: "", input: {}, preview: { server: "s", tool: "buy", action: "spend", title: "x", input: "{}" } })).toBe(true);
    // A confirm step that pays is refused; one that books is a card; a bridge message is a send.
    expect(hooks.promptVerdict(inbox, confirm.TOOL, { site: "a.example", button: "Pay now", does: "Pays" }, [], undefined)).toEqual({
      deny: "Blocked by fleetd: this step pays, orders or trades, which confirm_step never does. Hand the final click to the person with request_takeover.",
    });
    const booking = hooks.promptVerdict(inbox, confirm.TOOL, { site: "a.example", button: "Book", does: "Books a table" }, [], undefined);
    expect(booking && "ask" in booking && booking.ask.title).toBe('Click "Book" on a.example');
    const bridge = hooks.promptVerdict(inbox, "mcp__fleetd__project_message", { project: "app", text: "ship it" }, [], undefined);
    expect(bridge && "ask" in bridge && [bridge.ask.action, bridge.ask.title]).toEqual(["send", "Message the lead of app"]);
    expect(hooks.promptVerdict(inbox, "mcp__fleetd__automation_confirm", { automationId: "a1" }, [], undefined)).toEqual({
      deny: "Blocked by fleetd: this project has no such automation. automation_list names them.",
    });
    expect(hooks.promptVerdict(inbox, "Bash", { command: "ls" }, [], undefined)).toBeUndefined();
    // Sites, approvals, the lead.
    expect(await hooks.siteAllowed(inbox, "example.org")).toBe(false);
    await hooks.allowSite(inbox, "example.org", "human:desk");
    expect([await hooks.siteAllowed(inbox, "example.org"), await hooks.siteAllowed(inbox, undefined)]).toEqual([true, false]);
    expect((await hooks.approvalSettings(inbox))?.mode).toBe("checker");
    hub.db.conn.run("INSERT INTO leads (machine_id, project_id, thread_id, started_at, session_generation) VALUES ('devbox', 'inbox', 't-lead', '', 1)");
    expect([await hooks.isLead(inbox, "t-lead"), await hooks.isLead(inbox, "t-other")]).toEqual([true, false]);
    // The checker can't run its turn in the Bun hub yet: it asks.
    const checked = await hooks.checkAction(inbox, "t-lead", { tool: "mcp__mail__send", summary: "", input: { to: ["a@b.example"] } }, (await hooks.approvalSettings(inbox))!);
    expect("note" in checked && checked.note.verdict).toBe("ask");
    await hooks.autoApproved(inbox, { tool: "WebFetch", summary: "", input: { url: "https://a.example" }, site: "a.example" }, "yolo");
    expect(hub.db.conn.query("SELECT COUNT(*) AS n FROM project_auto_approved").get()).toEqual({ n: 1 });
  } finally {
    hub.shutdown.abort();
  }
});
