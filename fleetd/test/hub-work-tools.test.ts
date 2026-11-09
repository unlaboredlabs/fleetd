// The tools of wakes, prompts and the shared memory, through the registry as /mcp and /app call them.
import { expect, test } from "bun:test";
import { registerAll } from "../src/hub/serve/areas.ts";
import { Registry } from "../src/hub/api/registry.ts";
import { store } from "../src/hub/store/hub_store.ts";
import { isoMs } from "../src/hub/store/time.ts";
import type { Machine, ThreadSummary } from "../src/shared/contracts.ts";
import { caller, PROJECT, testHub } from "./hub-helpers.ts";

const tools = new Registry();
registerAll(tools);

test("wake_set needs a known thread; wake_list and wake_cancel see it", async () => {
  const { hub, clock, done } = testHub();
  const target = { machineId: "lab-a", threadId: "t1" };
  const input = {
    target,
    schedule: { kind: "at", at: isoMs(clock.ms + 3_600_000), tz: "UTC" },
    message: "check in",
    clientRequestId: "c1",
  };
  expect(await tools.call(hub, caller("operate"), "wake_set", input)).toMatchObject({ error: { error: { code: "not_found", message: "No machine lab-a." } } });
  store(hub).machineUpsert({ machineId: "lab-a", name: "lab-a", status: "online" } as unknown as Machine);
  expect(await tools.call(hub, caller("operate"), "wake_set", input)).toMatchObject({ error: { error: { message: "No thread t1 on lab-a." } } });
  store(hub).threadUpsert({ thread: { machineId: "lab-a", threadId: "t1", projectId: PROJECT.projectId, lastProgressAt: isoMs(clock.ms) } as unknown as ThreadSummary });
  const set = (await tools.call(hub, caller("operate"), "wake_set", input)) as { output: { wakeId: string; nextRunAt: string } };
  expect(set.output.nextRunAt).toBe(isoMs(clock.ms + 3_600_000));
  expect(await tools.call(hub, caller("operate"), "wake_set", { ...input, clientRequestId: "c2", schedule: { kind: "cron", cron: "* * *", tz: "UTC" } })).toMatchObject({
    error: { error: { code: "invalid", message: "Invalid schedule: cron needs 5 fields (minute hour day month weekday), got 3" } },
  });
  const listed = (await tools.call(hub, caller("read"), "wake_list", {})) as { output: { wakes: { wakeId: string; state: string }[] } };
  expect(listed.output.wakes.map((w) => [w.wakeId, w.state])).toEqual([[set.output.wakeId, "active"]]);
  expect(await tools.call(hub, caller("operate"), "wake_cancel", { wakeId: set.output.wakeId })).toEqual({ output: { ok: true } });
  expect(await tools.call(hub, caller("operate"), "wake_cancel", { wakeId: "wk_nope" })).toMatchObject({ error: { error: { code: "not_found" } } });
  done();
});

test("prompt_get lists and shows; prompt_set saves, warns, resets; only admins edit hub-wide", async () => {
  const { hub, done } = testHub();
  const listed = (await tools.call(hub, caller("read"), "prompt_get", {})) as { output: { prompts: { id: string; scope: string }[] } };
  expect(listed.output.prompts.length).toBe(28);
  expect(await tools.call(hub, caller("read"), "prompt_get", { id: "lead.digest" })).toMatchObject({
    error: { error: { code: "not_found", message: expect.stringContaining("fleetd retired lead.digest") } },
  });
  expect(await tools.call(hub, caller("operate"), "prompt_set", { id: "lead.voice", scope: "global", text: "Be brief." })).toMatchObject({
    error: { error: { code: "forbidden" } },
  });
  const saved = (await tools.call(hub, caller("admin"), "prompt_set", { id: "lead.start", scope: "global", text: "Lead {{project}} {{nope}}" })) as {
    output: { ref: string; warnings: { code: string }[] };
  };
  expect(saved.output.warnings.map((w) => w.code)).toContain("placeholder_unknown");
  expect(saved.output.warnings.map((w) => w.code)).toContain("placeholder_missing");
  const shown = (await tools.call(hub, caller("read"), "prompt_get", { id: "lead.start" })) as { output: { prompt: { scope: string; effective: { ref: string } } } };
  expect(shown.output.prompt).toMatchObject({ scope: "global", effective: { ref: saved.output.ref } });
  const project = (await tools.call(hub, caller("operate", true), "prompt_set", { id: "lead.start", scope: "project", projectRef: PROJECT, text: "Mine." })) as {
    output: { ref: string };
  };
  expect(project.output.ref).toStartWith("lead.start@");
  expect(await tools.call(hub, caller("admin"), "prompt_set", { id: "lead.start", scope: "global", reset: true })).toMatchObject({
    output: { next: "Reset: the next level's text is in effect." },
  });
  expect(await tools.call(hub, caller("read"), "session_prompt_get", { machineId: "lab-a", threadId: "t9" })).toMatchObject({
    error: { error: { code: "not_found" } },
  });
  done();
});

test("the shared memory is a hub admin's", async () => {
  const { hub, done } = testHub();
  expect(await tools.call(hub, caller("admin", true), "memory_shared_set", { text: "- Old hub.\n" })).toMatchObject({ output: { file: { text: "- Old hub.\n" } } });
  expect(await tools.call(hub, caller("read"), "memory_shared_get", {})).toMatchObject({ error: { error: { code: "forbidden" } } });
  expect(await tools.call(hub, caller("admin"), "memory_shared_get", {})).toMatchObject({ output: { file: { text: "- Old hub.\n" } } });
  done();
});
