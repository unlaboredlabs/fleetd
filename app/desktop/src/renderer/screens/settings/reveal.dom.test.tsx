// @vitest-environment happy-dom
// A reveal holds its place: the element a link or a search opens is scrolled to when its page shows it, and again each
// time the page around it changes size (what is over it was still loading), until the person scrolls, clicks or types.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { revealNext, useReveal } from "./reveal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
// Every observer made, with what it watches; `disconnect` empties it.
let observers: { readonly cb: ResizeObserverCallback; readonly watched: Set<Element> }[];
const scrolls: ScrollIntoViewOptions[] = [];

beforeEach(() => {
  observers = [];
  scrolls.length = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      readonly own: (typeof observers)[number];
      constructor(cb: ResizeObserverCallback) {
        this.own = { cb, watched: new Set() };
        observers.push(this.own);
      }
      observe(el: Element) {
        this.own.watched.add(el);
      }
      unobserve() {}
      disconnect() {
        this.own.watched.clear();
      }
    },
  );
  HTMLElement.prototype.scrollIntoView = function (options?: boolean | ScrollIntoViewOptions) {
    scrolls.push(typeof options === "object" ? options : {});
  };
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  revealNext(null);
  vi.unstubAllGlobals();
});

/** The page's sections changed size: every observer still watching something hears of it. */
const resize = () => {
  for (const o of observers) if (o.watched.size > 0) o.cb([], {} as ResizeObserver);
};

function Page({ whole }: { whole: boolean }) {
  const ref = useReveal<HTMLDivElement>("part", whole);
  return (
    <div id="scroll">
      <div id="column">
        <div id="above" />
        <div ref={ref} id="part" tabIndex={-1}>
          <button type="button">Add</button>
        </div>
      </div>
    </div>
  );
}

const open = (whole: boolean) => {
  revealNext("part");
  act(() => root.render(<Page whole={whole} />));
};

it("brings a part to the top again when what is over it arrives, and takes the focus itself", () => {
  open(true);
  expect(scrolls).toEqual([{ block: "start" }]);
  expect(document.activeElement?.id).toBe("part");
  // The page around it is watched, up to its scroller, not the part itself.
  expect([...(observers[0]?.watched ?? [])].map((el) => el.id)).toEqual(["column", "scroll", ""]);
  resize();
  resize();
  expect(scrolls).toEqual([{ block: "start" }, { block: "start" }, { block: "start" }]);
});

it("keeps an option in view the same way, with its first control in focus", () => {
  open(false);
  expect(document.activeElement?.textContent).toBe("Add");
  resize();
  expect(scrolls).toEqual([{ block: "nearest" }, { block: "nearest" }]);
});

it.each(["wheel", "pointerdown", "keydown", "touchstart"])("lets go once the person takes the page over (%s)", (type) => {
  open(true);
  window.dispatchEvent(new Event(type));
  resize();
  expect(scrolls).toHaveLength(1);
});

it("lets go when the page closes, and holds nothing nobody asked for", () => {
  open(true);
  act(() => root.render(null));
  resize();
  expect(scrolls).toHaveLength(1);
  act(() => root.render(<Page whole />));
  expect(scrolls).toHaveLength(1);
  expect(observers.filter((o) => o.watched.size > 0)).toEqual([]);
});
