import { describe, expect, it } from "vitest";
import type { BrowserSession } from "./desktop";
import {
  BACKSPACE,
  cardTitle,
  clampView,
  controlLine,
  controlOf,
  DOUBLE_MS,
  ENTER,
  fingerCancel,
  fingerDown,
  fingerHeld,
  fingerMove,
  fingerUp,
  FramePacer,
  hostOf,
  IDLE,
  MAX_ZOOM,
  pixelsPerPoint,
  screenCards,
  SLOP,
  toFrame,
  typed,
  waitLine,
  waitOutcome,
  type Finger,
  type Touch,
} from "./screen";

const AT = "2026-10-31T10:00:00.000Z";

const screen = (sessionId: string, extra: Partial<BrowserSession> = {}): BrowserSession => ({
  sessionId,
  projectRef: { machineId: "devbox", projectId: "navi" },
  threadId: "th-1",
  purpose: "Book the hotel",
  state: "live",
  control: "agent",
  startedAt: AT,
  ...extra,
});

describe("a chat's screen cards", () => {
  it("show its live screens, the one asking for you first, and say what each is", () => {
    const cards = screenCards([
      screen("B1", { kind: "android" }),
      screen("B2", { takeoverReason: "Solve the captcha on booking.com" }),
      screen("B3", { state: "recorded" }),
    ]);
    expect(cards.map((c) => c.id)).toEqual(["B2", "B1"]);
    expect(cardTitle(cards[0]!, "Nova")).toBe("Nova needs you");
    expect(cards[0]!.reason).toBe("Solve the captcha on booking.com");
    expect(cardTitle(cards[1]!, "Nova")).toBe("Nova's Android emulator");
    expect(screenCards(undefined)).toEqual([]);
  });

  it("stop asking once a person has control, and name a person's own screen as theirs", () => {
    const [taken] = screenCards([screen("B2", { takeoverReason: "Solve the captcha", control: "human" })]);
    expect(taken!.reason).toBeUndefined();
    expect(taken!.control).toBe("human");
    const [own] = screenCards([screen("B4", { openedBy: { personId: "p1", name: "Ann" } as NonNullable<BrowserSession["openedBy"]> })]);
    expect(cardTitle(own!, "Nova")).toBe("Your browser");
  });
});

describe("who has control", () => {
  it("is what the newest frame says, sooner than the list, else the list", () => {
    expect(controlOf({ control: "agent" }, { control: "human" })).toBe("human");
    expect(controlOf({ control: "handing_back" }, undefined)).toBe("handing_back");
    // A newer hub's word for it reads as the agent's.
    expect(controlOf({ control: "robot" }, undefined)).toBe("agent");
    expect(controlLine("human", "Nova", false)).toBe("You have control");
    expect(controlLine("agent", "Nova", false)).toBe("Nova has control");
    expect(controlLine("handing_back", "Nova", false)).toBe("Back to Nova at its next step");
  });

  it("names the page's site", () => {
    expect(hostOf("https://www.booking.com/hotel/x?y=1")).toBe("booking.com");
    expect(hostOf("http://127.0.0.1:5173/")).toBe("127.0.0.1");
    expect(hostOf(undefined)).toBe("");
    expect(hostOf("about:blank")).toBe("");
  });
});

// A phone's 390 × 600 box showing a 1280 × 800 page: it fits the width, 0.3046875 points a pixel, 243.75 points tall.
const box = { width: 390, height: 600 };
const frame = { width: 1280, height: 800 };
const rest = { zoom: 1, x: 0, y: 0 };

