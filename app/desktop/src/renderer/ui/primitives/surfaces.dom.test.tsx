// @vitest-environment happy-dom
// The dropdown menu and the popover, which share the context menu's surface, leave the page the moment they close.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "./Menu";
import o from "./Overlay.module.css";
import { Popover, PopoverContent, PopoverTrigger } from "./Popover";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A fade on a closed surface, which happy-dom never ends: as in the app when the surface's entrance went unseen, a
// closed menu or popover left to Radix would wait for it and stay on screen.
const fade = document.createElement("style");
fade.textContent = `.${o.surface}[data-state="closed"] { animation-name: fade; animation-duration: 120ms; }`;
document.head.appendChild(fade);

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root.render(
      <>
        <Menu>
          <MenuTrigger data-menu>Filter</MenuTrigger>
          <MenuContent>
            <MenuItem>Mine</MenuItem>
          </MenuContent>
        </Menu>
        <Popover>
          <PopoverTrigger data-popover>Hub</PopoverTrigger>
          <PopoverContent aria-label="Hub">Connected</PopoverContent>
        </Popover>
      </>,
    ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const el = (selector: string): HTMLElement => {
  const found = host.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`no ${selector}`);
  return found;
};
const surface = () => document.querySelector(`.${o.surface}`);

it("a dropdown menu leaves the page once a choice closes it", () => {
  act(() => {
    el("[data-menu]").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }));
  });
  const item = document.querySelector<HTMLElement>("[role='menuitem']");
  expect(item?.textContent).toBe("Mine");
  act(() => item?.click());
  expect(surface()).toBeNull();
});

it("a popover leaves the page once it closes", () => {
  act(() => el("[data-popover]").click());
  expect(surface()?.textContent).toBe("Connected");
  act(() => el("[data-popover]").click());
  expect(surface()).toBeNull();
});
