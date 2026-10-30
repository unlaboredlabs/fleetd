import { describe, expect, it } from "vitest";
import { armedDistance, BODY, circles, closed, commitDistance, drag, grab, handedVelocity, openDistance, release, resisted, shouldClose, swallows, tapCloses, touchCloses, touchDown, type Opened } from "./swipe";

// An iPhone 17 Pro's width, the simulator's Messages was measured on.
const W = 402;

/** A swipe from closed, the finger `along` points toward the far edge, `fromEdge` from it. */
const swipe = (along: number, count: number, opts: { velocity?: number; fromEdge?: number } = {}) =>
  drag(grab(0, 0, count, W), along, opts.velocity ?? 0, opts.fromEdge ?? 200, count, W);

describe("a swiped row's thresholds", () => {
  it("opens as far as Messages does: 70 pt for one circle, 130 pt for two", () => {
    expect(openDistance(0)).toBe(0);
    expect(openDistance(1)).toBe(70);
    expect(openDistance(2)).toBe(130);
  });

  it("commits past half the row (52.5%), or 20 pt past the circles on a narrow one, never past the row", () => {
    expect(commitDistance(1, W)).toBe(211);
    expect(commitDistance(2, W)).toBe(211);
    expect(commitDistance(2, 200)).toBe(150);
    expect(commitDistance(2, 140)).toBe(140);
  });

  it("jumps three quarters across once armed", () => {
    expect(armedDistance(2, W)).toBe(301.5);
    expect(armedDistance(2, 200)).toBe(150);
  });

  it("follows the finger up to the commit point, then rubber-bands at a 0.7 power", () => {
    expect(resisted(100, 211)).toBe(100);
    expect(resisted(211 + 32, 211)).toBeCloseTo(211 + 32 ** 0.7);
    expect(resisted(-32, 211)).toBeCloseTo(-(32 ** 0.7));
    expect(resisted(resisted(300, 211), 211, true)).toBeCloseTo(300);
  });
});

describe("a full swipe", () => {
  it("isn't armed short of the commit point, and the row is where the finger is", () => {
    const r = swipe(200, 2);
    expect(r.drag.armed).toBe(false);
    expect(r.to).toBe(200);
  });

  it("arms at the commit point and carries the row ahead to three quarters", () => {
    const r = swipe(211, 2);
    expect(r.drag.armed).toBe(true);
    expect(r.to).toBe(301.5);
    const past = swipe(250, 2);
    expect(past.to).toBeCloseTo(301.5 + 39 ** 0.7);
  });

  it("arms early with the finger near the edge it moves to: at two thirds of the way, later when it's fast", () => {
    expect(swipe(150, 2, { fromEdge: 40 }).drag.armed).toBe(true);
    expect(swipe(130, 2, { fromEdge: 40 }).drag.armed).toBe(false);
    expect(swipe(150, 2, { fromEdge: 80 }).drag.armed).toBe(false);
    expect(swipe(150, 2, { fromEdge: 40, velocity: 2000 }).drag.armed).toBe(false);
    expect(swipe(170, 2, { fromEdge: 40, velocity: 2000 }).drag.armed).toBe(true);
  });

  it("carries the row to the commit point when it arms early, then on from there", () => {
    const early = swipe(150, 2, { fromEdge: 40 });
    expect(early.to).toBe(301.5);
    expect(drag(early.drag, 160, 0, 30, 2, W).to).toBeCloseTo(301.5 + 10 ** 0.7);
  });

  it("disarms when the finger goes back, and arms again the same way", () => {
    let d = grab(0, 0, 1, W);
    d = drag(d, 230, 0, 150, 1, W).drag;
    expect(d.armed).toBe(true);
    d = drag(d, 180, 0, 200, 1, W).drag;
    expect(d.armed).toBe(false);
    expect(drag(d, 230, 0, 150, 1, W).drag.armed).toBe(true);
  });

  it("runs its action when let go armed, and the row goes back closed", () => {
    expect(release(swipe(260, 2).drag, 260, -400, 2)).toEqual({ commit: true, open: false });
    expect(release(swipe(200, 2).drag, 200, 0, 2)).toEqual({ commit: false, open: true });
  });

  it("doesn't arm again at once when a row springing back from it is grabbed", () => {
    // Let go armed, the row and the stretch spring back together: four fifths of the way back to the commit point.
    const d = grab(301.5 * 0.8, 0.8, 2, W);
    expect(drag(d, 0, 0, 200, 2, W)).toEqual({ drag: { initial: 168.8, adjust: 0, armed: false }, to: 168.8 });
  });
});

