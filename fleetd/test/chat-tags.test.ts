// The chat's tags trial (chat/tags.ts, artifact threads-design): off by default, and then nothing changes; on, the hub
// tags each message with the order it is about, folds a closed order into its last message, and a person's move of a
// message reaches the lead with its next wake.
import { expect, test } from "bun:test";
import type { Hub } from "../src/hub/api/hub.ts";
import type { Trigger } from "../src/hub/api/lead_lines.ts";
import { Registry } from "../src/hub/api/registry.ts";
import { Requests } from "../src/hub/approvals/store.ts";
import { touched } from "../src/hub/chat/about.ts";
import { mirror } from "../src/hub/chat/flow.ts";
import { chat } from "../src/hub/chat/index.ts";
import { forLead } from "../src/hub/chat/lead_text.ts";
import { humanAbout, refold, settleEnded, settleRun, tagAsked } from "../src/hub/chat/tags.ts";
import { renderLeadStart } from "../src/hub/leads/prompt.ts";
import { setChatTags } from "../src/hub/project_lead/store.ts";
import { prompts } from "../src/hub/prompts/store.ts";
import { registerAll } from "../src/hub/serve/areas.ts";
import { events } from "../src/hub/store/events.ts";
import { store } from "../src/hub/store/hub_store.ts";
import type { ChatItem, ChatMessage, ProjectSummary } from "../src/shared/contracts.ts";
import { caller, PROJECT, testHub } from "./hub-helpers.ts";

const DANA = { personId: "p_dddddddd", name: "Dana Park" };
const SAM = { personId: "p_ssssssss", name: "Sam Rivera" };

/** A hub with the project's lead, two orders and the wakes the lead would get. */
function rig(on: boolean) {
  const t = testHub();
  const wakes: Trigger[] = [];
  t.hub.area("lead_wakes", () => ({ trigger: (_r: unknown, trigger: Trigger) => void wakes.push(trigger) }));
  const c = t.hub.db.conn;
  c.run("INSERT INTO leads (machine_id, project_id, thread_id, started_at, session_generation) VALUES (?1, ?2, 'lead-1', 'x', 1)", [PROJECT.machineId, PROJECT.projectId]);
  const order = (n: number, title: string, startedBy?: object) =>
    c.run("INSERT INTO workstreams (n, machine_id, project_id, state, data) VALUES (?1, ?2, ?3, 'open', ?4)", [
      n,
      PROJECT.machineId,
      PROJECT.projectId,
      JSON.stringify({ workstreamId: `W${n}`, projectRef: PROJECT, title, state: "open", ...(startedBy ? { startedBy } : {}) }),
    ]);
  order(3, "Search speed", DANA);
  order(4, "Price filter", SAM);
  if (on) setChatTags(c, PROJECT, true);
  const tools = new Registry();
  registerAll(tools);
  const call = async (tool: string, input: unknown, person = SAM) => {
    const out = (await tools.call(t.hub, caller("operate", true, person), tool, input)) as { output?: any; error?: { message?: string; error?: Error } };
    if (out.error) throw new Error(out.error.error?.message ?? out.error.message ?? "refused");
    return out.output;
  };
  return { ...t, wakes, call };
}

const lead = (hub: Hub, text: string, source: string) => chat(hub).add(PROJECT, { author: "lead", text, source }).message;

function close(hub: Hub, n: number) {
  const row = hub.db.all<{ data: string }>("SELECT data FROM workstreams WHERE n = ?1", [n])[0] as { data: string };
  const data = { ...JSON.parse(row.data), state: "done" };
  hub.db.conn.run("UPDATE workstreams SET state = 'done', data = ?1 WHERE n = ?2", [JSON.stringify(data), n]);
}

