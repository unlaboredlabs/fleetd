// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VirtualList } from "./VirtualList";

// happy-dom has no layout. The scroller is 100 px tall; a row is 60 px when its text says "tall", else 20 px.
const heightOf = (el: Element) => {
  if (el.getAttribute("role") === "list") return 100;
  if (el instanceof HTMLElement && el.dataset["index"] !== undefined) return el.textContent.includes("tall") ? 60 : 20;
  return 0;
};
const proto = HTMLElement.prototype;
const realRect = proto.getBoundingClientRect.bind(proto);
beforeEach(() => {
  vi.spyOn(proto, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const h = heightOf(this);
    return h ? new DOMRect(0, 0, 300, h) : realRect.call(this);
  });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: function (this: HTMLElement) { return heightOf(this); } });
  Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => 300 });
});

// The observer never reports: the race the fix closes is a row painted before the observer's report arrives.
class SilentResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", SilentResizeObserver);

const ITEMS = Array.from({ length: 200 }, (_, i) => (i % 3 === 0 ? `row ${String(i)} tall` : `row ${String(i)}`));
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

function rows() {
  return [...host.querySelectorAll<HTMLElement>("[data-index]")]
    .map((el) => ({ index: Number(el.dataset["index"]), top: Number(/translateY\(([-\d.]+)px\)/.exec(el.style.transform)?.[1]), h: heightOf(el) }))
    .sort((a, b) => a.index - b.index);
}

it("rows that mount mid-scroll sit at their measured positions, without waiting for the ResizeObserver", async () => {
  await act(async () => {
    root.render(<VirtualList items={ITEMS} getKey={(_, i) => i} estimateSize={20} overscan={2} renderItem={(t) => <span>{t}</span>} />);
    await Promise.resolve();
  });
  const scroller = host.querySelector<HTMLElement>("[role=list]");
  if (!scroller) throw new Error("no scroller");
  // A scroll far down: TanStack is "scrolling" now, so it doesn't measure the rows this mounts.
  await act(async () => {
    scroller.scrollTop = 3000;
    scroller.dispatchEvent(new Event("scroll"));
    await Promise.resolve();
  });
  const mounted = rows();
  expect(mounted.length).toBeGreaterThan(3);
  for (let i = 1; i < mounted.length; i++) {
    const prev = mounted[i - 1];
    const cur = mounted[i];
    if (!prev || !cur || cur.index !== prev.index + 1) continue;
    expect(cur.top, `row ${String(cur.index)} starts where row ${String(prev.index)} ends`).toBe(prev.top + prev.h);
  }
});
