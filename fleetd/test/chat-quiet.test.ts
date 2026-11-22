// The lead's `(quiet)` never reaches a person: not as a bubble of its own after words of the same turn, not while it
// streams, and not on a retry after the store failed (W785).
import { expect, test } from "bun:test";
import { type LiveParts, maybeQuiet, streamPass } from "../src/hub/chat/flow.ts";
import { leadMessages, said, unquiet } from "../src/hub/chat/history.ts";
import { chat } from "../src/hub/chat/index.ts";
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
  ]);
  expect(out.map((m) => [m.source, m.text])).toEqual([
    ["lead:lead-1:a", "Still running, T4725 gets woken when it ends."],
    ["lead:lead-1:c", `Quoted:\n\n${FENCE}\n(quiet)\n${FENCE}`],
  ]);
});

test("streamed text holds back a last line that can still be (quiet)", () => {
  expect(maybeQuiet("Still running.\n\n(qui")).toBe("(qui");
  expect(maybeQuiet("Still running.\n\n(quiet) \n")).toBe("(quiet) \n");
  expect(maybeQuiet("Still running (see")).toBe("");
  expect(maybeQuiet("Still running.\n\n")).toBe("");
});

function lead() {
  const t = testHub();
  leads(t.hub).records.leadPut({ projectRef: PROJECT, threadId: "lead-1", startedAt: "2026-11-08T10:00:00Z", sessionGeneration: 1 });
  return t;
}

const shown = (m: ChatMessage | undefined) => JSON.stringify(m ?? {});

test("a reply of words then a final (quiet) bubble streams and lands as the words alone", async () => {
  const { hub, done } = lead();
  await chat(hub).readHistory(PROJECT, () => []);
  const appended: string[] = [];
  chat(hub).subscribe((d) => appended.push(d.append));
  const sent = new Map<string, number>();
  const words = "Still running, T4725 gets woken when it ends.";
  const source = "lead:lead-1:a";
  let parts: LiveParts = { text: { messageId: "a", tail: `${words}\n\n(qui`, total: words.length + 6 }, done: [], runActive: true };
  streamPass(hub, sent, () => parts);
  expect(chat(hub).bySource(PROJECT, source)).toMatchObject({ state: "streaming", text: `${words}\n\n` });
  const full = `${words}\n\n(quiet)\n`;
  parts = { text: { messageId: "a", tail: full, total: full.length }, done: [], runActive: true };
  streamPass(hub, sent, () => parts);
  expect(chat(hub).bySource(PROJECT, source)?.text).toBe(`${words}\n\n`);
  parts = { done: [{ messageId: "a", text: full }], runActive: false };
  streamPass(hub, sent, () => parts);
  const m = chat(hub).bySource(PROJECT, source);
  expect(m).toMatchObject({ state: "final", text: words });
  expect(m?.parts).toBeUndefined();
  expect(shown(m)).not.toContain("(quiet)");
  expect(appended.join("")).not.toContain("(quiet)");
  done();
});

test("text between tool calls, then (quiet) as the turn's last text, posts the text alone", async () => {
  const { hub, done } = lead();
  await chat(hub).readHistory(PROJECT, () => []);
  const sent = new Map<string, number>();
  // Its own reply after the tool calls, and the node's join of two texts of one message ("\n\n" between them).
  const parts: LiveParts = {
    done: [
      { messageId: "a", text: "Checking T4725." },
      { messageId: "b", text: "(quiet)" },
      { messageId: "c", text: "Now the writers.\n\n(quiet)" },
    ],
    runActive: false,
  };
  streamPass(hub, sent, () => parts);
  expect(chat(hub).bySource(PROJECT, "lead:lead-1:a")?.text).toBe("Checking T4725.");
  expect(chat(hub).bySource(PROJECT, "lead:lead-1:b")).toBeUndefined();
  expect(chat(hub).bySource(PROJECT, "lead:lead-1:c")).toMatchObject({ state: "final", text: "Now the writers." });
  done();
});

