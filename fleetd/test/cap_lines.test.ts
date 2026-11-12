import { expect, test } from "bun:test";
import {
  capRaisedText,
  fleetLine,
  loweredLine,
  machineLine,
  pausedLine,
  pausedReason,
  plural,
  projectLine,
  raisedLine,
} from "../src/shared/cap_lines.ts";
import { exported, findings, line, readRepo } from "./pkg/purity.ts";

const PATH = "fleetd/src/shared/cap_lines.ts";

test("the max agents lines are the package's fleetd/shared/cap_lines, with no hub behind them", () => {
  expect(exported()).toContainEqual({ name: "./shared/cap_lines", path: PATH });
  expect(findings(PATH, readRepo).map(line)).toEqual([]);
});

test("each line a max agents change says, in the hub's words", () => {
  expect(plural(1, "slot", "slots")).toBe("1 slot");
  expect(plural(0, "slot", "slots")).toBe("0 slots");

  expect(pausedLine(4, 2, 2, 2)).toBe("Max agents 4 → 2: 2 agents push their work and wait; 2 keep running.");
  expect(pausedLine(2, 2, 1, 1)).toBe("Max agents 2: 1 agent pushes its work and waits; 1 keeps running.");
  expect(raisedLine(2, 4, 0, 2)).toBe("Max agents 2 → 4.");
  expect(raisedLine(2, 4, 2, 0)).toBe("Max agents 2 → 4: 2 queued agents start now, 0 slots free.");
  expect(loweredLine(4, 1, 1)).toBe("Max agents 4 → 1: 1 running finishes its work; new agents wait.");
  expect(loweredLine(4, 2, 3)).toBe("Max agents 4 → 2: 3 running finish their work; new agents wait.");

  expect(machineLine("devbox", 12, 6, false, true)).toBe("Max agents on devbox set to 6 (auto was 12): running agents finish; new ones wait.");
  expect(machineLine("devbox", 4, 6, true, true)).toBe("Max agents on devbox 4 → 6: queued agents start as slots allow.");
  expect(machineLine("devbox", 6, 6, true, false)).toBe("Max agents on devbox back to auto: 6, was 6.");

  expect(fleetLine(undefined, 4, 8)).toBe("Fleet cap set to 4 (the machines fit 8): running agents finish; new ones wait.");
  expect(fleetLine(4, 10, 8)).toBe("Fleet cap 4 → 10: queued agents start as slots allow.");

  expect(pausedReason(2)).toBe("paused: max agents lowered to 2; resumes when a slot frees");
  expect(capRaisedText(4, 1)).toBe("- cap raised to 4: 1 slot free; queued agents already started");
  expect(capRaisedText(4, 3)).toBe("- cap raised to 4: 3 slots free; queued agents already started");
});

test("a project's line picks raised, paused, lowered, back to the default or a plain change", () => {
  const change = { from: 4, to: 4, started: 0, free: 0, paused: 0, running: 0, back: false };
  expect(projectLine({ ...change, to: 6, started: 1, free: 1 })).toBe("Max agents 4 → 6: 1 queued agent starts now, 1 slot free.");
  // The paused ones still count as running until they end.
  expect(projectLine({ ...change, to: 2, paused: 2, running: 4 })).toBe(
    "Max agents 4 → 2: 2 agents push their work and wait; 2 keep running.",
  );
  expect(projectLine({ ...change, to: 2, running: 3 })).toBe("Max agents 4 → 2: 3 running finish their work; new agents wait.");
  expect(projectLine({ ...change, to: 2, running: 2 })).toBe("Max agents 4 → 2.");
  expect(projectLine({ ...change, back: true })).toBe("Max agents 4, the default now.");
  expect(projectLine({ ...change, to: 6, back: true })).toBe("Max agents 4 → 6. It follows the default now.");
  expect(projectLine({ ...change, to: 2, running: 3, back: true })).toBe(
    "Max agents 4 → 2: 3 running finish their work; new agents wait. It follows the default now.",
  );
});
