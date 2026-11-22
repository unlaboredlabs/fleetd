// The lead's `(quiet)` never reaches a person: not as a bubble of its own after words of the same turn, and not on a
// retry after the store failed (W785).
import { expect, test } from "bun:test";
import { mirror } from "../src/hub/chat/flow.ts";
import { leadMessages, said, type ThreadMessage, unquiet } from "../src/hub/chat/history.ts";
import { chat } from "../src/hub/chat/index.ts";
import { executors } from "../src/hub/executor/index.ts";
import { leads } from "../src/hub/leads/index.ts";
import type { ChatMessage } from "../src/shared/contracts.ts";
import { PROJECT, testHub } from "./hub-helpers.ts";

const FENCE = "```";

test("a (quiet) line or bubble goes with its blank line; in a sentence or a code fence it stays", () => {
  expect(unquiet("Still running, T4725 gets woken when it ends.\n\n(quiet)")).toBe("Still running, T4725 gets woken when it ends.");
  expect(unquiet("Still running.\n(quiet)")).toBe("Still running.");
  expect(unquiet("Still running.\n\n  (quiet)  \n\n")).toBe("Still running.");
  expect(unquiet("\n\t(quiet)\r\n\nStill running.")).toBe("Still running.");
  expect(unquiet("One.\n\n(quiet)\n\nTwo.")).toBe("One.\n\nTwo.");
  for (const only of ["(quiet)", " (quiet) ", "\n\n(quiet)\n", "(quiet)\n\n(quiet)"]) {
    expect(unquiet(only)).toBe("");
    expect(said(only)).toBe(false);
  }
  const sentence = "A turn with nothing to say replies (quiet), which posts nothing.";
  expect(unquiet(sentence)).toBe(sentence);
  const quoted = `The token alone on its line:\n\n${FENCE}\n(quiet)\n${FENCE}`;
  expect(unquiet(quoted)).toBe(quoted);
  const tagged = `${FENCE}text\n(quiet)\n${FENCE}\n\n(quiet)`;
  expect(unquiet(tagged)).toBe(`${FENCE}text\n(quiet)\n${FENCE}`);
  expect(said("Done.")).toBe(true);
});

test("the history read and the mirror take a reply's (quiet) line out, and skip a reply of only (quiet)", () => {
  const at = "2026-11-08T10:00:00Z";
  const out = leadMessages("lead-1", [
    { id: "a", role: "assistant", text: "Still running, T4725 gets woken when it ends.\n\n(quiet)", createdAt: at },
    { id: "b", role: "assistant", text: "  (quiet)\n", createdAt: at },
    { id: "c", role: "assistant", text: `Quoted:\n\n${FENCE}\n(quiet)\n${FENCE}`, createdAt: at },
  ], new Set());
  expect(out.map((m) => [m.source, m.text])).toEqual([
    ["lead:lead-1:a", "Still running, T4725 gets woken when it ends."],
    ["lead:lead-1:c", `Quoted:\n\n${FENCE}\n(quiet)\n${FENCE}`],
  ]);
});

/** A hub with a lead whose session holds `messages` (each a turn of its own), its chat read; `land` mirrors them. */
async function lead(messages: ThreadMessage[]) {
  const t = testHub();
  leads(t.hub).records.leadPut({ projectRef: PROJECT, threadId: "lead-1", startedAt: "2026-11-08T10:00:00Z", sessionGeneration: 1 });
  await chat(t.hub).readHistory(PROJECT, () => []);
  Object.assign(executors(t.hub).views, {
    messages: async () => messages,
    runs: async () => messages.flatMap((m) => (m.runId ? [{ id: m.runId, status: "completed" }] : [])),
  });
  const land = () => mirror(t.hub, PROJECT, { machineId: PROJECT.machineId, threadId: "lead-1" });
  return { ...t, land };
}

const at = "2026-11-08T10:00:00Z";
const turn = (id: string, text: string): ThreadMessage => ({ id, runId: `run-${id}`, role: "assistant", text, createdAt: at });
const shown = (m: ChatMessage | undefined) => JSON.stringify(m ?? {});

test("a reply of words then a final (quiet) lands as the words alone", async () => {
  const words = "Still running, T4725 gets woken when it ends.";
  const { hub, land, done } = await lead([turn("a", `${words}\n\n(quiet)\n`)]);
  const appended: string[] = [];
  chat(hub).subscribe((d) => appended.push(d.append));
  await land();
  const m = chat(hub).bySource(PROJECT, "lead:lead-1:a");
  expect(m).toMatchObject({ state: "final", text: words });
  expect(m?.parts).toBeUndefined();
  expect(shown(m)).not.toContain("(quiet)");
  expect(appended.join("")).not.toContain("(quiet)");
  done();
});

test("a turn of only (quiet), any whitespace around it, posts nothing", async () => {
  const { hub, land, done } = await lead([turn("a", "\n(quiet)  \n")]);
  await land();
  expect(chat(hub).bySource(PROJECT, "lead:lead-1:a")).toBeUndefined();
  done();
});

test("(quiet) in a sentence or a code fence lands as written", async () => {
  const sentence = "A wake with no news gets (quiet), which posts nothing.";
  const fenced = `Alone on its line:\n\n${FENCE}\n(quiet)\n${FENCE}`;
  const { hub, land, done } = await lead([turn("a", sentence), turn("b", fenced)]);
  await land();
  expect(chat(hub).bySource(PROJECT, "lead:lead-1:a")?.text).toBe(sentence);
  expect(chat(hub).bySource(PROJECT, "lead:lead-1:b")?.text).toBe(fenced);
  done();
});

test("a store that fails while the reply lands brings no (quiet) back on the retry", async () => {
  const { hub, land, done } = await lead([turn("b", "Two landed.\n(quiet)")]);
  const c = chat(hub);
  const add = c.add.bind(c);
  let failAdd = true;
  c.add = (r, n) => {
    if (failAdd) {
      failAdd = false;
      throw new Error("disk full");
    }
    return add(r, n);
  };
  await land();
  expect(c.bySource(PROJECT, "lead:lead-1:b")).toBeUndefined();
  await land();
  expect(c.bySource(PROJECT, "lead:lead-1:b")?.text).toBe("Two landed.");
  done();
});
