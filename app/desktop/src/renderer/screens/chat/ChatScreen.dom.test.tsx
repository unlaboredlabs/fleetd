// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProjectStatusRow } from "../../../shared/contracts";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { AT, live, liveLane, project, snapshot } from "../../src/data/fixtures.test-util";
import { TooltipProvider } from "../../ui/primitives/Tooltip";
import { AppFrame, TopBar } from "../../ui/layout/Layout";
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
          {/* The frame's top row, where the chat's title and what needs you show. */}
          <AppFrame topBar={<TopBar />}>
            <ChatScreen project={project} />
          </AppFrame>
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

it("says why the project is blocked in the band over the composer, in the hub's words, and leaves the top bar to the pill", async () => {
  await mount({ state: "blocked", blockedReason: "devbox is offline" });
  expect(line()).toBe("Blocked: devbox is offline");
  expect(host.querySelector("[data-say] [data-attention]")).not.toBeNull();
  expect(host.querySelector("header [data-attention]")).toBeNull();
});

it("leaves the top bar to the title when nothing needs you: no state word, no agents counter", async () => {
  await mount({ state: "working", agentsRunning: 3 });
  expect(host.querySelector("header")?.textContent).toBe("storefront");
});

it("says a red main as the island's red dot, its reason whole in the island's card, and no block", async () => {
  const warning = "`e2e (webkit)` is red on main, fix in progress";
  await mount({ state: "working", warning });
  const island = host.querySelector("[data-band] [data-island]");
  const press = island?.querySelector<HTMLButtonElement>("button[aria-expanded]");
  expect(press?.getAttribute("aria-label")).toBe("main is red");
  // No words in the band: a dot, and nothing in what-needs-you's capsule.
  expect(press?.textContent).toBe("");
  expect(line()).toBeNull();
  act(() => press?.click());
  // Opened: the reason, the check's name set as code, its backticks not shown.
  const card = island?.querySelector("[data-island-card]");
  expect(card?.textContent).toBe("e2e (webkit) is red on main, fix in progress");
  expect(card?.querySelector("code")?.textContent).toBe("e2e (webkit)");
  act(() => root?.unmount());
  await mount({ state: "blocked", blockedReason: "devbox is offline", warning });
  expect(line()).toBe("Blocked: devbox is offline");
  expect(host.querySelector("[data-island] button")?.getAttribute("aria-label")).toBe("main is red");
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

it("says what the lead is doing in the island over the composer, never as a row of the conversation", async () => {
  const reading = { activity: { kind: "read" as const, path: "src/checkout/summary/rounding/half-cent-edge-cases.ts" }, since: AT };
  await mount({ state: "working" }, liveLane(leadLaneId(project), "working", { activity: reading }));
  const island = host.querySelector("[data-band] > [data-island]");
  // Its file's name as code; the whole name is held, the shown copy cut to the room it has. With no agents, main green
  // and no DMs its card would be empty: it says the step, and is no button.
  expect(island?.querySelector("[role='group']")?.getAttribute("aria-label")).toBe("Reading `half-cent-edge-cases.ts`");
  expect(island?.querySelector("button")).toBeNull();
  expect([...(island?.querySelectorAll("code") ?? [])].map((c) => c.textContent)).toContain("half-cent-edge-cases.ts");
  expect(host.querySelector("[data-index] [data-island]")).toBeNull();
  act(() => root?.unmount());
  // Only working or thinking, the lead's avatar says it: the island has nothing to say, and isn't drawn.
  await mount({ state: "working" }, liveLane(leadLaneId(project), "working"));
  expect(host.querySelector("[data-island]")).toBeNull();
});

it("floats the composer as an island over the conversation, which runs on behind it rather than ending above it", async () => {
  // With its lead's lane, the shell has opened the chat: its conversation shows.
  await mount({ state: "working" }, liveLane(leadLaneId(project), "working"));
  const island = host.querySelector<HTMLElement>("[data-floats]");
  const list = host.querySelector('[role="list"][aria-label="Conversation with the lead"]');
  expect(island?.querySelector("[data-composer]")).not.toBeNull();
  // The list and the island share the stage: the list fills it, the island is drawn over its end, not under it.
  expect(list).not.toBeNull();
  expect(island?.contains(list ?? null)).toBe(false);
  expect(island?.parentElement?.contains(list ?? null)).toBe(true);
  // The band the island floats in sits over the pill, outside it: nothing docks inside the box any more.
  const band = island?.querySelector("[data-band]");
  expect(band?.nextElementSibling?.hasAttribute("data-composer")).toBe(true);
  expect(island?.querySelector("[data-composer] [data-band]")).toBeNull();
});
