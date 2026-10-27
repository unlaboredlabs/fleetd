// @vitest-environment happy-dom
// A Navi's chat is the chat screen as an assistant's: its first message is the person's to a Navi, the box says whose
// it is, and its panel has its own sections (Asked work, Plan, History; Screens once served), no agents or PRs.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FleetStatus } from "../../../shared/contracts";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { AT, live } from "../../src/data/fixtures.test-util";
import { UiProvider } from "../../ui";
import { ChatScreen } from "../chat";
import { NAVI_STARTERS } from "../chat/EmptyChat";
import { ProjectPanel } from "../panel/ProjectPanel";
import { forgetViews } from "../panel/Sections";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => vi.stubGlobal("fleetd", { platform: "linux", fixture: null }));

const ADA = { machineId: "devbox", projectId: "ada" } as const;

const snapshot: HubFrame = {
  t: "snapshot",
  snapshot: {
    cursor: 1,
    attention: [],
    machines: [{ machineId: "devbox", name: "devbox", nodeVersion: "1", status: "online", lastSeenAt: AT, tags: [] }],
    projects: [{ ...ADA, title: "Ada", workspaceRoot: "/home/dev/.fleetd/navi/ada", lastActivityAt: AT, threads: { running: 0, waiting: 0, idle: 1, failed: 0 }, kind: "assistant" }],
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

const mount = async (ui: ReactNode, features?: string[]) => {
  let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;
  const answers: Readonly<Record<string, unknown>> = {
    orders_board: { orders: [] },
    chat_history: { messages: [], moreBefore: false, moreAfter: false, state: { projectRef: ADA, needsYou: false, leadWorking: false, lastSeq: 0 } },
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
  layer.chat.open("devbox/ada");
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

it("asks what the Navi can do for you, with an assistant's starters, and the box names it", async () => {
  await mount(<ChatScreen project={ADA} />);
  expect(host.querySelector("h2")?.textContent).toBe("What can Ada do for you?");
  const starters = [...host.querySelectorAll("[data-entry=empty] button")].map((b) => b.textContent);
  expect(starters).toEqual([...NAVI_STARTERS]);
  expect(host.querySelector("textarea")?.getAttribute("placeholder")).toBe("Message Ada");
});

it("gives the panel a Navi's sections, and a link to a project's view opens its first", async () => {
  await mount(<ProjectPanel project={ADA} view={{ tab: "prs", pr: null }} onWide={() => undefined} />);
  const tabs = () => [...host.querySelectorAll("[data-section]")].map((t) => t.getAttribute("data-section"));
  expect(tabs()).toEqual(["asked", "plan", "history"]);
  expect(host.querySelector("[aria-selected=true][data-section]")?.getAttribute("data-section")).toBe("asked");
  act(() => root.unmount());
  root = createRoot(host);
  await mount(<ProjectPanel project={ADA} view={{ tab: "asked" }} onWide={() => undefined} />, ["browser_sessions"]);
  expect(tabs()).toEqual(["asked", "screens", "plan", "history"]);
});
