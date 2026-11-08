import { afterEach, expect, test } from "bun:test";
import { start as startBrowser } from "../src/hub/browser/loops.ts";
import { get } from "../src/hub/browser/store.ts";
import { serve, stop } from "../src/hub/http/index.ts";
import { start as startRoles } from "../src/hub/machine_roles/loops.ts";
import { autoSessions, place, type Runner } from "../src/hub/machine_roles/places.ts";
import { goneProof, GONE_HEADER, hashToken, relays } from "../src/hub/machine_roles/relay.ts";
import { addMachine, addProject, agent, caller, testHub, tick } from "./screens_helpers.ts";

const S5 = "B55555555555555555555555555555555";
const S9 = "B99999999999999999999999999999999";
let t: ReturnType<typeof testHub>;
afterEach(() => t?.done());

const KEY = Buffer.alloc(32, 7).toString("base64");
const load = (hosts: { host: string; ready: boolean; detail: string }[]) => ({
  t: "hb",
  at: "2026-11-08T12:00:00.000Z",
  load: { cpus: 8, load1: 0, memTotalBytes: 16 * 2 ** 30, hosts },
});

/** devbox runs agents only; box2 hosts browsers for others. */
function setup() {
  t = testHub();
  startBrowser(t.hub);
  startRoles(t.hub);
  addMachine(t.hub, "devbox", { boxPubKey: KEY });
  addMachine(t.hub, "box2", { boxPubKey: KEY });
  addProject(t.hub, "devbox", "p1");
  t.link.link("devbox", ["browser", "session_seal", "session_host"]);
  t.link.link("box2", ["browser", "session_seal", "session_host", "screen_settings"]);
  t.hub.db.conn.query("INSERT INTO machine_roles (machine_id, agents, sessions) VALUES ('devbox', 1, 0)").run();
  t.link.deliver("box2", load([{ host: "browser", ready: true, detail: "Chrome 131" }]));
  return t;
}

const start = (extra: Record<string, unknown> = {}) => ({
  op: "session_route",
  frame: { id: "c1", cwd: "/w", threadId: "t1", call: { op: "session_start", purpose: "look" } },
  ...extra,
});

const runner = (r: Partial<Runner> & { machineId: string }): Runner => ({
  name: r.machineId,
  online: true,
  sessions: true,
  hosts: [{ host: "browser", ready: true, detail: "ok" }],
  hostsOthers: true,
  othersNote: undefined,
  live: 0,
  max: 4,
  held: 0,
  cloud: undefined,
  ...r,
});

test("placement: its own machine first, else the one with most free slots, a cloud machine last", () => {
  const own = runner({ machineId: "a" });
  expect(place("a", "browser", [own, runner({ machineId: "b" })], true)).toBe("a");
  const full = runner({ machineId: "a", live: 4 });
  const roomy = runner({ machineId: "c", live: 1 });
  const cloud = runner({ machineId: "d", cloud: true });
  expect(place("a", "browser", [full, runner({ machineId: "b", live: 3 }), roomy, cloud], true)).toBe("c");
  expect(place("a", "browser", [full, runner({ machineId: "b", live: 4 }), cloud], true)).toBe("d");
  expect(() => place("a", "browser", [full], false)).toThrow("a's session slots are full: 4 of 4.");
  expect(() => place("a", "browser", [full, runner({ machineId: "b", online: false })], true)).toThrow(
    "Every machine that can host a browser session is full: a 4 of 4.",
  );
  expect(() => place("a", "android", [own], false)).toThrow("a can't host an Android emulator session: it hasn't said what it can host.");
  expect(() => place("a", "android", [own], true)).toThrow("No machine can host an Android emulator session");
  expect(autoSessions({ cpus: 8, load1: 0, memTotalBytes: 6 * 2 ** 30 }, 1)).toEqual([3, "auto: 8 CPUs, 6 GB"]);
  expect(autoSessions(undefined, 5)).toEqual([5, "auto: one for each agent and lead it runs (5)"]);
});

