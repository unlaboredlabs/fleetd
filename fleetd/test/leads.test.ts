// The leads area's reads (`lead_state`), and what a fresh lead session is told of the chat before it.
import { expect, test } from "bun:test";
import { chat } from "../src/hub/chat/index.ts";
import { LEAD_FRESH_AFTER_MS, leadProfile, leads } from "../src/hub/leads/index.ts";
import { start } from "../src/hub/leads/loops.ts";
import { leadWiring } from "../src/hub/leads/ports.ts";
import { store } from "../src/hub/store/hub_store.ts";
import { isoMs } from "../src/hub/store/time.ts";
import type { ThreadSummary } from "../src/shared/contracts.ts";
import { PROJECT, testHub } from "./hub-helpers.ts";

test("a lead's state is read off its thread; a removed bot's lead is stopped", () => {
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

test("a fresh lead session's Recent chat names a message's files by id and name", async () => {
  const { hub, clock, done } = testHub();
  start(hub);
  const prompts: string[] = [];
  Object.assign(leadWiring(hub).ports, {
    launch: async (_machineId: string, input: { prompt: string }) => {
      prompts.push(input.prompt);
      return `lead-${prompts.length}`;
    },
    send: async () => false,
  });
  await leads(hub).start(PROJECT);
  // Two screenshots dragged into the composer, a narrow no-break space before "PM" as macOS names them (a plain one on
  // the recap's one line).
  const shot = (n: number, minute: number) => ({ attachmentId: `F${n}` as never, name: `Screenshot 2026-11-18 at 11.${minute}.04\u202fPM.png`, mime: "image/png" as const, bytes: 3000 });
  chat(hub).add(PROJECT, { author: "human", text: "the icons are off in the places i screenshotted", attachments: [shot(1093, 19), shot(1094, 20)] });
  chat(hub).add(PROJECT, { author: "human", text: "", attachments: [shot(1095, 21)] });
  // The lead's session goes idle and stays so past the prompt cache's life: the next message starts it fresh.
  const at = isoMs(clock.now());
  const { threadId } = leads(hub).records.leadGet(PROJECT)!;
  store(hub).threadUpsert({
    thread: { machineId: PROJECT.machineId, threadId, projectId: PROJECT.projectId, title: "lead", status: "idle", headline: "", latestMessageTail: "", lastProgressAt: at, stale: false, asOf: at } as never,
  });
  clock.ms += LEAD_FRESH_AFTER_MS + 1;
  expect(await leads(hub).freshIfDue(PROJECT, "Human: did you see them?")).toBeDefined();
  const recap = prompts[1]!.split("\n");
  expect(recap.find((l) => l.includes("the places i screenshotted"))).toMatch(
    /^Human \([^)]*\): the icons are off in the places i screenshotted \[attached: F1093 "Screenshot 2026-11-18 at 11\.19\.04 PM\.png", F1094 "Screenshot 2026-11-18 at 11\.20\.04 PM\.png"\]$/u,
  );
  // A message of files alone is a line too.
  expect(recap).toContainEqual(expect.stringMatching(/^Human \([^)]*\): \[attached: F1095 "Screenshot 2026-11-18 at 11\.21\.04 PM\.png"\]$/u));
  hub.shutdown.abort();
  done();
});