test("with the switch off nothing changes: no tags, markers stay, no prompt lines, and moving a message is refused", async () => {
  const { hub, call, wakes, done } = rig(false);
  expect(store(hub).projectGet(PROJECT)?.chatTags).toBeUndefined();
  touched(hub, PROJECT, "W3");
  const reply = lead(hub, "Found it: product images are 2 MB each.", "lead:lead-1:a");
  expect(reply.about).toBeUndefined();
  const marked = lead(hub, "[W3] Search is faster.\n\n[W4] The filter is in review.", "lead:lead-1:b");
  expect(marked.text).toBe("[W3] Search is faster.\n\n[W4] The filter is in review.");
  expect(marked.parts?.some((p) => p.about !== undefined)).toBe(false);
  expect(JSON.stringify(chat(hub).byId(marked.messageId))).not.toContain('"about"');
  expect(humanAbout(hub, PROJECT, "W3", reply, undefined)).toBeUndefined();
  settleRun(hub, PROJECT, "lead-1", hub.clock.now());
  expect(chat(hub).byId(reply.messageId)?.about).toBeUndefined();
  await expect(call("chat_about_set", { projectRef: PROJECT, messageId: reply.messageId, workstreamId: "W4" })).rejects.toThrow("This project's chat tags are off.");
  expect(wakes).toEqual([]);
  const set = prompts(hub.db).current(PROJECT);
  const off = renderLeadStart(set, PROJECT, "Shop", [], "", "", "", undefined);
  expect(off.system).not.toContain("[W12]");
  expect(off.system).not.toContain("{{tags}}");
  const human = { author: "human", text: "hi", createdAt: "2026-11-08T10:00:00Z" } as ChatMessage;
  expect(forLead(set, human, undefined, "", "Dana Park", "Sun 8 Nov")).toStartWith("Dana Park writes in your chat (Sun 8 Nov):");
  done();
});

test("switch on: the lead's message is about the one order its turn touched, and markers split a message by order", () => {
  const { hub, done } = rig(true);
  expect(store(hub).projectGet(PROJECT)?.chatTags).toBe(true);
  // Nothing touched yet: untagged.
  expect(lead(hub, "Mei: 71% of checkout's lines.", "lead:lead-1:q").about).toBeUndefined();
  touched(hub, PROJECT, "W3");
  expect(lead(hub, "Looking: an agent is timing search.", "lead:lead-1:a").about).toEqual({ workstreamId: "W3", title: "Search speed" });
  // One message about two orders: each bubble opens with its order's id, which the hub strips.
  const two = lead(hub, "[W3] Found it: images are 2 MB.\n\n[W4] On it: two writers.\n\nAnything else?", "lead:lead-1:b");
  expect(two.text).toBe("Found it: images are 2 MB.\n\nOn it: two writers.\n\nAnything else?");
  expect(two.about).toBeUndefined();
  expect(two.parts?.map((p) => [two.text.slice(p.start, p.end), p.about?.workstreamId])).toEqual([
    ["Found it: images are 2 MB.", "W3"],
    ["On it: two writers.", "W4"],
    ["Anything else?", undefined],
  ]);
  // Every bubble about the same order: the message's tag.
  const one = lead(hub, "[W4] On it.", "lead:lead-1:c");
  expect([one.text, one.about?.workstreamId, one.parts]).toEqual(["On it.", "W4", undefined]);
  // An id of no order of the project stays as it is.
  expect(lead(hub, "[W99] what?", "lead:lead-1:d").text).toBe("[W99] what?");
  // A streamed reply is tagged as it is finished.
  const streaming = chat(hub).add(PROJECT, { author: "lead", streaming: true, source: "lead:lead-1:e" }).message;
  expect(streaming.about).toBeUndefined();
  expect(chat(hub).finish(streaming, "Done.").about?.workstreamId).toBe("W3");
  done();
});

test("switch on: an approval card is about its request's order", () => {
  const { hub, done } = rig(true);
  const request = new Requests(hub.db).create({
    projectRef: PROJECT,
    workstreamId: "W4",
    kind: "approval",
    text: "Run bin/backfill on devbox",
    gated: { argv: ["bin/backfill"], cwd: "/srv/shop", class: "normal", reason: "backfill", timeoutSec: 60 },
    at: "2026-11-08T10:00:00.000Z",
    atMs: hub.clock.now(),
  } as never);
  const item = { kind: "command_approval", requestId: request.requestId, state: "open" } as unknown as ChatItem;
  expect(chat(hub).item(PROJECT, item).about).toEqual({ workstreamId: "W4", title: "Price filter" });
  done();
});