test("a session placed elsewhere: sealed to the runner, started there, with a relay token for the agent's node", async () => {
  setup();
  const first = await t.calls.call(agent("devbox", "p1", "T3"), start());
  expect(first.result).toEqual({ runner: "box2", here: false, sealTo: KEY });
  const asked: unknown[] = [];
  t.link.answer = async (machine: string, frame: Record<string, unknown>) => {
    asked.push({ machine, ...frame });
    const f = frame as { id: string; frame: { id: string; call: { op: string } } };
    const result = f.frame.call.op === "session_start" ? { op: "session_start", sessionId: S9 } : { op: "session_end" };
    return { id: f.id, frame: { id: f.frame.id, result } };
  };
  const second = await t.calls.call(agent("devbox", "p1", "T3"), start({ sealed: { runner: "box2", dataB64: "c2VhbGVk" } }));
  const routed = second.result as { runner: string; relay: string; answer: unknown };
  expect(routed).toMatchObject({ runner: "box2", here: false, answer: { id: "c1", result: { sessionId: S9 } } });
  expect(routed.relay).toMatch(/^[0-9a-f]{64}$/);
  // The runner knows the session by its key alone, never the agent's thread.
  expect(asked[0]).toMatchObject({ machine: "box2", t: "session_host", sealed: "c2VhbGVk", frame: { id: "c1" } });
  expect((asked[0] as { frame: { threadId?: string }; hostKey: string }).frame.threadId).toBeUndefined();
  expect((asked[0] as { hostKey: string }).hostKey).toMatch(/^H[0-9a-f]{32}$/);
  const row = t.hub.db.all<{ session_id: string; relay_hash: string }>("SELECT session_id, relay_hash FROM session_places")[0];
  expect(row).toEqual({ session_id: S9, relay_hash: hashToken(routed.relay) });
  // Another start while it is open is refused; its later calls go to the runner, and its end ends the place.
  expect((await t.calls.call(agent("devbox", "p1", "T3"), start())).error?.message).toContain("is open on box2");
  const end = { op: "session_route", frame: { id: "c2", cwd: "/w", threadId: "t1", call: { op: "session_end" } } };
  expect((await t.calls.call(agent("devbox", "p1", "T3"), end)).result).toMatchObject({ runner: "box2", here: false });
  expect(t.hub.db.all("SELECT ended_ms FROM session_places WHERE ended_ms IS NOT NULL")).toHaveLength(1);
  // The runner's lead calls under the host key act as the agent.
  expect(t.calls.hosts("box2", (asked[0] as { hostKey: string }).hostKey)).toMatchObject({
    agent: { kind: "task", taskId: "T3" },
    projectRef: { machineId: "devbox", projectId: "p1" },
    threadId: "t1",
  });
  expect(t.calls.hosts("devbox", (asked[0] as { hostKey: string }).hostKey)).toBeUndefined();
});

test("a session on the agent's own machine is answered there, and calls of no hosted session stay home", async () => {
  setup();
  t.hub.db.conn.query("UPDATE machine_roles SET sessions = 1 WHERE machine_id = 'devbox'").run();
  t.link.deliver("devbox", load([{ host: "browser", ready: true, detail: "Chrome" }]));
  expect((await t.calls.call(agent("devbox", "p1"), start())).result).toEqual({ runner: "devbox", here: true });
  const end = { op: "session_route", frame: { id: "c2", cwd: "/w", threadId: "t9", call: { op: "session_end" } } };
  expect((await t.calls.call(agent("devbox", "p1"), end)).result).toEqual({ runner: "devbox", here: true });
});

