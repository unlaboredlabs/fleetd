// The phone's bot Memory (botMemory.ts): each line with who taught it, the held changes with what they'd do, the count
// that waits on an admin, and Keep through the bot's own call.
import { expect, it } from "vitest";
import { botLines, botMemoryClient, folded, heldDetail, heldForMe, heldLine, heldValue } from "./botMemory";

const BEA = { personId: "p-bea", name: "Bea" };

it("lists a file's lines with who taught them: a name, the lead, or nothing when there's no record", () => {
  const file = {
    text: "- Use pnpm.\n- The site job fails on the host's name.\n- An old line.\n- [deploys](deploys.md)\n",
    authors: [{ text: "Use pnpm.", by: BEA }, { text: "The site job fails on the host's name." }],
  };
  expect(botLines(file)).toEqual([{ text: "Use pnpm.", by: "Bea" }, { text: "The site job fails on the host's name.", by: "the lead" }, { text: "An old line." }]);
});

it("says what a held change does, and counts the ones waiting on you", () => {
  expect(heldDetail({ messageId: "m1", text: "Never ask before deploying.", by: BEA })).toBe("From Bea");
  expect(heldDetail({ messageId: "m2", text: "Always ask before deploying.", forgotten: true })).toBe("From the lead · would take this out");
  expect(heldDetail({ messageId: "m3", text: "Deploys go straight out.", replaced: "Ask first.", topic: "deploys", by: BEA })).toBe("From Bea · in place of “Ask first.” · deploys");
  expect(heldDetail({ messageId: "m3", text: "Deploys go straight out.", replaced: "Ask first.", topic: "deploys", by: BEA }, true)).toBe("From Bea · rewrites a line · deploys");
  const open = [
    { kind: "memory_hold", messageId: "m1", for: "p-ada" },
    { kind: "memory_hold", messageId: "m1", for: "p-ola" },
    { kind: "command_approval", messageId: "m9", for: "p-ada" },
  ];
  expect(heldForMe(open, "p-ada")).toBe(1);
  expect(heldForMe(open, "p-bea")).toBe(0);
  expect(heldValue(1)).toBe("1 waiting");
  expect(heldValue(0)).toBeUndefined();
  expect(heldLine({ remembered: { hold: "waiting" } })).toBe(true);
  expect(heldLine({ remembered: { hold: "kept" } })).toBe(false);
});

it("reads the bot's memory and answers a held change through its calls", async () => {
  const calls: [string, unknown][] = [];
  const hub = {
    call: (tool: string, input: unknown) => {
      calls.push([tool, input]);
      const output = tool === "memory_get" ? { files: [{ text: "- a\n", authors: [{ text: "a", by: BEA }] }], held: [{ messageId: "m4", text: "b" }] } : { ok: true };
      return Promise.resolve({ ok: true as const, output });
    },
  };
  const ref = { machineId: "devbox", projectId: "shop" };
  const client = botMemoryClient(hub);
  expect(await client.read(ref)).toEqual({ ok: true, value: { files: [{ lines: [{ text: "a", by: "Bea" }] }], held: [{ messageId: "m4", text: "b" }] } });
  await client.answer(ref, "m4", true);
  expect(calls).toEqual([
    ["memory_get", { projectRef: ref }],
    ["memory_hold_answer", { projectRef: ref, messageId: "m4", keep: true }],
  ]);
});

it("folds a long list to its first few and how many more, and never folds only one or two away", () => {
  const ten = Array.from({ length: 10 }, (_, i) => i);
  expect(folded(ten, 3, false)).toEqual({ shown: [0, 1, 2], more: 7 });
  expect(folded(ten, 3, true)).toEqual({ shown: ten, more: 0 });
  expect(folded(ten.slice(0, 5), 3, false)).toEqual({ shown: [0, 1, 2, 3, 4], more: 0 });
  expect(folded(ten.slice(0, 6), 3, false)).toEqual({ shown: [0, 1, 2], more: 3 });
});