describe("letting go short of a full swipe", () => {
  it("opens past halfway to open, and closes short of it", () => {
    expect(release(swipe(66, 2).drag, 66, 0, 2).open).toBe(true);
    expect(release(swipe(64, 2).drag, 64, 0, 2).open).toBe(false);
  });

  it("follows a flick either way over 50 pt/s, wherever the row is", () => {
    expect(release(swipe(20, 2).drag, 20, 300, 2).open).toBe(true);
    expect(release(swipe(120, 2).drag, 120, -300, 2).open).toBe(false);
  });

  it("hands the finger's speed to the spring, never backwards and at most 100 times the way left a second", () => {
    expect(handedVelocity(400, 100, 130)).toBe(400);
    expect(handedVelocity(9000, 100, 130)).toBe(3000);
    expect(handedVelocity(400, 300, 0)).toBe(-0);
    expect(handedVelocity(-400, 300, 0)).toBe(-400);
  });

  it("settles on a critically damped half-second spring", () => {
    expect(BODY.stiffness).toBeCloseTo((2 * Math.PI) ** 2 / 0.25);
    expect(BODY.damping).toBeCloseTo(2 * Math.sqrt(BODY.stiffness));
  });
});

describe("the circles", () => {
  it("are hidden with the row closed, and pop in one by one as it passes them", () => {
    expect(circles(0, 0, 2, W).map((c) => c.scale)).toEqual([0, 0]);
    expect(circles(40, 0, 2, W).map((c) => c.scale)).toEqual([0, 0]);
    expect(circles(55, 0, 2, W).map((c) => c.scale)).toEqual([0.5, 0]);
    expect(circles(70, 0, 2, W).map((c) => c.scale)).toEqual([1, 0]);
    expect(circles(130, 0, 2, W).map((c) => c.scale)).toEqual([1, 1]);
  });

  it("stand where Messages' do when open: 50 pt, 10 pt from the edge and each other", () => {
    expect(circles(130, 0, 2, W).map((c) => [c.center, c.width])).toEqual([
      [35, 50],
      [95, 50],
    ]);
  });

  it("past open, the first stretches after the row and the next rides along, fading", () => {
    const [first, second] = circles(170, 0, 2, W);
    expect(first?.width).toBe(90);
    expect(second?.center).toBe(135);
    expect(second?.opacity).toBeLessThan(1);
  });

  it("armed, the first spans the gap and the others fold away", () => {
    const [first, second] = circles(301.5, 1, 2, W);
    expect(first).toEqual({ center: 10 + 281.5 / 2, width: 281.5, scale: 1, opacity: 1 });
    expect(second?.scale).toBe(0);
    expect(second?.opacity).toBe(0);
  });
});

