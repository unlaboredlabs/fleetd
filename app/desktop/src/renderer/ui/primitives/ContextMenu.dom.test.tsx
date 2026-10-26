// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ContextMenu, ContextMenuCopy, ContextMenuItem, ContextMenuSub } from "./ContextMenu";
import o from "./Overlay.module.css";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A fade on a closed surface, which happy-dom never ends: as in the app when the surface's entrance went unseen, a
// closed menu or submenu left to Radix would wait for it and stay on screen.
const fade = document.createElement("style");
fade.textContent = `.${o.surface}[data-state="closed"] { animation-name: fade; animation-duration: 120ms; }`;
document.head.appendChild(fade);

const copy = vi.fn((_text: string) => Promise.resolve());
let host: HTMLDivElement;
let root: Root;
let opened: string[];

beforeEach(() => {
  vi.stubGlobal("fleetd", { platform: "linux", copy });
  copy.mockClear();
  opened = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root.render(
      <ContextMenu
        menu={() => (
          <>
            <ContextMenuItem onSelect={() => opened.push("row")}>Open</ContextMenuItem>
            <ContextMenuCopy text="fleetd/T1">Copy branch</ContextMenuCopy>
            <ContextMenuSub label="More">
              <ContextMenuItem onSelect={() => opened.push("more")}>Pin</ContextMenuItem>
            </ContextMenuSub>
          </>
        )}
      >
        <div data-row tabIndex={0}>
          <span data-words>The row’s words</span>
          <input aria-label="Field" />
          <ContextMenu menu={() => <ContextMenuItem onSelect={() => opened.push("link")}>Open link</ContextMenuItem>}>
            <a href="#/x">A link</a>
          </ContextMenu>
        </div>
      </ContextMenu>,
    ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.getSelection()?.removeAllRanges();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const el = (selector: string): HTMLElement => {
  const found = host.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`no ${selector}`);
  return found;
};
const rightClick = (target: Element): boolean => {
  const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
  act(() => {
    target.dispatchEvent(e);
  });
  return e.defaultPrevented;
};
const press = (target: Element, init: KeyboardEventInit) => {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  });
};
const items = () => [...document.querySelectorAll("[role='menuitem']")].map((i) => i.textContent);
const choose = async (label: string) => {
  const item = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find((i) => i.textContent === label);
  if (item === undefined) throw new Error(`no ${label}`);
  act(() => item.click());
  await act(() => Promise.resolve());
};

it("a right-click opens the menu, and an item runs and closes it", async () => {
  expect(rightClick(el("[data-words]"))).toBe(true);
  expect(document.querySelector("[role='menu']")).not.toBeNull();
  expect(items()).toEqual(["Open", "Copy branch", "More"]);
  await choose("Copy branch");
  expect(copy).toHaveBeenCalledWith("fleetd/T1");
  expect(document.querySelector("[role='menu']")).toBeNull();
});

it("opens from the keyboard: Shift+F10 and the Menu key", async () => {
  press(el("[data-row]"), { key: "F10", shiftKey: true });
  expect(items()).toEqual(["Open", "Copy branch", "More"]);
  await choose("Open");
  expect(opened).toEqual(["row"]);
  press(el("[data-row]"), { key: "ContextMenu" });
  expect(items()).toEqual(["Open", "Copy branch", "More"]);
  press(document.querySelector("[role='menu']") ?? document.body, { key: "Escape" });
  expect(document.querySelector("[role='menu']")).toBeNull();
  press(el("[data-row]"), { key: "F10" });
  expect(document.querySelector("[role='menu']")).toBeNull();
});

it("with text selected inside, Copy selection comes first", async () => {
  const range = document.createRange();
  range.selectNodeContents(el("[data-words]"));
  window.getSelection()?.addRange(range);
  rightClick(el("[data-words]"));
  expect(items()).toEqual(["Copy selection", "Open", "Copy branch", "More"]);
  await choose("Copy selection");
  expect(copy).toHaveBeenCalledWith("The row’s words");
});

it("an inner element's menu wins over its container's", async () => {
  rightClick(el("a"));
  expect(items()).toEqual(["Open link"]);
  await choose("Open link");
  expect(opened).toEqual(["link"]);
});

it("a text field inside keeps the native edit menu, by mouse or keyboard", () => {
  expect(rightClick(el("input"))).toBe(false);
  press(el("input"), { key: "F10", shiftKey: true });
  expect(document.querySelector("[role='menu']")).toBeNull();
});

it("copies only the part of a selection inside its own element", async () => {
  const range = document.createRange();
  range.setStart(el("[data-words]").firstChild ?? el("[data-words]"), 4);
  range.setEnd(el("a").firstChild ?? el("a"), 1);
  window.getSelection()?.addRange(range);
  rightClick(el("a"));
  expect(items()).toEqual(["Copy selection", "Open link"]);
  await choose("Copy selection");
  expect(copy).toHaveBeenCalledWith("A");
  rightClick(el("[data-words]"));
  await choose("Copy selection");
  expect(copy).toHaveBeenLastCalledWith("row’s wordsA");
});

it("a long press inside an inner element's menu opens only that menu", () => {
  vi.useFakeTimers();
  act(() => {
    el("a").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "touch", clientX: 10, clientY: 10 }));
    vi.advanceTimersByTime(800);
  });
  expect(document.querySelectorAll("[role='menu']")).toHaveLength(1);
  expect(items()).toEqual(["Open link"]);
});

it("a submenu leaves the page once it closes", () => {
  rightClick(el("[data-words]"));
  const more = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find((i) => i.textContent === "More");
  if (more === undefined) throw new Error("no More");
  act(() => more.click());
  expect(items()).toContain("Pin");
  press(document.querySelectorAll("[role='menu']")[1] ?? document.body, { key: "ArrowLeft" });
  expect(document.querySelectorAll("[role='menu']")).toHaveLength(1);
  expect(items()).not.toContain("Pin");
});
