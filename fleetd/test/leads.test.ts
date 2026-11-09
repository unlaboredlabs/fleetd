// The leads area's reads (`lead_state`).
import { expect, test } from "bun:test";
import { leadProfile, leads } from "../src/hub/leads/index.ts";
import { store } from "../src/hub/store/hub_store.ts";
import type { ThreadSummary } from "../src/shared/contracts.ts";
import { PROJECT, testHub } from "./hub-helpers.ts";

test("a lead's state is read off its thread; a removed project's lead is stopped", () => {
  const { hub, done } = testHub();
  const area = leads(hub);
  expect(area.get(PROJECT)).toBeUndefined();
  area.records.leadPut({ projectRef: PROJECT, threadId: "t1", startedAt: "2026-11-08T10:00:00.000Z", sessionGeneration: 2 });
  area.records.leadProfilePut(PROJECT, "t1", "high");
  expect(area.get(PROJECT)).toEqual({
    state: "starting",
    projectRef: PROJECT,
    threadId: "t1",
    startedAt: "2026-11-08T10:00:00.000Z",
    sessionGeneration: 2,
  });
  const thread = (status: string) =>
    store(hub).threadUpsert({
      thread: { machineId: "lab-a", threadId: "t1", projectId: PROJECT.projectId, status, lastProgressAt: "2026-11-08T10:00:00.000Z" } as unknown as ThreadSummary,
    });
  for (const [status, state] of [
    ["running", "working"],
    ["waiting", "stalled"],
    ["failed", "stalled"],
    ["completed", "idle"],
  ]) {
    thread(status as string);
    expect(area.get(PROJECT)?.state).toBe(state as never);
  }
  expect(leadProfile(hub, PROJECT)).toBe("high");
  // A new session drops the old one's profile.
  area.records.leadPut({ projectRef: PROJECT, threadId: "t2", startedAt: "2026-11-08T11:00:00.000Z", sessionGeneration: 3 });
  expect(leadProfile(hub, PROJECT)).toBeUndefined();
  expect(area.list().map((l) => l.threadId)).toEqual(["t2"]);
  store(hub).projectRemove(PROJECT);
  expect(area.get(PROJECT)?.state).toBe("stopped");
  done();
});