test("the relay pipes the agent's node and the runner's frame for frame, and proves a gone session", async () => {
  setup();
  const server = serve(t.hub, t.tools, 0);
  try {
    const token = "a".repeat(64);
    t.hub.db.transaction((c) => {
      c.query(
        `INSERT INTO session_places (place_id, runner_id, origin_machine, origin_thread, project_id, hosted, session_id,
           started_ms, relay_hash) VALUES ('H${"0".repeat(32)}', 'box2', 'devbox', 't1', 'p1', 1, 's9', ?, ?)`,
      ).run(t.clock.now(), hashToken(token));
    });
    const piped: string[] = [];
    relays(t.hub).tap = (m) => piped.push(m.toString());
    const base = `ws://127.0.0.1:${server.port}/relay/`;
    const agentSide = new WebSocket(base + token);
    const fromRunner: string[] = [];
    agentSide.onmessage = (e) => fromRunner.push(String(e.data));
    await new Promise((r) => (agentSide.onopen = r));
    agentSide.send("early: before the runner connects");
    await Bun.sleep(20);
    const dial = t.link.sent("box2").find((f: { t: string }) => f.t === "relay_dial") as { token: string; hostKey: string; stream: string };
    expect(dial).toMatchObject({ hostKey: `H${"0".repeat(32)}`, stream: "cdp" });
    const runnerSide = new WebSocket(base + dial.token);
    const fromAgent: string[] = [];
    runnerSide.onmessage = (e) => fromAgent.push(String(e.data));
    await new Promise((r) => (runnerSide.onopen = r));
    runnerSide.send("from the runner");
    agentSide.send("from the agent");
    await Bun.sleep(50);
    expect(fromAgent).toEqual(["early: before the runner connects", "from the agent"]);
    expect(fromRunner).toEqual(["from the runner"]);
    expect(piped.sort()).toEqual(["early: before the runner connects", "from the agent", "from the runner"].sort());
    // The channel token is good once.
    const again = await fetch(`http://127.0.0.1:${server.port}/relay/${dial.token}`, { headers: { upgrade: "websocket" } });
    expect(again.status).toBe(410);
    const closed = new Promise((r) => (agentSide.onclose = r));
    runnerSide.close();
    await closed;
    const gone = await fetch(`http://127.0.0.1:${server.port}/relay/${"b".repeat(64)}`, { headers: { upgrade: "websocket" } });
    expect(gone.status).toBe(410);
    expect(gone.headers.get(GONE_HEADER)).toBe(goneProof(hashToken("b".repeat(64))));
    expect((await fetch(`http://127.0.0.1:${server.port}/relay/nope`, { headers: { upgrade: "websocket" } })).status).toBe(403);
  } finally {
    await stop(server);
  }
});

test("a person's screen: placed and started on the runner, theirs to drive, ended by them", async () => {
  setup();
  const person = caller("operate", { kind: "human", name: "laptop" });
  t.hub.db.conn.query("INSERT INTO people (person_id, name, role, created_ms) VALUES ('p_me', 'Sam', 'owner', 0)").run();
  person.person = { personId: "p_me", name: "Sam" };
  const runnerAgent = { ...agent("devbox", "p1"), agent: { kind: "lead" as const } };
  t.link.answer = async (_machine: string, frame: Record<string, unknown>) => {
    const f = frame as { id: string; hostKey: string; frame: { id: string; call: { op: string } } };
    if (f.frame.call.op === "session_start") {
      const thread = t.hub.db.all<{ origin_thread: string }>("SELECT origin_thread FROM session_places")[0]!.origin_thread;
      // The runner reports it live in the project's name, under the screen's own thread.
      await t.calls.call({ ...runnerAgent, threadId: thread }, {
        op: "browser_session",
        sessionId: S5,
        threadId: thread,
        purpose: "Browser opened by Sam",
        state: "live",
        startedAt: "2026-11-08T12:00:00.000Z",
      });
      return { id: f.id, frame: { id: f.frame.id, result: { op: "session_start", sessionId: S5 } } };
    }
    return { id: f.id, frame: { id: f.frame.id, result: { op: "session_end" } } };
  };
  const opened = t.tools.call(t.hub, person, "screen_open", { projectRef: { machineId: "devbox", projectId: "p1" }, machineId: "box2" });
  await Bun.sleep(20);
  expect(t.link.sent("box2").at(-1)).toMatchObject({ t: "browser_control", sessionId: S5, control: "human", by: "human:laptop" });
  await t.calls.call(runnerAgent, {
    op: "browser_session",
    sessionId: S5,
    threadId: get(t.hub, S5)!.threadId,
    purpose: "Browser opened by Sam",
    state: "live",
    control: "human",
    startedAt: "2026-11-08T12:00:00.000Z",
  });
  const out = (await opened) as { output: { session: { openedBy: unknown; control: string } } };
  expect(out.output.session).toMatchObject({ openedBy: { personId: "p_me", name: "Sam" }, control: "human" });
  const ended = await t.tools.call(t.hub, person, "screen_end", { sessionId: S5 });
  expect(ended).toMatchObject({ output: { next: "It closes on its machine; its recording goes to the hub." } });
  // Nobody else ends it, and an agent opens none.
  expect(await t.tools.call(t.hub, caller("operate"), "screen_open", { projectRef: { machineId: "devbox", projectId: "p1" }, machineId: "box2" })).toMatchObject({
    error: { error: { code: "forbidden" } },
  });
});

