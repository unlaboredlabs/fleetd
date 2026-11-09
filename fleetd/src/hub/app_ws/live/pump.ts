// The diff state of one live subscription: what the app was last sent,
// and the next frame, cut to the frame's limits. Pure, so the coalescing is testable.
import {
  LIVE_MAX_LANES,
  LIVE_MAX_MACHINES,
  LIVE_MAX_TEXTS,
  type LiveFrame,
  type LiveLane,
  type LiveText,
  type MachineLive,
  type SlotState,
} from "../../../shared/contracts.ts";
import { isoMs } from "../../auth/index.ts";
import type { StreamText } from "../../executor/activity.ts";

/** The hub keeps an encoded frame under this; lanes that don't fit go in the next tick. */
export const LIVE_MAX_FRAME_BYTES = 16 * 1024;

/** One lane in scope at this tick, with its streamed text when it is focused. */
export type LaneNow = { lane: LiveLane; text?: StreamText };

/** What a tick read. Absent parts were not read this tick and stay as last sent. */
export type TickInput = {
  nowMs: number;
  /** Every lane in scope (`boardComplete`), or only the focused ones. */
  lanes: LaneNow[];
  boardComplete: boolean;
  machines?: MachineLive[];
  slots?: SlotState;
};

/** The last `max` UTF-16 units of `s`, never splitting a character. */
export function tailUnits(s: string, max: number): string {
  if (s.length <= max) return s;
  const chars = [...s];
  let units = 0;
  let start = chars.length;
  for (let i = chars.length - 1; i >= 0; i--) {
    units += (chars[i] as string).length;
    if (units > max) break;
    start = i;
  }
  return chars.slice(start).join("");
}

const sizeOf = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export class Pump {
  private started = false;
  private readonly lanes = new Map<string, LiveLane>();
  private readonly text = new Map<string, [messageId: string, sent: number]>();
  private machines: MachineLive[] | undefined;
  private slots: SlotState | undefined;

  /** The next frame, or undefined when nothing changed. The first frame after a subscribe is `full`. */
  frame(input: TickInput): LiveFrame | undefined {
    const full = !this.started;
    this.started = true;
    const inScope = new Set(input.lanes.map((l) => l.lane.laneId));
    if (full || input.boardComplete) {
      for (const id of this.lanes.keys()) if (!inScope.has(id)) this.lanes.delete(id);
      for (const id of this.text.keys()) if (!inScope.has(id)) this.text.delete(id);
    }
    const changed: LiveLane[] = [];
    for (const now of input.lanes) {
      const lane: LiveLane = { ...now.lane };
      if (full) {
        changed.push(lane);
        continue;
      }
      const before = this.lanes.get(lane.laneId);
      // The sparkline only when its samples moved: an idle lane's flat line is sent once.
      if (same(before?.spark?.samples, lane.spark?.samples)) delete lane.spark;
      const moved =
        !before || before.status !== lane.status || !same(before.activity, lane.activity) || !same(before.tokens, lane.tokens);
      if (moved || lane.spark) changed.push(lane);
    }
    // Most recently changed first, so a frame cut at its limits carries the freshest lanes.
    const since = (l: LiveLane) => l.activity?.since;
    changed.sort((a, b) => {
      const x = since(b);
      const y = since(a);
      return x === y ? 0 : x === undefined ? -1 : y === undefined ? 1 : x < y ? -1 : 1;
    });
    const frame: LiveFrame = { at: isoMs(input.nowMs), full, lanes: [], text: [] };
    if (input.machines && (full || !same(this.machines, input.machines))) {
      const machines = input.machines.slice(0, LIVE_MAX_MACHINES);
      this.machines = machines;
      frame.machines = machines;
    }
    if (input.slots && (full || !same(this.slots, input.slots))) {
      this.slots = input.slots;
      frame.slots = input.slots;
    }
    let budget = Math.max(0, LIVE_MAX_FRAME_BYTES - (sizeOf(frame) + 64));
    const lanes: LiveLane[] = [];
    for (const lane of changed) {
      if (lanes.length === LIVE_MAX_LANES) break;
      const cost = sizeOf(lane) + 1;
      if (cost > budget) continue;
      budget -= cost;
      // What is in the frame is what the app has; a lane cut from the frame stays changed for the next tick.
      const stored = { ...lane };
      const prev = this.lanes.get(lane.laneId);
      if (!stored.spark && prev?.spark) stored.spark = prev.spark;
      this.lanes.set(lane.laneId, stored);
      lanes.push(lane);
    }
    const texts: LiveText[] = [];
    for (const now of input.lanes) {
      const text = now.text;
      if (!text) continue;
      if (texts.length === LIVE_MAX_TEXTS) break;
      const id = now.lane.laneId;
      const kept = this.text.get(id);
      const sent = kept && kept[0] === text.messageId ? kept[1] : 0;
      if (text.total <= sent || text.messageId === "") continue;
      const item: LiveText = { laneId: id, messageId: text.messageId, append: tailUnits(text.since(sent), 2000) };
      const cost = sizeOf(item) + 1;
      if (cost > budget) break;
      budget -= cost;
      this.text.set(id, [text.messageId, text.total]);
      texts.push(item);
    }
    frame.lanes = lanes;
    frame.text = texts;
    const empty = lanes.length === 0 && texts.length === 0 && !frame.machines && !frame.slots;
    return full || !empty ? frame : undefined;
  }
}
