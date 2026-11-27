// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MachineStatus, ProjectStatusRow } from "../../../shared/contracts";
import { parseHash } from "../shell/routes";
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
  vi.restoreAllMocks();
});

// happy-dom has no layout: the list's scroller is 600 px tall and each row 50 px, so every row renders, the bot at the
// chat's end (WakeRow.tsx) included.
const layout = () => {
  const heightOf = (el: Element) => (el.getAttribute("role") === "list" ? 600 : el instanceof HTMLElement && el.dataset["index"] !== undefined ? 50 : 0);
  const proto = HTMLElement.prototype;
  const realRect = proto.getBoundingClientRect.bind(proto);
  vi.spyOn(proto, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const h = heightOf(this);
    return h ? new DOMRect(0, 0, 400, h) : realRect.call(this);
  });
  vi.spyOn(proto, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return heightOf(this);
  });
};

/**
 * The chat on a live hub whose Status row for the project is `row`, its lead's lane `lead` when given. `working`: the
 * hub's chat state says the lead works (by default, when it has a lane); `messages`: the chat's, oldest first; `open`:
 * the shell opened the chat (by default, while the lead works).
 */
const mount = async (
  row: Partial<ProjectStatusRow>,
  lead?: ReturnType<typeof liveLane>,
  at: { working?: boolean; open?: boolean; messages?: readonly unknown[]; machine?: MachineStatus; hubInfo?: unknown } = {},
) => {
  const working = at.working ?? lead !== undefined;
  let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;
  const answers: Readonly<Record<string, unknown>> = {
    status_get: { rows: [{ projectRef: project, title: "storefront", asOf: AT, agentsRunning: 0, state: "idle", ...row }] },
    orders_board: { orders: [] },
    ...(at.hubInfo === undefined ? {} : { hub_info: at.hubInfo }),
    usage_resume: { resumed: 2, status: { machineId: project.machineId, breaker: { state: "closed" } } },
    chat_history: {
      messages: at.messages ?? [{ messageId: "m1", projectRef: project, seq: 1, author: "human", state: "final", text: "Add dark mode", createdAt: AT }],
      moreBefore: false,
      moreAfter: false,
      state: { projectRef: project, needsYou: false, leadWorking: working, lastSeq: at.messages?.length ?? 1 },
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
  if (at.open ?? working) layer.chat.open(projectKey(project));
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
    const snap = snapshot(1);
    if (at.machine !== undefined && snap.t === "snapshot") snap.snapshot.machines = snap.snapshot.machines.map((m) => ({ ...m, status: at.machine as MachineStatus }));
    send(snap);
    if (lead !== undefined) send({ t: "live", frame: { at: AT, full: true, lanes: [lead] } });
  });
  for (let i = 0; i < 5; i++) await act(() => new Promise((done) => setTimeout(done, 0)));
};

const line = () => host.querySelector("[data-attention]")?.textContent ?? null;