test("a full machine takes a person in line, and their wait shows in browser_sessions", async () => {
  setup();
  t.hub.db.conn.query("INSERT INTO machine_roles (machine_id, agents, sessions, max_sessions) VALUES ('box2', 1, 1, 1)").run();
  t.hub.db.conn
    .query(
      `INSERT INTO session_places (place_id, runner_id, origin_machine, origin_thread, project_id, hosted, started_ms)
       VALUES ('H${"1".repeat(32)}', 'box2', 'devbox', 'tx', 'p1', 1, ?)`,
    )
    .run(t.clock.now());
  const person = caller("operate", { kind: "human" });
  const r = { projectRef: { machineId: "devbox", projectId: "p1" }, machineId: "box2" };
  const full = await t.tools.call(t.hub, person, "screen_open", r);
  expect(full).toMatchObject({ error: { error: { code: "failed", message: "box2 is full: 1 of 1 screens." } } });
  const waiting = (await t.tools.call(t.hub, person, "screen_open", { ...r, wait: true })) as {
    output: { waiting: { waitId: string; ahead: number } };
  };
  expect(waiting.output.waiting).toMatchObject({ ahead: 0, machineId: "box2" });
  const listed = (await t.tools.call(t.hub, person, "browser_sessions", { projectRef: r.projectRef })) as {
    output: { waits: { waitId: string }[] };
  };
  expect(listed.output.waits.map((w) => w.waitId)).toEqual([waiting.output.waiting.waitId]);
  // An agent's start now sees the slot a person waits for as taken.
  expect(t.hub.db.all("SELECT 1 FROM screen_waits WHERE stage = 'waiting'")).toHaveLength(1);
  const given = await t.tools.call(t.hub, person, "screen_end", { waitId: waiting.output.waiting.waitId });
  expect(given).toMatchObject({ output: { next: "Your wait is given up." } });
});

test("machine_roles lists each machine's roles and slots; machine_roles_set changes them", async () => {
  setup();
  const listed = (await t.tools.call(t.hub, caller("read"), "machine_roles", {})) as {
    output: { machines: { machineId: string; roles: string[]; maxSessions: number; maxSessionsWhy: string; hostsOthers: boolean }[] };
  };
  expect(listed.output.machines.find((m) => m.machineId === "box2")).toMatchObject({
    roles: ["agents", "sessions"],
    maxSessions: 4,
    maxSessionsWhy: "auto: 8 CPUs, 16 GB",
    hostsOthers: true,
  });
  expect(listed.output.machines.find((m) => m.machineId === "devbox")?.roles).toEqual(["agents"]);
  const set = await t.tools.call(t.hub, caller("admin"), "machine_roles_set", { machineId: "box2", roles: ["sessions"], maxSessions: 6 });
  expect(set).toMatchObject({
    output: { machine: { roles: ["sessions"], maxSessions: 6, maxSessionsSet: 6 }, next: "box2 takes no new agents: those running finish their work, and its projects' agents wait." },
  });
  expect(await t.tools.call(t.hub, caller("admin"), "machine_roles_set", { machineId: "box2", macTool: false })).toMatchObject({
    error: { error: { code: "invalid" } },
  });
});

