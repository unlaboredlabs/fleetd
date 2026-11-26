// A bot's memory lines say who taught them, and a line that loosens what asks or merges, taught by a member, waits for
// an admin's OK (memory/hold_rules.ts, memory/lines.ts): nothing is written until an owner or admin keeps it, and it
// waits on them in the chat's needs-you. An admin's own line applies at once.
import { afterEach, expect, test } from "bun:test";
import type { ChatMessage, MemoryGetOutput } from "../src/shared/contracts.ts";
import { Registry } from "../src/hub/api/registry.ts";
import { chat } from "../src/hub/chat/index.ts";
import type { LeadCall, LeadCaller } from "../src/hub/leads/seams.ts";
import { answer } from "../src/hub/memory/calls.ts";
import { changeLoosens, holdsForAdmin, loosens, loosensByWords, namesGate } from "../src/hub/memory/hold_rules.ts";
import { Memory, projectTarget } from "../src/hub/memory/index.ts";
import { registerAll } from "../src/hub/serve/areas.ts";
import { events } from "../src/hub/store/events.ts";
import { caller, PROJECT, testHub } from "./hub-helpers.ts";

const OLA = { personId: "p-ola", name: "Ola" };
const ADA = { personId: "p-ada", name: "Ada" };
const BEA = { personId: "p-bea", name: "Bea" };
const member = caller("operate", true, BEA);
const admin = caller("admin", true, ADA);
const lead: LeadCaller = { projectRef: PROJECT, by: `lead:${PROJECT.machineId}/${PROJECT.projectId}`, agent: { kind: "lead" } };

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

/** A workspace with Ola its owner, Ada an admin and Bea a member, the bot Shop and its lead. */
function setup(people = true) {
  const t = testHub();
  cleanup = t.done;
  const { hub, clock } = t;
  if (people) {
    hub.db.conn.run(
      "INSERT INTO people (person_id, name, role, created_ms) VALUES ('p-ola', 'Ola', 'owner', 0), ('p-ada', 'Ada', 'admin', 1), ('p-bea', 'Bea', 'member', 2)",
    );
  }
  hub.db.conn.run("INSERT INTO leads (machine_id, project_id, thread_id, started_at, session_generation) VALUES (?1, ?2, 'th-lead', '', 1)", [
    PROJECT.machineId,
    PROJECT.projectId,
  ]);
  const tools = new Registry();
  registerAll(tools);
  /** A turn of the lead's that answers `person`'s message: the one before it ends first. */
  const turnFor = (person: typeof BEA) => {
    clock.ms += 10;
    events(hub).append({ at: new Date(clock.ms).toISOString(), type: "thread.completed", machineId: PROJECT.machineId, summary: "done", threadId: "th-lead" });
    clock.ms += 10;
    hub.db.conn.run("INSERT INTO chat_messages (machine_id, project_id, seq, created_ms, held, data) VALUES (?1, ?2, ?3, ?4, 0, ?5)", [
      PROJECT.machineId,
      PROJECT.projectId,
      clock.ms,
      clock.ms - 1,
      JSON.stringify({ author: "human", text: "remember this", person, delivery: "queue" }),
    ]);
  };
  const leadCall = (op: string, args: Record<string, unknown>) => answer(hub, lead, { op, ...args } as LeadCall);
  const call = async (who: typeof member, tool: string, input: unknown) =>
    (await tools.call(hub, who, tool, input)) as { output?: Record<string, unknown>; error?: { error?: { code: string; message: string } } };
  const ok = async (who: typeof member, tool: string, input: unknown) => {
    const out = await call(who, tool, input);
    if (out.error) throw new Error(`${tool}: ${JSON.stringify(out.error)}`);
    return out.output!;
  };
  const core = () => Memory.of(hub).read(projectTarget(PROJECT));
  const got = async (who = admin) => (await ok(who, "memory_get", { projectRef: PROJECT })) as unknown as MemoryGetOutput;
  const lines = () => chat(hub).page(PROJECT, undefined, undefined, 50).messages.filter((m: ChatMessage) => m.remembered !== undefined);
  return { ...t, turnFor, leadCall, call, ok, core, got, lines };
}