test("switch on: a person's message takes its lens or the tag of the bubble it answers, else its turn's order", () => {
  const { hub, clock, done } = rig(true);
  touched(hub, PROJECT, "W3");
  const reply = lead(hub, "Looking.", "lead:lead-1:a");
  expect(humanAbout(hub, PROJECT, undefined, reply, 0)?.workstreamId).toBe("W3");
  expect(humanAbout(hub, PROJECT, "W4", reply, 0)?.workstreamId).toBe("W4");
  close(hub, 4);
  // A lens on a closed order, or a reply to one's bubble, doesn't tag a new message.
  expect(humanAbout(hub, PROJECT, "W4", undefined, undefined)).toBeUndefined();
  // Rule (a): the message an order was opened from.
  const asked = chat(hub).add(PROJECT, { author: "human", text: "Search feels slow", person: DANA, delivery: "turn" }).message;
  tagAsked(hub, PROJECT, "W3", Date.parse(asked.createdAt), DANA);
  expect(chat(hub).byId(asked.messageId)?.about?.workstreamId).toBe("W3");
  // The run's end: an untagged message it took in is about the one order it touched.
  const more = chat(hub).add(PROJECT, { author: "human", text: "also on phones", person: DANA, delivery: "turn" }).message;
  clock.ms += 1000;
  events(hub).append({ at: new Date(hub.clock.now()).toISOString(), type: "thread.completed", machineId: PROJECT.machineId, threadId: "lead-1", summary: "done", data: { threadId: "lead-1" } } as never);
  settleRun(hub, PROJECT, "lead-1", hub.clock.now());
  expect(chat(hub).byId(more.messageId)?.about?.workstreamId).toBe("W3");
  const filter = lead(hub, "[W4] The filter is live.", "lead:lead-1:f");
  expect(humanAbout(hub, PROJECT, undefined, filter, 0)).toBeUndefined();
  done();
});

test("switch on: a run is settled once, so a message a person moved to no order stays there", async () => {
  const { hub, clock, call, done } = rig(true);
  touched(hub, PROJECT, "W3");
  const chips = chat(hub).add(PROJECT, { author: "human", text: "the chips overlap", person: DANA, delivery: "turn" }).message;
  clock.ms += 1000;
  // The run's end as a node reports it: its `at` is the session's last progress, before the hub logs it.
  const ended = events(hub).append({ at: new Date(clock.ms - 50).toISOString(), type: "thread.completed", machineId: PROJECT.machineId, threadId: "lead-1", summary: "done", data: { threadId: "lead-1" } } as never);
  settleEnded(hub, PROJECT, "lead-1", ended.seq);
  expect(chat(hub).byId(chips.messageId)?.about?.workstreamId).toBe("W3");
  await call("chat_about_set", { projectRef: PROJECT, messageId: chips.messageId });
  // The same run's end again (a later mirror, a node back): nothing is tagged again.
  clock.ms += 5000;
  settleEnded(hub, PROJECT, "lead-1", ended.seq);
  settleRun(hub, PROJECT, "lead-1", clock.ms);
  await mirror(hub, PROJECT, { machineId: PROJECT.machineId, threadId: "lead-1" });
  expect(chat(hub).byId(chips.messageId)?.about).toBeUndefined();
  done();
});

test("switch on: a closed order folds into its last message, and a later message about it takes the fold", () => {
  const { hub, done } = rig(true);
  touched(hub, PROJECT, "W3");
  const a = lead(hub, "Looking.", "lead:lead-1:a");
  const b = lead(hub, "Found it.", "lead:lead-1:b");
  close(hub, 3);
  events(hub).append({ at: new Date(hub.clock.now()).toISOString(), type: "workstream.done", machineId: PROJECT.machineId, projectId: PROJECT.projectId, summary: "W3 is done", data: { workstreamId: "W3" } } as never);
  // What the flow does as it follows workstream.done.
  refold(hub, PROJECT, "W3");
  expect(chat(hub).byId(a.messageId)?.fold).toBeUndefined();
  expect(chat(hub).byId(b.messageId)?.fold).toEqual({ workstreamId: "W3", title: "Search speed", state: "done", count: 2 });
  // The landing said after the close: the fold moves to it.
  const landed = lead(hub, "[W3] Search speed is live.", "lead:lead-1:c");
  expect(chat(hub).byId(b.messageId)?.fold).toBeUndefined();
  expect(chat(hub).byId(landed.messageId)?.fold).toEqual({ workstreamId: "W3", title: "Search speed", state: "done", count: 3 });
  // Each change reached the apps as a chat.message.
  const folds = events(hub)
    .page(0)
    .events.filter((e) => e.type === "chat.message" && (e.data as { message?: ChatMessage }).message?.messageId === b.messageId);
  expect(folds.map((e) => (e.data as { message: ChatMessage }).message.fold?.count)).toEqual([undefined, 2, undefined]);
  done();
});

