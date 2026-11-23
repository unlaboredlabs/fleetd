// A person's input on an iOS simulator sent straight into it (node/device/ios/hid.ts, and screen.ts's Hands and
// Shooter choosing that way): the commands fleetd-frames is told, and agent-device taking only what can't go straight.
// No simulator here: fleetd-frames and agent-device are stand-ins. bench/screens/ios-input.ts measures the real one.
import { expect, test } from "bun:test";
import { edgeOf, keyOf, Touches } from "../src/node/device/ios/hid.ts";
import { Hands, type Ran, type Runner, Shooter } from "../src/node/device/ios/screen.ts";
import type { Input } from "../src/node/device/scrcpy.ts";
import type { Command, StreamFrame } from "../src/node/screen/live.ts";

const touch = (action: "down" | "up" | "move", x: number, y: number): Input => ({ kind: "touch", action, x, y });
const key = (k: string, down: boolean, modifiers = 0): Input => ({ kind: "key", down, key: k, modifiers });
const screen: [number, number] = [1206, 2622];
const runner: Runner = { wrapper: "agent-device", env: {}, udid: "U1" };

/** A stream that takes input: what it was told. */
const told = () => {
  const said: Command[] = [];
  return { said, to: { tell: (c: Command) => said.push(c), screen } };
};

test("keys are a US keyboard's, Shift where it takes one", () => {
  expect(keyOf("a")).toEqual([0x04, false]);
  expect(keyOf("Z")).toEqual([0x1d, true]);
  expect(keyOf("1")).toEqual([0x1e, false]);
  expect(keyOf("0")).toEqual([0x27, false]);
  expect(keyOf("!")).toEqual([0x1e, true]);
  expect(keyOf(")")).toEqual([0x27, true]);
  expect(keyOf(" ")).toEqual([0x2c, false]);
  expect(keyOf("\n")).toEqual([0x28, false]);
  expect(keyOf("?")).toEqual([0x38, true]);
  expect(keyOf("é")).toBeUndefined();
  expect(keyOf("ab")).toBeUndefined();
});

test("a touch that starts at an edge says which: the system's gestures need it", () => {
  expect(edgeOf(600, 1300, screen)).toBe(0);
  expect(edgeOf(600, 2618, screen)).toBe(3);
  expect(edgeOf(600, 3, screen)).toBe(1);
  expect(edgeOf(2, 1300, screen)).toBe(2);
  expect(edgeOf(1204, 1300, screen)).toBe(4);
  // A corner: the nearer edge.
  expect(edgeOf(20, 2621, screen)).toBe(3);
  expect(edgeOf(600, 1300, [0, 0])).toBe(0);
});

test("a finger goes down, moves and lifts as the person's does, an edge's only on its down", () => {
  const { said, to } = told();
  const t = new Touches();
  for (const input of [touch("down", 603.4, 2619), touch("move", 603, 2000.6), touch("up", 603, 1400), touch("down", 300, 900), touch("up", 300, 900)]) expect(t.feed(input, to)).toBe(true);
  expect(said).toEqual(["touch down 603 2619 3", "touch move 603 2001 0", "touch up 603 1400 0", "touch down 300 900 0", "touch up 300 900 0"]);
});

test("the wheel is a finger of its own: down at the pointer, moved against the wheel, lifted once it stops", async () => {
  const { said, to } = told();
  const t = new Touches(20);
  t.feed({ kind: "scroll", x: 600, y: 1500, dx: 0, dy: 100 }, to);
  t.feed({ kind: "scroll", x: 600, y: 1500, dx: 10, dy: 100 }, to);
  expect(said).toEqual(["touch down 600 1500 0", "touch move 600 1400 0", "touch move 590 1300 0"]);
  await Bun.sleep(60);
  expect(said.at(-1)).toBe("touch up 590 1300 0");
  // One that would leave the screen lifts at its last place; the next turn starts at the pointer again.
  said.length = 0;
  t.feed({ kind: "scroll", x: 600, y: 100, dx: 0, dy: 80 }, to);
  t.feed({ kind: "scroll", x: 600, y: 100, dx: 0, dy: 80 }, to);
  t.feed({ kind: "scroll", x: 600, y: 100, dx: 0, dy: 80 }, to);
  expect(said).toEqual(["touch down 600 100 0", "touch move 600 20 0", "touch up 600 20 0", "touch down 600 100 0", "touch move 600 20 0"]);
  // A real touch meanwhile lifts the wheel's finger first.
  said.length = 0;
  t.feed(touch("down", 10, 10), to);
  expect(said).toEqual(["touch up 600 20 0", "touch down 10 10 1"]);
});