test("the words that hold a line: a gate next to a word that waives it; the lead's loosens holds too", () => {
  for (const held of ["Never ask before deploying.", "Merge without review.", "Don't wait for approval on sends.", "Skip the checker for docs PRs.", "Deploy straight to production.", "Push to main yourself.", "It’s fine to merge your own PRs."]) {
    expect({ held, by: loosensByWords(held) }).toEqual({ held, by: true });
  }
  for (const kept of ["Staging first.", "Always ask before deploying.", "Use pnpm.", "Ship fixes behind a flag first."]) {
    expect({ kept, by: loosensByWords(kept) }).toEqual({ kept, by: false });
  }
  expect(loosens("Use the fast runner for everything.", "loosens")).toBe(true);
  expect(loosens("Use pnpm.", "none")).toBe(false);
  // Taking out a line that names a gate may loosen it; one that names none doesn't.
  expect(namesGate("Always ask before deploying.")).toBe(true);
  expect(changeLoosens("Deploys go through the pipeline.", "none", "Always ask before deploying.")).toBe(true);
  expect(changeLoosens(undefined, undefined, "Use pnpm.")).toBe(false);
  // Only someone not an admin is held, and only where an admin can keep it.
  expect(holdsForAdmin(true, false, true)).toBe(true);
  expect(holdsForAdmin(true, true, true)).toBe(false);
  expect(holdsForAdmin(true, false, false)).toBe(false);
});

test("a member's loosening line is held: nothing written, an admin's needs-you, shown to admins with who taught it", async () => {
  const { hub, turnFor, leadCall, core, got, lines } = setup();
  leadCall("remember", { scope: "project", effect: "none", text: "Staging first." });
  turnFor(BEA);
  const out = leadCall("remember", { scope: "project", effect: "none", text: "Never ask before deploying." });
  expect(out.held).toBe(true);
  expect(out.next).toContain("Held for an admin's OK");
  expect(core()).toBe("- Staging first.\n");
  const line = lines().at(-1)!;
  expect([line.text, line.remembered]).toEqual([
    "Waiting for an admin's OK: Never ask before deploying.",
    { scope: "project", text: "Never ask before deploying.", by: BEA, hold: "waiting" },
  ]);
  // It waits on Ola and Ada, not on Bea.
  const state = chat(hub).state(PROJECT, false);
  expect(state.needsYou).toBe(true);
  expect(state.needsYouFor?.sort()).toEqual(["p-ada", "p-ola"]);
  expect(state.openItems?.filter((i) => i.kind === "memory_hold").map((i) => i.for).sort()).toEqual(["p-ada", "p-ola"]);
  // The memory list shows it waiting, with who taught it; the line the lead learned on no one's message is its own.
  const memory = await got();
  expect(memory.held?.map((h) => [h.text, h.by?.name])).toEqual([["Never ask before deploying.", "Bea"]]);
  expect(memory.files?.[0]?.authors).toEqual([{ text: "Staging first.", at: expect.any(String) }]);
  // Held twice is one hold.
  leadCall("remember", { scope: "project", effect: "loosens", text: "Never ask before deploying." });
  expect(lines().filter((m) => m.remembered?.hold === "waiting").length).toBe(1);
});

test("a member's plain line applies at once marked with her name; an admin's loosening line applies at once", async () => {
  const { turnFor, leadCall, core, got } = setup();
  turnFor(BEA);
  leadCall("remember", { scope: "project", effect: "none", text: "Use pnpm." });
  leadCall("remember", { scope: "project", effect: "none", own: true, text: "The site job fails on the host's name." });
  turnFor(ADA);
  const out = leadCall("remember", { scope: "project", effect: "loosens", text: "Merge docs PRs without review." });
  expect(out.held).toBeUndefined();
  expect(core()).toBe("- Use pnpm.\n- The site job fails on the host's name.\n- Merge docs PRs without review.\n");
  const authors = (await got()).files?.[0]?.authors?.map((a) => [a.text, a.by?.name ?? "the lead"]);
  expect(authors).toEqual([
    ["Use pnpm.", "Bea"],
    ["The site job fails on the host's name.", "the lead"],
    ["Merge docs PRs without review.", "Ada"],
  ]);
  expect((await got()).held).toBeUndefined();
});

