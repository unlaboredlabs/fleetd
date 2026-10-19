import { Virtualizer, type VirtualizerOptions } from "@tanstack/react-virtual";
import { describe, expect, it } from "vitest";
import { followOptions } from "./VirtualList";

// A virtualizer over a fake 100 px viewport: TanStack's core with the DOM hooks replaced, so the pinning logic
// that VirtualList configures runs for real without a browser.
function list(count: number, follow: boolean) {
  let offset = 0;
  let onOffset: ((offset: number, scrolling: boolean) => void) | undefined;
  const fakeEl = { scrollTop: 0, ownerDocument: { defaultView: globalThis } } as unknown as HTMLDivElement;
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
    ...followOptions(follow),
  };
  const v = new Virtualizer(options);
  v._didMount();
  v._willUpdate();
  const scrollTo = (to: number) => {
    offset = to;
    onOffset?.(offset, false);
  };
  const bottom = () => v.getTotalSize() - 100;
  return { v, scrollTo, bottom, offset: () => offset };
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
