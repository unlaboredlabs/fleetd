// The checklist.
import { expect, test } from "bun:test";
import { registerAll } from "../src/hub/serve/areas.ts";
import { Registry } from "../src/hub/api/registry.ts";
import { answer } from "../src/hub/checklist/calls.ts";
import { digestLines } from "../src/hub/checklist/index.ts";
import type { LeadCall, LeadCaller } from "../src/hub/leads/seams.ts";
import { LeadRecords } from "../src/hub/leads/records.ts";
import { events } from "../src/hub/store/events.ts";
import { TaskRecords } from "../src/hub/tasks/records.ts";
import { changeRecords } from "../src/hub/train/index.ts";
import type { Change, Task, TaskState } from "../src/shared/contracts.ts";
import type { Hub } from "../src/hub/api/hub.ts";
import { caller, PROJECT, testHub } from "./hub-helpers.ts";

const lead: LeadCaller = { projectRef: PROJECT, by: "lead:lab-a/p1", agent: { kind: "lead" } };
const call = (body: Record<string, unknown>) => ({ op: "checklist", ...body }) as LeadCall;
const shape = (items: unknown) => (items as { id: number; state: string; text: string }[]).map((i) => [i.id, i.state, i.text]);

test("the lead sets and updates its project's list and the app reads it", async () => {
  const { hub, done } = testHub(Date.parse("2026-10-14T17:46:40Z"));
  const tools = new Registry();
  registerAll(tools);
  const get = async () => ((await tools.call(hub, caller("read"), "checklist_get", { projectRef: PROJECT })) as { output: Record<string, unknown> }).output;
  const empty = await get();
  expect(empty.items).toEqual([]);
  expect(empty.updatedAt).toBeUndefined();
  expect(String(empty.next)).toContain("lead keeps this list");

  const out = answer(
    hub,
    lead,
    call({
      items: [
        { text: "Receipts in the shop's time zone", link: { workstreamId: "W3" } },
        { text: "Dark mode", state: "doing" },
        { text: "Release notes" },
      ],
    }),
  );
  expect(shape(out.items)).toEqual([
    [1, "todo", "Receipts in the shop's time zone"],
    [2, "doing", "Dark mode"],
    [3, "todo", "Release notes"],
  ]);
  answer(
    hub,
    lead,
    call({
      items: [
        { id: 2, state: "done", link: { pr: "https://github.com/acme/storefront/pull/11" } },
        { id: 3, remove: true },
        { text: "Ship it", state: "todo" },
      ],
    }),
  );
  const list = await get();
  expect(shape(list.items)).toEqual([
    [1, "todo", "Receipts in the shop's time zone"],
    [2, "done", "Dark mode"],
    [4, "todo", "Ship it"],
  ]);
  expect(list.updatedAt).toBe("2026-10-14T17:46:40.000Z");
  const changes = () => events(hub).page(0).events.filter((e) => e.type === "checklist.changed");
  expect(changes().length).toBe(2);
  expect(changes()[1]).toMatchObject({ summary: "checklist: 1 of 3 done", data: { done: 1, total: 3, by: "lead:lab-a/p1" } });
  const same = answer(hub, lead, call({ items: [{ id: 2, state: "done" }] }));
  expect(String(same.next)).toStartWith("No change");
  expect(changes().length).toBe(2);
  expect(() => answer(hub, lead, call({ items: [{ id: 9, state: "done" }] }))).toThrow("No item 9");
  done();
});

test("the lead's digest shows what is still open", () => {
  const { hub, done } = testHub();
  expect(digestLines(hub, PROJECT, hub.clock.now())).toBeUndefined();
  answer(
    hub,
    lead,
    call({
      items: [
        { text: "Receipts", state: "done" },
        { text: "Dark mode", state: "doing", link: { taskId: "T4", pr: "https://github.com/acme/storefront/pull/12" } },
        { text: "Release notes" },
      ],
    }),
  );
  expect(digestLines(hub, PROJECT, hub.clock.now())).toEqual([
    "1 of 3 done; keep it current with `checklist`",
    "- 2 doing: Dark mode (T4, PR #12)",
    "- 3 todo: Release notes",
  ]);
  done();
});

const DAY = 24 * 60 * 60 * 1000;

function order(hub: Hub, title: string, state: "open" | "done" = "open"): string {
  const records = new LeadRecords(hub.db);
  const { workstream } = records.workstreamCreate({ projectRef: PROJECT, title, text: title, channel: "chat", by: "lead", at: "2026-11-01T10:00:00.000Z" });
  if (state !== "open") records.workstreamPut({ ...workstream, state });
  return workstream.workstreamId;
}

const agent = (hub: Hub, workstreamId: string, state: TaskState) =>
  TaskRecords.create(hub.db.conn, {
    taskId: "T0",
    projectRef: PROJECT,
    workstreamId,
    title: "work",
    kind: "write",
    prompt: "do it",
    state,
    attempt: 1,
    createdAt: "2026-11-01T10:00:00.000Z",
  } as Task).taskId;

function pr(hub: Hub, n: number, state: string): string {
  const url = `https://github.com/acme/shop/pull/${n}`;
  changeRecords(hub).create({
    changeId: "X1",
    projectRef: PROJECT,
    repo: "acme/shop",
    prNumber: n,
    prUrl: url,
    branch: `fleetd/T9-pr-${n}`,
    workstreamId: "W1",
    headSha: "0123456789abcdef0123456789abcdef01234567",
    state,
    reviews: [],
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:00:00.000Z",
  } as unknown as Change);
  return url;
}