test("machine_screens_set has the node write it, and takes the node's new host checks", async () => {
  setup();
  t.link.answer = async (machine: string, frame: Record<string, unknown>) => {
    expect({ machine, frame }).toEqual({ machine: "box2", frame: { t: "node_action", action: "screens", screens: { host: "android", on: true } } });
    return { ok: true, message: "Saved.", hosts: [{ host: "android", ready: true, detail: "SDK" }] };
  };
  const out = await t.tools.call(t.hub, caller("admin"), "machine_screens_set", { machineId: "box2", host: "android", on: true });
  expect(out).toMatchObject({ output: { next: "Saved.", machine: { hosts: [{ host: "android", ready: true }] } } });
  t.link.unlink("box2");
  expect(await t.tools.call(t.hub, caller("admin"), "machine_screens_set", { machineId: "box2", host: "android", on: false })).toMatchObject({
    error: { error: { code: "machine_offline", message: "box2 is offline." } },
  });
});

test("the agents' Mac: mac_where names it, mac_send passes a sealed step on and back", async () => {
  setup();
  addMachine(t.hub, "mac1", { agentsMac: true, boxPubKey: KEY });
  const who = agent("devbox", "p1", "T4");
  expect((await t.calls.call(who, { op: "mac_where" })).error?.code).toBe("machine_offline");
  t.link.link("mac1", ["mac_tool"]);
  expect((await t.calls.call(who, { op: "mac_where" })).result).toEqual({ machineId: "mac1", boxPubKey: KEY });
  t.link.answer = async (machine: string, frame: Record<string, unknown>) => {
    expect(frame).toMatchObject({ t: "mac_call", caller: { machineId: "devbox", projectId: "p1", taskId: "T4", threadId: "t1" }, sealed: "c3RlcA==" });
    return { id: (frame as { id: string }).id, sealed: `answer from ${machine}` };
  };
  const sent = await t.calls.call(who, { op: "mac_send", machineId: "mac1", threadId: "t1", sealed: "c3RlcA==" });
  expect(sent.result).toEqual({ sealed: "answer from mac1" });
  expect((await t.calls.call({ ...who, agent: { kind: "person" } }, { op: "mac_where" })).error?.code).toBe("forbidden");
  // The admin's switch turns it off; a fill never goes to the Mac.
  await t.tools.call(t.hub, caller("admin"), "machine_roles_set", { machineId: "mac1", macTool: false });
  expect((await t.calls.call(who, { op: "mac_where" })).error?.code).toBe("machine_offline");
  await tick();
});

test("session_step goes to the runner of the agent's session hosted elsewhere, and nowhere else", async () => {
  setup();
  const step = { op: "session_step", threadId: "t1", item: { kind: "command", text: "agent-browser open" } };
  expect((await t.calls.call(agent("devbox", "p1"), step)).result).toEqual({ forwarded: false });
  t.hub.db.conn
    .query(
      `INSERT INTO session_places (place_id, runner_id, origin_machine, origin_thread, project_id, hosted, session_id, started_ms)
       VALUES ('H${"2".repeat(32)}', 'box2', 'devbox', 't1', 'p1', 1, ?, ?)`,
    )
    .run(`B${"3".repeat(32)}`, t.clock.now());
  expect((await t.calls.call(agent("devbox", "p1"), step)).result).toEqual({ forwarded: true });
  expect(t.link.sent("box2").at(-1)).toEqual({ t: "session_step", hostKey: `H${"2".repeat(32)}`, item: step.item });
});

test("an admin of every machine sets the recordings' retention", async () => {
  setup();
  const set = await t.tools.call(t.hub, caller("admin"), "browser_retention_set", { retentionDays: 7, maxGbPerProject: 2 });
  expect(set).toMatchObject({ output: { retention: { retentionDays: 7, maxGbPerProject: 2 } } });
  const roles = (await t.tools.call(t.hub, caller("read"), "machine_roles", {})) as { output: { retention: unknown } };
  expect(roles.output.retention).toEqual({ retentionDays: 7, maxGbPerProject: 2 });
});

test("hub.area(\"machine_roles\") says whether a machine runs agents, for the train", async () => {
  setup();
  const roles = t.hub.area<{ agents(m: string): boolean }>("machine_roles", () => {
    throw new Error("the machine_roles area's start makes it");
  });
  expect(roles.agents("box2")).toBe(true);
  expect(roles.agents("nowhere")).toBe(true);
  await t.tools.call(t.hub, caller("admin"), "machine_roles_set", { machineId: "box2", roles: ["sessions"] });
  expect(roles.agents("box2")).toBe(false);
});
