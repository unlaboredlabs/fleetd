// `fleetd status` in a person's words: an agent's line names its work, not its id (T12), unless --ids; two bots with
// one title are told apart by their machines.
import { expect, test } from "bun:test";
import { parseStatusArgs, render } from "../../src/cli/status.ts";

const asOf = "2026-11-26T14:00:00Z";
const row = (machineId: string, title: string) => ({
  asOf,
  projectRef: { machineId, projectId: `${machineId}-575f1d77-87f2` },
  title,
  state: "working",
  agentsRunning: 1,
  counts: { working: 1 },
  items: [{ group: "working", title: "Fix the login page", taskId: "T1", pr: { number: 7 } }],
});

test("an agent's line has no id unless --ids, and a shared title says its machine", () => {
  const two = [row("devbox", "fleetd-e2e"), row("worker", "fleetd-e2e"), row("devbox", "site")];
  const said = render(two, "UTC");
  expect(said).toContain("fleetd-e2e on devbox: working");
  expect(said).toContain("fleetd-e2e on worker: working");
  expect(said).toContain("\nsite: working");
  expect(said).toContain("  working: Fix the login page (#7)");
  expect(said).not.toMatch(/T1|575f1d77/);
  const withIds = render(two, "UTC", true);
  expect(withIds).toContain("  working: Fix the login page (T1, #7)");
  expect(withIds).toContain("fleetd-e2e on worker (worker/worker-575f1d77-87f2): working");
  expect(parseStatusArgs(["--ids"]).ids).toBe(true);
  expect(parseStatusArgs([]).ids).toBe(false);
});
