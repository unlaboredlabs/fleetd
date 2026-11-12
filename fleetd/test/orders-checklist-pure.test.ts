import { expect, test } from "bun:test";
import { digestOf, edited } from "../src/hub/checklist/list.ts";
import { encodeWorkstream, titleOf } from "../src/hub/leads/stored.ts";
import { askFooter } from "../src/hub/project_lead/asks.ts";
import { BOARD_MAX_BYTES, trimmed } from "../src/hub/orders/board.ts";
import { prRef } from "../src/hub/orders/cards.ts";

test("the board stays under its bound: lanes first, then PRs, then whole cards", () => {
  const lane = { laneId: "x".repeat(10_000) };
  const card = (n: number) => ({ workstreamId: `W${n}`, lanes: Array(8).fill(lane), prs: [{ n: 1 }, { n: 2 }] }) as never;
  const small = trimmed([card(1)], false);
  expect(small.truncated).toBe(true);
  expect((small.cards[0] as { lanes: unknown[] }).lanes).toHaveLength(4);
  const many = trimmed(Array.from({ length: 20 }, (_, i) => card(i)), false);
  expect(Buffer.byteLength(JSON.stringify(many.cards))).toBeLessThanOrEqual(BOARD_MAX_BYTES);
  expect(trimmed([], false)).toEqual({ cards: [], truncated: false });
});

test("a checklist edit adds and sets items, and the digest lists what's not done", () => {
  const empty = { items: [], nextId: 1 };
  const added = edited(empty, { items: [{ text: "Ship it" }, { text: "Tell them" }] }, "2026-01-01T00:00:00Z");
  expect(added.items.map((i) => [i.id, i.text, i.state])).toEqual([
    [1, "Ship it", "todo"],
    [2, "Tell them", "todo"],
  ]);
  const done = edited(added, { items: [{ id: 1, state: "done" }] }, "2026-01-01T00:01:00Z");
  const now = Date.parse("2026-01-01T00:02:00Z");
  const nothing = { order: () => false, task: () => false, pr: () => false };
  expect(digestOf(done, now, nothing)).toEqual(["1 of 2 done; keep it current with `checklist`", "- 2 todo: Tell them"]);
  expect(digestOf(empty, now, nothing)).toBeUndefined();
});

test("an order's title and row, a PR's ref, and an ask's footer", () => {
  expect(titleOf("  Fix the login\nand more  ")).toBe("Fix the login");
  const w = { workstreamId: "W1", projectRef: { machineId: "m", projectId: "p" }, title: "t", source: "s", state: "open", createdAt: "c", updatedAt: "u" };
  expect(Object.keys(JSON.parse(encodeWorkstream(w as never)))).toEqual(["workstreamId", "projectRef", "title", "source", "state", "createdAt", "updatedAt"]);
  expect(prRef({ repo: "acme/shop", prNumber: 4, prUrl: "https://github.com/acme/shop/pull/4", state: "queued" } as never)).toMatchObject({ number: 4 });
  expect(askFooter("A7")).toContain('asked: "A7"');
});
