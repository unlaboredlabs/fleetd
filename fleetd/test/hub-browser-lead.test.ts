// A person takes over the screen a project's lead opened and asked them to take, after the lead started again on a
// fresh session (a profile switch, a fresh start): the node's reports in the old session's name still reach the hub,
// as the link sends them, so the takeover is confirmed and the recording lands.
import { afterEach, expect, test } from "bun:test";
import { start as startBrowser } from "../src/hub/browser/loops.ts";
import { get } from "../src/hub/browser/store.ts";
import { leadCalls } from "../src/hub/lead_calls/index.ts";
import { start as startRoles } from "../src/hub/machine_roles/loops.ts";
import { addMachine, caller, testHub, tick } from "./screens_helpers.ts";

const S1 = "B11111111111111111111111111111111";
let t: ReturnType<typeof testHub>;
afterEach(() => t?.done());

function setup() {
  t = testHub();
  startBrowser(t.hub);
  startRoles(t.hub);
  addMachine(t.hub, "devbox");
  t.hub.db.conn
    .query("INSERT INTO projects (machine_id, project_id, search, last_activity_at, data) VALUES ('devbox', 'p1', '', '', ?)")
    .run(JSON.stringify({ machineId: "devbox", projectId: "p1", title: "p1", workspaceRoot: "/work/p1" }));
  t.link.link("devbox", ["browser", "session_end", "screen_settings"]);
  lead("lead-1");
  return t;
}

/** The project's lead runs in `thread` now. */
const lead = (thread: string) =>
  t.hub.db.conn
    .query("INSERT OR REPLACE INTO leads (machine_id, project_id, thread_id, started_at, session_generation) VALUES ('devbox', 'p1', ?, ?, 1)")
    .run(thread, "2026-11-08T12:00:00.000Z");

/** A call from devbox's node in `thread`'s name, from the node's own cwd, as the link answers it. */
const fromNode = (thread: string, call: Record<string, unknown>) =>
  leadCalls(t.hub).answer("devbox", { id: "c1", cwd: "/home/u", threadId: thread, call: call as never });

const report = (extra: Record<string, unknown> = {}) => ({
  op: "browser_session",
  sessionId: S1,
  threadId: "lead-1",
  purpose: "sign in to the dashboard",
  state: "live",
  control: "agent",
  startedAt: "2026-11-08T12:00:00.000Z",
  ...extra,
});

test("a person takes over a lead's screen that asked for it, after the lead started again on a fresh session", async () => {
  setup();
  expect(await fromNode("lead-1", report())).toMatchObject({ result: { sessionId: S1, state: "live" } });
  expect(await fromNode("lead-1", { op: "browser_takeover", sessionId: S1, reason: "sign in" })).toHaveProperty("result");
  // The hub restarts and the lead starts again on its new profile: a new session, while its screen waits on a person.
  lead("lead-2");
  const person = caller("operate", { kind: "human", name: "laptop" });
  const call = t.tools.call(t.hub, person, "browser_control", { sessionId: S1, control: "human" });
  await tick();
  expect(t.link.sent("devbox").at(-1)).toEqual({ t: "browser_control", sessionId: S1, control: "human", by: "human:laptop" });
  // The node took it over and says so, still in the screen's own session's name.
  expect(await fromNode("lead-1", report({ control: "human" }))).toMatchObject({ result: { sessionId: S1, state: "live" } });
  expect(await call).toMatchObject({ output: { session: { sessionId: S1, control: "human" } } });
  // Its recording reaches the hub when it ends.
  const piece = { op: "browser_recording_part", sessionId: S1, file: "actions", offset: 0, dataB64: Buffer.from("hi").toString("base64") };
  expect(await fromNode("lead-1", piece)).toMatchObject({ result: { bytes: 2 } });
  await fromNode("lead-1", report({ state: "recorded", control: "agent", files: [{ file: "actions", bytes: 2 }] }));
  expect(get(t.hub, S1)?.state).toBe("recorded");
});

test("an old session gets only its live screen's reports: no new screen, no other call, nothing once it ended", async () => {
  setup();
  await fromNode("lead-1", report());
  lead("lead-2");
  const refused = async (thread: string, call: Record<string, unknown>) => {
    const answer = await fromNode(thread, call);
    return "error" in answer ? answer.error.code : "answered";
  };
  // Another screen, a vault fill, a lead's own call: refused.
  expect(await refused("lead-1", report({ sessionId: "B22222222222222222222222222222222" }))).toBe("forbidden");
  expect(await refused("lead-1", { op: "vault_items" })).toBe("forbidden");
  expect(await refused("lead-1", { op: "ask_lead", question: "?" })).toBe("forbidden");
  // A session that never held a screen gets nothing.
  expect(await refused("stranger", report({ threadId: "stranger" }))).toBe("forbidden");
  // Once the screen is recorded, the old session is nobody's again.
  await fromNode("lead-1", report({ state: "recorded", files: [] }));
  expect(await refused("lead-1", report())).toBe("forbidden");
});
