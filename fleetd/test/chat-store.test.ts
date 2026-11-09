// The chat store and artifacts (nudges.rs, artifacts/mod.rs).
import { expect, test } from "bun:test";
import { registerAll } from "../src/hub/serve/areas.ts";
import { Registry } from "../src/hub/api/registry.ts";
import { publish } from "../src/hub/artifacts/index.ts";
import { asksQuestion, chat, needsYou } from "../src/hub/chat/index.ts";
import type { LeadCall, LeadCaller } from "../src/hub/leads/seams.ts";
import { events } from "../src/hub/store/events.ts";
import type { ChatDelta, ChatMessage } from "../src/shared/contracts.ts";
import { caller, PROJECT, testHub } from "./hub-helpers.ts";

test("a message is added once per request or source, announced once, in order", () => {
  const { hub, done } = testHub();
  const c = chat(hub);
  const first = c.add(PROJECT, { author: "human", text: "hi", request: "r1" });
  expect(first.created).toBe(true);
  expect(c.add(PROJECT, { author: "human", text: "hi again", request: "r1" })).toEqual({ message: first.message, created: false });
  c.add(PROJECT, { author: "lead", text: "Ship it today?", source: "lead:t1:m1" });
  c.add(PROJECT, { author: "lead", text: "again", source: "lead:t1:m1" });
  const page = c.page(PROJECT, undefined, undefined, 10);
  expect(page.messages.map((m) => [m.seq, m.author, m.text])).toEqual([
    [1, "human", "hi"],
    [2, "lead", "Ship it today?"],
  ]);
  expect(page).toMatchObject({ moreBefore: false, moreAfter: false });
  const announced = events(hub).page(0).events.filter((e) => e.type === "chat.message");
  expect(announced.length).toBe(2);
  expect(announced[0]?.summary).toBe("You in the chat of Shop");
  expect(c.state(PROJECT, false)).toMatchObject({ needsYou: true, leadWorking: false, lastSeq: 2 });
  done();
});

test("needs-you: a question waits until the human replies", () => {
  expect(asksQuestion("1. Ship it today? I'd say yes.")).toBe(true);
  expect(asksQuestion("Merged **PR #4**?**")).toBe(true);
  expect(asksQuestion("Merged it.")).toBe(false);
  const m = (author: string, text: string) => ({ author, text, state: "final" }) as ChatMessage;
  expect(needsYou([m("lead", "Ship it?"), m("system", "PR #4 merged")])).toBe(true);
  expect(needsYou([m("lead", "Ship it?"), m("human", "yes")])).toBe(false);
});

test("streamed text reaches subscribers with its offsets, and finish makes it final", () => {
  const { hub, done } = testHub();
  const c = chat(hub);
  const deltas: ChatDelta[] = [];
  const stop = c.subscribe((d) => deltas.push(d));
  let m = c.add(PROJECT, { author: "lead", streaming: true, source: "lead:t1:m2" }).message;
  m = c.append(m, "Hello ");
  m = c.append(m, "world");
  expect(deltas.map((d) => [d.offset, d.append])).toEqual([
    [0, "Hello "],
    [6, "world"],
  ]);
  const final = c.finish(m, "Hello world\n\n```fleetd-block\n{\"v\":1,\"kind\":\"ask\",\"question\":\"Go?\"}\n```");
  expect(final.state).toBe("final");
  expect(final.parts?.map((p) => p.block?.kind)).toEqual([undefined, "ask"]);
  expect(c.append(final, "late")).toBe(final);
  stop();
  done();
});

