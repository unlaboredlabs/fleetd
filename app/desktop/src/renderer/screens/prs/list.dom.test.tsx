// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PrRow } from "../../../shared/contracts";
import { TooltipProvider } from "../../ui/primitives/Tooltip";
import { forgetFolds } from "../panel/folds";
import { PrList } from "./PrList";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT = { machineId: "devbox", projectId: "storefront" };
const NOW = Date.parse("2026-10-19T10:30:00.000Z");

const row = (number: number, state: PrRow["state"]): PrRow => ({
  repo: "acme/storefront",
  number,
  url: `https://github.com/acme/storefront/pull/${number}`,
  title: `PR ${number}`,
  state,
  review: { state: "none", done: 0, needed: 0 },
  author: {},
  createdAt: "2026-10-19T08:00:00.000Z",
  updatedAt: "2026-10-19T10:00:00.000Z",
});

let host: HTMLDivElement;
let root: Root | undefined;

// happy-dom has no layout: the list is 400 px tall and a row 56 px, so the rows on screen render.
const heightOf = (el: Element): number => (el.getAttribute("role") === "list" ? 400 : el instanceof HTMLElement && el.dataset["index"] !== undefined ? 56 : 0);

beforeEach(() => {
  const proto = HTMLElement.prototype;
  const rect = proto.getBoundingClientRect.bind(proto);
  vi.spyOn(proto, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const h = heightOf(this);
    return h > 0 ? new DOMRect(0, 0, 400, h) : rect.call(this);
  });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: function (this: HTMLElement) { return heightOf(this); } });
  forgetFolds();
  host = document.createElement("div");
  document.body.appendChild(host);
});
afterEach(() => {
  unmount();
  host.remove();
  vi.restoreAllMocks();
});

const mount = async (rows: readonly PrRow[], { project = PROJECT, more = undefined as (() => void) | undefined } = {}) => {
  root = createRoot(host);
  act(() => {
    root?.render(
      <TooltipProvider>
        <PrList rows={rows} more={more === undefined ? undefined : { load: more, loading: false }} train={{ moving: [], state: "ready", retry: () => undefined }} project={project} nowMs={NOW} />
      </TooltipProvider>,
    );
  });
  await act(() => new Promise((done) => setTimeout(done, 0)));
};
function unmount() {
  act(() => root?.unmount());
  root = undefined;
}

const shown = () => [...host.querySelectorAll<HTMLAnchorElement>("a[data-pr]")].map((a) => Number(a.dataset["pr"]));
const fold = () => host.querySelector<HTMLButtonElement>("[data-group-label] button[aria-expanded]") ?? undefined;
const labels = () => [...host.querySelectorAll("[data-group-label]")].map((l) => l.textContent);
const click = async (b: HTMLButtonElement | undefined) => {
  if (b === undefined) throw new Error("no such button");
  act(() => b.click());
  await act(() => new Promise((done) => setTimeout(done, 0)));
};

it("is one list with nothing to choose above it: the open PRs, then the merged and closed ones folded under their count", async () => {
  await mount([row(11, "open"), row(12, "draft"), row(8, "merged"), row(7, "closed")]);
  expect(shown()).toEqual([11, 12]);
  expect(labels()).toEqual(["Open2", "Merged and closed2"]);
  expect(fold()?.getAttribute("aria-expanded")).toBe("false");
  // No filter and no tabs of its own: the fold is the list's one control.
  expect(host.querySelector("[role='tablist'], [role='tab'], [aria-pressed], select")).toBeNull();
  expect([...host.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Merged and closed2"]);

  await click(fold());
  expect(shown()).toEqual([11, 12, 8, 7]);
  expect(fold()?.getAttribute("aria-expanded")).toBe("true");

  // What the reader unfolded stays unfolded for the project's next list.
  unmount();
  await mount([row(11, "open"), row(8, "merged")]);
  expect(shown()).toEqual([11, 8]);
  await click(fold());
  expect(shown()).toEqual([11]);

  // Another project's list starts folded.
  unmount();
  await mount([row(11, "open"), row(8, "merged")], { project: { machineId: "devbox", projectId: "docs" } });
  expect(shown()).toEqual([11]);
});

it("keeps a row to its title, when, and where it stands; its repo, number and branch are its hover's", async () => {
  await mount([{ ...row(11, "open"), branch: "fleetd/T11-fix" }, { ...row(13, "open"), branch: "fleetd/T13-fix", queue: { changeId: "X13", length: 1, position: 0, state: "queued" } }]);
  const open = host.querySelector<HTMLAnchorElement>("a[data-pr='11']");
  const waiting = host.querySelector<HTMLAnchorElement>("a[data-pr='13']");
  // An open PR under Open says nothing more than its title and when.
  expect(open?.textContent).toBe("PR 1110:00");
  expect(waiting?.textContent).toBe("PR 1310:00waiting to merge");
  expect(host.textContent).not.toMatch(/storefront#|fleetd\/T1/u);
  act(() => waiting?.focus());
  expect(document.querySelector("[role='tooltip']")?.textContent).toBe("storefront#13 · fleetd/T13-fix");
});

it("says nothing is open in one line when only merged ones are left, with the fold under it", async () => {
  await mount([row(8, "merged")]);
  expect(shown()).toEqual([]);
  expect(host.querySelector("[data-list-note]")?.textContent).toBe("Nothing open.");
  await click(fold());
  expect(shown()).toEqual([8]);
});

it("still offers older PRs under a list with nothing open, since they may hold its PRs", async () => {
  const load = vi.fn();
  await mount([row(8, "merged")], { more: load });
  expect(host.textContent).toContain("Nothing open.");
  await click([...host.querySelectorAll("button")].find((b) => b.textContent === "Load more"));
  expect(load).toHaveBeenCalledOnce();
});

it("is one short line while there are no PRs at all", async () => {
  await mount([]);
  expect(host.querySelector("[data-panel-empty]")?.textContent).toBe("No pull requests yet");
  expect(host.querySelector("button")).toBeNull();
});

it("a row's right-click menu opens the PR here or on GitHub, and copies its URL and branch", async () => {
  const copy = vi.fn((_text: string) => Promise.resolve());
  const openExternal = vi.fn((_url: string) => Promise.resolve({ ok: true }));
  vi.stubGlobal("fleetd", { platform: "linux", copy, openExternal });
  await mount([{ ...row(11, "open"), branch: "fleetd/T11-fix" }]);
  const link = host.querySelector<HTMLAnchorElement>("a[data-pr='11']");
  if (link === null) throw new Error("no row");
  const choose = async (label: string) => {
    act(() => {
      link.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    });
    const item = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find((i) => i.textContent === label);
    if (item === undefined) throw new Error(`no ${label}`);
    act(() => item.click());
    await act(() => Promise.resolve());
  };
  act(() => {
    link.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  });
  expect([...document.querySelectorAll("[role='menuitem']")].map((i) => i.textContent)).toEqual(["Open", "Open on GitHub", "Copy URL", "Copy branch"]);
  act(() => {
    document.querySelector("[role='menu']")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  window.location.hash = "";
  await choose("Open");
  expect(window.location.hash).toBe(link.getAttribute("href"));
  await choose("Open on GitHub");
  expect(openExternal).toHaveBeenCalledWith("https://github.com/acme/storefront/pull/11");
  await choose("Copy URL");
  await choose("Copy branch");
  expect(copy.mock.calls).toEqual([["https://github.com/acme/storefront/pull/11"], ["fleetd/T11-fix"]]);
  vi.unstubAllGlobals();
});
