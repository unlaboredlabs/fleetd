// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { AgentRow, Change, ChecklistGetOutput, Decision, PrGetOutput, PrRow, TodoItem } from "../../../shared/contracts";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { AT, event, live, snapshot } from "../../src/data/fixtures.test-util";
import { TooltipProvider } from "../../ui/primitives/Tooltip";
import { PANEL_TABS } from "../panel/tabs";
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

// Two projects at work: the one on screen, and checkout, whose reviewer waits on you.
const agentRow = (projectId: string, projectTitle: string, laneId: string, title: string, status: AgentRow["status"] = "working"): AgentRow => ({
  laneId,
  role: laneId === "T41" ? "reviewer" : "implementer",
  status,
  title,
  projectRef: { machineId: "devbox", projectId },
  projectTitle,
  threadRef: { machineId: "devbox", threadId: `s-${laneId}` },
  startedAt: AT,
});
const agents: AgentRow[] = [
  agentRow("checkout", "checkout", "T40", "Move the card form to the payment element"),
  agentRow("checkout", "checkout", "T41", "Review the payment element change", "waiting"),
  agentRow("storefront", "storefront", "T1", "Receipts show the shop's local time"),
];

// storefront's train: #11 in CI, #12 next in line.
const change = (n: number, state: Change["state"], position?: number): Change => ({
  changeId: `X${n}`,
  projectRef: { machineId: "devbox", projectId: "storefront" },
  repo: "acme/storefront",
  prNumber: n,
  prUrl: `https://github.com/acme/storefront/pull/${n}`,
  branch: `fleetd/pr-${n}`,
  headSha: "b".repeat(40),
  state,
  reviews: [],
  workstreamId: "W1",
  createdAt: AT,
  updatedAt: AT,
  ...(position === undefined ? {} : { position }),
});
const TRAIN = [change(11, "ci"), change(12, "ready", 0)];
// Two settled questions: one in force, one it replaced.
const decision = (decisionId: string, state: Decision["state"]): Decision => ({
  decisionId,
  key: "api.health.path",
  value: state === "active" ? "/healthz" : "/health",
  scope: { kind: "project", projectRef: { machineId: "devbox", projectId: "storefront" } },
  source: "lead",
  state,
  at: AT,
});

const ANSWERS: Readonly<Record<string, unknown>> = {
  decisions_list: { decisions: [decision("D2", "active"), decision("D1", "superseded")], orders: [] },
  events_list: { events: [], more: false },
  pr_list: { at: AT, prs: [pr] },
  pr_get: detail,
  pr_files: { files: [], total: 0 },
  agents_list: { at: AT, agents },
  agent_work: { running: true, steps: [] },
  // storefront's repo: its own writer (left out of Elsewhere), a person's claim, and a direct push.
  work_list: {
    scope: { repoKey: "github.com/acme/storefront", base: "main" },
    items: [
      { id: "T1", kind: "task", projectRef: { machineId: "devbox", projectId: "storefront" }, title: "Receipts show the shop's local time", state: "running", keys: [], paths: [], since: AT },
      { id: "C3", kind: "claim", owner: { kind: "human_session", keyId: "k1", label: "laptop" }, title: "Dark mode toggle", state: "active", keys: [], paths: [], since: AT, expiresAt: AT },
    ],
    recentLandings: [{ sha: "a".repeat(40), at: AT, route: "direct_push", subject: "fix: the search box keeps its query", authorEmail: "ada@example.com", covers: [] }],
  },
};

const todo = (id: number, state: TodoItem["state"], text: string, link?: TodoItem["link"]): TodoItem => ({ id, text, state, updatedAt: AT, ...(link === undefined ? {} : { link }) });
const STORE = { machineId: "devbox", projectId: "storefront" };
// The lead's list for storefront: one item each way, linked to its PR and its agent.
let checklist: ChecklistGetOutput;
const listOf = (items: TodoItem[]): ChecklistGetOutput => ({ projectRef: STORE, items, updatedAt: AT });

let host: HTMLDivElement;
let root: Root | undefined;

