// Phone screens for people (W804, D652): a person's own iPhone simulator on the agents' Mac (`screen_open` kind ios),
// and the device controls of any phone screen they have control of (`screen_control`).
//
// A person's simulator is a `mac sim start` the hub makes itself: it seals the step to the Mac as an agent's node does
// (node/mac_tool/protocol.ts), in the name of a thread of the person's screen's own, with the screen's place (a sim
// place with the person on it) in the `mac_call`. The Mac lends it ahead of every agent waiting (D239), within its
// simulator budget, and reports its screen live; the hub then hands control to the person, as for any screen of
// theirs. It ends with `screen_end` or the hub's idle end, as a sealed `mac sim end`.
//
// It goes on in the hub's own time, as a PR's build does: `screen_open` answers at once with the person's wait row, and
// the hub follows the start (a model the Mac has no clone of is a create and a cold boot: minutes), always in the
// Mac's line, so a Mac that is full or still booting the next clone keeps the person first while the hub asks again
// every ASK_EVERY. The row says how far it is until the screen is theirs, or why it failed.
import type { BrowserSession, PersonRef, ProjectRef, ScreenControl, ScreenSim, SimModel } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { settingsPath } from "../../shared/settings_path.ts";
import { CAP_SCREEN_CONTROL, type MacResultFrame, type ScreenControlResult } from "../../shared/screens_wire.ts";
import { type Done, type Envelope, openAnswer, sealStep, type Step } from "../../node/mac_tool/protocol.ts";
import { ASK_EVERY } from "../../node/mac_tool/queue.ts";
import type { Hub } from "../api/hub.ts";
import { isHuman, requireRole } from "../api/grants.ts";
import type { Caller } from "../api/registry.ts";
import { asRead, changeControl } from "../browser/tools.ts";
import { get } from "../browser/store.ts";
import { link } from "../link/index.ts";
import { SEND_WAIT, sims } from "../mac_tool/index.ts";
import { store } from "../store/hub_store.ts";
import { request } from "./calls.ts";
import { isOwnMac, macMachine } from "./mac.ts";
import { endPlace, newKey, type Place, runnerOf, runners, simPlace } from "./places.ts";
import { WAIT_MS } from "./screen_rules.ts";

/**
 * How often a start that waits in the Mac's line asks again, and how often its place's start moves to now while it
 * waits (a sim place with no screen yet is pruned past START_MS, and a wait runs up to WAIT_MS); tests shorten them.
 */
export const asking = { everyMs: ASK_EVERY, keepMs: 30_000 };

/** How long a person's control waits for its machine: a fold or a screenshot takes seconds. */
export const CONTROL_WAIT = 45_000;

/**
 * How long a person's `sim_start` waits for the Mac: a model it has no warm clone of is created and cold-booted (pool.ts
 * OWN_BOOT, 150 s), then settled (a Duo's first fold builds its helpers).
 */
export const START_WAIT = 300_000;

/** The model a person picked from the Mac's `sims`, or why not; none picked: the Mac's plain iPhone. */
export function modelOf(models: SimModel[] | undefined, sim: ScreenSim | undefined): { model?: SimModel; runtime?: string } {
  if (!sim) return {};
  const model = models?.find((m) => m.id === sim.model || m.name === sim.model);
  if (!model) throw new ToolError("invalid", `The Mac has no ${sim.model} simulator.`, "Pick one of the models the Mac lists.");
  if (sim.runtime !== undefined && !model.runtimes.some((r) => r.id === sim.runtime || r.name === sim.runtime)) {
    throw new ToolError("invalid", `${model.name} doesn't run ${sim.runtime} on the Mac.`, `Pick one of: ${model.runtimes.map((r) => r.name).join(", ")}.`);
  }
  return { model, ...(sim.runtime === undefined ? {} : { runtime: model.runtimes.find((r) => r.id === sim.runtime || r.name === sim.runtime)!.id }) };
}

