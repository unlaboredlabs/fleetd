// The factory bridge (crates/fleetd/src/hub/navi/bridge_tests.rs): asks and their retries, the follow that wakes the
// asking lead, a link's feed, the asks sent through a kept link, and navi_asks.
import { expect, test } from "bun:test";
import { leadWakes, type Trigger } from "../src/hub/api/leads.ts";
import { leadCalls } from "../src/hub/lead_calls/index.ts";
import { answer, bridgeOf, found, step } from "../src/hub/navi/bridge.ts";
import { start } from "../src/hub/navi/loops.ts";
import { apply } from "../src/hub/checklist/index.ts";
import { events } from "../src/hub/store/events.ts";
import type { ProjectRef } from "../src/shared/contracts.ts";
import { key, kit, project, workstream } from "./work-kit.ts";

const ref = (projectId: string): ProjectRef => ({ machineId: "devbox", projectId });

function setup() {
  const k = kit();
  for (const [id, title] of [
    ["navi", "Home"],
    ["storefront", "Storefront"],
    ["checkout", "Checkout"],
  ]) {
    project(k.hub, ref(id!), { title: title! });
  }
  k.hub.db.conn.run(`INSERT INTO project_settings (machine_id, project_id, only_me, created_ms, created_by_key, created_by_name)
                     VALUES ('devbox', 'navi', 1, 1792000000000, 'k1', 'desk')`);
  const posts: [string, string, string][] = [];
  found.sendAsAgent = async (_hub, to, by, body) => {
    posts.push([to.projectId, by, body]);
    return {};
  };
  const woken: [string, Trigger][] = [];
  leadWakes(k.hub).trigger = (r, t) => woken.push([r.projectId, t]);
  return { ...k, posts, woken };
}

const message = (text: string) => ({ op: "project_message", project: "storefront", text });

test("a lead writes to another project's lead as its project, and a retry is the first ask", async () => {
  const { hub, posts, clock } = setup();
  const navi = ref("navi");
  const first = (await answer(hub, navi, message("Gift cards, please."))) as Record<string, unknown>;
  expect(first).toMatchObject({ handle: "N1", projectRef: ref("storefront"), title: "Storefront" });
  expect(posts[0]?.slice(0, 2)).toEqual(["storefront", "Home"]);
  expect(posts[0]?.[2]).toStartWith(`Gift cards, please.\n\n(Ask N1. If you open an order for it, pass asked: "N1" to brief`);
  expect(((await answer(hub, navi, message("Gift cards, please."))) as { handle: string }).handle).toBe("N1");
  expect(((await answer(hub, navi, message("And dark mode."))) as { handle: string }).handle).toBe("N2");
  clock.ms += 11 * 60 * 1000;
  expect(((await answer(hub, navi, message("Gift cards, please."))) as { handle: string }).handle).toBe("N3");
  // Its own project, an unknown one, and an archived asker are refused.
  await expect(answer(hub, navi, { op: "project_message", project: "Home", text: "x" })).rejects.toThrow("That is this lead's own project.");
  await expect(answer(hub, navi, { op: "project_message", project: "nope", text: "x" })).rejects.toThrow("No project nope on this hub.");
  hub.db.conn.run("UPDATE project_settings SET archived_ms = 1 WHERE project_id = 'navi'");
  await expect(answer(hub, navi, message("x"))).rejects.toThrow("This project is archived");
});

