// A person's input on an iOS simulator as the simulator's own HID events, sent straight into it by fleetd-frames
// (../../screen/frames.swift: dtuhidd, as Simulator.app's input goes) while its stream runs: a finger goes down, moves
// and lifts as the person's does, so a tap shows within a frame or two of the click, a drag follows the pointer, and
// typing is a hardware keyboard's. agent-device takes what this can't carry (Back, text with no key on a US keyboard)
// and everything while the stream doesn't take input (screen.ts `Hands`).
import type { Input } from "../scrcpy.ts";
import type { Command } from "../../screen/live.ts";

/** Where input goes: a stream that takes it (`tell`), and the screen's size in pixels (input coordinates are in it). */
export type Direct = { tell(command: Command): void; screen: [number, number] };

/** A touch that starts this close to an edge, as a share of the screen, is an edge gesture's (home, Notification
 * Centre, Control Centre, back): iOS tells those by a flag, not by where the finger is. */
const EDGE = 0.02;
/** A wheel's finger lifts once the wheel is still this long. */
export const WHEEL_LIFT = 150;

/** USB HID keyboard usages (page 7). */
const SHIFT = 0xe1;
const MODIFIERS: [bit: number, usage: number][] = [
  [8, SHIFT],
  [2, 0xe0], // Control
  [1, 0xe2], // Option
  [4, 0xe3], // Command
];
const KEYS: Record<string, number> = {
  Enter: 0x28,
  Escape: 0x29,
  Backspace: 0x2a,
  Tab: 0x2b,
  Delete: 0x4c,
  ArrowRight: 0x4f,
  ArrowLeft: 0x50,
  ArrowDown: 0x51,
  ArrowUp: 0x52,
};

/** A character's key on a US keyboard, and whether it takes Shift. */
export function keyOf(char: string): [usage: number, shift: boolean] | undefined {
  const c = char.charCodeAt(0);
  if (char.length !== 1) return undefined;
  if (c >= 0x61 && c <= 0x7a) return [0x04 + c - 0x61, false];
  if (c >= 0x41 && c <= 0x5a) return [0x04 + c - 0x41, true];
  if (c >= 0x31 && c <= 0x39) return [0x1e + c - 0x31, false];
  const plain = "0\n\t -=[]\\;'`,./";
  const plainUsage = [0x27, 0x28, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f, 0x30, 0x31, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38];
  const shifted = "!@#$%^&*()_+{}|:\"~<>?";
  const shiftedUsage = [0x1e, 0x1f, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x2d, 0x2e, 0x2f, 0x30, 0x31, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38];
  const at = plain.indexOf(char);
  if (at >= 0) return [plainUsage[at]!, false];
  const up = shifted.indexOf(char);
  if (up >= 0) return [shiftedUsage[up]!, true];
  return undefined;
}

/** The edge a touch at `x`,`y` starts at, on a screen of `size`: the nearest within EDGE (1 top, 2 left, 3 bottom,
 * 4 right), else 0. */
export function edgeOf(x: number, y: number, [width, height]: [number, number]): number {
  if (width <= 0 || height <= 0) return 0;
  const near: [number, number][] = [
    [y / height, 1],
    [x / width, 2],
    [1 - y / height, 3],
    [1 - x / width, 4],
  ];
  const [share, edge] = near.reduce((a, b) => (b[0] < a[0] ? b : a));
  return share <= EDGE ? edge : 0;
}

/** One screen's person's inputs as HID commands: a finger, the wheel as a finger of its own, keys. */
export class Touches {
  /** The wheel's finger while it is down, where it is now, and the lift that waits. */
  private wheel: { x: number; y: number; to: Direct; lift: ReturnType<typeof setTimeout> } | undefined;

  constructor(private readonly lift = WHEEL_LIFT) {}

  /** Sends one input; false when it can't go this way (agent-device takes it). */
  feed(input: Input, to: Direct): boolean {
    const r = (v: number) => Math.round(v);
    switch (input.kind) {
      case "touch": {
        this.liftWheel();
        const edge = input.action === "down" ? edgeOf(input.x, input.y, to.screen) : 0;
        to.tell(`touch ${input.action} ${r(input.x)} ${r(input.y)} ${edge}`);
        return true;
      }
      case "scroll": {
        // The wheel drags the content as a finger does: down at the pointer, moved against the wheel, lifted once the
        // wheel stops. A finger that would leave the screen lifts there, and the next turn starts at the pointer again.
        const [width, height] = to.screen;
        let w = this.wheel;
        if (!w) {
          to.tell(`touch down ${r(input.x)} ${r(input.y)} 0`);
          w = this.wheel = { x: input.x, y: input.y, to, lift: setTimeout(() => {}, 0) };
        }
        clearTimeout(w.lift);
        const x = w.x - input.dx;
        const y = w.y - input.dy;
        if (x < 0 || y < 0 || x >= width || y >= height) {
          this.liftWheel();
          return true;
        }
        w.x = x;
        w.y = y;
        to.tell(`touch move ${r(x)} ${r(y)} 0`);
        w.lift = setTimeout(() => this.liftWheel(), this.lift);
        return true;
      }
      case "key": {
        if (input.key === "BrowserHome") {
          if (input.down) to.tell("button home");
          return true;
        }
        const usage = KEYS[input.key] ?? keyOf(input.key)?.[0];
        if (usage === undefined) return false;
        const held = MODIFIERS.filter(([bit]) => input.modifiers & bit).map(([, u]) => u);
        const state = input.down ? "down" : "up";
        const order = input.down ? [...held, usage] : [usage, ...held.reverse()];
        for (const u of order) to.tell(`keyboard ${u} ${state}`);
        return true;
      }
      case "text": {
        const keys = [...input.text].map(keyOf);
        if (keys.some((k) => k === undefined)) return false;
        this.liftWheel();
        for (const [usage, shift] of keys as [number, boolean][]) {
          if (shift) to.tell(`keyboard ${SHIFT} down`);
          to.tell(`keyboard ${usage} down`);
          to.tell(`keyboard ${usage} up`);
          if (shift) to.tell(`keyboard ${SHIFT} up`);
        }
        return true;
      }
    }
  }

  /** The wheel's finger lifts, if it is down. */
  liftWheel(): void {
    const w = this.wheel;
    if (!w) return;
    clearTimeout(w.lift);
    this.wheel = undefined;
    w.to.tell(`touch up ${Math.round(w.x)} ${Math.round(w.y)} 0`);
  }
}
