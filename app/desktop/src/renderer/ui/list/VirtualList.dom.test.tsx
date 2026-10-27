// @vitest-environment happy-dom
import type { Virtualizer } from "@tanstack/react-virtual";
import { act, createRef } from "react";
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

// The rows on screen, in order, each with the start and size the virtualizer counts it at.
function rows(v: Virtualizer<HTMLDivElement, Element>) {
  const counted = new Map(v.getVirtualItems().map((r) => [r.index, r]));
  return [...host.querySelectorAll<HTMLElement>("[data-index]")].map((el) => {
    const index = Number(el.dataset["index"]);
    return { index, h: heightOf(el), start: counted.get(index)?.start, size: counted.get(index)?.size, el };
  });
}

it("rows that mount mid-scroll are counted at their measured sizes, without waiting for the ResizeObserver", async () => {
  const v = createRef<Virtualizer<HTMLDivElement, Element>>();
  await act(async () => {
    root.render(<VirtualList items={ITEMS} getKey={(_, i) => i} estimateSize={20} overscan={2} virtualizerRef={v} renderItem={(t) => <span>{t}</span>} />);
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
  const virtualizer = v.current;
  if (!virtualizer) throw new Error("no virtualizer");
  const mounted = rows(virtualizer);
  expect(mounted.length).toBeGreaterThan(3);
  for (const row of mounted) expect(row.size, `row ${String(row.index)}'s size`).toBe(row.h);
  // They stack in flow under the first one's start: none is placed by a size it no longer has.
  const first = mounted[0];
  expect(first?.el.parentElement?.style.transform).toBe(`translateY(${String(first?.start)}px)`);
  expect(new Set(mounted.map((r) => r.el.parentElement)).size).toBe(1);
  expect(mounted.every((r) => r.el.style.transform === "")).toBe(true);
});