test("typing is key presses, Shift held for a capital; Enter, Backspace and Home are their own; Command+A holds Command", () => {
  const { said, to } = told();
  const t = new Touches();
  expect(t.feed({ kind: "text", text: "Hi!" }, to)).toBe(true);
  expect(said.splice(0)).toEqual([
    "keyboard 225 down",
    "keyboard 11 down",
    "keyboard 11 up",
    "keyboard 225 up",
    "keyboard 12 down",
    "keyboard 12 up",
    "keyboard 225 down",
    "keyboard 30 down",
    "keyboard 30 up",
    "keyboard 225 up",
  ]);
  t.feed(key("Enter", true), to);
  t.feed(key("Enter", false), to);
  t.feed(key("Backspace", true), to);
  t.feed(key("BrowserHome", true), to);
  t.feed(key("BrowserHome", false), to);
  t.feed(key("a", true, 4), to);
  t.feed(key("a", false, 4), to);
  expect(said.splice(0)).toEqual(["keyboard 40 down", "keyboard 40 up", "keyboard 42 down", "button home", "keyboard 227 down", "keyboard 4 down", "keyboard 4 up", "keyboard 227 up"]);
  // What has no key here goes to agent-device: Back, and text a US keyboard can't type.
  expect(t.feed(key("BrowserBack", true), to)).toBe(false);
  expect(t.feed({ kind: "text", text: "café" }, to)).toBe(false);
  expect(said).toEqual([]);
});

/** agent-device as Hands runs it: each command logged, answered when `answer` says. */
function agentDevice() {
  const ran: string[] = [];
  let release: () => void = () => {};
  let held = false;
  const run = async (_r: Runner, args: string[]): Promise<Ran> => {
    ran.push(args.join(" "));
    if (held) await new Promise<void>((r) => (release = r));
    return { ok: true, said: "", ms: 700 };
  };
  return { ran, run, hold: () => (held = true), answer: () => ((held = false), release()) };
}

test("while the stream takes input it all goes straight, logged as agent-device would have run it; Back still goes through agent-device", async () => {
  const { said, to } = told();
  const ad = agentDevice();
  const logged: string[] = [];
  const hands = new Hands(runner, 3, (args, _r, direct) => logged.push(`${direct ? "straight" : "agent-device"} ${args.join(" ")}`), ad.run, () => to);
  hands.send(touch("down", 300, 600));
  hands.send(touch("move", 300, 900));
  hands.send(touch("up", 300, 1200));
  hands.send({ kind: "text", text: "a" });
  hands.send({ kind: "scroll", x: 600, y: 1500, dx: 0, dy: 30 });
  // Straight ones go as they come, not after a turn of the event loop.
  expect(said).toEqual(["touch down 300 600 0", "touch move 300 900 0", "touch up 300 1200 0", "keyboard 4 down", "keyboard 4 up", "touch down 600 1500 0", "touch move 600 1470 0"]);
  hands.send(key("BrowserBack", true));
  await hands.idle();
  expect(ad.ran).toEqual(["back"]);
  expect(logged).toEqual(["straight swipe 100 200 100 400", "straight type -- a", "agent-device back"]);
  // Handed back: the wheel's finger lifts.
  hands.release();
  await hands.idle();
  expect(said.at(-1)).toBe("touch up 600 1470 0");
  hands.stop();
});

