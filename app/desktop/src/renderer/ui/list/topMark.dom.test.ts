// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { topMark } from "./VirtualList";

// happy-dom has no layout: each element's box, top and height on screen, is given here.
const boxes = new Map<Element, [number, number]>();
const box = (tag: string, top: number, height: number, children: Element[] = []): Element => {
  const el = document.createElement(tag);
  el.append(...children);
  boxes.set(el, [top, height]);
  return el;
};
vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
  const [top, height] = boxes.get(this) ?? [0, 0];
  return new DOMRect(0, top, 300, height);
});
afterEach(() => boxes.clear());

describe("topMark: what sits at a list's top", () => {
  it("is the first thing starting at or below the top in the row the top cuts through, looking only inside what spans it", () => {
    const caption = box("p", 160, 20);
    const picture = box("img", 40, 120);
    const bubble = box("div", 40, 140, [picture, caption]);
    const text = box("p", 10, 20);
    const row = box("div", 10, 190, [text, bubble]);
    const rows = box("div", 10, 400, [box("div", -80, 90), row, box("div", 200, 60)]);
    // The view's top at 100 cuts through the row, and through the picture in it: under the top is the caption.
    const mark = topMark(box("div", 100, 500), rows);
    expect(mark).toEqual({ row, el: caption, at: 150 });
  });

  it("is nothing when the top falls between rows", () => {
    const rows = box("div", 0, 400, [box("div", 0, 100), box("div", 100, 50)]);
    expect(topMark(box("div", 100, 500), rows)).toBeUndefined();
  });
});
