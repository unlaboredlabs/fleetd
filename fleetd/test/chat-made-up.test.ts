// A lead never posts a turn it made up for the person (`Human: …`), and its next turn is told the person never wrote
// it (W787). The shape replayed is the lead's on 2026-11-22: a fresh session's first reply was that turn alone.
import { expect, test } from "bun:test";
import { quiet, type Trigger } from "../src/hub/api/lead_lines.ts";
import { mirror } from "../src/hub/chat/flow.ts";
import { leadMessages, leadText, madeUpLine, said } from "../src/hub/chat/history.ts";
import { chat } from "../src/hub/chat/index.ts";
import { executors } from "../src/hub/executor/index.ts";
import { leads } from "../src/hub/leads/index.ts";
import { PROJECT, testHub } from "./hub-helpers.ts";

const FENCE = "```";
const FAKE = `Human: [W760] I just checked the docs site - there's still a whole page about "Bring your own sandbox (E2B, Daytona)". thought we removed that?`;

test("a reply is cut before a line that opens a made-up turn; a mention of Human: in a sentence, quote or fence stays", () => {
  expect(leadText(FAKE)).toBe("");
  expect(said(FAKE)).toBe(false);
  expect(madeUpLine(`No such page.\n\n${FAKE}`)).toContain(`("${FAKE.slice(0, 80)}…")`);
  expect(madeUpLine("A line can say Human: mid-sentence.")).toBeUndefined();
  expect(leadText(`Checked: there's no such page.\n\n${FAKE}\n\nAssistant: Let me look.`)).toBe("Checked: there's no such page.");
  expect(leadText("Done.\nHuman: thanks\nAssistant: welcome")).toBe("Done.");
  expect(leadText("Done.\n\nAssistant: and more")).toBe("Done.");
  expect(leadText("Done.\n\nHuman (11:49): ok")).toBe("Done.");
  expect(leadText("Done.\n  Human: indented")).toBe("Done.");
  expect(leadText("Done.\n\n(quiet)\n\nHuman: next")).toBe("Done.");
  for (const kept of [
    'The bubble read "Human: [W760] …", which you never wrote.',
    "A line can say Human: mid-sentence.",
    "> Human: quoted as the person wrote it",
    `The marker alone:\n\n${FENCE}\nHuman: hi\nAssistant: hello\n${FENCE}`,
    "Humans: three agents read this.",
    "Hi: there",
    "The screenshot is 1920 by 1080:\nW: 1920\nH: 1080",
    "H: a line of its own\nA: and its answer",
  ]) {
    expect(leadText(kept)).toBe(kept);
  }
  // A fence closed before the marker no longer shields it.
  expect(leadText(`${FENCE}\nHuman: hi\n${FENCE}\nHuman: real`)).toBe(`${FENCE}\nHuman: hi\n${FENCE}`);
});

test("the history read and the mirror skip a reply that is only a made-up turn and cut one that ends with it", () => {
  const at = "2026-11-08T10:00:00Z";
  const out = leadMessages("lead-1", [
    { id: "a", role: "assistant", text: FAKE, createdAt: at },
    { id: "b", role: "assistant", text: `No such page.\n\n${FAKE}`, createdAt: at },
  ]);
  expect(out.map((m) => [m.source, m.text])).toEqual([["lead:lead-1:b", "No such page."]]);
});

/** A hub with a lead, its chat read, and the wakes its lead gets. */
async function lead() {
  const t = testHub();
  leads(t.hub).records.leadPut({ projectRef: PROJECT, threadId: "lead-1", startedAt: "2026-11-08T10:00:00Z", sessionGeneration: 1 });
  await chat(t.hub).readHistory(PROJECT, () => []);
  const woken: Trigger[] = [];
  leads(t.hub).wakes.trigger = (_r, trigger) => void woken.push(trigger);
  const appended: string[] = [];
  chat(t.hub).subscribe((d) => appended.push(d.append));
  return { ...t, woken, appended };
}

/** The lead's session holding `text` as its turn's reply, said now, and the mirror that lands it. */
function holds(t: Awaited<ReturnType<typeof lead>>, text: string) {
  const reply = { id: "a", role: "assistant", text, createdAt: new Date(t.clock.ms).toISOString() };
  Object.assign(executors(t.hub).views, { messages: async () => [reply] });
  return () => mirror(t.hub, PROJECT, { machineId: PROJECT.machineId, threadId: "lead-1" });
}

test("a reply that is only a made-up turn posts nothing, and the lead's next wake says so", async () => {
  const t = await lead();
  const { hub, done, woken, appended } = t;
  const land = holds(t, FAKE);
  await land();
  await land();
  expect(chat(hub).bySource(PROJECT, "lead:lead-1:a")).toBeUndefined();
  expect(appended.join("")).not.toContain("Human:");
  expect(chat(hub).page(PROJECT, undefined, undefined, 50).messages.some((m) => m.text.includes("Human:"))).toBe(false);
  // Once, and a wake of its own: the session still holds the turn, which its next turn would read as the person's.
  expect(woken).toHaveLength(1);
  expect(woken[0]).toMatchObject({ kind: "line", line: "made_up" });
  expect(quiet(woken[0]!)).toBe(false);
  const told = (woken[0] as { text: string }).text;
  expect(told).toContain('"Human: [W760] I just checked the docs site');
  expect(told).toContain("The person never wrote it");
  done();
});

test("words then a made-up turn land as the words alone", async () => {
  const t = await lead();
  const { hub, done, woken } = t;
  const words = "Checked: there's no such page.";
  await holds(t, `${words}\n\n${FAKE}\n\nAssistant: Let me look.`)();
  expect(chat(hub).bySource(PROJECT, "lead:lead-1:a")).toMatchObject({ state: "final", text: words });
  expect(woken.map((t) => (t.kind === "line" ? t.line : t.kind))).toEqual(["made_up"]);
  done();
});

test("a reply whose lines only start like a turn marker lands whole, and wakes nobody", async () => {
  const t = await lead();
  const { hub, done, woken } = t;
  const full = `Here's the plan.\nHumans read it first.\n${FENCE}\nHuman: quoted\n${FENCE}\nAssistants too.`;
  await holds(t, full)();
  expect(chat(hub).bySource(PROJECT, "lead:lead-1:a")).toMatchObject({ state: "final", text: full });
  expect(woken).toEqual([]);
  done();
});

test("a made-up turn the mirror lands once its run ended wakes the lead once, and a hub back later tells it no more", async () => {
  const { hub, clock, done, woken } = await lead();
  const thread = { machineId: PROJECT.machineId, threadId: "lead-1" };
  clock.ms += 1000;
  const reply = { id: "a", role: "assistant", text: FAKE, createdAt: new Date(clock.ms).toISOString() };
  Object.assign(executors(hub).views, { messages: async () => [reply] });
  await mirror(hub, PROJECT, thread);
  await mirror(hub, PROJECT, thread);
  expect(chat(hub).bySource(PROJECT, "lead:lead-1:a")).toBeUndefined();
  expect(woken.map((t) => (t.kind === "line" ? t.line : t.kind))).toEqual(["made_up"]);
  // The wake went out after the reply; a hub that comes up later reads the session again and wakes nobody for it.
  clock.ms += 1000;
  const later = await lead();
  later.hub.db.conn.run("UPDATE leads SET last_wake_at = ?1", [new Date(clock.ms).toISOString()]);
  later.clock.ms = clock.ms + 1000;
  Object.assign(executors(later.hub).views, { messages: async () => [reply] });
  await mirror(later.hub, PROJECT, thread);
  expect(later.woken).toEqual([]);
  later.done();
  done();
});
