// The line of agents waiting for one of the Mac's iOS simulators (crates/fleetd/src/node/mac_tool/queue.rs's tests).
import { expect, test } from "bun:test";
import { ASK_EVERY, GONE, Queue } from "../src/node/mac_tool/queue.ts";

/** The Mac's side of `mac sim start` (sims.ts) over a pool whose clones come ready at `ready` (seconds): each agent
 * asks from its second, every `every` seconds, waiting, and takes a clone when its turn comes and one is warm. The
 * agents in the order they got one. */
function served(askers: [string, number, number][], ready: number[], budget: number): string[] {
  const start = 1_790_000_000_000;
  const queue = new Queue();
  const got: string[] = [];
  let warm = 0;
  for (let t = 0; t < 600; t++) {
    warm += ready.filter((r) => r === t).length;
    for (const [agent, from, every] of askers) {
      if (t < from || (t - from) % every !== 0 || got.includes(agent)) continue;
      if (queue.turn(agent, true, got.length, budget, start + t * 1000).now && warm > 0) {
        warm -= 1;
        queue.leave(agent);
        got.push(agent);
      }
    }
  }
  return got;
}

test("simulators go to agents in the order they asked, however often each asks", () => {
  // A asked first but asks only every 20 s; C, last, every second. Before the line, C took each clone.
  const askers: [string, number, number][] = [["A", 0, 20], ["B", 1, 7], ["C", 2, 1]];
  expect(served(askers, [30, 60, 90], 3)).toEqual(["A", "B", "C"]);
  // One clone warm at once and room for all: still in order.
  expect(served(askers, [5, 5, 5], 3)).toEqual(["A", "B", "C"]);
});

test("with every simulator in use everyone waits in order", () => {
  const queue = new Queue();
  const now = Date.now();
  expect(queue.turn("A", true, 2, 2, now)).toEqual({ now: false, place: 1, full: true });
  expect(queue.turn("B", true, 2, 2, now)).toEqual({ now: false, place: 2, full: true });
  // One ends: A's turn, and B is behind it.
  expect(queue.turn("B", true, 1, 2, now)).toEqual({ now: false, place: 2, full: false });
  expect(queue.turn("A", true, 1, 2, now)).toEqual({ now: true });
});

test("a turn not taken passes to the next agent", () => {
  const queue = new Queue();
  const t0 = Date.now();
  queue.ask("A", t0);
  queue.ask("B", t0);
  // A's clone is ready but A asks no more (its task ended, or its command was cut off and not run again).
  for (let t = t0; t < t0 + GONE; t += ASK_EVERY) expect(queue.turn("B", true, 0, 2, t)).toEqual({ now: false, place: 2, full: false });
  expect(queue.turn("B", true, 0, 2, t0 + GONE)).toEqual({ now: true });
  // Back after that, A waits behind B.
  expect(queue.ask("A", t0 + GONE)).toBe(2);
});

test("an agent run again in time keeps its place", () => {
  const queue = new Queue();
  const t0 = Date.now();
  queue.ask("A", t0);
  queue.ask("B", t0);
  expect(queue.ask("A", t0 + GONE - 1000)).toBe(1);
  // B wasn't: it lost its place, and joins again behind A.
  expect(queue.ask("B", t0 + GONE + 1000)).toBe(2);
});

test("an agent that ends or is cancelled leaves the line", () => {
  const queue = new Queue();
  const now = Date.now();
  for (const agent of ["A", "B", "C"]) queue.ask(agent, now);
  // `mac sim end`, or a lend that failed.
  expect(queue.leave("B")).toBe(true);
  expect(queue.leave("B")).toBe(false);
  expect(queue.ask("C", now)).toBe(2);
  expect(queue.leave("A")).toBe(true);
  expect(queue.turn("C", true, 0, 2, now)).toEqual({ now: true });
  expect(queue.leave("C")).toBe(true);
});

test("an agent that doesn't wait never joins and never jumps the line", () => {
  const queue = new Queue();
  const now = Date.now();
  // Nobody waiting and room: its turn, as before the line.
  expect(queue.turn("A", false, 0, 2, now)).toEqual({ now: true });
  expect(queue.turn("A", false, 2, 2, now)).toEqual({ now: false, place: 1, full: true });
  expect(queue.ask("B", now)).toBe(1); // A didn't join
  expect(queue.turn("A", false, 0, 2, now)).toEqual({ now: false, place: 2, full: false });
  expect(queue.ask("B", now)).toBe(1);
});
