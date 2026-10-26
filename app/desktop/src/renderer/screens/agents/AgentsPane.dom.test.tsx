// @vitest-environment happy-dom
// The panel's agents as the app routes to them: the list under its orders' titles, each row a link to the same route
// chat, Status and the palette open, and that route opening the agent's live view, whose PR opens in the PRs tab.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentRow } from "../../../shared/contracts";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { AT, card, live, project, snapshot } from "../../src/data/fixtures.test-util";
import { TooltipProvider } from "../../ui/primitives/Tooltip";
import { parseHash, panelRoute, toHash } from "../shell/routes";
import { AgentsPane } from "./AgentsPane";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CHAT = "#/project/devbox/storefront";

/** The agents' titles as the lead and the hub write them: plain outcomes, a review by what it checks. */
const TITLES: Readonly<Record<string, string>> = { T1: "Dark mode follows the system", T2: "Checking: Receipts in the store's zone", T3: "Find where receipts format dates" };

const row = (laneId: string, status: AgentRow["status"], workstreamId: string, more: Partial<AgentRow> = {}): AgentRow => ({
  laneId,
  role: "implementer",
  status,
  title: TITLES[laneId] ?? "An agent",
  taskId: laneId,
  projectRef: project,
  projectTitle: "storefront",
  workstreamId,
  ...more,
});

const PR = { changeId: "X12", repo: "acme/storefront", number: 12, url: "https://github.com/acme/storefront/pull/12", state: "ci" as const, reviewsDone: 0, reviewsNeeded: 1 };
const AGENTS = [
  row("lead:devbox/storefront", "working", "W1", { role: "lead", title: "Lead" }),
  row("T1", "working", "W1", { branch: "fleetd/T1-dark-mode", threadRef: { machineId: "devbox", threadId: "s-T1" } }),
  row("T2", "working", "W2", { pr: PR, role: "reviewer" }),
  row("T3", "waiting", "W2", { role: "reader" }),
];

const answer = (tool: string): unknown => {
  switch (tool) {
    case "orders_board":
      return { at: AT, trains: [], orders: [card("W1", { title: "Dark mode" }), card("W2", { title: "Receipts in the store's zone" })] };
    case "agents_list":
      return { at: AT, agents: AGENTS };
    case "work_list":
      return { scope: { repoKey: "github.com/acme/storefront", base: "main" }, items: [], recentLandings: [] };
    default:
      return {};
  }
};

// happy-dom has no layout: the lists' scroller is 600 px tall and each row 50 px, so every row renders.
const heightOf = (el: Element) => {
  if (el.getAttribute("role") === "list") return 600;
  if (el instanceof HTMLElement && el.dataset["index"] !== undefined) return 50;
  return 0;
};
const proto = HTMLElement.prototype;
const realRect = proto.getBoundingClientRect.bind(proto);

let host: HTMLDivElement;
let root: Root | undefined;
const copy = vi.fn((_text: string) => Promise.resolve());

beforeEach(() => {
  vi.spyOn(proto, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const h = heightOf(this);
    return h ? new DOMRect(0, 0, 400, h) : realRect.call(this);
  });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: function (this: HTMLElement) { return heightOf(this); } });
  Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => 400 });
  vi.stubGlobal("fleetd", { platform: "darwin", fixture: null, openExternal: vi.fn(), copy });
  window.localStorage.clear();
  window.location.hash = `${CHAT}/agents`;
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

/** The pane at the agent the window's hash names, as the panel mounts it. */
function Harness() {
  const screen = parseHash(window.location.hash);
  const agent = screen.id === "project" && screen.panel?.tab === "agents" ? screen.panel.agent : null;
  return (
    <TooltipProvider>
      <AgentsPane project={project} agent={agent} scope="project" onScope={() => undefined} />
    </TooltipProvider>
  );
}

