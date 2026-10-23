// One count of agents per project, so every place a shot shows it agrees: the chat header ("agents 4 / 6") and the
// Max agents popover read the slot state; the strip and the sidebar read the orders' lanes merged with the live
// feed; Status reads its rows. `pnpm fixtures` runs this on every fixture last, after the groups have added theirs.
//
// The lanes are the truth: the slot state and the Status rows are derived from them. A fixture whose point is a
// slot state (Settings' Max agents) sets `agentsFromSlots`, and gets lanes made to match its slots instead.
import { agentsAt } from "./chat.ts";
import type { Fixture } from "./fixture.ts";
import { asText, isObject, type JsonObject, type JsonValue } from "./json.ts";
import { arr, obj } from "./stress.ts";

type Ref = { machineId: string; projectId: string };
const keyOf = (ref: JsonValue | undefined) => `${asText(obj(ref)["machineId"])}/${asText(obj(ref)["projectId"])}`;
const ACTIVE = new Set(["working", "starting"]);

/** Each lane's status as the app ends up holding it: the card's, then every live frame's in order (a full one resets). */
const laneStatuses = (f: Fixture): Map<string, string> => {
  const live = new Map<string, string>();
  for (const frame of f.live) {
    if (frame["full"] === true) live.clear();
    for (const lane of arr(frame["lanes"]).filter(isObject)) live.set(asText(lane["laneId"]), asText(lane["status"]));
  }
  return live;
};

/** Running and queued agents per project key (the lead not counted), from the board's cards and the live feed. */
export const agentsByProject = (f: Fixture): Map<string, { running: number; queued: number }> => {
  const live = laneStatuses(f);
  const board = f.output("orders_board", {}) ?? f.answers("orders_board")[0]?.output;
  const out = new Map<string, { running: number; queued: number }>();
  const seen = new Set<string>();
  for (const card of arr(obj(board)["orders"]).filter(isObject)) {
    const key = keyOf(card["projectRef"]);
    const counts = out.get(key) ?? { running: 0, queued: 0 };
    for (const lane of arr(card["lanes"]).filter(isObject)) {
      const id = asText(lane["laneId"]);
      if (lane["role"] === "lead" || seen.has(id)) continue;
      seen.add(id);
      const status = live.get(id) ?? asText(lane["status"]);
      if (ACTIVE.has(status)) counts.running++;
      else if (status === "queued") counts.queued++;
    }
    out.set(key, counts);
  }
  return out;
};

/** A max that reads as someone's setting: 6, 12, then steps of 6, never under what runs. */
const plausibleMax = (running: number) => (running <= 6 ? 6 : running <= 12 ? 12 : Math.ceil(running / 6) * 6);

export const syncAgents = (f: Fixture): void => {
  if (f.snapshot === undefined) return;
  const projects = arr(f.snapshot["projects"]).filter(isObject);
  const refOf = (p: JsonObject): Ref => ({ machineId: asText(p["machineId"]), projectId: asText(p["projectId"]) });
  const set = obj(f.snapshot["slots"]);
  if (f.agentsFromSlots) {
    // Lanes made to the slot state: each project runs what its row says.
    const rows = arr(set["perProject"]).filter(isObject);
    agentsAt(
      f,
      rows.flatMap((r) => (typeof r["running"] === "number" && r["running"] > 0 ? [{ ref: refOf(obj(r["projectRef"])), n: r["running"] }] : [])),
      true,
    );
  }
  const agents = agentsByProject(f);
  const counts = (ref: Ref) => agents.get(`${ref.machineId}/${ref.projectId}`) ?? { running: 0, queued: 0 };
  const before = new Map(arr(set["perProject"]).filter(isObject).map((r) => [keyOf(r["projectRef"]), r]));
  const perProject = projects.slice(0, 50).map((p): JsonObject => {
    const ref = refOf(p);
    const { running, queued } = counts(ref);
    const row = before.get(keyOf(ref));
    // A recording's max (the lab runs 40) reads as no setting at all: only a fixture about the slot state keeps its own.
    const kept = f.agentsFromSlots && typeof row?.["maxAgents"] === "number" && row["maxAgents"] >= running ? row["maxAgents"] : plausibleMax(running);
    const waiting = f.agentsFromSlots && typeof row?.["queued"] === "number" ? row["queued"] : queued;
    return { projectRef: ref, maxAgents: kept, running, queued: waiting };
  });
  const used = perProject.reduce((n, r) => n + (r["running"] as number), 0);
  const queued = perProject.reduce((n, r) => n + (r["queued"] as number), 0);
  const largest = Math.max(0, ...perProject.map((r) => r["maxAgents"] as number));
  const cap = f.agentsFromSlots && typeof set["cap"] === "number" ? set["cap"] : Math.max(12, largest, Math.ceil(used / 6) * 6);
  const slots: JsonObject = { cap, used, queued, perProject };
  f.snapshot["slots"] = slots;
  for (const frame of f.live) if (frame["slots"] !== undefined || frame["full"] === true) frame["slots"] = structuredClone(slots);

  // Status: the same counts, and a state word that never says working with nothing at work.
  const chats = new Map(arr(f.snapshot["chats"]).filter(isObject).map((c) => [keyOf(c["projectRef"]), c]));
  f.update("status_projects", (out) => ({
    ...obj(out),
    rows: arr(obj(out)["rows"])
      .filter(isObject)
      .map((row) => {
        const ref = refOf(obj(row["projectRef"]));
        const { running } = counts(ref);
        const leadWorking = chats.get(keyOf(row["projectRef"]))?.["leadWorking"] === true;
        const state = row["state"] === "working" && running === 0 && !leadWorking ? "idle" : running > 0 && row["state"] === "idle" ? "working" : row["state"];
        return { ...row, agentsRunning: running, state: state ?? "idle" };
      }),
  }));
};
