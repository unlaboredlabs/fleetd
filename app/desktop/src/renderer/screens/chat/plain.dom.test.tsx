// @vitest-environment happy-dom
// Your own project with no repo: its empty chat offers everyday first asks and the box names it; one with a repo asks
// what the lead should do in it. Every project's panel has the same sections, Asked work under Plan and Skills of its own.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FleetStatus } from "../../../shared/contracts";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { AT, live } from "../../src/data/fixtures.test-util";
import { UiProvider } from "../../ui";
import { ChatScreen } from ".";
import { PLAIN_STARTERS, STARTERS } from "./EmptyChat";
import { ProjectPanel } from "../panel/ProjectPanel";
import { forgetViews } from "../panel/Sections";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => vi.stubGlobal("fleetd", { platform: "linux", fixture: null }));

const ADA = { machineId: "devbox", projectId: "ada" } as const;

const SHOP = { machineId: "devbox", projectId: "shop" } as const;

const snapshot: HubFrame = {
  t: "snapshot",
  snapshot: {
    cursor: 1,
    attention: [],
    machines: [{ machineId: "devbox", name: "devbox", nodeVersion: "1", status: "online", lastSeenAt: AT, tags: [] }],
    projects: [
      { ...ADA, title: "Ada", workspaceRoot: "/home/dev/projects/ada", lastActivityAt: AT, threads: { running: 0, waiting: 0, idle: 1, failed: 0 }, onlyMe: true },
      {
        ...SHOP,
        title: "shop",
        workspaceRoot: "/home/dev/src/shop",
        lastActivityAt: AT,
        threads: { running: 0, waiting: 0, idle: 1, failed: 0 },
        repos: [{ name: "shop", repoId: "r1", checkout: SHOP }],
      },
    ],
  } satisfies FleetStatus,
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  forgetViews();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const mount = async (ui: ReactNode, features?: string[], open: string = "devbox/ada") => {
  let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;
  const answers: Readonly<Record<string, unknown>> = {
    orders_board: { orders: [] },
    chat_history: { messages: [], moreBefore: false, moreAfter: false, state: { projectRef: open === "devbox/ada" ? ADA : SHOP, needsYou: false, leadWorking: false, lastSeq: 0 } },
  };
  const hub: HubApi = {
    call: (tool) => Promise.resolve({ ok: true, output: answers[tool] ?? {} } as never),
    subscribe: (l) => ((send = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  const layer = createDataLayer(hub);
  // The shell opens the chat it shows.
  layer.chat.open(open);
  act(() => {
    root.render(
      <UiProvider>
        <DataProvider layer={layer}>{ui}</DataProvider>
      </UiProvider>,
    );
  });
  act(() => {
    send(live(features));
    send(snapshot);
  });
  for (let i = 0; i < 6; i++) await act(() => new Promise((done) => setTimeout(done, 0)));
};

it("asks what your own project with no repo can do for you, with everyday starters, and the box names it", async () => {
  await mount(<ChatScreen project={ADA} />);
  expect(host.querySelector("h2")?.textContent).toBe("What can Ada do for you?");
  const starters = [...host.querySelectorAll("[data-entry=empty] button")].map((b) => b.textContent);
  expect(starters).toEqual([...PLAIN_STARTERS]);
  expect(host.querySelector("textarea")?.getAttribute("placeholder")).toBe("Message Ada");
});

it("asks what the lead should do in a project with a repo, with a codebase's starters", async () => {
  await mount(<ChatScreen project={SHOP} />, undefined, "devbox/shop");
  expect(host.querySelector("h2")?.textContent).toBe("What should the lead do in shop?");
  const starters = [...host.querySelectorAll("[data-entry=empty] button")].map((b) => b.textContent);
  expect(starters).toEqual([...STARTERS]);
});

const tabs = () => [...host.querySelectorAll("[data-section]")].map((t) => t.getAttribute("data-section"));

it("gives every project the same sections, Asked work under Plan", async () => {
  await mount(<ProjectPanel project={ADA} view={{ tab: "asked" }} onWide={() => undefined} />);
  expect(tabs()).toEqual(["agents", "shipping", "plan", "history"]);
  expect(host.querySelector("[aria-selected=true][data-section]")?.getAttribute("data-section")).toBe("plan");
  // One row of tabs: the asked work is a group of Plan's list, not a tab under it.
  expect(host.querySelectorAll("[data-tab]")).toHaveLength(0);
  act(() => root.unmount());
  root = createRoot(host);
  await mount(<ProjectPanel project={SHOP} view={{ tab: "checklist" }} onWide={() => undefined} />, undefined, "devbox/shop");
  expect(tabs()).toEqual(["agents", "shipping", "plan", "history"]);
});
