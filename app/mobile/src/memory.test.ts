// The phone's Memory screen's reading of the person's memory (memory.ts): the core without its topic lines, saved back
// with them, and whether the last tidy's line still has anything to undo.
import { expect, it } from "vitest";
import { coreEntries, memoryClient, openChanges, withTopicLines } from "./memory";

it("shows the core without its topic lines, and saves it back with them", () => {
  const core = "- Keep answers short.\n- [phone](phone.md)\n- [site](site.md)\n";
  expect(coreEntries(core)).toBe("- Keep answers short.\n");
  expect(withTopicLines("- Keep answers short.\n- Plain words.\n\n", core)).toBe("- Keep answers short.\n- Plain words.\n- [phone](phone.md)\n- [site](site.md)\n");
  expect(withTopicLines("", "- Short.\n")).toBe("");
});

it("offers Undo while any of the tidy's changes holds", () => {
  const tidied = (items: { undone?: boolean }[], more?: { total: number; undone?: number }) => ({ messageId: "m1", projectRef: { machineId: "m", projectId: "p" }, memoryRefreshed: { items, ...more } });
  expect(openChanges(undefined)).toBe(0);
  expect(openChanges(tidied([{}, { undone: true }]))).toBe(1);
  expect(openChanges(tidied([{ undone: true }]))).toBe(0);
  expect(openChanges(tidied([{ undone: true }], { total: 3, undone: 1 }))).toBe(2);
});

it("reads, saves a topic and undoes a tidy through the person's own key", async () => {
  const calls: [string, unknown][] = [];
  const hub = {
    call: (tool: string, input: unknown) => {
      calls.push([tool, input]);
      const output = tool === "memory_get" ? { user: { text: "- a\n", chars: 4, cap: 16000 }, userFiles: [{ topic: "ci", text: "- b\n", chars: 4, cap: 32000 }] } : {};
      return Promise.resolve({ ok: true as const, output });
    },
  };
  const client = memoryClient(hub);
  const read = await client.read();
  expect(read.ok && read.value.topics.map((f) => f.topic)).toEqual(["ci"]);
  await client.save("ci", "- c\n");
  await client.undoTidy({ messageId: "m9", projectRef: { machineId: "m", projectId: "p" } });
  expect(calls.slice(1)).toEqual([
    ["memory_set", { scope: "user", text: "- c\n", topic: "ci" }],
    ["memory_undo", { projectRef: { machineId: "m", projectId: "p" }, messageId: "m9" }],
  ]);
});

it("says why the last tidy didn't run, and nothing when it did", async () => {
  const { tidyFailed } = await import("./memory");
  expect(tidyFailed({ state: "failed", why: "No bot's machine can run it now." })).toBe("No bot's machine can run it now.");
  expect(tidyFailed({ state: "done" })).toBeUndefined();
  expect(tidyFailed(undefined)).toBeUndefined();
});
