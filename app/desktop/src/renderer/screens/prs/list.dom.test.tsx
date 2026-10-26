// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PrRow } from "../../../shared/contracts";
import { TooltipProvider } from "../../ui/primitives/Tooltip";
import { PrList, forgetFilters } from "./PrList";

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
  forgetFilters();
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
        <PrList rows={rows} more={more === undefined ? undefined : { load: more, loading: false }} project={project} nowMs={NOW} />
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
const filter = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("[aria-label='Show'] button")].find((b) => b.textContent.startsWith(label));
const click = async (b: HTMLButtonElement | undefined) => {
  if (b === undefined) throw new Error("no such button");
  act(() => b.click());
  await act(() => new Promise((done) => setTimeout(done, 0)));
};

it("opens on the open PRs, filters to merged or all, and keeps the reader's filter for the next list", async () => {
  await mount([row(11, "open"), row(12, "draft"), row(8, "merged"), row(7, "closed")]);
  expect(shown()).toEqual([11, 12]);
  expect(filter("Open")?.getAttribute("aria-pressed")).toBe("true");
  expect(filter("Open")?.textContent).toBe("Open2");

  await click(filter("Merged"));
  expect(shown()).toEqual([8]);
  expect(filter("Merged")?.getAttribute("aria-pressed")).toBe("true");

  await click(filter("All"));
  expect(shown()).toEqual([11, 12, 8, 7]);
  expect(host.textContent).toContain("Merged or closed");

  unmount();
  await mount([row(11, "open"), row(8, "merged")]);
  expect(shown()).toEqual([11, 8]);

  // Another project's list opens on its own filter.
  unmount();
  await mount([row(11, "open"), row(8, "merged")], { project: { machineId: "devbox", projectId: "docs" } });
  expect(shown()).toEqual([11]);
});

it("says a filter with nothing in it is empty, and offers one that has rows", async () => {
  await mount([row(8, "merged")]);
  expect(shown()).toEqual([]);
  expect(host.textContent).toContain("Nothing open");
  await click([...host.querySelectorAll("button")].find((b) => b.textContent === "Show merged"));
  expect(shown()).toEqual([8]);
});

it("still offers older PRs when a filter is empty, since they may hold its PRs", async () => {
  const load = vi.fn();
  await mount([row(8, "merged")], { more: load });
  expect(host.textContent).toContain("Nothing open");
  await click([...host.querySelectorAll("button")].find((b) => b.textContent === "Load more"));
  expect(load).toHaveBeenCalledOnce();
});

it("has no filter while there are no PRs at all", async () => {
  await mount([]);
  expect(host.querySelector("[aria-label='Show']")).toBeNull();
  expect(host.textContent).toContain("No pull requests yet");
});
