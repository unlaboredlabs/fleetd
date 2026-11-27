// The lead reply that closes an order keeps its stamp, "Done in 3m 8s · 3 agents" (chat/closed.ts): the hub writes it
// onto the reply as the run ends, so a chat read again later (a reload, the phone) shows it as the live one did.
import { expect, test } from "bun:test";
import { stampClosed } from "../src/hub/chat/closed.ts";
import { chat } from "../src/hub/chat/index.ts";
import { events } from "../src/hub/store/events.ts";
import { PROJECT, testHub } from "./hub-helpers.ts";

const START = Date.parse("2026-11-08T10:00:00Z");

function rig() {
  const t = testHub(START);
  const c = t.hub.db.conn;
  c.run("INSERT INTO leads (machine_id, project_id, thread_id, started_at, session_generation) VALUES (?1, ?2, 'lead-1', 'x', 1)", [PROJECT.machineId, PROJECT.projectId]);
  c.run("INSERT INTO workstreams (n, machine_id, project_id, state, data) VALUES (7, ?1, ?2, 'open', ?3)", [
    PROJECT.machineId,
    PROJECT.projectId,
    JSON.stringify({ workstreamId: "W7", projectRef: PROJECT, title: "Search speed", state: "open", createdAt: new Date(START).toISOString() }),
  ]);
  // Three agents the lead started (a QA review among them), and the train's review, which isn't one of them.
  for (const task of [{ kind: "write" }, { kind: "read" }, { kind: "review", qa: true }, { kind: "review" }]) {
    c.run("INSERT INTO tasks (machine_id, project_id, workstream_id, state, data) VALUES (?1, ?2, 'W7', 'completed', ?3)", [PROJECT.machineId, PROJECT.projectId, JSON.stringify(task)]);
  }
  const at = () => new Date(t.clock.ms).toISOString();
  const runEnd = () =>
    events(t.hub).append({ at: at(), type: "thread.completed", machineId: PROJECT.machineId, threadId: "lead-1", summary: "done", data: { threadId: "lead-1" } } as never);
  const reply = (text: string, id: string) => chat(t.hub).add(PROJECT, { author: "lead", text, source: `lead:lead-1:${id}`, createdMs: t.clock.ms }).message;
  return { ...t, at, runEnd, reply };
}

test("the reply whose run closed an order is stored with the order's whole time and agents, and keeps it when read again", () => {
  const { hub, clock, at, runEnd, reply, done } = rig();
  // The run before: it closed nothing, so its reply has no stamp.
  clock.ms += 60_000;
  const before = reply("On it: two agents.", "a");
  clock.ms += 1000;
  stampClosed(hub, PROJECT, "lead-1", runEnd().seq);
  expect(chat(hub).byId(before.messageId)?.closed).toBeUndefined();
  const floor = clock.ms;
  // The run that closes it: workstream.done, then its reply.
  clock.ms = START + 188_000;
  events(hub).append({ at: at(), type: "workstream.done", machineId: PROJECT.machineId, projectId: PROJECT.projectId, summary: "W7 is done", data: { workstreamId: "W7", reason: "shipped", by: "lead" } } as never);
  clock.ms += 2000;
  const closing = reply("Search is fast now.", "b");
  clock.ms += 1000;
  const seen: unknown[] = [];
  events(hub).subscribe((e) => {
    if (e.type === "chat.message") seen.push(e.data);
  });
  const ended = runEnd();
  stampClosed(hub, PROJECT, "lead-1", ended.seq);
  const stamp = { workstreamId: "W7", ms: 188_000, agents: 3, since: new Date(floor).toISOString(), until: new Date(clock.ms).toISOString() };
  // As stored: what the chat reads after a reload.
  const stamped = chat(hub).byId(closing.messageId);
  expect(stamped?.closed).toEqual(stamp);
  // Newer than the copy announced as it landed, so an open chat takes the stamped one over it.
  expect(stamped?.updatedAt).toBe(new Date(clock.ms).toISOString());
  expect(Date.parse(stamped?.updatedAt ?? "")).toBeGreaterThan(Date.parse(closing.updatedAt ?? closing.createdAt));
  expect(chat(hub).byId(before.messageId)?.closed).toBeUndefined();
  // And told live, so an open chat shows it at once.
  expect(JSON.stringify(seen)).toContain('"closed"');
  // The same run's end again (a later mirror) changes nothing; the next run, which closed nothing, stamps nothing.
  clock.ms += 5000;
  stampClosed(hub, PROJECT, "lead-1", ended.seq);
  const next = reply("Anything else?", "c");
  clock.ms += 1000;
  stampClosed(hub, PROJECT, "lead-1", runEnd().seq);
  expect(chat(hub).byId(next.messageId)?.closed).toBeUndefined();
  expect(chat(hub).byId(closing.messageId)?.closed).toEqual(stamp);
  done();
});
