import { describe, expect, it } from "vitest";
import Yoga, { Direction, Edge, Errata, Justify, PositionType, type Node } from "yoga-layout";
import { bubble } from "./bubble";
import { workedFor } from "./desktop";
import { revealOf, revealWidth, TIME_SCALE, timeColumn, timeLine } from "./reveal";

describe("revealWidth", () => {
  it("fits the longest time with its padding at the default text size", () => {
    expect(revealWidth(1)).toBe(68);
  });

  it("grows with Dynamic Type as far as the time's text does, and no further", () => {
    expect(revealWidth(1.1)).toBe(74);
    expect(revealWidth(TIME_SCALE)).toBe(80);
    expect(revealWidth(2)).toBe(revealWidth(TIME_SCALE));
  });

  it("narrows for smaller text", () => {
    expect(revealWidth(0.85)).toBe(60);
  });
});

describe("revealOf", () => {
  it("starts from where the drag took hold, without a jump", () => {
    expect(revealOf(-10, -10, 68)).toBe(0);
    expect(revealOf(-40, -10, 68)).toBe(30);
  });

  it("follows up to the column's width, then stretches at a quarter of the pace", () => {
    expect(revealOf(-78, -10, 68)).toBe(68);
    expect(revealOf(-118, -10, 68)).toBe(78);
  });

  it("shows nothing for a drag back to the right", () => {
    expect(revealOf(20, -10, 68)).toBe(0);
  });
});

// A row and its time column laid out by Yoga, the engine React Native lays views out with, set as React Native sets
// it: every legacy erratum on (its default outside a strict LayoutConformance), on a 3x screen.
const config = Yoga.Config.create();
config.setErrata(Errata.All);
config.setPointScaleFactor(3);

/** A view with `style`, by the keys the column's styles use; one it doesn't know is an error, not a silent skip. */
const view = (style: Readonly<Record<string, string | number>>, children: readonly Node[] = []): Node => {
  const node = Yoga.Node.create(config);
  for (const [key, value] of Object.entries(style)) {
    if (key === "position" && value === "absolute") node.setPositionType(PositionType.Absolute);
    else if (key === "justifyContent" && value === "center") node.setJustifyContent(Justify.Center);
    else if (key === "left" && typeof value === "string") node.setPositionPercent(Edge.Left, Number.parseFloat(value));
    else if (typeof value === "string") throw new Error(`style ${key}: ${value}`);
    else if (key === "top") node.setPosition(Edge.Top, value);
    else if (key === "bottom") node.setPosition(Edge.Bottom, value);
    else if (key === "width") node.setWidth(value);
    else if (key === "height") node.setHeight(value);
    else if (key === "marginLeft") node.setMargin(Edge.Left, value);
    else if (key === "paddingLeft") node.setPadding(Edge.Left, value);
    else if (key === "paddingHorizontal") node.setPadding(Edge.Horizontal, value);
    else throw new Error(`style ${key}`);
  }
  children.forEach((child, i) => node.insertChild(child, i));
  return node;
};

/** Caption type (theme.ts), which the column's Texts grow with Dynamic Type up to TIME_SCALE. */
const CAPTION = { fontSize: 12, lineHeight: 16 };
const captionScale = (fontScale: number): number => Math.min(fontScale, TIME_SCALE);
/** A glyph's width as a share of the font's size: generous, as "Worked for" is 0.51 of it a glyph on the phone. */
const ADVANCE = 0.6;

/** A line of the column saying `words`: one line where they fit its width, and as tall as two where they'd be cut. */
const line = (words: string, fontScale: number): Node => {
  const node = view(timeLine);
  const scale = captionScale(fontScale);
  node.setMeasureFunc((width) => ({ width, height: (words.length * CAPTION.fontSize * scale * ADVANCE <= width ? 1 : 2) * CAPTION.lineHeight * scale }));
  return node;
};

