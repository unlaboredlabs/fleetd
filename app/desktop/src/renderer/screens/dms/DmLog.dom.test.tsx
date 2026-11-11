// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { live, project, snapshot } from "../../src/data/fixtures.test-util";
import { TooltipProvider } from "../../ui/primitives/Tooltip";
import { ActivityPane } from "../activity";
import type { AgentMessage } from "./model";

const START = Date.parse("2026-11-08T23:30:00.000Z");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom has no layout: the list is 400 px tall and a row 28 px, so the rows on screen render.
const heightOf = (el: Element): number => (el.getAttribute("role") === "list" ? 400 : el instanceof HTMLElement && el.dataset["index"] !== undefined ? 28 : 0);

let host: HTMLDivElement;
let root: Root;
const reads: { tool: string; input: Record<string, unknown> }[] = [];

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

const at = (hhmm: string) => `2026-11-08T${hhmm}:00.000Z`;

/** Newest first, as agent_messages answers. */
const MESSAGES: AgentMessage[] = [
  {
    id: "M14",
    from: { taskId: "T2573", title: "Quiet update states on the phone" },
    text: "Verified in the iOS simulator: SocketRocket rejects close code 1012. Use 1001 for the restart close.",
    sentAt: at("23:02"),
    to: [
      { taskId: "T2577", title: "A stopping hub closes node links as a restart", outcome: "delivered", at: at("23:02") },
      { taskId: "T2576", title: "Agents’ tool calls ride through a restart", outcome: "delivered", at: at("23:03") },
      { taskId: "T2574", title: "Automatic updates install when a build is ready", outcome: "held" },
    ],
  },
  {
    id: "M11",
    from: { taskId: "T2584", title: "A seeded throwaway hub for phone agents" },
    text: "Which simulator did you run the phone tests on?",
    sentAt: at("22:31"),
    to: [{ taskId: "T2567", title: "Reply shows its quote as the menu goes", outcome: "not_woken", detail: "it has finished and isn’t waiting on T2584" }],
  },
];

const mount = async (features: readonly string[] = ["agent_messages"]) => {
  let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      reads.push({ tool, input: input as Record<string, unknown> });
      if (tool === ("agent_messages" as typeof tool)) {
        const only = (input as { taskId?: string }).taskId;
        const messages = only === undefined ? MESSAGES : MESSAGES.filter((m) => m.from.taskId === only || m.to.some((t) => t.taskId === only));
        return Promise.resolve({ ok: true, output: { messages, more: false, total: messages.length } } as never);
      }
      if (tool === "events_list") return Promise.resolve({ ok: true, output: { events: [], more: false } });
      if (tool === "decisions_list") return Promise.resolve({ ok: true, output: { decisions: [], orders: [] } });
      return Promise.resolve({ ok: true, output: { at: new Date(START).toISOString(), orders: [], trains: [] } } as never);
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
          <ActivityPane project={project} view={{ tab: "activity", dms: true }} />
        </TooltipProvider>
      </DataProvider>,
    );
  });
  await act(async () => {
    send(live(features));
    send(snapshot(1));
    await vi.advanceTimersByTimeAsync(0);
  });
};

const rows = () => [...host.querySelectorAll<HTMLElement>("[data-dm] > button")];
/** History's one filter, and the kinds its menu offers once opened from the keyboard. */
const filter = () => host.querySelector<HTMLButtonElement>("[data-filter]");
const kinds = () => {
  act(() => void filter()?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  return [...document.querySelectorAll<HTMLElement>("[role='menuitemradio']")];
};

it("opens on the DMs log from the lead chat's count: every DM newest first, and no events read", async () => {
  await mount();
  expect(filter()?.textContent).toBe("DMs");
  expect(reads.some((r) => r.tool === "events_list")).toBe(false);
  expect(reads.find((r) => r.tool === "agent_messages")?.input).toMatchObject({ projectRef: project, limit: 50 });
  expect(rows().map((r) => r.textContent)).toEqual([
    expect.stringContaining("T2573 → T2577, T2576, T2574"),
    expect.stringContaining("T2584 → T2567"),
  ]);
  expect(rows()[0]?.textContent).toContain("2 delivered, 1 held");
  expect(rows()[1]?.textContent).toContain("didn’t wake T2567");
  // Read-only: nothing on a DM edits or deletes it.
  expect(host.textContent).not.toMatch(/Delete|Edit/u);
});

it("opens a row in place to its words, a receipt per recipient, and the lead's copy", async () => {
  await mount();
  act(() => rows()[0]?.click());
  expect(rows()[0]?.getAttribute("aria-expanded")).toBe("true");
  const receipts = host.querySelector("[aria-label='What became of it']");
  expect([...(receipts?.querySelectorAll("dt") ?? [])].map((d) => d.textContent)).toEqual(["T2573", "T2577", "T2576", "T2574", "Lead"]);
  expect(receipts?.textContent).toContain("read it at its next step");
  expect(receipts?.textContent).toContain("isn’t running: held for its next run");
  expect(receipts?.textContent).toContain("had a copy with its next wake");
  expect(receipts?.querySelector("a")?.getAttribute("href")).toBe("#/project/devbox/storefront/agents/T2573");

  act(() => rows()[1]?.click());
  expect(host.querySelector("[data-outcome=not_woken]")?.textContent).toBe("wasn’t woken: it has finished and isn’t waiting on T2584. Held for its next run");
});

it("has no DMs in the filter on a hub from before DMs, and reads none", async () => {
  await mount([]);
  const offered = kinds().map((k) => k.textContent);
  expect(offered).toContain("Merges");
  expect(offered).not.toContain("DMs");
  expect(reads.some((r) => r.tool === "agent_messages")).toBe(false);
});

it("goes back to every event with the filter's Everything", async () => {
  await mount();
  const all = kinds().find((k) => k.textContent === "Everything");
  act(() => all?.click());
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(reads.some((r) => r.tool === "events_list")).toBe(true);
  expect(rows()).toEqual([]);
});
