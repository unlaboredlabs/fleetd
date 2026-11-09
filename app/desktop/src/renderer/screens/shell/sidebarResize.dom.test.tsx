// @vitest-environment happy-dom
// The sidebar's right edge, as the shell holds it (Shell.tsx): dragged or keyed within its bounds, kept across a
// relaunch, reset by a double-click, taken in by a narrowed window, and a drag that renders nothing in the sidebar.
import { act, useRef, type CSSProperties } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppFrame } from "../../ui";
import { SidebarEdge } from "./ResizeEdge";
import { useSidebarWidth } from "./sidebarWidth";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | null = null;
let renders = 0;

/** A window resized, and the frame after it. */
const viewport = (width: number) =>
  act(async () => {
    (window as unknown as { happyDOM: { setViewport: (v: { width: number; height: number }) => void } }).happyDOM.setViewport({ width, height: 900 });
    window.dispatchEvent(new Event("resize"));
    await new Promise((done) => requestAnimationFrame(done));
  });

function Rows() {
  renders++;
  return <nav>rows</nav>;
}

function Harness() {
  const frame = useRef<HTMLDivElement>(null);
  const [px, setPx] = useSidebarWidth();
  return (
    <div ref={frame} data-testid="root" style={{ "--sidebar-w": `${String(px)}px` } as CSSProperties}>
      <AppFrame topBar={<header />} sidebar={<Rows />} sidebarEdge={<SidebarEdge root={frame} width={px} onSet={setPx} />}>
        <p>chat</p>
      </AppFrame>
    </div>
  );
}

const mount = () => {
  root = createRoot(host);
  act(() => root?.render(<Harness />));
};
const unmount = () => {
  act(() => root?.unmount());
  root = null;
};

const edge = () => host.querySelector<HTMLElement>("[role='separator']");
const width = () => Number(edge()?.getAttribute("aria-valuenow"));
const variable = () => host.querySelector<HTMLElement>("[data-testid='root']")?.style.getPropertyValue("--sidebar-w");
const key = (k: string, shiftKey = false) =>
  act(() => {
    edge()?.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true, cancelable: true }));
  });
const pointer = (type: string, clientX: number) =>
  act(() => {
    edge()?.dispatchEvent(new PointerEvent(type, { clientX, button: 0, pointerId: 1, bubbles: true, cancelable: true }));
  });

beforeEach(async () => {
  window.localStorage.clear();
  await viewport(1400);
  host = document.createElement("div");
  document.body.appendChild(host);
  vi.spyOn(HTMLElement.prototype, "setPointerCapture").mockImplementation(() => undefined);
  vi.spyOn(HTMLElement.prototype, "hasPointerCapture").mockImplementation(() => true);
  vi.spyOn(HTMLElement.prototype, "releasePointerCapture").mockImplementation(() => undefined);
});
afterEach(() => {
  unmount();
  host.remove();
  vi.restoreAllMocks();
});

it("sits on the sidebar's edge as a focusable separator, at today's width", () => {
  mount();
  const e = edge();
  expect(e?.getAttribute("aria-label")).toBe("Resize the sidebar");
  expect(e?.getAttribute("aria-orientation")).toBe("vertical");
  expect(e?.getAttribute("aria-controls")).toBe("sidebar");
  expect(host.querySelector("#sidebar")).not.toBeNull();
  expect(e?.tabIndex).toBe(0);
  expect([e?.getAttribute("aria-valuemin"), e?.getAttribute("aria-valuemax")]).toEqual(["200", "420"]);
  expect(width()).toBe(264);
  expect(variable()).toBe("264px");
});

it("moves by the arrow keys (Right widens), Shift four steps, Home and End to its ends", () => {
  mount();
  key("ArrowRight");
  expect(width()).toBe(280);
  key("ArrowLeft", true);
  expect(width()).toBe(216);
  expect(variable()).toBe("216px");
  key("End");
  expect(width()).toBe(420);
  key("Home");
  expect(width()).toBe(200);
  key("Enter");
  expect(width()).toBe(264);
});

it("follows a drag on the frame's variable alone, and sets it once as it ends, within its bounds", () => {
  mount();
  const before = renders;
  pointer("pointerdown", 264);
  pointer("pointermove", 300);
  pointer("pointermove", 340);
  expect(variable()).toBe("340px");
  expect(edge()?.getAttribute("aria-valuenow")).toBe("340");
  // Nothing in the sidebar renders again mid-drag.
  expect(renders).toBe(before);
  expect(document.documentElement.dataset["resizing"]).toBe("");
  pointer("pointerup", 340);
  expect(width()).toBe(340);
  expect(document.documentElement.dataset["resizing"]).toBeUndefined();

  // Past either end it stops there.
  pointer("pointerdown", 340);
  pointer("pointermove", 1200);
  expect(variable()).toBe("420px");
  pointer("pointerup", 1200);
  expect(width()).toBe(420);
  pointer("pointerdown", 420);
  pointer("pointermove", 0);
  pointer("pointerup", 0);
  expect(width()).toBe(200);
});

it("keeps the width across a relaunch, and a double-click puts it back to the default for good", () => {
  mount();
  pointer("pointerdown", 264);
  pointer("pointermove", 330);
  pointer("pointerup", 330);
  unmount();
  mount();
  expect(width()).toBe(330);
  expect(variable()).toBe("330px");

  act(() => {
    edge()?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  expect(width()).toBe(264);
  unmount();
  mount();
  expect(width()).toBe(264);
  expect(window.localStorage.getItem("fleetd.sidebar.width")).toBeNull();
});

it("is taken in by a narrowed window, and given back as it widens", async () => {
  mount();
  key("End");
  expect(width()).toBe(420);
  await viewport(900);
  expect(width()).toBe(360);
  expect(edge()?.getAttribute("aria-valuemax")).toBe("360");
  expect(variable()).toBe("360px");
  await viewport(1400);
  expect(width()).toBe(420);
});