/** The sealed `mac sim` step for a person's screen, and its answer key. */
export function sealFor(macKey: Uint8Array, thread: string, step: Step, now: number): { sealed: string; answerKey: Uint8Array } {
  const answerKey = crypto.getRandomValues(new Uint8Array(32));
  const envelope: Envelope = {
    thread,
    atMs: now,
    nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex"),
    answerKey: Buffer.from(answerKey).toString("base64"),
    step,
  };
  return { sealed: sealStep(macKey, envelope), answerKey };
}

/** A person's simulator on its way: its place on the Mac, for project `origin`, and its `sim_start`. */
type SimStart = { mac: string; place: Place; origin: ProjectRef; person: PersonRef; step?: Step };

/** Sends one sealed step for a person's simulator to the Mac and opens its answer, waiting up to `waitMs`. */
async function macStep(hub: Hub, s: SimStart, step: Step, waitMs = SEND_WAIT): Promise<Done> {
  const key = Buffer.from(store(hub).machineGet(s.mac)?.boxPubKey ?? "", "base64");
  if (key.length !== 32) throw new ToolError("failed", "The agents' Mac has no key to seal to.", "An admin updates fleetd on the Mac.");
  const { sealed, answerKey } = sealFor(key, s.place.originThread, step, hub.clock.now());
  let answer: MacResultFrame;
  try {
    answer = await request<MacResultFrame>(
      hub,
      s.mac,
      {
        t: "mac_call",
        id: `mac-${newKey().slice(1, 13)}`,
        caller: { machineId: s.origin.machineId, projectId: s.origin.projectId, threadId: s.place.originThread },
        sealed,
        screen: { hostKey: s.place.key, sessionId: s.place.sessionId! },
        ...sims(hub, s.mac),
      },
      waitMs,
    );
  } catch (e) {
    throw new ToolError("machine_offline", `The Mac did not answer: ${(e as Error).message}.`, "Try again shortly.");
  }
  if (answer.error) throw new ToolError(answer.error.code, answer.error.message, answer.error.fix);
  const opened = answer.sealed === undefined ? undefined : openAnswer(answerKey, answer.sealed);
  if (!opened) throw new ToolError("failed", "The agents' Mac's answer didn't open.");
  const [a] = opened;
  if (a.error) throw new ToolError(a.error.code, a.error.message, a.error.fix);
  if (!a.done) throw new ToolError("failed", "The agents' Mac sent an empty answer.");
  return a.done;
}

/** Where a person's iPhone start stands: theirs now, or waiting in the Mac's line at `place`. */
export type SimOpened = { session: BrowserSession } | { queued: { place: number; why: string } };

/**
 * A person's iPhone on the agents' Mac `machineId` (or a Mac that runs agents) for project `r`, checked and given its
 * place: what `followSim` then starts. A Mac that can't (neither, too old, not ready) or a model it doesn't list is
 * refused here, before anything starts.
 */
export function prepareSim(hub: Hub, caller: Caller, r: ProjectRef, person: PersonRef, machineId: string, sim: ScreenSim | undefined): SimStart {
  const mac = isOwnMac(hub, machineId) ? machineId : macMachine(hub);
  if (!mac || mac !== machineId) {
    throw new ToolError(
      "invalid",
      mac ? `iPhone screens run on the agents' Mac (${mac}), not ${machineId}.` : "No agents' Mac is online to run an iPhone screen.",
      mac ? "Pick the agents' Mac." : `An admin connects one in ${settingsPath("Machines")}.`,
    );
  }
  requireRole(caller, "read", mac);
  if (!link(hub).can(mac, CAP_SCREEN_CONTROL)) {
    throw new ToolError("failed", "The Mac runs an older fleetd: it starts no iPhone for a person yet.", "An admin updates fleetd on the Mac.");
  }
  const runner = runners(hub).find((m) => m.runner.machineId === mac)?.runner;
  const ios = runner?.hosts?.find((h) => h.host === "ios");
  if (!runner?.online || !ios?.ready) {
    throw new ToolError("failed", `The Mac can't start an iPhone now: ${ios?.detail ?? "it hasn't said why"}.`, "Try again shortly.");
  }
  const { model, runtime } = modelOf(ios.sims?.models, sim);
  const thread = `screen-${newKey().slice(1)}`;
  const place = hub.db.transaction((c) => {
    const p = simPlace(c, mac, r, thread, undefined, hub.clock.now());
    c.query("UPDATE session_places SET person_id = ?2 WHERE place_id = ?1").run(p.key, person.personId);
    return p;
  });
  // Always in the Mac's line: a person's start waits for a free simulator, or the next clone's boot, ahead of agents.
  const step: Step = {
    step: "sim_start",
    ...(model ? { device: model.id } : {}),
    ...(runtime ? { runtime } : {}),
    wait: true,
    person: person.name,
  };
  return { mac, place, origin: r, person, step };
}

