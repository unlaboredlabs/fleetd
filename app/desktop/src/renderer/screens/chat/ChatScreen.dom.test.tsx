// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProjectStatusRow } from "../../../shared/contracts";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { AT, live, liveLane, project, snapshot } from "../../src/data/fixtures.test-util";
import { TooltipProvider } from "../../ui/primitives/Tooltip";
import { leadLaneId } from "../../src/data/selectors";
import { projectKey } from "../../src/data/store";
import { ChatScreen } from "./ChatScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// Settings, which the chat's controls link to, reads the platform as it loads.
vi.hoisted(() => vi.stubGlobal("fleetd", { platform: "darwin", fixture: null }));

let host: HTMLDivElement;
let root: Root | undefined;
const calls: [string, unknown][] = [];

beforeEach(() => {
  calls.length = 0;
  window.localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

/** The chat on a live hub whose Status row for the project is `row`, its lead's lane `lead` when given. */
const mount = async (row: Partial<ProjectStatusRow>, lead?: ReturnType<typeof liveLane>) => {
  let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;
  const answers: Readonly<Record<string, unknown>> = {
    status_get: { rows: [{ projectRef: project, title: "storefront", asOf: AT, agentsRunning: 0, state: "idle", ...row }] },
    orders_board: { orders: [] },
    usage_resume: { resumed: 2, status: { machineId: project.machineId, breaker: { state: "closed" } } },
    chat_history: {
      messages: [{ messageId: "m1", projectRef: project, seq: 1, author: "human", state: "final", text: "Add dark mode", createdAt: AT }],
      moreBefore: false,
      moreAfter: false,
      state: { projectRef: project, needsYou: false, leadWorking: lead !== undefined, lastSeq: 1 },
    },
  };
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push([tool, input]);
      return Promise.resolve({ ok: true, output: answers[tool] ?? {} } as never);
    },
    subscribe: (l) => ((send = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  const layer = createDataLayer(hub);
  // The shell opens the chat it shows; the lead's lines show only in a loaded one.
  if (lead !== undefined) layer.chat.open(projectKey(project));
  root = createRoot(host);
  act(() => {
    root?.render(
      <DataProvider layer={layer}>
        <TooltipProvider>
          <ChatScreen project={project} />
        </TooltipProvider>
      </DataProvider>,
    );
  });
  act(() => {
    send(live());
    send(snapshot(1));
    if (lead !== undefined) send({ t: "live", frame: { at: AT, full: true, lanes: [lead] } });
  });
  for (let i = 0; i < 5; i++) await act(() => new Promise((done) => setTimeout(done, 0)));
};

const line = () => host.querySelector("[data-attention]")?.textContent ?? null;

it("says why the project is blocked above the box, in the hub's words", async () => {
  await mount({ state: "blocked", blockedReason: "devbox is offline" });
  expect(line()).toBe("Blocked: devbox is offline");
});

it("says a red main as a warning, not a block, and a block or the lead's question before it", async () => {
  const warning = "`rust (macos)` is red on main, fix in progress";
  await mount({ state: "working", warning });
  expect(host.querySelector('[data-attention="warning"]')?.textContent).toBe(warning);
  act(() => root?.unmount());
  await mount({ state: "blocked", blockedReason: "devbox is offline", warning });
  expect(line()).toBe("Blocked: devbox is offline");
});

it("offers Resume on the blocked line when its machine's usage pause is why, and Resume calls usage_resume", async () => {
  await mount({ state: "blocked", blockedReason: "rate-limited by your proxy on devbox, checking again shortly", usagePausedOn: project.machineId });
  expect(line()).toBe("Blocked: rate-limited by your proxy on devbox, checking again shortly" + "Resume");
  const resume = host.querySelector<HTMLButtonElement>("[data-attention] button");
  await act(async () => {
    resume?.click();
    await new Promise((done) => setTimeout(done, 0));
  });
  expect(calls.filter(([tool]) => tool === "usage_resume")).toEqual([["usage_resume", { machineId: project.machineId }]]);
  // Another reason offers none.
  act(() => root?.unmount());
  await mount({ state: "blocked", blockedReason: "devbox is offline" });
  expect(host.querySelector("[data-attention] button")).toBeNull();
});

it("says only that it is blocked when the hub gave no reason, and nothing when it isn't", async () => {
  await mount({ state: "blocked" });
  expect(line()).toBe("Blocked");
  act(() => root?.unmount());
  await mount({ state: "working" });
  expect(line()).toBeNull();
});

it("keeps the beat going only while the lead's activity line is on screen", async () => {
  // happy-dom has no layout: the line is on screen until the observer says otherwise.
  const seen: IntersectionObserverCallback[] = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(cb: IntersectionObserverCallback) {
        seen.push(cb);
      }
      observe() {}
      disconnect() {}
    },
  );
  // happy-dom has no layout either: the list's scroller is 600 px tall and each row 50 px, so every row renders.
  const heightOf = (el: Element) => (el.getAttribute("role") === "list" ? 600 : el instanceof HTMLElement && el.dataset["index"] !== undefined ? 50 : 0);
  const proto = HTMLElement.prototype;
  const realRect = proto.getBoundingClientRect.bind(proto);
  const rect = vi.spyOn(proto, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const h = heightOf(this);
    return h ? new DOMRect(0, 0, 400, h) : realRect.call(this);
  });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: function (this: HTMLElement) { return heightOf(this); } });
  try {
    await mount({ state: "working" }, liveLane(leadLaneId(project), "working"));
    expect(host.querySelector("[data-entry='activity'][data-turn='running']")).not.toBeNull();
    const beat = () => document.documentElement.dataset["beat"];
    expect(beat()).toBeDefined();
    const view = (isIntersecting: boolean) =>
      act(() => {
        for (const cb of seen) cb([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver);
      });
    view(false);
    expect(beat()).toBeUndefined();
    view(true);
    expect(beat()).toBeDefined();
  } finally {
    rect.mockRestore();
    delete (proto as { clientHeight?: number }).clientHeight;
    vi.unstubAllGlobals();
    vi.stubGlobal("fleetd", { platform: "darwin", fixture: null });
  }
});