describe("one row open at a time", () => {
  // The list's open row, as SwipeRow and Chats drive it: each step is what the gesture, a tap or the list calls. Each row
  // keeps what was open as a touch on it came down (`held`) until that touch ends, lifted or cancelled; React runs a
  // tap's onPress before the row's onTouchEnd, so the tap reads it first.
  const list = (open: Opened = null) => {
    const held = new Map<string, Opened>();
    /** The pan's onBegin: whether a swipe from this touch would only close another row. */
    const down = (key: string): boolean => {
      const d = touchDown(open, key);
      open = d.open;
      held.set(key, d.held);
      return swallows(d.held, key);
    };
    const end = (key: string) => held.set(key, null);
    /** SwipeRow's tap: reads what the row held once, and only closes if something was open. */
    const press = (key: string): boolean => {
      const was = held.get(key) ?? null;
      held.set(key, null);
      if (tapCloses(was)) {
        open = null;
        return false;
      }
      return true;
    };
    return {
      get open() {
        return open;
      },
      /** A finger down on a row (the pan's onBegin), then a swipe on it: whether it moved the row. */
      swipe(key: string, { cancelledFirst = false } = {}): boolean {
        const closing = down(key);
        // iOS can cancel the row's touch before the pan starts, as its menu begins to lift the row.
        if (cancelledFirst) end(key);
        if (!closing) open = key;
        end(key);
        return !closing;
      },
      /** A finger down on a row, then a tap: whether it opened the chat. */
      tap(key: string): boolean {
        down(key);
        const opened = press(key);
        end(key);
        return opened;
      },
      /** VoiceOver's double-tap on a row, which can come without a touch the pan sees. */
      voiceOver(key: string): boolean {
        return press(key);
      },
      /** A finger down on a row that becomes a long press: iOS's menu lifts it and cancels the touch. */
      hold(key: string) {
        down(key);
        end(key);
      },
      /** A touch away from the rows: the list's space, its filters, the navigation bar's title, + or search field. */
      touchAway() {
        if (touchCloses(open, false)) open = null;
      },
      /** A filter picked with VoiceOver, or the list left for another tab or a chat: Swipes.close. */
      close() {
        open = null;
      },
      /** A row goes back closed, or leaves the list. */
      closed(key: string) {
        open = closed(open, key);
      },
    };
  };

  it("closes the open row when a swipe begins on another, and that swipe only closes it", () => {
    const l = list();
    expect(l.swipe("a")).toBe(true);
    expect(l.swipe("b")).toBe(false);
    expect(l.open).toBe(null);
    expect(l.swipe("b")).toBe(true);
    expect(l.open).toBe("b");
  });

  it("lets the open row be swiped again", () => {
    const l = list("a");
    expect(l.swipe("a")).toBe(true);
    expect(l.open).toBe("a");
  });

  it("makes a tap on any row only close the open one, and the next tap opens a chat", () => {
    const l = list("a");
    expect(l.tap("b")).toBe(false);
    expect(l.open).toBe(null);
    expect(l.tap("b")).toBe(true);
    const own = list("a");
    expect(own.tap("a")).toBe(false);
    expect(own.open).toBe(null);
  });

  it("closes the open row when another is held for its menu", () => {
    const l = list("a");
    l.hold("b");
    expect(l.open).toBe(null);
  });

  it("closes the open row on a touch away from the rows: empty space, the filters, the navigation bar", () => {
    const l = list("a");
    l.touchAway();
    expect(l.open).toBe(null);
    expect(touchCloses("a", true)).toBe(false);
    expect(touchCloses(null, false)).toBe(false);
  });

  it("closes the open row when a filter is picked without a touch, or the list is left", () => {
    const l = list();
    l.swipe("a");
    l.close();
    expect(l.open).toBe(null);
    expect(l.tap("b")).toBe(true);
  });

  it("only closes the open row on a swipe whose touch iOS cancelled before it started", () => {
    const l = list("a");
    expect(l.swipe("b", { cancelledFirst: true })).toBe(false);
    expect(l.open).toBe(null);
    expect(l.swipe("b", { cancelledFirst: true })).toBe(true);
  });

  it("opens the chat on a VoiceOver tap after a swipe or a hold that only closed another row", () => {
    const swiped = list("a");
    expect(swiped.swipe("b")).toBe(false);
    expect(swiped.voiceOver("b")).toBe(true);
    const held = list("a");
    held.hold("b");
    expect(held.voiceOver("b")).toBe(true);
    // The row's own swipe, closed again, leaves nothing behind either.
    const own = list("a");
    expect(own.swipe("a")).toBe(true);
    own.closed("a");
    expect(own.voiceOver("a")).toBe(true);
  });

  it("doesn't spend the next tap when the open row leaves the list", () => {
    const l = list("a");
    // A search is typed and row a goes: it frees the list as it unmounts.
    l.closed("a");
    expect(l.tap("b")).toBe(true);
  });

  it("leaves another row open when one that had closed reports it", () => {
    expect(closed("b", "a")).toBe("b");
  });

  it("closes a row shown open once another is the open one, or none is", () => {
    expect(shouldClose("b", "a")).toBe(true);
    expect(shouldClose(null, "a")).toBe(true);
    expect(shouldClose("a", "a")).toBe(false);
  });
});
