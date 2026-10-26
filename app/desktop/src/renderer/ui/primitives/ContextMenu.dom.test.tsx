// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ContextMenu, ContextMenuCopy, ContextMenuItem } from "./ContextMenu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  expect(items()).toEqual(["Open", "Copy branch"]);
  await choose("Copy branch");
  expect(copy).toHaveBeenCalledWith("fleetd/T1");
  expect(document.querySelector("[role='menu']")).toBeNull();
});

it("opens from the keyboard: Shift+F10 and the Menu key", async () => {
  press(el("[data-row]"), { key: "F10", shiftKey: true });
  expect(items()).toEqual(["Open", "Copy branch"]);
  await choose("Open");
  expect(opened).toEqual(["row"]);
  press(el("[data-row]"), { key: "ContextMenu" });
  expect(items()).toEqual(["Open", "Copy branch"]);
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
  expect(items()).toEqual(["Copy selection", "Open", "Copy branch"]);
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
