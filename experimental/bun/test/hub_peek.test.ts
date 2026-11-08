import { expect, test } from "bun:test";
import { Hub } from "../src/hub/api/hub.ts";
import { HubDb } from "../src/hub/store/db.ts";
import { fresh } from "../src/hub/train/seams.ts";

const hub = () => new Hub({ home: "/nonexistent", listen: { host: "127.0.0.1", port: 0 } }, HubDb.memory(), { now: () => 0 });

test("peek finds an area its owner made, and never makes one", () => {
  const h = hub();
  expect(h.peek("status_fresh")).toBeUndefined();
  // Peeking made nothing: the owner's make still runs.
  const made = h.area("status_fresh", () => ({ owner: true }));
  expect(made).toEqual({ owner: true });
  expect(h.peek<{ owner: boolean }>("status_fresh")).toBe(made);
});

test("the train's freshness goes nowhere before the status area exists, and to it once it does", () => {
  const h = hub();
  const f = fresh(h);
  f.touch("train:acme/web", 1);
  expect(h.peek("status_fresh")).toBeUndefined();
  const seen: string[] = [];
  h.area("status_fresh", () => ({
    expect: (s: string) => seen.push(`expect ${s}`),
    forget: (s: string) => seen.push(`forget ${s}`),
    touch: (s: string) => seen.push(`touch ${s}`),
    fail: (s: string, why: string) => seen.push(`fail ${s} ${why}`),
  }));
  f.touch("train:acme/web", 2);
  f.fail("github:acme/web", "down");
  expect(seen).toEqual(["touch train:acme/web", "fail github:acme/web down"]);
});