/** Where a view is on the screen, in points. */
const box = (node: Node) => {
  let left = 0;
  let top = 0;
  for (let n: Node | null = node; n !== null; n = n.getParent()) {
    left += n.getComputedLeft();
    top += n.getComputedTop();
  }
  return { left, top, right: left + node.getComputedWidth(), bottom: top + node.getComputedHeight() };
};

/** A row `height` tall in the thread of a screen `width` wide, as Revealed lays it out: its body, then the column's lines. */
const revealed = (width: number, fontScale: number, height: number, lines: readonly string[]) => {
  const texts = lines.map((words) => line(words, fontScale));
  const column = view(timeColumn(bubble.margin, revealWidth(fontScale)), texts);
  const row = view({}, [view({}, [view({ height })]), column]);
  view({ width, paddingHorizontal: bubble.margin }, [row]).calculateLayout(width, undefined, Direction.LTR);
  return { row, column, texts };
};

// iPhone SE zoomed and iPhone mini to iPhone Pro Max, portrait.
const WIDTHS = [320, 375, 402, 440];
// Dynamic Type's smallest size, the default, the column's cap, the largest of the seven, and the largest accessibility
// size, as React Native scales text for them.
const TEXT_SIZES = [0.823, 1, TIME_SCALE, 1.353, 3.571];
/** A one-line reply's height at a text size: its words grow with it, uncapped. */
const oneLine = (fontScale: number): number => bubble.lineHeight * fontScale + 2 * bubble.padY;
const TIME = "12:59 PM";
// The longest a turn's time reads: under an hour, under a day, and weeks.
const LONGEST = [workedFor(3_599_000), workedFor(86_399_000), workedFor(1000 * 3_600_000 - 1000)];

describe("how long a turn took, under its reply's time", () => {
  it("reads as a duration alone, short enough for the column", () => {
    expect(LONGEST).toEqual(["59m 59s", "23h 59m", "999h 59m"]);
  });

  it("leaves its row as tall as it was before the turn ended", () => {
    for (const width of WIDTHS)
      for (const fontScale of TEXT_SIZES)
        // A one-line reply, a long one, and a row shorter than the column's two lines.
        for (const height of [oneLine(fontScale), 480, 20]) {
          const before = revealed(width, fontScale, height, [TIME]).row.getComputedHeight();
          for (const worked of LONGEST) expect(revealed(width, fontScale, height, [TIME, worked]).row.getComputedHeight()).toBe(before);
        }
  });

  it("is off the screen at rest, with the time", () => {
    for (const width of WIDTHS)
      for (const fontScale of TEXT_SIZES)
        for (const worked of LONGEST) {
          const { column, texts } = revealed(width, fontScale, oneLine(fontScale), [TIME, worked]);
          expect(box(column).left).toBe(width);
          for (const text of texts) expect(box(text).left).toBeGreaterThanOrEqual(width);
        }
  });

  it("is whole in the shown column, under the time and inside the row", () => {
    for (const width of WIDTHS)
      for (const fontScale of TEXT_SIZES)
        for (const worked of LONGEST) {
          const { row, column, texts } = revealed(width, fontScale, oneLine(fontScale), [TIME, worked]);
          // The thread slides by the column's width.
          const slid = revealWidth(fontScale);
          const where = `${worked} on ${String(width)} pt at ${String(fontScale)}x`;
          expect(box(column).left - slid, where).toBeGreaterThan(0);
          expect(box(column).right - slid, where).toBe(width);
          const [time, took] = texts.map(box);
          if (time === undefined || took === undefined) throw new Error("two lines");
          for (const at of [time, took]) {
            expect(at.right - slid, where).toBeLessThanOrEqual(width);
            // One line: its words fit the column, none cut.
            expect(at.bottom - at.top, where).toBeCloseTo(CAPTION.lineHeight * captionScale(fontScale), 0);
          }
          expect(took.top, where).toBeCloseTo(time.bottom, 0);
          expect(time.top, where).toBeGreaterThanOrEqual(box(row).top);
          expect(took.bottom - box(row).bottom, where).toBeLessThan(0.5);
        }
  });
});