const mount = async () => {
  let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;
  const hub: HubApi = {
    call: (tool) => Promise.resolve({ ok: true, output: answer(tool) }),
    subscribe: (l) => ((send = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  const layer = createDataLayer(hub);
  const render = () => {
    root?.render(
      <DataProvider layer={layer}>
        <Harness />
      </DataProvider>,
    );
  };
  root = createRoot(host);
  act(render);
  act(() => {
    send(live());
    send(snapshot(1));
  });
  await settle();
  return async (hash: string) => {
    act(() => {
      window.location.hash = hash;
      render();
    });
    await settle();
  };
};

it("lists the project's agents under their orders' titles, the order waiting on you first, without the lead", async () => {
  await mount();
  const list = host.querySelector("[data-screen='agents']");
  const lines = [...(list?.querySelectorAll("[aria-label='Agents'] a, [aria-label='Agents'] [data-group]") ?? [])].map((el) =>
    el.tagName === "A" ? el.getAttribute("data-state") : el.textContent,
  );
  expect(lines).toEqual(["Receipts in the store's zone1 needs you2", "waiting", "working", "Dark mode1", "working"]);
  expect(list?.textContent).toContain("#12 · in CI");
  expect(list?.textContent).toContain("1 needs you");
  expect(list?.querySelector("[role='img'][aria-label='needs you']")).not.toBeNull();
});

it("shows no internal ids in its rows: a writer's branch by its slug, the full branch in its tooltip", async () => {
  await mount();
  const list = host.querySelector("[data-screen='agents']");
  expect(list?.textContent).not.toMatch(/\b[WTXPCDSQ]\d+\b/u);
  const branch = list?.querySelector("[title='fleetd/T1-dark-mode']");
  expect(branch?.textContent).toBe("dark-mode");
});

it("leaves the PR out of an agent's row on that PR's own page", async () => {
  const go = await mount();
  await go(`${CHAT}/prs/12`);
  expect(host.querySelector("[data-screen='agents']")?.textContent).not.toContain("#12 · in CI");
  await go(`${CHAT}/prs/7`);
  expect(host.querySelector("[data-screen='agents']")?.textContent).toContain("#12 · in CI");
});

it("links each row to the agent's panel route, which opens its live view with its order and its PR", async () => {
  const go = await mount();
  const link = [...host.querySelectorAll<HTMLAnchorElement>("[data-screen='agents'] a")].find((a) => a.textContent.includes("Checking: Receipts"));
  const href = toHash(panelRoute(project, { tab: "agents", agent: "T2" }));
  expect(href).toBe(`${CHAT}/agents/T2`);
  expect(link?.getAttribute("href")).toBe(href);

  await go(href);
  const work = host.querySelector("[data-screen='agents.work']");
  expect(work?.querySelector("h2")?.textContent).toBe("Checking: Receipts in the store's zone");
  expect(work?.textContent).toContain("Receipts in the store's zone");
  expect(work?.textContent).toContain("working");
  const prButton = [...(work?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "PR #12 · in CI");
  act(() => prButton?.click());
  expect(window.location.hash).toBe(toHash(panelRoute(project, { tab: "prs", pr: { repo: "acme/storefront", number: 12 } })));
});

it("a row's right-click menu opens the agent, copies its branch, and Steer opens it with the cursor in its box", async () => {
  const go = await mount();
  const link = [...host.querySelectorAll<HTMLAnchorElement>("[data-screen='agents'] a")].find((a) => a.textContent.includes("Dark mode follows"));
  if (link === undefined) throw new Error("no row");
  const choose = async (label: string) => {
    act(() => {
      link.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    });
    expect([...document.querySelectorAll("[role='menuitem']")].map((i) => i.textContent)).toEqual(["Open", "Steer", "Copy branch"]);
    const item = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find((i) => i.textContent === label);
    act(() => item?.click());
    await act(() => Promise.resolve());
  };
  await choose("Copy branch");
  expect(copy).toHaveBeenCalledWith("fleetd/T1-dark-mode");
  await choose("Steer");
  const href = toHash(panelRoute(project, { tab: "agents", agent: "T1" }));
  expect(window.location.hash).toBe(href);
  await go(href);
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Steer this agent");
});

it("a row with no steer box yet has no Steer, so no box takes the cursor later", async () => {
  await mount();
  const link = [...host.querySelectorAll<HTMLAnchorElement>("[data-screen='agents'] a")].find((a) => a.textContent.includes("Lane T2"));
  if (link === undefined) throw new Error("no row");
  act(() => {
    link.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  });
  expect([...document.querySelectorAll("[role='menuitem']")].map((i) => i.textContent)).toEqual(["Open"]);
});