test("switch on: chat_about_set moves a message to another open order, refolds, and tells the lead with its next wake", async () => {
  const { hub, call, wakes, done } = rig(true);
  touched(hub, PROJECT, "W3");
  const chips = chat(hub).add(PROJECT, { author: "human", text: "also the filter chips overlap the results", person: DANA, about: { workstreamId: "W3", title: "Search speed" } }).message;
  const out = await call("chat_about_set", { projectRef: PROJECT, messageId: chips.messageId, workstreamId: "W4" });
  expect(out.message.about).toEqual({ workstreamId: "W4", title: "Price filter" });
  expect(out.next).toBe("The lead hears of it with its next wake.");
  expect(chat(hub).byId(chips.messageId)?.about?.workstreamId).toBe("W4");
  expect(wakes).toEqual([
    {
      kind: "line",
      line: "retag",
      text: `- Sam Rivera moved a message (${chips.messageId}) from Search speed (W3) to Price filter (W4): "also the filter chips overlap the results"`,
    },
  ]);
  // The same move again is no move; none takes the tag off.
  await call("chat_about_set", { projectRef: PROJECT, messageId: chips.messageId, workstreamId: "W4" });
  expect(wakes.length).toBe(1);
  const none = await call("chat_about_set", { projectRef: PROJECT, messageId: chips.messageId });
  expect(none.message.about).toBeUndefined();
  expect(wakes[1]?.text).toContain("from Price filter (W4) to no order");
  // Only to an open order of the project, and only a message of its chat.
  close(hub, 4);
  await expect(call("chat_about_set", { projectRef: PROJECT, messageId: chips.messageId, workstreamId: "W4" })).rejects.toThrow("W4 is not an open order of this project.");
  await expect(call("chat_about_set", { projectRef: PROJECT, messageId: "m999", workstreamId: "W3" })).rejects.toThrow("No message m999 in this chat.");
  done();
});

test("switch on: the lead's prompt carries the design's lines, and a person's message says what it is about", () => {
  const { hub, done } = rig(true);
  const set = prompts(hub.db).current(PROJECT);
  const on = renderLeadStart(set, PROJECT, "Shop", [], "", "", "", undefined, true);
  expect(on.system).toContain("don't start a bubble with a person's name.");
  expect(on.system).toContain("start each with the order's id in brackets, [W12]. fleetd hides it.");
  expect(on.system).toContain("is a person's correction: take it as theirs, and act on it if it changes the work.");
  const human = { author: "human", text: "hi", createdAt: "2026-11-08T10:00:00Z" } as ChatMessage;
  expect(forLead(set, { ...human, about: { workstreamId: "W12", title: "Apple Pay" } }, undefined, "", "Alice Chen", "Sun 8 Nov", true)).toStartWith(
    "Alice Chen writes in your chat about Apple Pay (W12) (Sun 8 Nov):",
  );
  expect(forLead(set, human, undefined, "", "Alice Chen", "Sun 8 Nov", true)).toStartWith("Alice Chen writes in your chat, not about an order (Sun 8 Nov):");
  done();
});

test("project_settings_set turns the trial on and off, and the project serves it", async () => {
  const { hub, call, done } = rig(false);
  const input = { machineId: PROJECT.machineId, projectId: PROJECT.projectId };
  await call("project_settings_set", { ...input, chatTags: true }).catch(() => undefined);
  expect((store(hub).projectGet(PROJECT) as ProjectSummary).chatTags).toBe(true);
  expect(events(hub).page(0).events.filter((e) => e.type === "project.settings").map((e) => e.data)).toEqual([{ chatTags: true }]);
  await call("project_settings_set", { ...input, chatTags: false }).catch(() => undefined);
  expect((store(hub).projectGet(PROJECT) as ProjectSummary).chatTags).toBeUndefined();
  done();
});