test("the asker hears when its order opens, its PRs merge or fail, and it closes", async () => {
  const { hub, woken } = setup();
  const navi = ref("navi");
  const shop = ref("storefront");
  const start = events(hub).head();
  await answer(hub, navi, message("Gift cards, please."));
  const append = (type: string, r: ProjectRef, data: Record<string, unknown>) =>
    events(hub).append({ at: "2026-10-25T10:00:00.000Z", type, machineId: r.machineId, projectId: r.projectId, summary: type, data });
  // An order the shop's lead opens on its own wakes no one; nor one in another project that names the ask.
  const dark = workstream(hub, shop, "Dark mode");
  append("workstream.created", shop, { workstreamId: dark.workstreamId });
  const other = workstream(hub, ref("checkout"), "Gift cards");
  append("workstream.created", ref("checkout"), { workstreamId: other.workstreamId, asked: "N1" });
  let s = step(hub, start);
  expect(s.woken).toEqual([]);
  const w = workstream(hub, shop, "Gift cards");
  append("workstream.created", shop, { workstreamId: w.workstreamId, asked: "N1" });
  s = step(hub, s.cursor);
  expect(s.woken).toEqual([[navi, `- N1 to Storefront: its lead opened order ${w.workstreamId} "Gift cards"`]]);
  expect(woken.at(-1)?.[1]).toEqual({ kind: "line", line: "factory", text: s.woken[0]?.[1] ?? "" });
  const change = (to: string, pr: number) =>
    append("change.state", shop, { changeId: "X4", workstreamId: w.workstreamId, repo: "acme/storefront", prNumber: pr, from: "ci", to });
  change("reviewing", 41);
  change("ci_failed", 41);
  change("merged", 42);
  s = step(hub, s.cursor);
  expect(s.woken.map(([, l]) => l)).toEqual([
    `- N1 to Storefront: PR #41 (acme/storefront) of order ${w.workstreamId} "Gift cards" failed CI`,
    `- N1 to Storefront: PR #42 (acme/storefront) of order ${w.workstreamId} "Gift cards" merged`,
  ]);
  append("workstream.done", shop, { workstreamId: w.workstreamId, reason: "Gift cards pay at checkout" });
  s = step(hub, s.cursor);
  expect(s.woken.map(([, l]) => l)).toEqual([`- N1 to Storefront: order ${w.workstreamId} "Gift cards" is done: Gift cards pay at checkout`]);
});

test("a link's asks go out on its feed, not as wakes; asks sent through a kept link are recorded once", async () => {
  const { hub, woken } = setup();
  const bridge = bridgeOf(hub);
  const link = { linkId: "L1", label: "Work", grants: [{ role: "operate" as const, machines: "*" as const }], who: "Ada" };
  const sent = await bridge.projectMessage({ kind: "link", link }, { project: "Storefront", text: "Invoices." });
  expect(sent.handle).toBe("N1");
  const w = workstream(hub, ref("storefront"), "Invoices");
  events(hub).append({ at: "x", type: "workstream.created", machineId: "devbox", projectId: "storefront", summary: "s", data: { workstreamId: w.workstreamId, asked: "N1" } });
  expect(step(hub, 0).woken).toEqual([]);
  expect(woken).toEqual([]);
  expect(bridge.feed("L1", 0)).toEqual({ cursor: 1, more: false, items: [{ handle: "N1", title: "Storefront", what: `its lead opened order ${w.workstreamId} "Invoices"` }] });
  expect(bridge.feed("L2", 0).items).toEqual([]);
  // A read-only link opens no orders; a link limited to other projects doesn't reach this one.
  await expect(bridge.projectMessage({ kind: "link", link: { ...link, grants: [{ role: "read", machines: "*" }] } }, { project: "Storefront", text: "x" })).rejects.toThrow(
    "they only read it",
  );
  await expect(bridge.projectMessage({ kind: "link", link: { ...link, projects: [ref("checkout")] } }, { project: "Storefront", text: "x" })).rejects.toThrow(
    "is not one of this link's projects",
  );
  const handle = bridge.recordSent(ref("navi"), "K1", { handle: "N7", projectRef: ref("far"), title: "Far" }, "Hello there", 5);
  expect(bridge.recordSent(ref("navi"), "K1", { handle: "N7", projectRef: ref("far"), title: "Far" }, "Hello there", 6)).toBe(handle);
  expect(bridge.askSent("K1", "N7")).toEqual({ handle, from: ref("navi") });
  expect(bridge.askSent("K1", "N8")).toBeUndefined();
});

