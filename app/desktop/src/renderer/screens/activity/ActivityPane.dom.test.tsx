// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EventsListInput, EventsListOutput, HubEvent } from "../../../shared/contracts";
import type { HubError } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { live, project, snapshot } from "../../src/data/fixtures.test-util";
import { TooltipProvider } from "../../ui/primitives/Tooltip";
import { ActivityPane, useActivityUnread } from "./index";

const START = Date.parse("2026-10-19T15:00:00.000Z");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom has no layout: the list is 400 px tall and a row 28 px, so the rows on screen render.
const heightOf = (el: Element): number => (el.getAttribute("role") === "list" ? 400 : el instanceof HTMLElement && el.dataset["index"] !== undefined ? 28 : 0);

let host: HTMLDivElement;
let root: Root;
const reads: EventsListInput[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  const proto = HTMLElement.prototype;
  const rect = proto.getBoundingClientRect.bind(proto);
  vi.spyOn(proto, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const h = heightOf(this);
    return h > 0 ? new DOMRect(0, 0, 400, h) : rect.call(this);
  });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: function (this: HTMLElement) { return heightOf(this); } });
  window.localStorage.clear();
  reads.length = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const ev = (seq: number, type: string, data: Record<string, unknown>, summary: string = type, minutesAgo = 100 - seq): HubEvent => ({
  seq,
  at: new Date(START - minutesAgo * 60_000).toISOString(),
  type,
  summary,
  ...project,
  data,
});

type Send = Parameters<HubApi["subscribe"]>[0];
type Answer = (input: EventsListInput) => { ok: true; output: EventsListOutput } | { ok: false; error: HubError };

const page = (events: HubEvent[], more = false) => ({ ok: true as const, output: { events, more } });

function Unread() {
  return <span data-unread>{useActivityUnread(project)}</span>;
}

