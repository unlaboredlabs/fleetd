import { expect, test } from "bun:test";
import { Registry } from "../src/hub/api/registry.ts";
import { register as apiTools } from "../src/hub/api/tools.ts";
import { register as pinTools } from "../src/hub/chat_pins/tools.ts";
import { register as orderTools } from "../src/hub/sidebar_order/tools.ts";
import { Hub } from "../src/hub/api/hub.ts";
import { HubDb } from "../src/hub/store/db.ts";
import { events, type NewEvent } from "../src/hub/store/events.ts";
import type { AgentKeyInfo } from "../src/shared/contracts.ts";

function setup() {
  const hub = new Hub({ home: "/nonexistent", listen: { host: "127.0.0.1", port: 0 } }, HubDb.memory(), { now: () => Date.now() });
  const tools = new Registry();
  apiTools(tools);
  orderTools(tools);
  pinTools(tools);
  hub.db.conn.run("INSERT INTO people (person_id, name, role, created_ms) VALUES ('p_adaadaad', 'Ada', 'owner', 1), ('p_bobobobo', 'Bo', 'member', 2)");
  const key = (person: string | undefined, grants: AgentKeyInfo["grants"] = [{ role: "admin", machines: "*" }]): AgentKeyInfo => ({
    keyId: `k_${person ?? "agent"}`,
    name: person ?? "agent",
    prefix: "fld_aaaaaa",
    grants,
    createdAt: "2026-11-08T00:00:00.000Z",
    ...(person ? { kind: "human" as const, person: { personId: person, name: person } } : {}),
  });
  return { hub, tools, key };
}

const ok = (r: { output: unknown } | { error: unknown }) => {
  if (!("output" in r)) throw new Error(JSON.stringify(r.error));
  return r.output as Record<string, unknown>;
};

test("a person's sidebar order and pins are theirs: kept, announced, and their events seen only by them", async () => {
  const { hub, tools, key } = setup();
  const ada = key("p_adaadaad");
  const bo = key("p_bobobobo");
  const order = [{ machineId: "devbox", projectId: "p2" }, { machineId: "devbox", projectId: "p1" }];
  expect(ok(await tools.call(hub, ada, "sidebar_order_get", {}))).toEqual({ order: [] });
  expect(ok(await tools.call(hub, ada, "sidebar_order_set", { order }))).toEqual({ order });
  expect(ok(await tools.call(hub, ada, "sidebar_order_get", {}))).toEqual({ order });
  expect(ok(await tools.call(hub, bo, "sidebar_order_get", {}))).toEqual({ order: [] });
  expect(ok(await tools.call(hub, ada, "chat_pins_get", {}))).toEqual({ set: false, pins: [] });
  ok(await tools.call(hub, ada, "chat_pins_set", { pins: order.slice(0, 1) }));
  expect(ok(await tools.call(hub, ada, "chat_pins_get", {}))).toEqual({ set: true, pins: order.slice(0, 1) });
  const agent = await tools.call(hub, key(undefined), "sidebar_order_set", { order });
  expect(agent).toMatchObject({ error: { kind: "tool", error: { code: "forbidden", message: "Only a person keeps a sidebar order, from one of their own devices." } } });

  const adaSees = ok(await tools.call(hub, ada, "events_wait", { cursor: 0, timeoutSec: 0 }));
  expect((adaSees.events as { type: string }[]).map((e) => e.type)).toEqual(["sidebar.order", "chat.pins"]);
  const boSees = ok(await tools.call(hub, bo, "events_wait", { cursor: 0, timeoutSec: 0 }));
  expect(boSees.events).toEqual([]);
  expect(boSees.cursor).toBe(2);
});

test("events_wait returns at once when events are there, waits for the next otherwise, and filters by machine grant", async () => {
  const { hub, tools, key } = setup();
  const reader = key(undefined, [{ role: "read", machines: ["devbox"] }]);
  const append = (machineId: string, summary: string) =>
    events(hub).append({ at: new Date().toISOString(), type: "machine.online", machineId, summary } as NewEvent);
  append("other", "hidden");
  const waiting = tools.call(hub, reader, "events_wait", { cursor: 0, timeoutSec: 2 });
  await Bun.sleep(20);
  append("devbox", "seen");
  const page = ok(await waiting);
  expect((page.events as { summary: string }[]).map((e) => e.summary)).toEqual(["seen"]);
  expect(page).toMatchObject({ cursor: 2, more: false, next: "Call events_wait with cursor 2 to keep waiting." });
  const refused = await tools.call(hub, reader, "events_wait", { machineId: "other", timeoutSec: 0 });
  expect(refused).toMatchObject({ error: { kind: "tool", error: { code: "forbidden", message: "This key has no read grant on machine other." } } });

  const list = ok(
    await tools.call(hub, reader, "events_list", { projectRef: { machineId: "devbox", projectId: "p1" }, limit: 10 }),
  );
  expect(list).toEqual({ events: [], more: false });
});
