// A person's own iPhone on the agents' Mac (`screen_open` kind ios) and phone screens' device controls
// (`screen_control`), on the hub (W804): the hub seals the Mac's `mac sim start` itself, always in the Mac's line, and
// answers at once with the person's wait row while it follows the start; the screen is the person's from the start,
// its controls go to the machine that runs it, and its end is a sealed `mac sim end`.
import { afterEach, expect, test } from "bun:test";
import { start as startBrowser } from "../src/hub/browser/loops.ts";
import { get } from "../src/hub/browser/store.ts";
import { start as startRoles } from "../src/hub/machine_roles/loops.ts";
import { modelOf } from "../src/hub/machine_roles/phone.ts";
import { type Envelope, sealAnswer, splitRaw } from "../src/node/mac_tool/protocol.ts";
import { openSealed, publicKeyOf } from "../src/shared/sealed_box.ts";
import { addMachine, addProject, caller, testHub, tick } from "./screens_helpers.ts";

let t: ReturnType<typeof testHub>;
afterEach(() => t?.done());

const SECRET = new Uint8Array(32).fill(9);
const MAC_KEY = Buffer.from(publicKeyOf(SECRET)).toString("base64");
const DUO = {
  id: "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo",
  name: "iPhone Duo",
  family: "foldable",
  runtimes: [{ id: "com.apple.CoreSimulator.SimRuntime.iOS-27-2-iPhone19-4", name: "iOS 27.2" }],
};
const IPHONE = { id: "com.apple.CoreSimulator.SimDeviceType.iPhone-17", name: "iPhone 17", family: "iphone", runtimes: [{ id: "r", name: "iOS 27.2" }] };
const DEVICE = { controls: ["rotate_left", "rotate_right", "shake", "home", "lock", "appearance", "screenshot", "location", "fold"], orientation: "portrait", appearance: "light", fold: "closed", folds: ["closed", "half-open", "open"] };
const human = () => caller("operate", { kind: "human", name: "ada-laptop" });

/** devbox runs the bot; mac1 is the agents' Mac, its simulators ready with two models. */
function setup() {
  t = testHub();
  startBrowser(t.hub);
  startRoles(t.hub);
  addMachine(t.hub, "devbox");
  addMachine(t.hub, "mac1", { agentsMac: true, boxPubKey: MAC_KEY });
  addProject(t.hub, "devbox", "p1");
  t.link.link("mac1", ["mac_tool", "screen_control", "browser"]);
  t.link.deliver("mac1", {
    t: "hb",
    at: "2026-11-08T12:00:00.000Z",
    load: {
      cpus: 8,
      load1: 0,
      memTotalBytes: 16 * 2 ** 30,
      hosts: [
        { host: "mac", ready: true, detail: "ok" },
        { host: "ios", ready: true, detail: "2 models", sims: { models: [IPHONE, DUO], live: 0, max: 2 } },
      ],
    },
  });
  return t;
}

/** The Mac: each sealed step opened with its key, answered as `reply` says, a `sim_start` reported live first. */
function fakeMac(reply: (env: Envelope, frame: Record<string, unknown>) => Record<string, unknown>) {
  const steps: Envelope[] = [];
  const frames: Record<string, unknown>[] = [];
  const hostKeys = new Map<string, string>();
  const reportLive = async (sessionId: string, control: string) => {
    const who = t.calls.hosts("mac1", hostKeys.get(sessionId)!)!;
    await t.calls.call(
      { projectRef: who.projectRef, by: "node:mac1", agent: who.agent, threadId: who.threadId },
      { op: "browser_session", sessionId, kind: "ios", threadId: who.threadId, purpose: "iPhone Duo · Ada", state: "live", control, startedAt: "2026-11-08T12:00:00.000Z", device: DEVICE },
    );
  };
  // A takeover is confirmed as the Mac's screens do: a report of who drives now.
  t.link.onSend = (_m, frame) => {
    frames.push(frame as Record<string, unknown>);
    if (frame.t === "browser_control") void reportLive(String(frame.sessionId), frame.control === "human" ? "human" : "agent");
  };
  t.link.answer = async (_machine: string, frame: Record<string, unknown>) => {
    frames.push(frame);
    if (frame.t === "screen_control") {
      return { id: frame.id, device: { ...DEVICE, orientation: "landscape_left" } };
    }
    if (frame.t !== "mac_call") return { id: frame.id };
    const [env] = splitRaw<Envelope>(openSealed(SECRET, Buffer.from(String(frame.sealed), "base64"))!);
    steps.push(env);
    const done = reply(env, frame);
    if (done.step === "sim_start") {
      const screen = frame.screen as { hostKey: string; sessionId: string };
      hostKeys.set(screen.sessionId, screen.hostKey);
      await reportLive(screen.sessionId, "agent");
    }
    return { id: frame.id, sealed: sealAnswer(Buffer.from(env.answerKey, "base64"), { done: done as never }) };
  };
  return { steps, frames };
}

