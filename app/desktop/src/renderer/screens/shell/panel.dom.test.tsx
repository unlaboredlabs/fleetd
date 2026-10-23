// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { PrGetOutput, PrRow } from "../../../shared/contracts";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { AT, live, snapshot } from "../../src/data/fixtures.test-util";
import { TooltipProvider } from "../../ui/primitives/Tooltip";
import { useRoute } from "./navigation";
import { PanelSlot, PanelToggle, useProjectPanel } from "./panel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CHAT = "#/project/devbox/storefront";

const pr: PrRow = {
  repo: "acme/storefront",
  number: 11,
  url: "https://github.com/acme/storefront/pull/11",
  title: "Receipts show the shop's local time",
  state: "open",
  review: { state: "pending", done: 1, needed: 3 },
  author: { role: "implementer" },
  createdAt: AT,
  updatedAt: AT,
};
const detail: PrGetOutput = { pr, body: "", checks: [], reviews: [], history: [], links: { checks: "", files: "", pr: pr.url } };

const ANSWERS: Readonly<Record<string, unknown>> = {
  pr_list: { at: AT, prs: [pr] },
  pr_get: detail,
  agents_list: { at: AT, agents: [] },
};

let host: HTMLDivElement;
let root: Root | undefined;

// The panel's own chunk, loaded once up front as the app's first opening would, so each step waits on answers only.
beforeAll(async () => {
  await import("../panel/ProjectPanel");
});

/** happy-dom's window size, which its media queries follow. */
const viewport = (width: number) =>
  (window as unknown as { happyDOM: { setViewport: (v: { width: number; height: number }) => void } }).happyDOM.setViewport({ width, height: 900 });

// happy-dom has no layout: the lists are 400 px tall and a row 56 px, so the rows on screen render.
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
  window.localStorage.clear();
  viewport(1400);
  window.location.hash = CHAT;
  host = document.createElement("div");
  document.body.appendChild(host);
});
afterEach(() => {
  unmount();
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Harness() {
  const panel = useProjectPanel(useRoute());
  return (
    <TooltipProvider>
      <PanelToggle panel={panel} />
      <PanelSlot panel={panel} />
    </TooltipProvider>
  );
}

/** The panel's frame on a hub that answers at once: a launch of the app. */
const mount = async () => {
  let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;
  const hub: HubApi = {
    call: (tool) => Promise.resolve({ ok: true, output: ANSWERS[tool] ?? {} }),
    subscribe: (l) => ((send = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  const layer = createDataLayer(hub);
  root = createRoot(host);
  act(() => {
    root?.render(
      <DataProvider layer={layer}>
        <Harness />
      </DataProvider>,
    );
  });
  act(() => {
    send(live());
    send(snapshot(1));
  });
  await settle();
};

function unmount() {
  act(() => root?.unmount());
  root = undefined;
}

/** Lets the panel's chunk load and the hub's answers land. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await act(() => new Promise((done) => setTimeout(done, 0)));
};

const panel = () => host.querySelector("aside[aria-label='Agents and pull requests']");
const button = (name: string) => [...host.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === name || b.textContent === name);
const click = async (name: string) => {
  const b = button(name);
  if (b === undefined) throw new Error(`no button "${name}"`);
  act(() => b.click());
  await settle();
};
const go = async (hash: string) => {
  act(() => {
    window.location.hash = hash;
  });
  await settle();
};
const press = async (key: string) => {
  const target = document.activeElement !== null && panel()?.contains(document.activeElement) ? document.activeElement : panel();
  act(() => {
    target?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
  await settle();
};
const resize = async (width: number) => {
  act(() => viewport(width));
  await settle();
};

it("opens and closes with its toggle, as the window left it last launch", async () => {
  await mount();
  expect(panel()).toBeNull();
  await click("Show agents and PRs");
  expect(panel()).not.toBeNull();
  expect(button("Hide agents and PRs")?.getAttribute("aria-pressed")).toBe("true");

  unmount();
  await mount();
  expect(panel()).not.toBeNull();
  await click("Hide agents and PRs");
  expect(panel()).toBeNull();

  unmount();
  await mount();
  expect(panel()).toBeNull();
});

it("opens on a PR a link names, goes back to the list, and Esc steps back out", async () => {
  await mount();
  await go(`${CHAT}/prs`);
  expect(panel()?.querySelector("[data-screen='prs']")).not.toBeNull();

  const row = panel()?.querySelector<HTMLAnchorElement>("a[data-pr='11']");
  expect(row?.getAttribute("href")).toBe(`${CHAT}/prs/acme/storefront/11`);
  await go(row?.getAttribute("href") ?? "");
  expect(panel()?.querySelector("[data-screen^='prs.detail']")).not.toBeNull();

  await click("All pull requests");
  expect(window.location.hash).toBe(`${CHAT}/prs`);
  expect(panel()?.querySelector("a[data-pr='11']")).not.toBeNull();

  // Esc: from the PR to the list, then the panel closes and the route no longer names it, so the link opens it again.
  await go(`${CHAT}/prs/11`);
  await press("Escape");
  expect(window.location.hash).toBe(`${CHAT}/prs`);
  await press("Escape");
  expect(panel()).toBeNull();
  expect(window.location.hash).toBe(CHAT);
  expect(document.activeElement).toBe(button("Show agents and PRs"));
  await go(`${CHAT}/prs`);
  expect(panel()).not.toBeNull();
});

it("hides itself in a narrow window, shows there with its toggle, and widening restores the wide choice", async () => {
  await mount();
  await click("Show agents and PRs");
  await resize(900);
  expect(panel()).toBeNull();
  await click("Show agents and PRs");
  expect(panel()).not.toBeNull();
  // Narrowed again later, it hides again; widened, it is as you left it there.
  await resize(1400);
  await resize(900);
  expect(panel()).toBeNull();
  await resize(1400);
  expect(panel()).not.toBeNull();
});
