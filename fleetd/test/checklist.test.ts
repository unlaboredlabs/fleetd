// The checklist (crates/fleetd/src/hub/checklist/tests.rs).
import { expect, test } from "bun:test";
import { registerAll } from "../src/hub/serve/areas.ts";
import { Registry } from "../src/hub/api/registry.ts";
import { answer } from "../src/hub/checklist/calls.ts";
import { digestLines } from "../src/hub/checklist/index.ts";
import type { LeadCall, LeadCaller } from "../src/hub/leads/seams.ts";
import { events } from "../src/hub/store/events.ts";
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
  expect(digestLines(hub.db, PROJECT)).toBeUndefined();
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
  expect(digestLines(hub.db, PROJECT)).toEqual([
    "1 of 3 done; keep it current with `checklist`",
    "- 2 doing: Dark mode (T4, PR #12)",
    "- 3 todo: Release notes",
  ]);
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