test("an input made while the stream's helper hasn't said whether it takes input waits for it, not for agent-device", async () => {
  const { said, to } = told();
  const ad = agentDevice();
  let direct: typeof to | undefined;
  let pending = true;
  const hands = new Hands(runner, 3, () => {}, ad.run, () => direct, () => pending);
  hands.send(touch("down", 300, 600));
  hands.send(touch("up", 300, 600));
  await Bun.sleep(60);
  expect(ad.ran).toEqual([]);
  // The helper says `input`: the tap goes straight, and agent-device never ran.
  direct = to;
  pending = false;
  await hands.idle();
  expect(said).toEqual(["touch down 300 600 0", "touch up 300 600 0"]);
  expect(ad.ran).toEqual([]);
  // It says `noinput`: the next tap goes through agent-device at once.
  direct = undefined;
  hands.send(touch("down", 300, 600));
  hands.send(touch("up", 300, 600));
  await hands.idle();
  expect(ad.ran).toEqual(["press 100 200"]);
  hands.stop();
});

test("input waits behind an agent-device command still running, so it lands in order, and a finger ends the way it began", async () => {
  const { said, to } = told();
  const ad = agentDevice();
  let direct: typeof to | undefined;
  const hands = new Hands(runner, 3, () => {}, ad.run, () => direct);
  // No stream yet: a tap through agent-device, held up.
  ad.hold();
  hands.send(touch("down", 300, 600));
  hands.send(touch("up", 300, 600));
  await Bun.sleep(5);
  expect(ad.ran).toEqual(["press 100 200"]);
  // The stream takes input now, but a tap and typing wait behind the press.
  direct = to;
  hands.send(touch("down", 30, 1300));
  hands.send(touch("up", 30, 1300));
  hands.send({ kind: "text", text: "b" });
  expect(said).toEqual([]);
  ad.answer();
  await hands.idle();
  expect(said).toEqual(["touch down 30 1300 0", "touch up 30 1300 0", "keyboard 5 down", "keyboard 5 up"]);
  // A finger that went down through agent-device lifts there too, even once the stream takes input.
  direct = undefined;
  hands.send(touch("down", 300, 1500));
  direct = to;
  hands.send(touch("up", 300, 600));
  await hands.idle();
  expect(ad.ran).toEqual(["press 100 200", "swipe 100 500 100 200"]);
  // The stream stops taking input: the rest goes through agent-device.
  direct = undefined;
  hands.send({ kind: "text", text: "c" });
  await hands.idle();
  expect(ad.ran.at(-1)).toBe("type -- c");
  hands.stop();
});

test("the live view takes input once its stream says so, at the size its frames say", async () => {
  let onFrame: (f: StreamFrame) => void = () => {};
  let input = false;
  const told: Command[] = [];
  let watching = true;
  const shooter = new Shooter(
    async () => new Uint8Array(0),
    performance.now(),
    () => watching,
    () => {},
    (ms) => Bun.sleep(Math.min(ms, 5)),
    async (fn) => {
      onFrame = fn;
      return { still: () => {}, tell: (c) => told.push(c), stop: () => {}, ended: new Promise<string | undefined>(() => {}), input: () => input };
    },
  );
  expect(shooter.direct()).toBeUndefined();
  shooter.run();
  await Bun.sleep(10);
  onFrame({ kind: "jpeg", key: true, screen, data: new Uint8Array([1]) });
  expect(shooter.direct()).toBeUndefined();
  input = true;
  const to = shooter.direct()!;
  expect(to.screen).toEqual(screen);
  to.tell("touch down 1 2 0");
  expect(told.at(-1)).toBe("touch down 1 2 0");
  // Nobody watches: the stream stops, and input goes through agent-device again.
  watching = false;
  await Bun.sleep(300);
  expect(shooter.direct()).toBeUndefined();
  shooter.stop();
});