/** The person's screens and waits for the bot, as browser_sessions lists them now. */
const listed = async () =>
  ((await t.tools.call(t.hub, human(), "browser_sessions", { projectRef: { machineId: "devbox", projectId: "p1" } })) as {
    output: { sessions: { sessionId: string; threadId: string; control: string }[]; waits?: { waitId: string; stage?: string }[] };
  }).output;

/** The person's wait row for the open, as browser_sessions lists it now. */
const waitRow = async (waitId: string) => (await listed()).waits?.find((w) => w.waitId === waitId);

/** The person's iPhone, once the hub has followed its start to the end: their screen, its wait row gone. */
const yours = async (waitId: string, thread: string) => {
  for (let i = 0; i < 100; i++) {
    const now = await listed();
    const s = now.sessions.find((x) => x.threadId === thread && x.control === "human");
    if (s && !now.waits?.some((w) => w.waitId === waitId)) return get(t.hub, s.sessionId)!;
    await Bun.sleep(20);
  }
  throw new Error("the iPhone never became the person's");
};

const open = (input: Record<string, unknown>) =>
  t.tools.call(t.hub, human(), "screen_open", { projectRef: { machineId: "devbox", projectId: "p1" }, machineId: "mac1", kind: "ios", ...input }) as Promise<{
    output?: Record<string, any>;
    error?: Record<string, any>;
  }>;

test("a person starts an iPhone Duo: the Mac lends it ahead of agents, and it is theirs, controls and all", async () => {
  setup();
  const mac = fakeMac((env) => (env.step.step === "sim_start" ? { step: "sim_start", udid: "U1", device: "iPhone Duo on iOS 27.2" } : { step: "sim_end", ended: true }));
  const opened = await open({ sim: { model: DUO.id } });
  expect(opened.error).toBeUndefined();
  // Answered at once: its wait row, starting, followed in the hub's own time (a cold boot takes minutes).
  const waiting = opened.output!.waiting;
  expect(waiting).toMatchObject({ kind: "ios", stage: "starting" });
  expect(String(waiting.threadId)).toMatch(/^screen-/);
  const session = await yours(waiting.waitId, waiting.threadId);
  // The step the hub sealed: the Duo on its own runtime (the newest it runs, none picked), in the person's name, in line.
  expect(mac.steps[0]!.step).toEqual({ step: "sim_start", device: DUO.id, wait: true, person: "ada-laptop" });
  expect(mac.steps[0]!.thread).toBe(waiting.threadId);
  expect(session).toMatchObject({ kind: "ios", state: "live", controls: DEVICE.controls, fold: "closed", folds: DEVICE.folds, openedBy: { name: "ada-laptop" } });
  // Theirs from the start: the hub took control for them.
  expect(mac.frames.some((f) => f.t === "browser_control" && f.control === "human")).toBe(true);
  expect(session.control).toBe("human");

  const turned = (await t.tools.call(t.hub, human(), "screen_control", { sessionId: session.sessionId, control: "rotate_left" })) as { output: Record<string, any> };
  expect(mac.frames.at(-1)).toMatchObject({ t: "screen_control", sessionId: session.sessionId, control: "rotate_left", by: "human:ada-laptop" });
  expect(turned.output.session.orientation).toBe("landscape_left");

  // Its end is a sealed mac sim end in its own thread.
  const ended = await t.tools.call(t.hub, human(), "screen_end", { sessionId: session.sessionId });
  expect(ended).not.toHaveProperty("error");
  expect(mac.steps.at(-1)!.step).toEqual({ step: "sim_end" });
  expect(mac.steps.at(-1)!.thread).toBe(mac.steps[0]!.thread);
  await tick();
});