/** The pane on a hub whose events_list answers with `answer`; returns the hub's sender. */
const mount = async (answer: Answer): Promise<Send> => {
  let send: Send = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      if (tool === "events_list") {
        reads.push(input as EventsListInput);
        return Promise.resolve(answer(input as EventsListInput));
      }
      return Promise.resolve({ ok: true, output: { at: new Date(START).toISOString(), orders: [], trains: [] } });
    },
    subscribe: (l) => ((send = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  const layer = createDataLayer(hub);
  act(() => {
    root.render(
      <DataProvider layer={layer}>
        <TooltipProvider>
          <ActivityPane project={project} />
          <Unread />
        </TooltipProvider>
      </DataProvider>,
    );
  });
  await act(async () => {
    send(live());
    send(snapshot(1));
    await vi.advanceTimersByTimeAsync(0);
  });
  return send;
};

const settle = () => act(() => vi.advanceTimersByTimeAsync(0));
const texts = () => [...host.querySelectorAll("[data-event], [data-run], [role=heading], [role=separator]")].map((el) => el.textContent.replace(/\d\d:\d\d$/u, "").trim());

const FIRST = [
  ev(9, "pr.merged", { repo: "acme/storefront", prNumber: 31, base: "main" }),
  ev(8, "review.verdict", { taskId: "T41", blocking: 0, pr: "https://github.com/acme/storefront/pull/31" }),
  ev(7, "review.verdict", { taskId: "T40", blocking: 2, pr: "https://github.com/acme/storefront/pull/31" }),
  ev(6, "task.completed", { taskId: "T12" }, "T12 completed: Receipt dates in the shop's zone"),
];

it("shows the project's events newest first, a run folded, each linking to its agent or PR", async () => {
  await mount(() => page(FIRST));
  expect(reads[0]).toMatchObject({ projectRef: project, hubWide: true, limit: 50 });
  expect(reads[0]?.before).toBeUndefined();
  expect(texts()).toEqual(["Today", "Merged #31 into main", "2 reviews of #31Latest: Review of #31 passed", "T12 finishedReceipt dates in the shop's zone"]);
  expect(host.querySelector("[data-event='9']")?.getAttribute("href")).toBe("#/project/devbox/storefront/prs/acme/storefront/31");
  expect(host.querySelector("[data-event='6']")?.getAttribute("href")).toBe("#/project/devbox/storefront/agents/T12");

  const run = host.querySelector<HTMLButtonElement>("[data-run]");
  expect(run?.getAttribute("aria-expanded")).toBe("false");
  act(() => run?.click());
  expect(host.querySelector("[data-run]")?.getAttribute("aria-expanded")).toBe("true");
  expect(texts()).toContain("Review of #31: 2 blocking findings");
});

it("reads only the chosen kinds, and says so when there are none", async () => {
  await mount((input) => page(input.types?.includes("task.completed") === true ? FIRST : []));
  const chip = [...host.querySelectorAll("button")].find((b) => b.textContent === "Asks you");
  act(() => chip?.click());
  await settle();
  expect(reads.at(-1)).toMatchObject({ types: ["request.opened", "request.updated"], hubWide: false });
  expect(host.textContent).toContain("Nothing of this kind");
  const all = [...host.querySelectorAll("button")].find((b) => b.textContent === "Show everything");
  act(() => all?.click());
  await settle();
  expect(texts()[1]).toBe("Merged #31 into main");
});

it("puts a streamed event on top without reading again, and counts it unread until the feed shows it", async () => {
  const send = await mount(() => page(FIRST));
  const before = reads.length;
  await act(async () => {
    send({ t: "event", event: ev(12, "task.failed", { taskId: "T13" }, "T13 failed: Cart page", 1) });
    send({ t: "event", event: { ...ev(13, "task.started", { taskId: "T99" }), projectId: "elsewhere" } });
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(texts()[1]).toBe("T13 failedCart page");
  expect(texts()).not.toContain("T99 started");
  expect(reads.length).toBe(before);
  // The pane is open: what it shows is seen.
  expect(host.querySelector("[data-unread]")?.textContent).toBe("0");
  expect(window.localStorage.getItem("fleetd.seenActivity")).toBe(JSON.stringify({ "devbox/storefront": 12 }));
});

it("draws the divider under what came in since the last look", async () => {
  window.localStorage.setItem("fleetd.seenActivity", JSON.stringify({ "devbox/storefront": 8 }));
  await mount(() => page(FIRST));
  expect(texts().slice(0, 4)).toEqual(["Today", "Merged #31 into main", "Since you last looked", "2 reviews of #31Latest: Review of #31 passed"]);
});

it("loads older events as the end of the list comes into view, and then says where the log ends", async () => {
  const older = [ev(3, "task.started", { taskId: "T12" }, "T12 started (high): Receipt dates", 60 * 30)];
  await mount((input) => (input.before === undefined ? page(FIRST, true) : page(older)));
  await settle();
  expect(reads.map((r) => r.before)).toEqual([undefined, 6]);
  expect(texts().slice(-2)).toEqual(["Yesterday", "T12 startedReceipt dates"]);
  expect(host.textContent).toContain("That’s everything from the last 30 days.");
});

it("stops asking for an older page that keeps failing, and offers Retry", async () => {
  const older = [ev(3, "task.started", { taskId: "T12" }, "T12 started (high): Receipt dates", 60 * 30)];
  let down = true;
  await mount((input) =>
    input.before === undefined ? page(FIRST, true) : down ? { ok: false, error: { code: "failed", message: "The hub couldn't read its event log" } } : page(older),
  );
  // The read's own retries, then nothing more however long it waits.
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  const tried = reads.length;
  expect(reads.filter((r) => r.before === 6).length).toBe(3);
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(reads.length).toBe(tried);
  const retry = [...host.querySelectorAll("button")].find((b) => b.textContent === "Couldn’t load older activity. Retry");
  expect(retry).toBeDefined();
  expect(host.textContent).not.toContain("Loading older activity");

  down = false;
  act(() => retry?.click());
  await settle();
  expect(texts().slice(-2)).toEqual(["Yesterday", "T12 startedReceipt dates"]);
  expect(host.textContent).toContain("That’s everything from the last 30 days.");
});

it("says when nothing has happened, and when the hub can't list activity", async () => {
  await mount(() => page([]));
  expect(host.textContent).toContain("Nothing has happened yet");
  act(() => root.unmount());
  root = createRoot(host);
  await mount(() => ({ ok: false, error: { code: "not_found", message: "No tool events_list." } }));
  expect(host.textContent).toContain("This hub is older than the app");
});