test("start fills navi_bridge whoever asked first, and registers the two lead calls", async () => {
  const { hub, ok } = setup();
  const early = hub.area<Record<string, unknown>>("navi_bridge", () => ({}));
  const stop = hub.shutdown;
  start(hub);
  expect(typeof early.factoryStatus).toBe("function");
  expect(leadCalls(hub).handler("project_message")).toBeDefined();
  expect(leadCalls(hub).handler("factory_status")).toBeDefined();
  // navi_asks reads the asks a project made, with their orders.
  await answer(hub, ref("navi"), message("Gift cards, please."));
  const listed = await ok(key("read"), "project_asks", { project: ref("navi") });
  expect(listed.asks).toEqual([{ toTitle: "Storefront", handle: "N1", to: ref("storefront"), text: "Gift cards, please.", at: "2026-10-17T10:00:00.000Z", orders: [] }]);
  expect((await ok(key("read"), "navi_asks", { navi: ref("checkout") })).next).toBe("This project has asked no other project for anything yet.");
  stop.abort();
});

test("factory_status reads the other projects with their open orders, checklist and asks", async () => {
  const { hub } = setup();
  found.statusRows = (_hub, _now) =>
    ["navi", "storefront", "checkout"].map((id) => ({ projectRef: ref(id), title: id, state: "idle", agentsRunning: 0 }));
  await answer(hub, ref("navi"), message("Gift cards, please."));
  const w = workstream(hub, ref("storefront"), "Gift cards");
  hub.db.conn.query("INSERT INTO navi_ask_orders (workstream_id, n) VALUES (?, 1)").run(w.workstreamId);
  apply(hub.db, ref("storefront"), { items: [{ text: "ship gift cards" }, { text: "old", state: "done" }] }, 0);
  const out = (await answer(hub, ref("navi"), { op: "factory_status" })) as { projects: { projectRef: ProjectRef; openOrders: unknown[]; checklist: { text: string }[]; asks: { handle: string; text: string; at: string; orders: string[] }[] }[]; next: string };
  // Its own project is left out.
  expect(out.projects.map((p) => p.projectRef.projectId)).toEqual(["storefront", "checkout"]);
  const shop = out.projects[0]!;
  expect(shop.openOrders).toEqual([{ workstreamId: w.workstreamId, title: "Gift cards", asked: "N1" }]);
  expect(shop.checklist.map((i) => i.text)).toEqual(["ship gift cards"]);
  expect(shop.asks).toEqual([{ handle: "N1", text: "Gift cards, please.", at: "2026-10-17T10:00:00.000Z", orders: [w.workstreamId] }]);
  expect(out.next).toBe("factory_status with project reads one. Write to a project's lead with project_message.");
  delete found.statusRows;
});

test("navi_asks says an order merged once any PR of it did, however many others merged since", async () => {
  const { hub, ok } = setup();
  await answer(hub, ref("navi"), message("Gift cards, please."));
  const w = workstream(hub, ref("storefront"), "Gift cards");
  hub.db.conn.query("INSERT INTO navi_ask_orders (workstream_id, n) VALUES (?, 1)").run(w.workstreamId);
  const merged = (n: number, workstreamId: string) =>
    hub.db.conn
      .query<never, [number, number, string]>(
        "INSERT INTO changes (repo, pr_number, state, machine_id, project_id, train_order, data) VALUES ('o/r', ?, 'merged', 'devbox', 'storefront', ?, ?)",
      )
      .run(n, n, JSON.stringify({ workstreamId, state: "merged" }));
  merged(1, w.workstreamId);
  for (let i = 2; i < 520; i++) merged(i, "W999");
  const listed = await ok(key("read"), "project_asks", { project: ref("navi") });
  expect(listed.asks[0].orders).toEqual([{ workstreamId: w.workstreamId, title: "Gift cards", state: "open", merged: true }]);
});