describe("where a touch lands on the page", () => {
  it("is the frame's own pixel under the finger, through the zoom and the pan", () => {
    expect(toFrame({ x: 195, y: 300 }, box, frame, rest)).toEqual({ x: 640, y: 400 });
    expect(toFrame({ x: 0, y: 300 - 243.75 / 2 }, box, frame, rest)).toEqual({ x: 0, y: 0 });
    // Zoomed in twice about the centre and moved right by 100 points: the centre of the box is 164 pixels left of the page's.
    expect(toFrame({ x: 195, y: 300 }, box, frame, { zoom: 2, x: 100, y: 0 })).toEqual({ x: 476, y: 400 });
    // The bars above and below the page aren't on it.
    expect(toFrame({ x: 195, y: 10 }, box, frame, rest)).toBeNull();
    expect(pixelsPerPoint(box, frame, { zoom: 2, x: 0, y: 0 })).toBeCloseTo(1280 / 390 / 2);
  });

  it("keeps the zoom in 1…MAX_ZOOM and the page over the box", () => {
    expect(clampView(box, frame, { zoom: 9, x: 0, y: 0 }).zoom).toBe(MAX_ZOOM);
    expect(clampView(box, frame, { zoom: 0.5, x: 40, y: 40 })).toEqual({ zoom: 1, x: 0, y: 0 });
    // At 2×, 780 points wide: it moves 195 each way, and still can't move up or down (487.5 tall in 600).
    expect(clampView(box, frame, { zoom: 2, x: 500, y: 50 })).toEqual({ zoom: 2, x: 195, y: 0 });
  });
});

const at = (x: number, y: number, t = 0, frameAt: { x: number; y: number } | null = { x: x * 4, y: y * 4 }): Touch => ({ at: { x, y }, frame: frameAt, t });

/** Runs a finger's steps, returning what each sent and where it ended. */
const run = (steps: ((f: Finger) => { finger: Finger; send: readonly unknown[] })[], from: Finger = IDLE) => {
  let finger = from;
  const sent: unknown[] = [];
  for (const step of steps) {
    const out = step(finger);
    finger = out.finger;
    sent.push(...out.send);
  }
  return { finger, sent };
};

describe("a finger on a page you took over", () => {
  it("clicks where it tapped, and double-clicks on a second tap soon and near", () => {
    const one = run([(f) => fingerDown(f, at(10, 20)), (f) => fingerMove(f, at(12, 21, 50), 4), (f) => fingerUp(f, at(12, 21, 90))]);
    expect(one.sent).toEqual([
      { kind: "mouse", action: "pressed", x: 40, y: 80, button: "left", clickCount: 1 },
      { kind: "mouse", action: "released", x: 40, y: 80, button: "left", clickCount: 1 },
    ]);
    const two = run([(f) => fingerDown(f, at(11, 20, 90 + DOUBLE_MS - 10)), (f) => fingerUp(f, at(11, 20, 90 + DOUBLE_MS + 40))], one.finger);
    expect(two.sent).toMatchObject([{ action: "pressed", clickCount: 2 }, { action: "released", clickCount: 2 }]);
    // Too late: two single clicks.
    const late = run([(f) => fingerDown(f, at(11, 20, 1000)), (f) => fingerUp(f, at(11, 20, 1050))], one.finger);
    expect(late.sent).toMatchObject([{ clickCount: 1 }, { clickCount: 1 }]);
  });

  it("scrolls the page with the finger once it moves past the slop, and clicks nothing", () => {
    const { sent, finger } = run([(f) => fingerDown(f, at(100, 300)), (f) => fingerMove(f, at(100, 300 - SLOP - 2, 30), 3), (f) => fingerMove(f, at(100, 250, 60), 3), (f) => fingerUp(f, at(100, 250, 90))]);
    // Dragged up 10 points then 40 more: the page scrolls down that far in its pixels, the wheel at where it began.
    expect(sent).toEqual([
      { kind: "mouse", action: "wheel", x: 400, y: 1200, deltaX: -0, deltaY: 30 },
      { kind: "mouse", action: "wheel", x: 400, y: 1200, deltaX: -0, deltaY: 120 },
    ]);
    expect(finger).toEqual(IDLE);
  });

  it("held still a moment, presses, drags with the button down, and lets go where it lifts", () => {
    const { sent } = run([(f) => fingerDown(f, at(10, 10)), fingerHeld, (f) => fingerMove(f, at(60, 10, 500), 4), (f) => fingerUp(f, at(60, 10, 600))]);
    expect(sent).toEqual([
      { kind: "mouse", action: "pressed", x: 40, y: 40, button: "left", clickCount: 1 },
      { kind: "mouse", action: "moved", x: 240, y: 40, button: "left" },
      { kind: "mouse", action: "released", x: 240, y: 40, button: "left", clickCount: 1 },
    ]);
    // A hold whose finger already scrolled presses nothing.
    expect(run([(f) => fingerDown(f, at(10, 10)), (f) => fingerMove(f, at(10, 60, 50), 4), fingerHeld]).sent).toHaveLength(1);
  });

  it("lets go of a press when a pinch takes the touch, and does nothing off the page", () => {
    expect(run([(f) => fingerDown(f, at(10, 10)), fingerHeld, fingerCancel]).sent.at(-1)).toMatchObject({ action: "released", x: 40, y: 40 });
    expect(run([(f) => fingerDown(f, at(10, 10)), fingerCancel]).sent).toEqual([]);
    expect(run([(f) => fingerDown(f, at(1, 1, 0, null)), fingerHeld, (f) => fingerUp(f, at(1, 1, 50, null))]).sent).toEqual([]);
  });
});

