// @vitest-environment happy-dom
// The PR list pages back: Load more reads the page after the first with its cursor, adds the older PRs under it, and
// goes once the last page is in.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PrListInput, PrRow } from "../../../shared/contracts";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { AT, live, snapshot } from "../../src/data/fixtures.test-util";
import { TooltipProvider } from "../../ui/primitives/Tooltip";
import { forgetFilters } from "./PrList";
import { PrsPane } from "./PrsPane";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const project = { machineId: "devbox", projectId: "storefront" };
const pr = (number: number, state: PrRow["state"]): PrRow => ({
  repo: "acme/storefront",
  number,
  url: `https://github.com/acme/storefront/pull/${number}`,
  title: `PR ${number}`,
  state,
  review: { state: "pending", done: 0, needed: 1 },
  author: { role: "implementer" },
  createdAt: AT,
  updatedAt: AT,
});

let host: HTMLDivElement;
let root: Root | undefined;
let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;

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
  vi.stubGlobal("fleetd", { platform: "darwin", fixture: null });
  forgetFilters();
  host = document.createElement("div");
  document.body.appendChild(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const settle = async () => {
  for (let i = 0; i < 5; i++) await act(() => new Promise((done) => setTimeout(done, 0)));
};
const numbers = () => [...host.querySelectorAll("a[data-pr]")].map((a) => Number(a.getAttribute("data-pr")));
const loadMore = () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Load more");

it("loads older PRs past the first page, and stops at the last", async () => {
  const asked: PrListInput[] = [];
  const hub: HubApi = {
    call: (tool, input) => {
      if (tool !== "pr_list") return Promise.resolve({ ok: true, output: {} });
      const { cursor } = input as PrListInput;
      asked.push(input as PrListInput);
      // The first page ends at #9; the next holds the older ones, #9 again among them (it moved while paging).
      const output =
        cursor === undefined
          ? { at: AT, prs: [pr(12, "open"), pr(10, "merged"), pr(9, "merged")], nextCursor: "c|2026-10-01T00:00:00.000Z|9|acme/storefront", truncated: true }
          : { at: AT, prs: [pr(9, "merged"), pr(5, "closed"), pr(2, "merged")] };
      return Promise.resolve({ ok: true, output });
    },
    subscribe: (l) => ((send = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  root = createRoot(host);
  act(() => {
    root?.render(
      <DataProvider layer={createDataLayer(hub)}>
        <TooltipProvider>
          <PrsPane project={project} pr={null} tab="overview" onTab={() => undefined} />
        </TooltipProvider>
      </DataProvider>,
    );
  });
  act(() => {
    send(live());
    send(snapshot(1));
  });
  await settle();
  // Every PR, not only the open ones the list starts on.
  const all = [...host.querySelectorAll<HTMLButtonElement>("[aria-label='Show'] button")].find((b) => b.textContent.startsWith("All"));
  act(() => all?.click());
  await settle();
  expect(numbers()).toEqual([12, 10, 9]);
  const more = loadMore();
  expect(more).toBeDefined();
  act(() => more?.click());
  await settle();
  expect(asked.at(-1)).toEqual({ projectRef: project, cursor: "c|2026-10-01T00:00:00.000Z|9|acme/storefront" });
  expect(numbers()).toEqual([12, 10, 9, 5, 2]);
  expect(loadMore()).toBeUndefined();
});
