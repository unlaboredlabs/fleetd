// @vitest-environment happy-dom
// Right-click menus inside rendered markdown: a link opens or copies, a code block copies.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "../primitives/Tooltip";
import { Markdown } from "./Markdown";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const copy = vi.fn((_text: string) => Promise.resolve());
const openExternal = vi.fn((_url: string) => Promise.resolve({ ok: true }));
let host: HTMLDivElement;
let root: Root;

beforeAll(async () => {
  await import("./MarkdownBody");
});
beforeEach(async () => {
  vi.stubGlobal("fleetd", { platform: "linux", copy, openExternal });
  copy.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root.render(
      <TooltipProvider>
        <Markdown source={"See [the docs](https://fleetd.sh/docs) or [PR #12](#/project/devbox/storefront/prs/acme/storefront/12).\n\n```sh\npnpm test\n```\n"} />
      </TooltipProvider>,
    ),
  );
  for (let i = 0; i < 3; i++) await act(() => new Promise((done) => setTimeout(done, 0)));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const menuOn = (target: Element | null): HTMLElement[] => {
  if (target === null) throw new Error("nothing to right-click");
  act(() => {
    target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  });
  return [...document.querySelectorAll<HTMLElement>("[role='menuitem']")];
};
const choose = async (items: HTMLElement[], label: string) => {
  act(() => items.find((i) => i.textContent === label)?.click());
  await act(() => Promise.resolve());
};

it("a link opens in the browser or copies", async () => {
  const link = host.querySelector("a[href^='https']");
  expect(menuOn(link).map((i) => i.textContent)).toEqual(["Open link", "Copy link"]);
  await choose(menuOn(link), "Open link");
  expect(openExternal).toHaveBeenCalledWith("https://fleetd.sh/docs");
  await choose(menuOn(link), "Copy link");
  expect(copy).toHaveBeenCalledWith("https://fleetd.sh/docs");
});

it("an app link opens in the app", async () => {
  window.location.hash = "";
  const link = host.querySelector("a[href^='#/']");
  await choose(menuOn(link), "Open link");
  expect(window.location.hash).toBe("#/project/devbox/storefront/prs/acme/storefront/12");
});

it("a code block copies its code", async () => {
  await choose(menuOn(host.querySelector("pre")), "Copy code");
  expect(copy).toHaveBeenCalledWith("pnpm test");
});