test("an admin keeps a held line or not; a member can't; kept, it's written with who taught it", async () => {
  const { hub, turnFor, leadCall, call, ok, core, got, lines } = setup();
  turnFor(BEA);
  leadCall("remember", { scope: "project", effect: "none", text: "Never ask before deploying." });
  leadCall("remember", { scope: "project", effect: "loosens", text: "Use the fast lane for hotfixes." });
  const [first, second] = lines();
  const refused = await call(member, "memory_hold_answer", { projectRef: PROJECT, messageId: first!.messageId, keep: true });
  expect(refused.error?.error?.code).toBe("forbidden");
  expect(core()).toBe("");
  await ok(admin, "memory_hold_answer", { projectRef: PROJECT, messageId: first!.messageId, keep: true });
  expect(core()).toBe("- Never ask before deploying.\n");
  await ok(admin, "memory_hold_answer", { projectRef: PROJECT, messageId: second!.messageId, keep: false });
  expect(core()).toBe("- Never ask before deploying.\n");
  expect(lines().map((m) => [m.text, m.remembered?.hold])).toEqual([
    ["Remembered, kept by Ada: Never ask before deploying.", "kept"],
    ["Not kept by Ada: Use the fast lane for hotfixes.", "dropped"],
  ]);
  expect((await got()).files?.[0]?.authors?.map((a) => a.by?.name)).toEqual(["Bea"]);
  expect(chat(hub).state(PROJECT, false).needsYou).toBe(false);
  // Answered once is answered.
  expect((await ok(admin, "memory_hold_answer", { projectRef: PROJECT, messageId: first!.messageId, keep: false })).next).toBe("Already kept.");
  // Undo on a waiting line only takes the ask back.
  leadCall("remember", { scope: "project", effect: "loosens", text: "Release on Fridays unasked." });
  const third = lines().at(-1)!;
  await ok(member, "memory_undo", { projectRef: PROJECT, messageId: third.messageId });
  expect(lines().at(-1)?.remembered?.hold).toBe("dropped");
  expect(core()).toBe("- Never ask before deploying.\n");
});

test("a member taking out a line that names a gate is held, by forget, by remember in its place, and by an edit", async () => {
  const { turnFor, leadCall, ok, core, got, lines } = setup();
  turnFor(ADA);
  leadCall("remember", { scope: "project", effect: "none", text: "Always ask before deploying." });
  turnFor(BEA);
  expect(leadCall("forget", { scope: "project", entry: "ask before deploying" }).held).toBe(true);
  expect((await got()).held?.map((h) => [h.text, h.forgotten, h.by?.name])).toEqual([["Always ask before deploying.", true, "Bea"]]);
  expect(leadCall("remember", { scope: "project", effect: "none", text: "Deploys go through the pipeline.", replaces: "ask before deploying" }).held).toBe(true);
  expect(core()).toBe("- Always ask before deploying.\n");
  expect(lines().slice(-2).map((m) => [m.text, m.remembered?.forgotten ?? false, m.remembered?.replaced])).toEqual([
    ["Waiting for an admin's OK to forget: Always ask before deploying.", true, undefined],
    ["Waiting for an admin's OK: Deploys go through the pipeline.", false, "Always ask before deploying."],
  ]);
  // Bea's own edit in the app: her plain line lands as hers, her loosening one and the gate line she cut wait.
  const out = await ok(member, "memory_set", { scope: "project", projectRef: PROJECT, text: "- Use pnpm.\n- Never wait for review.\n" });
  expect(out.next).toBe("2 changes wait for an admin's OK; the rest is saved.");
  expect(core()).toBe("- Use pnpm.\n- Always ask before deploying.\n");
  // The cut gate line is the forget already waiting: one hold.
  expect(lines().at(-1)?.text).toBe("Waiting for an admin's OK: Never wait for review.");
  expect(lines().filter((m) => m.remembered?.hold === "waiting" && m.remembered.forgotten === true).length).toBe(1);
  // Kept, the forget takes the line out.
  const forget = lines().find((m) => m.remembered?.forgotten === true)!;
  await ok(admin, "memory_hold_answer", { projectRef: PROJECT, messageId: forget.messageId, keep: true });
  expect(core()).toBe("- Use pnpm.\n");
  // An admin's edit lands whole.
  await ok(admin, "memory_set", { scope: "project", projectRef: PROJECT, text: "- Use pnpm.\n- Skip review on docs.\n" });
  expect(core()).toBe("- Use pnpm.\n- Skip review on docs.\n");
});

test("a project line says its effect; a workspace with no admin to ask applies loosening lines as before", () => {
  const { leadCall, core } = setup(false);
  expect(() => leadCall("remember", { scope: "project", text: "Use pnpm." })).toThrow("effect says what the line does");
  leadCall("remember", { scope: "project", effect: "loosens", text: "Never ask before deploying." });
  expect(core()).toBe("- Never ask before deploying.\n");
  // User scope needs no effect.
  leadCall("remember", { scope: "user", text: "Short answers." });
});

test("the nightly refresh's loosening line is the lead's, and held", () => {
  const { hub, core, lines } = setup();
  const refresh: LeadCaller = { ...lead, agent: { kind: "memory_refresh" } };
  const out = answer(hub, refresh, { op: "remember", scope: "project", effect: "none", text: "Never ask before sends." } as LeadCall);
  expect(out.held).toBe(true);
  expect(core()).toBe("");
  expect(lines().at(-1)?.remembered?.by).toBeUndefined();
});