test("the digest lists stale items first: nothing live behind their link for 3 days or more", () => {
  const { hub, clock, done } = testHub();
  const closed = order(hub, "closed order", "done");
  agent(hub, closed, "running");
  const busy = order(hub, "busy order");
  agent(hub, busy, "running");
  const waiting = order(hub, "waiting order");
  agent(hub, waiting, "idle");
  const idle = order(hub, "idle order");
  agent(hub, idle, "done");
  const ended = agent(hub, idle, "failed");
  const running = agent(hub, busy, "queued");
  const merged = pr(hub, 11, "merged");
  const onTrain = pr(hub, 12, "ci");
  const off = "https://github.com/acme/shop/pull/13";
  answer(
    hub,
    lead,
    call({
      items: [
        { text: "Order closed", link: { workstreamId: closed } },
        { text: "Order with a running agent", state: "doing", link: { workstreamId: busy } },
        { text: "Order with an agent waiting", link: { workstreamId: waiting } },
        { text: "Order with no live agent", link: { workstreamId: idle } },
        { text: "Ended task", state: "doing", link: { taskId: ended } },
        { text: "Queued task", link: { taskId: running } },
        { text: "Merged PR", link: { pr: merged } },
        { text: "PR on the train", link: { pr: onTrain } },
        { text: "PR never on the train", link: { pr: off } },
        { text: "Ended task, PR on the train", link: { taskId: ended, pr: onTrain } },
        { text: "No link" },
        { text: "Done long ago", state: "done" },
      ],
    }),
  );
  clock.ms += 5 * DAY;
  expect(digestLines(hub, PROJECT, clock.ms)).toEqual([
    "1 of 12 done; keep it current with `checklist`",
    `- 1 todo: Order closed (${closed}) (unchanged 5 d, nothing running)`,
    `- 4 todo: Order with no live agent (${idle}) (unchanged 5 d, nothing running)`,
    `- 5 doing: Ended task (${ended}) (unchanged 5 d, nothing running)`,
    "- 7 todo: Merged PR (PR #11) (unchanged 5 d, nothing running)",
    "- 9 todo: PR never on the train (PR #13) (unchanged 5 d, nothing running)",
    "- 11 todo: No link (unchanged 5 d, nothing running)",
    `- 2 doing: Order with a running agent (${busy})`,
    `- 3 todo: Order with an agent waiting (${waiting})`,
    `- 6 todo: Queued task (${running})`,
    "- 8 todo: PR on the train (PR #12)",
    `- 10 todo: Ended task, PR on the train (${ended}, PR #12)`,
  ]);
  done();
});

test("an item turns stale at 3 days unchanged, and a change starts its clock again", () => {
  const { hub, clock, done } = testHub();
  answer(hub, lead, call({ items: [{ text: "Release notes" }, { text: "Receipts" }] }));
  clock.ms += 3 * DAY - 1;
  expect(digestLines(hub, PROJECT, clock.ms)).toEqual([
    "0 of 2 done; keep it current with `checklist`",
    "- 1 todo: Release notes",
    "- 2 todo: Receipts",
  ]);
  answer(hub, lead, call({ items: [{ id: 2, state: "doing" }] }));
  clock.ms += 1;
  expect(digestLines(hub, PROJECT, clock.ms)).toEqual([
    "0 of 2 done; keep it current with `checklist`",
    "- 1 todo: Release notes (unchanged 3 d, nothing running)",
    "- 2 doing: Receipts",
  ]);
  answer(hub, lead, call({ items: [{ id: 1, state: "done" }] }));
  clock.ms += 30 * DAY;
  expect(digestLines(hub, PROJECT, clock.ms)).toEqual([
    "1 of 2 done; keep it current with `checklist`",
    "- 2 doing: Receipts (unchanged 30 d, nothing running)",
  ]);
  done();
});

test("at most 10 stale items are named, then a count of the rest, before the fresh ones", () => {
  const { hub, clock, done } = testHub();
  answer(hub, lead, call({ items: Array.from({ length: 13 }, (_, i) => ({ text: `Old ${i + 1}` })) }));
  clock.ms += 4 * DAY;
  answer(hub, lead, call({ items: [{ text: "New" }] }));
  const lines = digestLines(hub, PROJECT, clock.ms)!;
  expect(lines.length).toBe(13);
  expect(lines[1]).toBe("- 1 todo: Old 1 (unchanged 4 d, nothing running)");
  expect(lines[10]).toBe("- 10 todo: Old 10 (unchanged 4 d, nothing running)");
  expect(lines.slice(11)).toEqual(["(+3 more stale items)", "- 14 todo: New"]);
  done();
});

test("a person takes items off; an agent key may not", async () => {
  const { hub, done } = testHub();
  const tools = new Registry();
  registerAll(tools);
  answer(hub, lead, call({ items: [{ text: "a" }, { text: "b", state: "done" }] }));
  const refused = await tools.call(hub, caller("operate"), "checklist_remove", { projectRef: PROJECT, ids: [2] });
  expect(refused).toMatchObject({ error: { kind: "tool", error: { code: "forbidden" } } });
  const removed = (await tools.call(hub, caller("operate", true), "checklist_remove", { projectRef: PROJECT, ids: [2] })) as {
    output: { items: unknown };
  };
  expect(shape(removed.output.items)).toEqual([[1, "todo", "a"]]);
  const last = events(hub).page(0).events.filter((e) => e.type === "checklist.changed").at(-1);
  expect(last?.data).toMatchObject({ by: "human:Ada's phone", done: 0, total: 1 });
  done();
});