test("a full Mac: in line ahead of agents, wait or not, the row saying it waits", async () => {
  setup();
  const mac = fakeMac(() => ({ step: "sim_queued", place: 1, secs: null, why: "all 2 of the Mac's iOS simulators are in use by other agents" }));
  const waited = await open({});
  expect(waited.output!.waiting).toMatchObject({ kind: "ios", stage: "starting" });
  for (let i = 0; i < 50 && (await waitRow(waited.output!.waiting.waitId))?.stage !== "waiting"; i++) await tick();
  expect(await waitRow(waited.output!.waiting.waitId)).toMatchObject({ stage: "waiting" });
  expect(mac.steps[0]!.step).toEqual({ step: "sim_start", wait: true, person: "ada-laptop" });
  // Giving up the wait: the hub's next ask leaves the Mac's line instead.
  expect(await t.tools.call(t.hub, human(), "screen_end", { waitId: waited.output!.waiting.waitId })).not.toHaveProperty("error");
  t.link.answer = async (_m: string, frame: Record<string, unknown>) => {
    const [env] = splitRaw<Envelope>(openSealed(SECRET, Buffer.from(String(frame.sealed), "base64"))!);
    throw new Error(`refused without wait: ${env.step.step}`);
  };
  await tick();
});

test("a Mac still booting the next clone keeps the person first: the row stays starting, no error", async () => {
  setup();
  const mac = fakeMac(() => ({ step: "sim_queued", place: 1, secs: 20, why: "yours is booting" }));
  const opened = await open({});
  const id = opened.output!.waiting.waitId;
  for (let i = 0; i < 20 && mac.steps.length === 0; i++) await tick();
  await tick();
  expect(mac.steps[0]!.step).toMatchObject({ step: "sim_start", wait: true });
  expect(await waitRow(id)).toMatchObject({ stage: "starting" });
  expect((await waitRow(id)) as Record<string, unknown>).not.toHaveProperty("error");
  // Given up while it boots: the row goes, and the hub's next ask ends it on the Mac.
  expect(await t.tools.call(t.hub, human(), "screen_end", { waitId: id })).not.toHaveProperty("error");
  expect(await waitRow(id)).toBeUndefined();
});

test("screen_control is a person's, for a screen they control, with a control it has", async () => {
  setup();
  fakeMac(() => ({ step: "sim_start", udid: "U1", device: "iPhone Duo on iOS 27.2" }));
  const w = (await open({ sim: { model: "iPhone Duo" } })).output!.waiting;
  const session = await yours(w.waitId, w.threadId);
  const call = (who: ReturnType<typeof caller>, input: Record<string, unknown>) =>
    (t.tools.call(t.hub, who, "screen_control", { sessionId: session.sessionId, ...input }) as Promise<{ error?: { error: { code: string; message: string } } }>).then(
      (a) => ({ error: a.error?.error }),
    );
  expect((await call(caller("operate"), { control: "shake" })).error?.code).toBe("forbidden");
  // Handed back to nobody: whoever has control uses them, and no one does now.
  t.hub.db.conn.query("UPDATE browser_sessions SET data = json_set(data, '$.control', 'agent') WHERE session_id = ?").run(session.sessionId);
  expect((await call(human(), { control: "shake" })).error?.message).toContain("Take screen");
  t.hub.db.conn.query("UPDATE browser_sessions SET data = json_set(data, '$.control', 'human') WHERE session_id = ?").run(session.sessionId);
  expect((await call(human(), { control: "back" })).error?.message).toContain("has no back control");
  expect((await call(human(), { control: "shake" })).error).toBeUndefined();
  expect(get(t.hub, session.sessionId)?.controls).toEqual(DEVICE.controls);
  await tick();
});

test("a model or runtime the Mac doesn't list is refused before anything starts", () => {
  expect(() => modelOf([IPHONE as never], { model: "iPhone Duo" })).toThrow("no iPhone Duo simulator");
  expect(() => modelOf([DUO as never], { model: DUO.id, runtime: "iOS 26.0" })).toThrow("doesn't run iOS 26.0");
  expect(modelOf([DUO as never], { model: "iPhone Duo", runtime: "iOS 27.2" })).toEqual({ model: DUO, runtime: DUO.runtimes[0]!.id });
  expect(modelOf([DUO as never], undefined)).toEqual({});
});
