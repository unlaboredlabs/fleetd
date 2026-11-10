import { describe, expect, it } from "vitest";
import Yoga, { Align, Direction, Edge, Errata, Gutter, PositionType, type Node } from "yoga-layout";
import { bubble, bubbleMax } from "./bubble";
import { workedFor } from "./desktop";
import { lead } from "./stamp";

// The thread's rows laid out by Yoga, the engine React Native lays views out with, set as React Native sets it: every
// legacy erratum on (its default outside a strict LayoutConformance), on a 3x screen.
const config = Yoga.Config.create();
config.setErrata(Errata.All);
config.setPointScaleFactor(3);

type Style = Readonly<Record<string, string | number>>;
const ALIGN: Readonly<Record<string, Align>> = { "flex-start": Align.FlexStart, stretch: Align.Stretch };

/** A view with `style`, by the keys the thread's styles use; one it doesn't know is an error, not a silent skip. */
const view = (style: Style, children: readonly Node[] = []): Node => {
  const node = Yoga.Node.create(config);
  for (const [key, value] of Object.entries(style)) {
    if (key === "left" && typeof value === "string") node.setPositionPercent(Edge.Left, Number.parseFloat(value));
    else if (key === "position" && value === "absolute") node.setPositionType(PositionType.Absolute);
    else if (typeof value === "string") {
      const align = ALIGN[value];
      if (align === undefined) throw new Error(`style ${key}: ${value}`);
      if (key === "alignItems") node.setAlignItems(align);
      else if (key === "alignSelf") node.setAlignSelf(align);
      else throw new Error(`style ${key}: ${value}`);
    } else if (key === "width") node.setWidth(value);
    else if (key === "height") node.setHeight(value);
    else if (key === "gap") node.setGap(Gutter.All, value);
    else if (key === "paddingRight") node.setPadding(Edge.Right, value);
    else if (key === "paddingHorizontal") node.setPadding(Edge.Horizontal, value);
    else if (key === "marginTop") node.setMargin(Edge.Top, value);
    else if (key === "marginLeft") node.setMargin(Edge.Left, value);
    else if (key === "bottom") node.setPosition(Edge.Bottom, value);
    else throw new Error(`style ${key}`);
  }
  children.forEach((child, i) => node.insertChild(child, i));
  return node;
};

/** Caption type (theme.ts), which grows with Dynamic Type. */
const CAPTION = { fontSize: 12, lineHeight: 16 };
/** A glyph's width as a share of the font's size: generous, as "Worked for" is 0.51 of it a glyph on the phone. */
const ADVANCE = 0.6;

/** A caption Text saying `words` at text size `fontScale`: one line if it fits, else every line, at the whole width. */
const caption = (style: Style, words: string, fontScale: number): Node => {
  const node = view(style);
  const em = CAPTION.fontSize * fontScale * ADVANCE;
  node.setMeasureFunc((width) => {
    let lines = 1;
    let line = 0;
    for (const word of words.split(" ")) {
      const next = line === 0 ? word.length * em : line + (word.length + 1) * em;
      if (next > width && line > 0) {
        lines += 1;
        line = word.length * em;
      } else line = next;
    }
    return { width: lines === 1 ? line : width, height: lines * CAPTION.lineHeight * fontScale };
  });
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

/** The thread on a screen `width` points wide, holding the lead's `row`. */
const thread = (width: number, row: Node): void => {
  view({ width, paddingHorizontal: bubble.margin }, [row]).calculateLayout(width, undefined, Direction.LTR);
};

// iPhone SE zoomed and iPhone mini to iPhone Pro Max, portrait.
const WIDTHS = [320, 375, 402, 440];
// The default text size, the largest of Dynamic Type's seven (xxxLarge), and the largest accessibility size, as React
// Native scales text for them.
const TEXT_SIZES = [1, 1.353, 3.571];
// The longest a turn's time reads, under an hour and over a day.
const LONGEST = [`Worked for ${workedFor(3_599_000)}`, `Worked for ${workedFor(100 * 3_600_000 - 1000)}`];

describe("the Worked for stamp", () => {
  it("is under its reply and inside the thread's margins, whole, at every screen width and text size", () => {
    expect(LONGEST).toEqual(["Worked for 59m 59s", "Worked for 99h 59m"]);
    for (const width of WIDTHS)
      for (const fontScale of TEXT_SIZES)
        for (const words of LONGEST)
          // A one-word bubble, the widest words make, and a card, which takes the row's width.
          for (const reply of [{ width: 48 }, { width: bubbleMax(width) }, { alignSelf: "stretch" }]) {
            const body = view({ ...reply, height: 42 });
            const stamp = caption(lead.stamp, words, fontScale);
            const row = view(lead.row, [body, stamp]);
            thread(width, row);
            const at = box(stamp);
            const where = `${words} on ${String(width)} pt at ${String(fontScale)}x`;
            expect(at.left, where).toBe(bubble.margin + lead.stamp.marginLeft);
            expect(at.right, where).toBeLessThanOrEqual(width - bubble.margin);
            expect(at.top, where).toBeGreaterThanOrEqual(box(body).bottom);
            // In the row's own height, so the next row starts under it (each is rounded to a pixel, a third of a point).
            expect(at.bottom - box(row).bottom, where).toBeLessThan(0.5);
            // The bubble keeps its own width beside a longer stamp.
            if ("width" in reply) expect(body.getComputedWidth(), where).toBe(reply.width);
          }
  });

  it("is one line at the default text size and at the largest of Dynamic Type's seven", () => {
    for (const width of WIDTHS)
      for (const fontScale of [1, 1.353])
        for (const words of LONGEST) {
          const stamp = caption(lead.stamp, words, fontScale);
          thread(width, view(lead.row, [view({ width: 48, height: 42 }), stamp]));
          expect(stamp.getComputedHeight(), `${words} on ${String(width)} pt`).toBeCloseTo(CAPTION.lineHeight * fontScale, 1);
        }
  });

  // What it was (#1470), and what the screenshot showed: on a 402 pt iPhone "Worked for" began 338 pt in, beside every
  // reply whatever its width, and ran off the screen's right edge.
  it("isn't placed at a percent of its bubble's width, which React Native takes of the row's", () => {
    for (const reply of [120, 275]) {
      const stamp = caption({ position: "absolute", left: "100%", bottom: 9, marginLeft: 8 }, "Worked for 12s", 1);
      const stamped = view({ alignSelf: "flex-start" }, [view({ width: reply, height: 42 }), stamp]);
      thread(402, view(lead.row, [stamped]));
      expect(stamped.getComputedWidth()).toBe(reply);
      expect(box(stamp).left).toBe(338);
      expect(box(stamp).right).toBeGreaterThan(402);
    }
  });
});