describe("typing on the page", () => {
  it("sends what the keyboard added as text, and delete and return as keys", () => {
    expect(typed("a")).toEqual([{ kind: "text", text: "a" }]);
    expect(typed("4 2 1 8 0 9")).toEqual([{ kind: "text", text: "4 2 1 8 0 9" }]);
    expect(typed("")).toEqual([]);
    expect(typed("x".repeat(20_000))[0]).toMatchObject({ text: "x".repeat(10_000) });
    expect(BACKSPACE).toEqual([
      { kind: "key", action: "down", key: "Backspace", code: "Backspace" },
      { kind: "key", action: "up", key: "Backspace", code: "Backspace" },
    ]);
    expect(ENTER.map((k) => k.kind === "key" && k.key)).toEqual(["Enter", "Enter"]);
  });
});

describe("drawing frames", () => {
  it("draws the first at once, then the newest at most each gap, and always the last of a burst", () => {
    let now = 0;
    const timers: { run: () => void; at: number }[] = [];
    const drawn: number[] = [];
    const pacer = new FramePacer<number>((f) => drawn.push(f), { gapMs: 100, now: () => now, later: (run, ms) => timers.push({ run, at: now + ms }), cancel: () => undefined });
    pacer.offer(1);
    now = 20;
    pacer.offer(2);
    now = 40;
    pacer.offer(3);
    expect(drawn).toEqual([1]);
    expect(timers).toHaveLength(1);
    now = timers[0]!.at;
    timers.shift()!.run();
    // Frame 2 never drew: 3 came first.
    expect(drawn).toEqual([1, 3]);
    now = 400;
    pacer.offer(4);
    expect(drawn).toEqual([1, 3, 4]);
    pacer.offer(5);
    pacer.stop();
    expect(drawn).toEqual([1, 3, 4]);
  });
});

describe("a screen of your own on its way", () => {
  it("waits in line, then opens the screen on the thread its wait named, or says why it failed", () => {
    const wait = { waitId: "w1", stage: "waiting", ahead: 1 };
    expect(waitOutcome({ sessions: [], waits: [{ ...wait, ahead: 0 }] }, wait, AT)).toEqual({ t: "waiting", wait: { ...wait, ahead: 0 } });
    expect(waitLine({ ...wait, ahead: 2 }, "devbox")).toBe("Waiting for a slot on devbox: 2 people ahead of you.");
    expect(waitLine({ ...wait, stage: "starting" }, "devbox")).toBe("Starting it on devbox…");
    const mine = screen("B9", { openedBy: { personId: "p1", name: "Ann" } as NonNullable<BrowserSession["openedBy"]>, threadId: "th-9" });
    expect(waitOutcome({ sessions: [screen("B1"), mine], waits: [] }, { ...wait, threadId: "th-9" }, AT)).toEqual({ t: "opened", sessionId: "B9" });
    // An agent's screen is never the one it waited for.
    expect(waitOutcome({ sessions: [screen("B1")] }, wait, AT)).toEqual({ t: "gone" });
    expect(waitOutcome({ sessions: [], waits: [{ ...wait, stage: "failed", error: "The machine went offline." }] }, wait, AT)).toEqual({ t: "failed", error: "The machine went offline." });
  });
});