test("a nudge waits until it is seen, and past the cap replaces the oldest", async () => {
  const { hub, clock, done } = testHub();
  const c = chat(hub);
  const tools = new Registry();
  registerAll(tools);
  const ids = [1, 2, 3, 4].map((i) => {
    clock.ms += 1000;
    return c.nudge(c.add(PROJECT, { author: "lead", text: `look ${i}`, source: `s${i}` }).message, `try ${i}`).messageId;
  });
  expect(c.nudgesListed(PROJECT).map((n) => n.reason)).toEqual(["try 2", "try 3", "try 4"]);
  expect(c.byId(ids[0] as string)?.nudge?.cleared).toBe("replaced");
  clock.ms += 25 * 3_600_000;
  expect(c.nudgesListed(PROJECT)).toEqual([]);
  expect(c.byId(ids[3] as string)?.nudge?.cleared).toBe("expired");
  done();
});

test("an artifact keeps its versions, posts a card and lists in the Artifacts tab", async () => {
  const { hub, done } = testHub();
  const tools = new Registry();
  registerAll(tools);
  const lead: LeadCaller = { projectRef: PROJECT, by: "lead:lab-a/p1", agent: { kind: "lead" } };
  const call = (content: string) => ({ op: "artifact_publish", name: "sweep-report", title: "Sweep", content }) as LeadCall;
  expect(publish(hub, lead, call("# one"))).toMatchObject({ name: "sweep-report", version: 1 });
  expect(publish(hub, lead, call("# two"))).toMatchObject({ version: 2 });
  expect(() => publish(hub, lead, { op: "artifact_publish", name: "Bad Name", title: "x", content: "y" } as LeadCall)).toThrow();
  const lines = chat(hub).page(PROJECT, undefined, undefined, 10).messages;
  expect(lines.map((m) => m.text)).toEqual(["Lead published Sweep", "Lead published Sweep, version 2"]);
  expect(lines[1]?.artifact).toEqual({ name: "sweep-report", version: 2, title: "Sweep", format: "md", by: "Lead" });
  const list = (await tools.call(hub, caller("read"), "artifacts_list", { projectRef: PROJECT })) as { output: Record<string, unknown> };
  expect(list.output).toMatchObject({ artifacts: [{ name: "sweep-report", newest: { version: 2, bytes: 5 } }], files: [] });
  const first = (await tools.call(hub, caller("read"), "artifact_get", { projectRef: PROJECT, name: "sweep-report", version: 1 })) as {
    output: Record<string, unknown>;
  };
  expect(first.output).toMatchObject({ content: "# one", versions: [{ version: 2 }, { version: 1 }] });
  expect(await tools.call(hub, caller("read"), "artifact_get", { projectRef: PROJECT, name: "nope" })).toMatchObject({
    error: { error: { code: "not_found", message: "No artifact nope here." } },
  });
  done();
});

test("chat_state says whether the chat waits on the person", async () => {
  const { chatState } = await import("../src/hub/chat/index.ts");
  const { hub, done } = testHub();
  expect(chatState(hub).needsYou(PROJECT)).toBe(false);
  chat(hub).add(PROJECT, { author: "lead", text: "Ship it?", source: "s1" });
  expect(chatState(hub).needsYou(PROJECT)).toBe(true);
  chat(hub).add(PROJECT, { author: "human", text: "yes", request: "r1" });
  expect(chatState(hub).needsYou(PROJECT)).toBe(false);
  done();
});

test("an agent's message to another lead is stored once, held, and says why it waits", async () => {
  const { sendAsAgent } = await import("../src/hub/chat/index.ts");
  const { checklistRead } = await import("../src/hub/checklist/index.ts");
  const { hub, done } = testHub();
  const first = await sendAsAgent(hub, PROJECT, "Ada (Navi)", "Can you book the room?", "navi:1");
  expect(first.message).toMatchObject({ author: "agent", by: "Ada (Navi)", delivery: "queued", text: "Can you book the room?" });
  expect(first.leadWaiting).toBe("Launching a lead thread is not wired in this hub yet.");
  const again = await sendAsAgent(hub, PROJECT, "Ada (Navi)", "Can you book the room?", "navi:1");
  expect(again.message.messageId).toBe(first.message.messageId);
  expect(chat(hub).held(PROJECT).length).toBe(1);
  expect(checklistRead(hub, PROJECT)).toEqual({ items: [], nextId: 1 });
  done();
});