it("says why the bot is blocked in the band over the composer, in the hub's words, and leaves the top bar to the pill", async () => {
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

it("opens the machine from the blocked pill while its machine is offline, for an admin; a member gets the words alone", async () => {
  window.location.hash = "";
  await mount({ state: "blocked", blockedReason: "devbox is offline" }, undefined, { machine: "offline" });
  expect(line()).toBe("Blocked: devbox is offline" + "Open machine");
  // The words themselves open it: the pill is what people press.
  act(() => host.querySelector<HTMLElement>("[data-attention] span")?.click());
  expect(parseHash(window.location.hash)).toEqual({ id: "settings", tab: "hub.machines", machine: "devbox" });
  window.location.hash = "";
  act(() => host.querySelector<HTMLButtonElement>("[data-attention] button")?.click());
  expect(parseHash(window.location.hash)).toEqual({ id: "settings", tab: "hub.machines", machine: "devbox" });
  act(() => root?.unmount());
  await mount({ state: "blocked", blockedReason: "devbox is offline" }, undefined, { machine: "offline", hubInfo: { admin: false } });
  expect(line()).toBe("Blocked: devbox is offline");
  expect(host.querySelector("[data-attention] button")).toBeNull();
});

it("says only that it is blocked when the hub gave no reason, and nothing when it isn't", async () => {
  await mount({ state: "blocked" });
  expect(line()).toBe("Blocked");
  act(() => root?.unmount());
  await mount({ state: "working" });
  expect(line()).toBeNull();
});

// W949: the lead's step in plain words beside its bot in the reply's place, for the whole turn, its reply answered or
// not; never in the island over the composer as well.
it("says what the lead is doing beside its bot at the chat's end, in plain words, after its reply too", async () => {
  layout();
  const reading = { activity: { kind: "read" as const, path: "src/checkout/summary/rounding/half-cent-edge-cases.ts" }, since: AT };
  const messages = [
    { messageId: "m1", projectRef: project, seq: 1, author: "human", state: "final", text: "Add dark mode", createdAt: AT },
    { messageId: "m2", projectRef: project, seq: 2, author: "lead", state: "final", text: "On it.", createdAt: AT },
  ];
  await mount({ state: "working" }, liveLane(leadLaneId(project), "working", { activity: reading }), { messages });
  const row = host.querySelector("[data-index] [data-wake]");
  expect(row?.getAttribute("data-wake")).toBe("working");
  // The file by its name, never its path; a button that opens the turn's steps.
  expect(row?.getAttribute("aria-label")).toBe("Reading half-cent-edge-cases.ts");
  expect(row?.querySelector("button")).not.toBeNull();
  expect(row?.textContent).not.toContain("src/checkout");
  expect(host.querySelector("[data-band] > [data-island]")).toBeNull();
});

// T6171's find on the cloud (2026-11-27): "Done in 18s · 1 agent" showed on the reply that closed an order, live, and
// was gone after a reload. The stamp is the message's own (the hub's `closed`), so a chat read again, with none of the
// lead's turn among its events, still shows it, and it still opens what that run did.
it("keeps the closing reply's stamp after the chat is read again, and it opens what the run did", async () => {
  layout();
  const closed = { workstreamId: "W7", ms: 188_000, agents: 2, since: AT, until: "2026-10-19T10:03:10.000Z" };
  const messages = [
    { messageId: "m1", projectRef: project, seq: 1, author: "human", state: "final", text: "Make search fast", createdAt: AT },
    { messageId: "m2", projectRef: project, seq: 2, author: "lead", state: "final", text: "Search is fast now.", createdAt: "2026-10-19T10:03:09.000Z", closed },
  ];
  await mount({ state: "idle" }, undefined, { working: false, open: true, messages });
  // The stamp's button comes with its lazily loaded list (Bubble.tsx), which may take a few more ticks.
  const find = () => host.querySelector<HTMLButtonElement>("button[aria-label='Done in 3m 8s · 2 agents: what it did']");
  await vi.waitFor(() => expect(find()?.textContent).toBe("Done in 3m 8s · 2 agents"));
  const stamp = find();
  await act(async () => {
    stamp?.click();
    await new Promise((done) => setTimeout(done, 0));
  });
  expect(document.querySelector("[aria-label='What this turn did']")).not.toBeNull();
  expect(calls.some(([tool]) => tool === "tasks_list")).toBe(true);
});

/** The lead's Stop beside Send, and the island over the composer. */
const stop = () => host.querySelector("button[aria-label='Stop the lead and its agents']");
const island = () => host.querySelector("[data-band] > [data-island]");

// The human's screenshot (2026-11-15): "start", then "1-16" sent as a steer while the turn ran, nothing from the lead
// yet. The composer showed Stop and "It reads this at its next step.", the band over it nothing at all: the island
// said only a step with more words than "Working", so a turn with none (or only thinking) drew no island.
it("shows the lead at work whenever the composer shows Stop: its bot at the chat's end, with a word for its step", async () => {
  layout();
  const human = (seq: number, text: string, delivery: string) => ({ messageId: `m${String(seq)}`, projectRef: project, seq, author: "human", state: "final", text, createdAt: AT, delivery });
  // The lead answered and works on: the bot stays in the reply's place for the rest of the turn.
  const answered = (seq: number) => ({ messageId: `m${String(seq)}`, projectRef: project, seq, author: "lead", state: "final", text: "On it.", createdAt: AT });
  const steered = [human(1, "start", "turn"), human(2, "1-16", "steer"), answered(3)];
  const asked = [human(1, "Add dark mode", "turn"), answered(2)];
  const states: readonly [string, Parameters<typeof mount>[1], Parameters<typeof mount>[2], string][] = [
    ["a turn with no step yet, after a steer", undefined, { working: true, messages: steered }, "Thinking"],
    ["a turn with no step yet", undefined, { working: true, messages: asked }, "Thinking"],
    ["a lane at work with no activity", liveLane(leadLaneId(project), "working"), { messages: asked }, "Thinking"],
    ["thinking", liveLane(leadLaneId(project), "working", { activity: { activity: { kind: "thinking" }, since: AT } }), { messages: asked }, "Thinking"],
    ["writing", liveLane(leadLaneId(project), "working", { activity: { activity: { kind: "writing" }, since: AT } }), { messages: asked }, "Writing"],
  ];
  for (const [state, lead, at, words] of states) {
    await mount({ state: "working" }, lead, at);
    expect(stop(), state).not.toBeNull();
    expect(host.querySelector("[data-index] [data-wake]")?.getAttribute("aria-label"), state).toBe(words);
    // One sign of it: the island over the composer doesn't say it again.
    expect(island(), state).toBeNull();
    act(() => root?.unmount());
  }
  // Idle: no Stop, no bot at the end, no island.
  await mount({ state: "idle" });
  expect(stop()).toBeNull();
  expect(host.querySelector("[data-wake]")).toBeNull();
  expect(island()).toBeNull();
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