/** The start's step, sent (again): theirs once the Mac lends it, else its place in line. */
async function simAgain(hub: Hub, start: SimStart, device: string): Promise<SimOpened> {
  const done = await macStep(hub, start, start.step!, START_WAIT);
  if (done.step === "sim_queued") return { queued: { place: done.place, why: done.why } };
  if (done.step !== "sim_start") throw new ToolError("failed", "The agents' Mac answered with another step's answer.");
  const id = start.place.sessionId!;
  const session = await reported(hub, id);
  if (!session) throw new ToolError("failed", "The iPhone started, but its screen wasn't reported.", "Look for it in Screens, or try again.");
  try {
    await changeControl(hub, session, start.mac, "human", "human", `human:${device}`);
  } catch (e) {
    console.warn(`a person's iPhone ${id} started without their control:`, (e as ToolError).message);
  }
  return { session: get(hub, id) ?? session };
}

/** Screen `id`, once the Mac's report of it live is in (a moment after its answer at most). */
async function reported(hub: Hub, id: string): Promise<BrowserSession | undefined> {
  for (let i = 0; i < 50; i++) {
    const s = get(hub, id);
    if (s) return s;
    await Bun.sleep(100);
  }
  return get(hub, id);
}

/**
 * A person's start, in the hub's own time: sent now, then, while the Mac keeps it in line (full, or booting the next
 * clone), asked again every ASK_EVERY (keeping its place) until it is theirs, `gone` says the person gave up, or
 * WAIT_MS passed. `queued` hears each place in line; theirs or failed, `done` hears.
 */
export async function followSim(
  hub: Hub,
  start: SimStart,
  device: string,
  gone: () => boolean,
  queued: (q: { place: number; why: string }) => void,
  done: (outcome: { session: BrowserSession } | { error: string }) => void,
): Promise<void> {
  const until = hub.clock.now() + WAIT_MS;
  // Its place is kept from the prune until the Mac reports its screen: the Mac reports it under the place's key.
  const keep = setInterval(() => {
    if (hub.shutdown.signal.aborted) return;
    hub.db.conn
      .query(
        `UPDATE session_places SET started_ms = ?2 WHERE place_id = ?1 AND ended_ms IS NULL
           AND NOT EXISTS (SELECT 1 FROM browser_sessions b WHERE b.session_id = session_places.session_id)`,
      )
      .run(start.place.key, hub.clock.now());
  }, asking.keepMs);
  try {
    for (let first = true; ; first = false) {
      if (!first) await Bun.sleep(asking.everyMs);
      // The hub stopping: the Mac's line forgets the person by itself (queue.ts GONE).
      if (hub.shutdown.signal.aborted) return;
      if (gone()) {
        await macStep(hub, start, { step: "sim_end" }).catch(() => {});
        hub.db.transaction((c) => endPlace(c, start.place.key, hub.clock.now()));
        return;
      }
      if (hub.clock.now() > until) throw new ToolError("failed", "No simulator on the agents' Mac freed up in 30 minutes.");
      const opened = await simAgain(hub, start, device);
      if ("session" in opened) return done(opened);
      queued(opened.queued);
    }
  } catch (e) {
    if (hub.shutdown.signal.aborted) return;
    // A simulator the Mac lent meanwhile (its screen not reported, a step that failed after it) goes back.
    await macStep(hub, start, { step: "sim_end" }).catch(() => {});
    hub.db.transaction((c) => endPlace(c, start.place.key, hub.clock.now()));
    done({ error: (e as Error).message });
  } finally {
    clearInterval(keep);
  }
}

