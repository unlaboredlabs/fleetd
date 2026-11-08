// The node core's seams (D350): its areas by name, each handler of `items` given every step that ended.
import { expect, test } from "bun:test";
import { Node } from "../../src/node/api.ts";
import { LeadRelay } from "../../src/node/lead/index.ts";
import type { ThreadItem } from "../../src/node/sessions/types.ts";

test("node.area(\"items\") hands each ended step to every handler, and one that throws doesn't stop the rest", () => {
  const node = new Node("/nowhere", { hub: "http://devbox:4790", machineId: "devbox", name: "devbox", enrolled: true }, new LeadRelay());
  const got: string[] = [];
  node.area("items").on(() => {
    throw new Error("a broken area");
  });
  node.area("items").on((session, item) => got.push(`${session}/${item.id}/${item.status}`));
  const at = "2026-11-08T12:00:00.000Z";
  const item: ThreadItem = { id: "tu1", status: "completed", title: "Bash", startedAt: at, updatedAt: at, kind: { type: "command", command: "ls" } };
  node.area("items").ended("s1", item);
  expect(got).toEqual(["s1/tu1/completed"]);
  expect(node.area("browser", () => ({ made: 1 }))).toEqual({ made: 1 });
  expect(() => node.area("nope" as never)).toThrow("no node area nope");
});

test("node.area(\"caps\") lists every contributed capability once, a part that throws left out", () => {
  const node = new Node("/nowhere", { hub: "http://devbox:4790", machineId: "devbox", name: "devbox", enrolled: true }, new LeadRelay());
  node.area("caps").contribute(() => ["browser", "session_host"]);
  node.area("caps").contribute(() => {
    throw new Error("a broken area");
  });
  node.area("caps").contribute(() => ["browser", "session_android"]);
  expect(node.area("caps").list()).toEqual(["browser", "session_host", "session_android"]);
});
