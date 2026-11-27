// `project_setup`'s approvals, merges and mergeMode (D786, call 9): a lead makes its bot's approvals or merges stricter
// when a person asks in the chat, never looser, and only for an owner or admin as a person's own change is
// (bot_admin.ts). The order each setting goes by is pure (tighten_rules.ts), so the cloud holds a lead to the same.
import { afterEach, expect, test } from "bun:test";
import { chat } from "../src/hub/chat/index.ts";
import { leadCalls } from "../src/hub/lead_calls/index.ts";
import { approvals, setApprovals } from "../src/hub/project_lead/checker.ts";
import { setMergeMode, setMerges } from "../src/hub/project_lead/store.ts";
import { registerLeadCalls } from "../src/hub/projects/calls.ts";
import { strictness } from "../src/hub/projects/tighten.ts";
import { tighten } from "../src/hub/projects/tighten_rules.ts";
import { events } from "../src/hub/store/events.ts";
import { store } from "../src/hub/store/hub_store.ts";
import { PROJECT, testHub } from "./hub-helpers.ts";

const BEA = { personId: "p-bea", name: "Bea" };
const ADA = { personId: "p-ada", name: "Ada" };

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

/** A workspace with Ada an admin and Bea a member, the bot on YOLO with fleetd merging after the fact. */
function setup() {
  const t = testHub();
  cleanup = t.done;
  const c = t.hub.db.conn;
  c.run("INSERT INTO people (person_id, name, role, created_ms) VALUES ('p-ola', 'Ola', 'owner', 0), ('p-ada', 'Ada', 'admin', 1), ('p-bea', 'Bea', 'member', 2)");
  c.run("INSERT INTO leads (machine_id, project_id, thread_id, started_at, session_generation) VALUES (?1, ?2, 'th-lead', '', 1)", [PROJECT.machineId, PROJECT.projectId]);
  setApprovals(c, PROJECT, "yolo");
  setMerges(c, PROJECT, "fleetd");
  setMergeMode(c, PROJECT, "verify_after");
  /** A message from `person`: the lead's turn now acts for them. A turn before it ended first. */
  const say = (person: typeof BEA) => {
    t.clock.ms += 10;
    events(t.hub).append({ at: new Date(t.clock.ms).toISOString(), type: "thread.completed", machineId: PROJECT.machineId, summary: "done", threadId: "th-lead" });
    t.clock.ms += 10;
    c.run("INSERT INTO chat_messages (machine_id, project_id, seq, created_ms, held, data) VALUES (?1, ?2, ?3, ?4, 0, ?5)", [
      PROJECT.machineId,
      PROJECT.projectId,
      t.clock.ms,
      t.clock.ms - 1,
      JSON.stringify({ author: "human", text: "ask me before every send", person, delivery: "queue" }),
    ]);
  };
  registerLeadCalls(t.hub);
  c.run(`INSERT INTO tasks (n, machine_id, project_id, workstream_id, state, thread_id, data) VALUES (4, ?1, ?2, 'W1', 'running', 'th-task', ?3)`, [
    PROJECT.machineId,
    PROJECT.projectId,
    JSON.stringify({ taskId: "T4", projectRef: PROJECT }),
  ]);
  /** The lead's project_setup, through the lead-call registry as its tool sends it: its result, or throws its refusal. */
  const call = async (args: Record<string, unknown>, threadId = "th-lead") => {
    const frame = await leadCalls(t.hub).answer(PROJECT.machineId, { id: "c1", cwd: "/home/me/shop", call: { op: "project_setup", ...args } as never, threadId });
    if ("error" in frame) throw Object.assign(new Error(frame.error.message), { code: frame.error.code });
    return frame.result as Record<string, unknown>;
  };
  const lines = () =>
    chat(t.hub)
      .page(PROJECT, undefined, undefined, 50)
      .messages.filter((m) => m.author === "system")
      .map((m) => m.text);
  return { ...t, say, call, lines };
}