/** Ends a person's iPhone: a sealed `mac sim end` in its thread's name; whether the Mac had it. */
export async function endSim(hub: Hub, mac: string, place: Place): Promise<boolean> {
  const done = await macStep(hub, { mac, place, origin: place.origin, person: { personId: "", name: "" } }, { step: "sim_end" });
  return done.step === "sim_end";
}

/** Whether the place is a simulator's (a `mac sim start`'s screen). */
export const isSimPlace = (hub: Hub, key: string) =>
  hub.db.all<{ sim: number | null }>("SELECT sim FROM session_places WHERE place_id = ?1", [key])[0]?.sim === 1;

/** `screen_control`: a person's device control on a phone screen they have control of. */
export async function screenControl(hub: Hub, caller: Caller, input: { sessionId: string; control: ScreenControl; value?: string }) {
  if (!isHuman(caller)) {
    throw new ToolError("forbidden", "Only a person's device uses a screen's controls; an agent runs `mac sim <control>`.", "Use the fleetd app.");
  }
  const id = input.sessionId;
  const session = get(hub, id);
  const notFound = () => new ToolError("not_found", `No screen ${id}.`, "Call browser_sessions for the bot's screens.");
  if (!session) throw notFound();
  try {
    requireRole(caller, "operate", session.projectRef.machineId);
  } catch {
    throw notFound();
  }
  if (session.state !== "live") throw new ToolError("invalid", `Screen ${id} has ended.`);
  if (!session.controls?.includes(input.control)) {
    throw new ToolError("invalid", `Screen ${id} has no ${input.control} control.`, session.controls?.length ? `Its controls: ${session.controls.join(", ")}.` : undefined);
  }
  if (session.control !== "human") throw new ToolError("invalid", `Take screen ${id} over first: its controls are for whoever has control.`);
  const runner = hub.db.transaction((c) => runnerOf(c, id)) ?? session.machineId ?? session.projectRef.machineId;
  if (!link(hub).can(runner, CAP_SCREEN_CONTROL)) {
    throw new ToolError("failed", `${runner} runs an older fleetd: its screens take no controls yet.`, "An admin updates fleetd there.");
  }
  let answer: ScreenControlResult;
  try {
    answer = await request<ScreenControlResult>(
      hub,
      runner,
      {
        t: "screen_control",
        id: `ctl-${newKey().slice(1, 13)}`,
        sessionId: id,
        control: input.control,
        ...(input.value === undefined ? {} : { value: input.value }),
        by: `human:${caller.name}`,
      },
      CONTROL_WAIT,
    );
  } catch (e) {
    throw new ToolError("machine_offline", `${runner} did not answer: ${(e as Error).message}.`, "Try again shortly.");
  }
  if (answer.error) throw new ToolError(answer.error.code, answer.error.message, answer.error.fix);
  // The node's report of the device may land a moment after its answer: the answer's own is the newest.
  const after = get(hub, id);
  return {
    // As browser_sessions reads it (its `rtc` too): the app writes it over its list, and keeps its peer with it.
    ...(after ? { session: { ...asRead(hub, after), ...(answer.device ?? {}) } } : {}),
    ...(answer.screenshot
      ? { screenshot: { mime: "image/png", dataB64: answer.screenshot.pngB64, width: answer.screenshot.width, height: answer.screenshot.height } }
      : {}),
  };
}
