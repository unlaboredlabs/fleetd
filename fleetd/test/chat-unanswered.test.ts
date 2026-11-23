// A lead turn a person's message came into never ends with the person left waiting (W788): a turn that posts nothing
// (one that ends with `(quiet)`, or no text) asks the lead once to answer, and if that turn posts nothing too, the chat
// says so. A wake's turn keeps `(quiet)` as silence.
import { expect, test } from "bun:test";
import type { Trigger } from "../src/hub/api/lead_lines.ts";
import { run } from "../src/hub/chat/flow.ts";
import { chat } from "../src/hub/chat/index.ts";
import { NO_REPLY_LINE } from "../src/hub/chat/unanswered.ts";
import { executors } from "../src/hub/executor/index.ts";
import { leads } from "../src/hub/leads/index.ts";
import { events } from "../src/hub/store/events.ts";
import { store } from "../src/hub/store/hub_store.ts";
import type { ThreadRef } from "../src/shared/contracts.ts";
import type { ThreadMessage } from "../src/shared/sessions.ts";
import { PROJECT, testHub } from "./hub-helpers.ts";

const THREAD = "lead-1";

/** A hub following its lead's turns, with the lead's session read from `said` and its wakes recorded. */
async function rig(o: { unread?: boolean } = {}) {
  const t = testHub();
  const { hub, clock } = t;
  leads(hub).records.leadPut({ projectRef: PROJECT, threadId: THREAD, startedAt: "2026-11-08T10:00:00Z", sessionGeneration: 1 });
  await chat(hub).readHistory(PROJECT, () => []);
  const said: ThreadMessage[] = [];
  executors(hub).views.messages = async (_thread: ThreadRef) => {
    if (o.unread) throw new Error("the node didn't answer");
    return said;
  };
  executors(hub).views.runs = async (_thread: ThreadRef) => [];
  const wakes: Trigger[] = [];
  leads(hub).wakes.trigger = (_r, trigger) => void wakes.push(trigger);
  void run(hub);
  await Bun.sleep(20);
  const at = () => new Date(clock.ms).toISOString();
  let n = 0;
  /** The person writes, as a message the lead took. */
  const person = (text: string) => {
    clock.ms += 1000;
    return chat(hub).add(PROJECT, { author: "human", text, delivery: "turn" }).message;
  };
  /** The lead's session wrote `text` in its turn. */
  const lead = (text: string) => {
    clock.ms += 1000;
    said.push({ id: `a${++n}`, role: "assistant", text, createdAt: at() });
  };
  /** The lead's turn ends as `type`, and the hub has followed it. */
  const ends = async (type: "thread.completed" | "thread.interrupted" = "thread.completed") => {
    clock.ms += 1000;
    events(hub).append({ at: at(), type, machineId: PROJECT.machineId, projectId: PROJECT.projectId, threadId: THREAD, summary: type });
    // The follower takes it from the event log and reads the lead's session.
    await Bun.sleep(60);
  };
  events(hub).append({ at: at(), type: "thread.started", machineId: PROJECT.machineId, projectId: PROJECT.projectId, threadId: THREAD, summary: "started" });
  const lines = () => chat(hub).page(PROJECT, undefined, undefined, 50).messages.map((m) => `${m.author}: ${m.text}`);
  return { ...t, wakes, person, lead, ends, lines };
}

test("a turn answering a person that ends with only (quiet) asks the lead once; a second silent turn posts a plain line, then nothing more", async () => {
  const { wakes, person, lead, ends, lines, done } = await rig();
  person("retry");
  lead("(quiet)");
  await ends();
  expect(wakes).toEqual([{ kind: "line", line: "unanswered", text: expect.stringContaining('The person\'s message "retry" has no reply') }]);
  expect(lines()).toEqual(["human: retry"]);
  // The asked turn says nothing either: the person reads why there is no answer, and the lead isn't asked again.
  lead("\n(quiet)\n");
  await ends();
  expect(wakes.length).toBe(1);
  expect(lines()).toEqual(["human: retry", `system: ${NO_REPLY_LINE}`]);
  // Later turns (wakes) say nothing about it again.
  await ends();
  lead("(quiet)");
  await ends();
  expect(wakes.length).toBe(1);
  expect(lines()).toEqual(["human: retry", `system: ${NO_REPLY_LINE}`]);
  done();
});

test("a turn answering a person with words then (quiet) posts nothing, so the lead is asked once and its answer lands", async () => {
  const { wakes, person, lead, ends, lines, done } = await rig();
  person("what model are you");
  lead("Asked and answered before; nothing new.\n\n(quiet)");
  await ends();
  expect(wakes.map((w) => w.kind === "line" && w.line)).toEqual(["unanswered"]);
  expect(lines()).toEqual(["human: what model are you"]);
  lead("I'm running on Opus 5.5.");
  await ends();
  expect(wakes.length).toBe(1);
  expect(lines()).toEqual(["human: what model are you", "lead: I'm running on Opus 5.5."]);
  done();
});

test("a turn answering a person that ends with no text at all asks the lead; its answer then lands and nothing more is said", async () => {
  const { wakes, person, lead, ends, lines, done } = await rig();
  person("so ??");
  await ends();
  expect(wakes.map((w) => w.kind === "line" && w.line)).toEqual(["unanswered"]);
  lead("Sorry, should've said: the import is blocked on the tern folder.");
  await ends();
  expect(wakes.length).toBe(1);
  expect(lines()).toEqual(["human: so ??", "lead: Sorry, should've said: the import is blocked on the tern folder."]);
  done();
});

test("a turn that answers, a wake's quiet turn, a stopped turn and a turn still followed by another post nothing more", async () => {
  const { hub, wakes, person, lead, ends, lines, done } = await rig();
  person("add dark mode");
  lead("On it: W5.");
  await ends();
  // An agent's result wakes the lead later; its turn is quiet, and the person's message was answered before it.
  lead("(quiet)");
  await ends();
  expect(wakes).toEqual([]);
  // The person stops the lead's turn: no ask for the message it was answering.
  person("wait");
  await ends("thread.interrupted");
  expect(wakes).toEqual([]);
  // A wake's quiet turn after the stop: the person's message is older than the thread's last end.
  lead("(quiet)");
  await ends();
  expect(wakes).toEqual([]);
  // A message that came while a next turn already runs waits for that turn's end.
  person("and a toggle");
  store(hub).threadUpsert({
    thread: { machineId: PROJECT.machineId, threadId: THREAD, projectId: PROJECT.projectId, status: "running", lastProgressAt: new Date(hub.clock.now()).toISOString() } as never,
  });
  await ends();
  expect(wakes).toEqual([]);
  expect(lines()).toEqual(["human: add dark mode", "lead: On it: W5.", "human: wait", "human: and a toggle"]);
  done();
});

test("a turn whose session couldn't be read asks nothing: its reply may be there", async () => {
  const { wakes, person, ends, done } = await rig({ unread: true });
  person("retry");
  await ends();
  expect(wakes).toEqual([]);
  done();
});