test("a turn of only (quiet), any whitespace around it, posts nothing", async () => {
  const { hub, done } = lead();
  await chat(hub).readHistory(PROJECT, () => []);
  const sent = new Map<string, number>();
  const text = "\n(quiet)  \n";
  let parts: LiveParts = { text: { messageId: "a", tail: text, total: text.length }, done: [], runActive: true };
  streamPass(hub, sent, () => parts);
  parts = { done: [{ messageId: "a", text }], runActive: false };
  streamPass(hub, sent, () => parts);
  expect(chat(hub).bySource(PROJECT, "lead:lead-1:a")).toBeUndefined();
  done();
});

test("(quiet) in a sentence or a code fence lands as written", async () => {
  const { hub, done } = lead();
  await chat(hub).readHistory(PROJECT, () => []);
  const sent = new Map<string, number>();
  const sentence = "A wake with no news gets (quiet), which posts nothing.";
  const fenced = `Alone on its line:\n\n${FENCE}\n(quiet)\n${FENCE}`;
  const parts: LiveParts = { done: [{ messageId: "a", text: sentence }, { messageId: "b", text: fenced }], runActive: false };
  streamPass(hub, sent, () => parts);
  expect(chat(hub).bySource(PROJECT, "lead:lead-1:a")?.text).toBe(sentence);
  expect(chat(hub).bySource(PROJECT, "lead:lead-1:b")?.text).toBe(fenced);
  done();
});

test("a store that fails while the reply streams or lands brings no (quiet) back on the retry", async () => {
  const { hub, done } = lead();
  await chat(hub).readHistory(PROJECT, () => []);
  const c = chat(hub);
  const sent = new Map<string, number>();
  const words = "Still running.";
  const full = `${words}\n\n(quiet)`;
  // The append fails once: the next pass streams the same words again, still without the held line.
  const append = c.append.bind(c);
  let failAppend = true;
  c.append = (m, text) => {
    if (failAppend) {
      failAppend = false;
      throw new Error("disk full");
    }
    return append(m, text);
  };
  const streaming: LiveParts = { text: { messageId: "a", tail: full, total: full.length }, done: [], runActive: true };
  streamPass(hub, sent, () => streaming);
  streamPass(hub, sent, () => streaming);
  expect(c.bySource(PROJECT, "lead:lead-1:a")).toMatchObject({ state: "streaming", text: `${words}\n\n` });
  // Landing fails once: the next pass lands it, as the words alone.
  const finish = c.finish.bind(c);
  let failFinish = true;
  c.finish = (m, text) => {
    if (failFinish) {
      failFinish = false;
      throw new Error("disk full");
    }
    return finish(m, text);
  };
  const landed: LiveParts = { done: [{ messageId: "a", text: full }], runActive: false };
  streamPass(hub, sent, () => landed);
  expect(c.bySource(PROJECT, "lead:lead-1:a")?.state).toBe("streaming");
  streamPass(hub, sent, () => landed);
  expect(c.bySource(PROJECT, "lead:lead-1:a")).toMatchObject({ state: "final", text: words });
  // A reply that never streamed, whose add fails once, lands the words alone too.
  const add = c.add.bind(c);
  let failAdd = true;
  c.add = (r, n) => {
    if (failAdd) {
      failAdd = false;
      throw new Error("disk full");
    }
    return add(r, n);
  };
  const other: LiveParts = { done: [{ messageId: "b", text: "Two landed.\n(quiet)" }], runActive: false };
  streamPass(hub, sent, () => other);
  expect(c.bySource(PROJECT, "lead:lead-1:b")).toBeUndefined();
  streamPass(hub, sent, () => other);
  expect(c.bySource(PROJECT, "lead:lead-1:b")?.text).toBe("Two landed.");
  done();
});
