import { Virtualizer, type VirtualizerOptions } from "@tanstack/react-virtual";
import { describe, expect, it } from "vitest";
import { followOptions, keepsPlace, readerLeft } from "./VirtualList";

// A virtualizer over a fake 100 px viewport: TanStack's core with the DOM hooks replaced, so the pinning logic
// that VirtualList configures runs for real without a browser.
function list(count: number, follow: boolean, away = false) {
  let offset = 0;
  let onOffset: ((offset: number, scrolling: boolean) => void) | undefined;
  // A window whose frames never come: a follow's scroll lands at once, and its check a frame later never runs.
  const win = Object.assign(Object.create(globalThis) as object, { requestAnimationFrame: () => 0, cancelAnimationFrame: () => {} });
  // Its scroll range is the list's (TanStack reads the element's to tell how far the end is).
  const fakeEl = {
    scrollTop: 0,
    clientHeight: 100,
    get scrollHeight() {
      return v.getTotalSize();
    },
    ownerDocument: { defaultView: win },
  } as unknown as HTMLDivElement;
  const options: VirtualizerOptions<HTMLDivElement, Element> = {
    count,
    getScrollElement: () => fakeEl,
    estimateSize: () => 20,
    getItemKey: (i) => i,
    initialRect: { width: 300, height: 100 },
    observeElementRect: (_v, cb) => cb({ width: 300, height: 100 }),
    observeElementOffset: (_v, cb) => {
      onOffset = cb;
      cb(offset, false);
    },
    scrollToFn: (to, { adjustments = 0 }) => {
      offset = to + adjustments;
      onOffset?.(offset, false);
    },
    ...followOptions(follow, away),
  };
  const v = new Virtualizer(options);
  // As VirtualList sets it, with how far what sits at the view's top moved within its row given by the test.
  const top: { moved: number | undefined } = { moved: undefined };
  v.shouldAdjustScrollPositionOnItemSizeChange = (item, delta, inst) => keepsPlace(item, delta, inst.scrollOffset ?? 0, top.moved);
  v._didMount();
  v._willUpdate();
  const scrollTo = (to: number) => {
    offset = to;
    onOffset?.(offset, false);
  };
  /** The reader scrolling there, by the wheel: TanStack takes the way they go from it. */
  const wheelTo = (to: number) => {
    offset = to;
    onOffset?.(offset, true);
  };
  const bottom = () => v.getTotalSize() - 100;
  /** `more` rows appended, as a new render hands TanStack its options. */
  const append = (more: number) => {
    options.count += more;
    v.setOptions(options);
    v._willUpdate();
  };
  return { v, top, scrollTo, wheelTo, bottom, append, offset: () => offset };
}

describe("VirtualList followOutput", () => {
  it("stays at the bottom while the last row grows in place (a streaming message)", () => {
    const { v, scrollTo, bottom, offset } = list(50, true);
    scrollTo(bottom());
    expect(offset()).toBe(bottom());
    v.resizeItem(49, 120);
    v.resizeItem(49, 400);
    expect(offset()).toBe(bottom());
  });

  it("leaves the view alone when the reader has scrolled up", () => {
    const { v, scrollTo, offset } = list(50, true);
    scrollTo(200);
    v.resizeItem(49, 400);
    expect(offset()).toBe(200);
  });

  it("does not pin without followOutput", () => {
    const { v, scrollTo, bottom, offset } = list(50, false);
    const end = bottom();
    scrollTo(end);
    v.resizeItem(49, 400);
    expect(offset()).toBe(end);
  });
});

describe("VirtualList: the reader leaving the end", () => {
  it("follows an append within the threshold of the end, but not once the reader has scrolled up from it", () => {
    // 10 px up from the end, within the 24 px threshold: taken for at the end, the reader is pulled back down to it.
    const near = list(50, true);
    near.scrollTo(near.bottom() - 10);
    near.append(1);
    expect(near.offset()).toBe(near.bottom());
    // The same 10 px, scrolled by the reader (readerLeft): the view stays where they put it.
    const leaving = list(50, true, true);
    const at = leaving.bottom() - 10;
    leaving.scrollTo(at);
    leaving.append(1);
    expect(leaving.offset()).toBe(at);
  });

  it("takes a scroll toward the start with the same sizes for the reader leaving, and the end for them back", () => {
    const end = { top: 900, height: 1000, view: 100 };
    expect(readerLeft(end, { ...end, top: 897 })).toBe(true);
    // Scrolled back down to the end (or the list put them there).
    expect(readerLeft({ ...end, top: 850 }, end)).toBe(false);
    // Further down but short of the end, it is still away.
    expect(readerLeft({ ...end, top: 800 }, { ...end, top: 850 })).toBeUndefined();
    // Moved up because the list changed size (a row above measured, a page landing): not the reader.
    expect(readerLeft(end, { ...end, top: 880, height: 1100 })).toBeUndefined();
    expect(readerLeft(end, { top: 880, height: 1000, view: 120 })).toBe(false);
  });
});

describe("VirtualList: a row above the view changing size", () => {
  it("moves the view with a row the view's top cuts through when the change came above what sits at that top (a picture loading)", () => {
    const { v, top, scrollTo, wheelTo, offset } = list(50, true, true);
    scrollTo(500);
    // Row 24 (480 to 500) measured once, above the view: the view moves with it.
    v.resizeItem(24, 30);
    expect(offset()).toBe(510);
    // Scrolling up, the view's top now cuts through it; its picture loads, 200 px more, all of it above what sits at
    // the view's top. What is on screen stays.
    wheelTo(495);
    top.moved = 200;
    v.resizeItem(24, 230);
    expect(offset()).toBe(695);
  });

  it("leaves the view where it is for a fold opened in view in a row the view's top cuts through (a diff's Show all)", () => {
    const { v, top, scrollTo, wheelTo, offset } = list(50, true, true);
    scrollTo(500);
    v.resizeItem(24, 30);
    wheelTo(495);
    // What sits at the view's top stayed where it was in its row: the lines opened under it.
    top.moved = 0;
    v.resizeItem(24, 430);
    expect(offset()).toBe(495);
    // Nothing known of what sits at the top: nothing moves either.
    top.moved = undefined;
    v.resizeItem(24, 30);
    expect(offset()).toBe(495);
  });

  it("moves the view with a row wholly above it while the reader scrolls up (an edit, a picture read again)", () => {
    const { v, scrollTo, wheelTo, offset } = list(50, true, true);
    scrollTo(500);
    v.resizeItem(10, 30);
    expect(offset()).toBe(510);
    wheelTo(490);
    v.resizeItem(10, 130);
    expect(offset()).toBe(590);
  });

  it("leaves the view where it is for the last row growing at its bottom while it reaches into the view (a reply streaming)", () => {
    const { v, top, scrollTo, wheelTo, offset } = list(50, true, true);
    scrollTo(800);
    v.resizeItem(49, 200);
    wheelTo(900);
    top.moved = 0;
    v.resizeItem(49, 400);
    expect(offset()).toBe(900);
  });

  it("leaves the view where it is for a row below its top", () => {
    const { v, scrollTo, offset } = list(50, true, true);
    scrollTo(500);
    v.resizeItem(26, 30);
    v.resizeItem(26, 230);
    expect(offset()).toBe(500);
  });
});