test("each setting goes loosest to strictest; a looser value refuses the whole call, the same one changes nothing", () => {
  const now = { approvals: "checker", merges: "fleetd", mergeMode: "test_first" } as const;
  expect(tighten(now, { approvals: "ask", merges: "people" })).toEqual({ change: { approvals: "ask", merges: "people" } });
  expect(tighten(now, { approvals: "checker", mergeMode: "test_first" })).toEqual({ change: {} });
  const looser = tighten(now, { merges: "people", approvals: "yolo" });
  expect(looser).toEqual({
    code: "forbidden",
    refused: "YOLO is looser than Checker decides: a lead only makes approvals stricter, never looser.",
    fix: "A person loosens a bot's settings in the app: the bot's settings, Safety.",
  });
  expect(tighten({ ...now, mergeMode: "test_first" }, { mergeMode: "verify_after" })).toMatchObject({ code: "forbidden" });
  expect(tighten(now, {})).toMatchObject({ code: "invalid" });
  expect(tighten(now, { approvals: "never" as never })).toMatchObject({ code: "invalid", refused: "never isn't a value of approvals." });
});

test("an admin's ask makes approvals and merges stricter, with one line in the chat and no Undo", async () => {
  const { hub, say, call, lines } = setup();
  say(ADA);
  const out = await call({ approvals: "ask", merges: "people", mergeMode: "test_first" });
  expect(strictness(hub, PROJECT)).toEqual({ approvals: "ask", merges: "people", mergeMode: "test_first" });
  expect(out.changed).toEqual(["Made stricter: Approvals: Ask me about everything; Who merges: You merge; How PRs merge: Test, then merge"]);
  expect(out.next).toBe(
    "Made stricter: Approvals: Ask me about everything; Who merges: You merge; How PRs merge: Test, then merge. It is one line in the chat; only a person loosens it again, in the bot's settings.",
  );
  const [line] = lines();
  expect(line).toBe(
    "Made stricter: Approvals: Ask me about everything; Who merges: You merge; How PRs merge: Test, then merge. [Ada](person:p-ada) asked for it. A person loosens it in the bot's settings.",
  );
  expect(chat(hub).page(PROJECT, undefined, undefined, 50).messages.find((m) => m.text === line)?.setupChanged).toBeUndefined();
  // The apps hear it as a person's change, saying who.
  const said = events(hub).page(0, ["project.settings"]).events.map((e) => e.summary);
  expect(said).toContain("Shop's approvals: ask, by the lead, at Ada's ask");
  expect(said).toContain("People merge Shop's PRs now, by the lead, at Ada's ask");
});

test("the lead can't loosen: YOLO from checker is refused, in any call, with nothing changed", async () => {
  const { hub, say, call, lines } = setup();
  say(ADA);
  await call({ approvals: "checker", merges: "people" });
  await expect(call({ approvals: "yolo" })).rejects.toThrow("YOLO is looser than Checker decides");
  await expect(call({ mergeMode: "test_first", approvals: "yolo" })).rejects.toThrow("a lead only makes approvals stricter, never looser");
  await expect(call({ merges: "fleetd" })).rejects.toThrow("fleetd merges is looser than You merge: a lead only makes who merges stricter");
  expect(strictness(hub, PROJECT)).toEqual({ approvals: "checker", merges: "people", mergeMode: "verify_after" });
  expect(lines()).toHaveLength(1);
  // Asking for what it already is changes nothing and posts nothing.
  expect((await call({ approvals: "checker" })).changed).toEqual([]);
  expect(lines()).toHaveLength(1);
});

test("a member's ask is refused as their own change would be; a task's call is refused", async () => {
  const { hub, say, call } = setup();
  say(BEA);
  await expect(call({ approvals: "ask" })).rejects.toThrow("Only the workspace's owners and admins can change a bot's approvals.");
  await expect(call({ merges: "people" })).rejects.toThrow("Only the workspace's owners and admins can change who merges a bot's PRs.");
  expect(approvals(hub.db.conn, PROJECT).mode).toBe("yolo");
  await expect(call({ approvals: "ask" }, "th-task")).rejects.toThrow("project_setup is a lead's call, and T4 is a task.");
  expect(approvals(hub.db.conn, PROJECT).mode).toBe("yolo");
});

test("a looser value refuses the whole call: nothing else in it changes either", async () => {
  const { hub, say, call } = setup();
  say(ADA);
  await call({ approvals: "ask" });
  await expect(call({ title: "Shop two", approvals: "checker" })).rejects.toThrow("Checker decides is looser than Ask me about everything");
  expect(store(hub).projectGet(PROJECT)?.title).toBe("Shop");
  expect(approvals(hub.db.conn, PROJECT).mode).toBe("ask");
});