// The panel's own chunk and its tabs' counts, loaded once up front as the app's first opening would, so each step waits on answers only.
beforeAll(async () => {
  await Promise.all([import("../panel/ProjectPanel"), import("../panel/counts"), import("../train/TrainPane")]);
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
  checklist = listOf([
    todo(1, "done", "Receipts in the shop's time zone", { pr: "https://github.com/acme/storefront/pull/11" }),
    todo(2, "doing", "Dark mode", { taskId: "T1" }),
    todo(3, "todo", "Release notes"),
  ]);
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

let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;

/** The panel's frame on a hub that answers at once: a launch of the app. Without `online`, the hub is out of reach. */
const mount = async ({ online = true }: { online?: boolean } = {}) => {
  const hub: HubApi = {
    call: (tool, input) => {
      if (tool === "changes_list") {
        const state = (input as { state?: string }).state;
        return Promise.resolve({ ok: true, output: { changes: TRAIN.filter((c) => c.state === state) } });
      }
      return Promise.resolve({ ok: true, output: tool === "checklist_get" ? checklist : (ANSWERS[tool] ?? {}) });
    },
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
  if (online) connect();
  await settle();
};

const connect = () =>
  act(() => {
    send(live());
    send(snapshot(1));
  });

function unmount() {
  act(() => root?.unmount());
  root = undefined;
}

/** Lets the panel's chunk load and the hub's answers land. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await act(() => new Promise((done) => setTimeout(done, 0)));
};

const panel = () => host.querySelector("aside[aria-label='Project panel']");
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

it("is open on a first launch, and opens and closes with its toggle as the window left it last launch", async () => {
  await mount();
  expect(panel()).not.toBeNull();
  expect(button("Hide the panel")?.getAttribute("aria-pressed")).toBe("true");
  await click("Hide the panel");
  expect(panel()).toBeNull();

  unmount();
  await mount();
  expect(panel()).toBeNull();
  await click("Show the panel");
  expect(panel()).not.toBeNull();

  unmount();
  await mount();
  expect(panel()).not.toBeNull();
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
  expect(document.activeElement).toBe(button("Show the panel"));
  await go(`${CHAT}/prs`);
  expect(panel()).not.toBeNull();
});

it("hides itself in a narrow window, shows there with its toggle, and widening restores the wide choice", async () => {
  await mount();
  expect(panel()).not.toBeNull();
  await resize(900);
  expect(panel()).toBeNull();
  await click("Show the panel");
  expect(panel()).not.toBeNull();
  // Narrowed again later, it hides again; widened, it is as you left it there.
  await resize(1400);
  await resize(900);
  expect(panel()).toBeNull();
  await resize(1400);
  expect(panel()).not.toBeNull();
});

it("says the agents and PRs show once you're connected while it has none to show, never loading", async () => {
  await mount({ online: false });
  const text = () => panel()?.textContent ?? "";
  const bars = () => panel()?.querySelector("[aria-label='Loading agents'], [aria-label='Loading the pull requests']") ?? null;
  expect(text()).toContain("Agents show once you’re connected.");
  expect(bars()).toBeNull();

  await go(`${CHAT}/prs`);
  expect(text()).toContain("Pull requests show once you’re connected.");
  expect(bars()).toBeNull();
  await go(`${CHAT}/prs/11`);
  expect(text()).toContain("#11 shows once you’re connected.");
  await go(`${CHAT}/prs/acme/storefront/11`);
  expect(text()).toContain("#11 shows once you’re connected.");
  expect(text()).not.toContain("Loading");
  await go(`${CHAT}/agents/T1`);
  expect(text()).toContain("This agent shows once you’re connected.");
  expect(panel()?.querySelector("[aria-busy='true']")).toBeNull();
  await go(`${CHAT}/prs/11`);

  // Connected: the PR it named opens.
  connect();
  await settle();
  expect(panel()?.querySelector("[data-screen^='prs.detail']")).not.toBeNull();
  expect(text()).not.toContain("once you’re connected");
});

it("lists every project's agents with All projects, remembers it across a remount, and opens another project's agent", async () => {
  await mount();
  const rows = () => [...(panel()?.querySelectorAll<HTMLAnchorElement>("[data-screen='agents'] a") ?? [])].map((a) => a.getAttribute("href"));
  const lines = () => panel()?.querySelector("[role='list']")?.textContent ?? "";
  const tabCount = () => panel()?.querySelector("[role='tab']")?.textContent;
  expect(button("This project")?.getAttribute("aria-pressed")).toBe("true");
  expect(rows()).toEqual([`${CHAT}/agents/T1`]);
  expect(tabCount()).toBe("Agents1");

  // Every project's, under its name; checkout first, as one of its agents waits on you, and the waiting one first.
  await click("All projects");
  expect(button("All projects")?.getAttribute("aria-pressed")).toBe("true");
  expect(rows()).toEqual(["#/project/devbox/checkout/agents/T41", "#/project/devbox/checkout/agents/T40", `${CHAT}/agents/T1`]);
  expect(lines().indexOf("checkout")).toBeLessThan(lines().indexOf("Review the payment element change"));
  expect(lines()).toContain("storefront");
  expect(tabCount()).toBe("Agents3");

  unmount();
  await mount();
  expect(button("All projects")?.getAttribute("aria-pressed")).toBe("true");
  expect(rows()).toHaveLength(3);

  // Another project's agent opens its work, beside that project's chat; its list is every project's still.
  await go(rows()[0] ?? "");
  expect(panel()?.querySelector("[data-screen='agents.work'][aria-label='What Review the payment element change is doing']")).not.toBeNull();
  await click("All agents");
  expect(window.location.hash).toBe("#/project/devbox/checkout/agents");
  expect(rows()).toHaveLength(3);

  await click("This project");
  expect(rows()).toEqual(["#/project/devbox/checkout/agents/T41", "#/project/devbox/checkout/agents/T40"]);
});

it("shows the work elsewhere on the project's repo under its agents, with This project only", async () => {
  await mount();
  const lines = () => panel()?.querySelector("[role='list']")?.textContent ?? "";
  const other = () => [...(panel()?.querySelectorAll<HTMLElement>("[data-elsewhere]") ?? [])].map((el) => el.dataset["elsewhere"]);
  expect(other()).toEqual(["C3", `landing:${"a".repeat(40)}`]);
  expect(lines().indexOf("Receipts show the shop's local time")).toBeLessThan(lines().indexOf("Elsewhere on main"));
  expect(lines()).toContain("held by you (laptop)");
  expect(lines()).toContain("pushed straight to main by ada@example.com");
  expect(panel()?.querySelectorAll("[data-screen='agents'] a")).toHaveLength(1);
  expect(panel()?.querySelector("[role='tab']")?.textContent).toBe("Agents1");

  await click("All projects");
  expect(other()).toEqual([]);
  expect(lines()).not.toContain("Elsewhere");
});

const handle = () => panel()?.querySelector<HTMLElement>("[role='separator']") ?? null;
const width = () => Number(handle()?.getAttribute("aria-valuenow"));
const key = async (el: Element | null, k: string, shiftKey = false) => {
  act(() => {
    el?.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true, cancelable: true }));
  });
  await settle();
};
const pointer = (el: Element | null, type: string, clientX: number) =>
  act(() => {
    el?.dispatchEvent(new PointerEvent(type, { clientX, button: 0, pointerId: 1, bubbles: true, cancelable: true }));
  });

it("lists its tabs from the one tab list, in its order, each a route of its own", async () => {
  await mount();
  const tabs = [...(panel()?.querySelectorAll<HTMLElement>("[role='tab']") ?? [])];
  expect(tabs.map((tab) => tab.dataset["tab"])).toEqual(PANEL_TABS.map((tab) => tab.id));
  expect(tabs.map((tab) => tab.textContent.replace(/[0-9]+$/u, ""))).toEqual(PANEL_TABS.map((tab) => tab.label));
  for (const tab of PANEL_TABS) {
    await go(`${CHAT}/${tab.id}`);
    expect(panel()?.querySelector(`[role='tab'][data-tab='${tab.id}']`)?.getAttribute("aria-selected")).toBe("true");
  }
});

it("opens the merge train, the activity and the decisions from their tabs, each with its count, and a train row opens its PR", async () => {
  await mount();
  const tab = (id: string) => panel()?.querySelector(`[role='tab'][data-tab='${id}']`);
  // On the train: #11 merging and #12 in line. In force: one decision. Activity counts only after a first look.
  expect(tab("train")?.textContent).toBe("Train2");
  expect(tab("decisions")?.textContent).toBe("Decisions1");
  expect(tab("activity")?.textContent).toBe("Activity");

  await go(`${CHAT}/train`);
  const train = panel()?.querySelector("[data-screen='train']");
  expect(train?.querySelector("section[aria-label='Merging now']")?.textContent).toContain("#11");
  expect(train?.querySelector("section[aria-label='In line']")?.textContent).toContain("#12");
  const row = train?.querySelector<HTMLAnchorElement>("a[data-pr='12']");
  expect(row?.getAttribute("href")).toBe(`${CHAT}/prs/acme/storefront/12`);
  act(() => row?.click());
  await settle();
  expect(tab("prs")?.getAttribute("aria-selected")).toBe("true");

  await go(`${CHAT}/activity`);
  expect(panel()?.querySelector("[data-screen^='activity']")).not.toBeNull();
  await go(`${CHAT}/decisions`);
  expect(panel()?.querySelector("[data-screen^='decisions']")).not.toBeNull();
});

it("resizes from its edge by keyboard and by drag, keeps the width across a relaunch, and a double-click resets it", async () => {
  vi.spyOn(HTMLElement.prototype, "setPointerCapture").mockImplementation(() => undefined);
  vi.spyOn(HTMLElement.prototype, "hasPointerCapture").mockImplementation(() => true);
  vi.spyOn(HTMLElement.prototype, "releasePointerCapture").mockImplementation(() => undefined);
  await mount();
  const edge = handle();
  expect(edge?.getAttribute("aria-orientation")).toBe("vertical");
  expect(edge?.getAttribute("aria-label")).toBe("Resize the panel");
  expect([edge?.getAttribute("aria-valuemin"), edge?.getAttribute("aria-valuemax")]).toEqual(["320", "800"]);
  expect(width()).toBe(420);
  expect(edge?.tabIndex).toBe(0);

  // Left widens (the edge is on its left), Shift four steps at a time, End and Home to its ends.
  await key(edge, "ArrowLeft");
  expect(width()).toBe(436);
  await key(handle(), "ArrowLeft", true);
  expect(width()).toBe(500);
  expect(panel()?.getAttribute("style")).toContain("--panel-size: 500px");
  await key(handle(), "End");
  expect(width()).toBe(800);
  await key(handle(), "Home");
  expect(width()).toBe(320);

  // A drag moves it with the pointer and sets it as it ends.
  pointer(handle(), "pointerdown", 1000);
  pointer(handle(), "pointermove", 900);
  expect(panel()?.getAttribute("style")).toContain("--panel-size: 420px");
  pointer(handle(), "pointerup", 900);
  await settle();
  expect(width()).toBe(420);
  pointer(handle(), "pointerdown", 1000);
  pointer(handle(), "pointermove", 860);
  pointer(handle(), "pointerup", 860);
  await settle();
  expect(width()).toBe(560);

  unmount();
  await mount();
  expect(width()).toBe(560);

  act(() => {
    handle()?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  await settle();
  expect(width()).toBe(420);
  unmount();
  await mount();
  expect(width()).toBe(420);
});

it("keeps its width within the window's room, so a narrower window never squeezes the chat out", async () => {
  window.localStorage.setItem("fleetd.panel.width", JSON.stringify({ normal: 780, wide: null }));
  await mount();
  expect(width()).toBe(780);
  await resize(1100);
  expect(width()).toBe(1100 - 240 - 360);
  // Wide again, it is as you set it.
  await resize(1400);
  expect(width()).toBe(780);
});

it("keeps the width a key chose even where it matched the default, so a wider window doesn't undo it", async () => {
  viewport(1024);
  await mount();
  expect(width()).toBe(320);
  await key(handle(), "Home");
  await resize(1400);
  expect(width()).toBe(320);
});

it("shows the lead's checklist with its progress, doing and to do open and done folded, and follows it live", async () => {
  await mount();
  await go(`${CHAT}/checklist`);
  const pane = () => panel()?.querySelector("[data-screen='checklist']") ?? null;
  const rows = () => [...(pane()?.querySelectorAll<HTMLElement>("[data-item]") ?? [])].map((r) => `${r.dataset["state"] ?? ""} ${r.textContent}`);
  expect(pane()?.textContent).toContain("1 of 3 done");
  expect(pane()?.querySelector("[role='progressbar']")?.getAttribute("aria-valuenow")).toBe("1");
  // Doing first, then to do; the agent on an item by its title while it works.
  expect(rows()).toEqual(["doing Dark modeReceipts show the shop's local time", "todo Release notes"]);
  expect(pane()?.querySelector<HTMLAnchorElement>("[data-item='2'] a")?.getAttribute("href")).toBe(`${CHAT}/agents/T1`);
  expect(panel()?.querySelector("[role='tab'][data-tab='checklist']")?.textContent).toBe("Checklist2");

  const fold = [...(pane()?.querySelectorAll("button") ?? [])].find((b) => b.textContent.startsWith("Done"));
  expect(fold?.getAttribute("aria-expanded")).toBe("false");
  act(() => fold?.click());
  await settle();
  expect(fold?.getAttribute("aria-expanded")).toBe("true");
  expect(rows()).toHaveLength(3);
  // A done item's PR opens in the panel.
  expect(pane()?.querySelector<HTMLAnchorElement>("[data-item='1'] a")?.getAttribute("href")).toBe(`${CHAT}/prs/acme/storefront/11`);

  // The lead moves an item on: the event reads the list again.
  checklist = listOf([...checklist.items.slice(0, 1), todo(2, "done", "Dark mode"), todo(3, "doing", "Release notes")]);
  act(() => send(event(2, "checklist.changed", { projectRef: STORE, done: 2, total: 3, by: "lead:devbox/storefront" })));
  // Events coalesce for a moment before their reads go out.
  await act(() => new Promise((done) => setTimeout(done, 150)));
  await settle();
  expect(pane()?.textContent).toContain("2 of 3 done");
  expect(rows()).toEqual(["doing Release notes", "done Receipts in the shop's time zonePR #11", "done Dark mode"]);
  expect(panel()?.querySelector("[role='tab'][data-tab='checklist']")?.textContent).toBe("Checklist1");
});

it("says the lead keeps a checklist while there is none, and that it shows once you're connected", async () => {
  checklist = listOf([]);
  await mount();
  await go(`${CHAT}/checklist`);
  expect(panel()?.querySelector("[data-screen='checklist.empty']")?.textContent).toContain("No checklist yet");
  unmount();
  await mount({ online: false });
  await go(`${CHAT}/checklist`);
  expect(panel()?.textContent).toContain("The checklist shows once you’re connected.");
  expect(panel()?.querySelector("[aria-busy='true']")).toBeNull();
});

it("fits its tabs to its width: icons with their labels as names, then the rest under More, the open tab kept", async () => {
  // The measuring copy: 160 px a tab with its label, 40 as an icon, 28 for More; the bar has `room` px.
  // Six tabs: 960 px with their labels, 240 as icons.
  let room = 300;
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    if (this.dataset["more"] !== undefined) return 28;
    const row = this.parentElement?.dataset["row"];
    return row === "full" ? 160 : row === "icon" ? 40 : 0;
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: function (this: HTMLElement) {
      return this.querySelector(":scope > [role='tablist']") !== null ? room : 0;
    },
  });
  await mount();
  const tabs = () => [...(panel()?.querySelectorAll<HTMLElement>("[role='tab']") ?? [])];
  expect(tabs().map((tab) => tab.getAttribute("aria-label"))).toEqual(PANEL_TABS.map((tab) => tab.label));
  expect(tabs()[0]?.textContent).toBe("1");
  expect(button("More tabs")).toBeUndefined();

  room = 110;
  unmount();
  await go(`${CHAT}/checklist`);
  await mount();
  expect(tabs().map((tab) => tab.dataset["tab"])).toEqual(["agents", "checklist"]);
  const more = button("More tabs");
  expect(more).toBeDefined();
  act(() => {
    more?.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, cancelable: true }));
  });
  await settle();
  const items = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")];
  expect(items.map((el) => el.textContent.replace(/[0-9]+$/u, ""))).toEqual(["Pull requests", "Train", "Activity", "Decisions"]);
  const item = items.find((el) => el.textContent.startsWith("Pull requests"));
  expect(item).toBeDefined();
  act(() => item?.click());
  await settle();
  expect(window.location.hash).toBe(`${CHAT}/prs`);
  expect(tabs().map((tab) => tab.dataset["tab"])).toEqual(["agents", "prs"]);
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
});

it("widens for a PR's changes with a width of its own, and narrows again to yours from its Overview", async () => {
  await mount();
  await key(handle(), "ArrowRight", true);
  expect(width()).toBe(356);
  await go(`${CHAT}/prs/acme/storefront/11`);
  const prTab = (name: string) => [...(panel()?.querySelectorAll<HTMLElement>("[data-screen^='prs.detail'] [role='tab']") ?? [])].find((t) => t.textContent.startsWith(name));
  act(() => {
    prTab("Changes")?.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }));
  });
  await settle();
  expect(panel()?.getAttribute("data-mode")).toBe("wide");
  expect(width()).toBe(770);
  await key(handle(), "ArrowLeft");
  expect(width()).toBe(786);

  act(() => {
    prTab("Overview")?.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }));
  });
  await settle();
  expect(panel()?.getAttribute("data-mode")).toBe("normal");
  expect(width()).toBe(356);
  await click("All pull requests");
  expect(width()).toBe(356);
});
