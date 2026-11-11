// @vitest-environment happy-dom
// Asked work, a group at the foot of a project's Plan: each ask a row that opens to its words and its orders, with no
// fleetd ids. Its old tab's route (`/asked`) opens the Plan at it.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetStatus, NaviAsksOutput, ProjectSummary } from "../../../shared/contracts";
import type { CallOutcome, HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { AT, live } from "../../src/data/fixtures.test-util";
import { UiProvider } from "../../ui";
import { orderHref } from "../automations/model";
import { PROJECT_TOOLS } from "../projects/model";
import { ChecklistPane } from "../checklist/ChecklistPane";
import { forgetFolds } from "../panel/folds";

const went = vi.hoisted(() => [] as unknown[]);
vi.mock("../shell/navigation", () => ({ navigate: (s: unknown) => went.push(s) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const summary = (title: string, extra: Partial<ProjectSummary> = {}): ProjectSummary => ({
  machineId: "devbox",
  projectId: title.toLowerCase(),
  title,
  workspaceRoot: `/home/dev/${title.toLowerCase()}`,
  lastActivityAt: AT,
  threads: { running: 0, waiting: 0, idle: 0, failed: 0 },
  ...extra,
});
const STOREFRONT = summary("storefront");
const ADA = summary("Ada", { onlyMe: true });

const snapshot = (cursor: number, projects: ProjectSummary[]): HubFrame => {
  const snap: FleetStatus = {
    cursor,
    attention: [],
    machines: [{ machineId: "devbox", name: "devbox", nodeVersion: "1", status: "online", lastSeenAt: AT, tags: [] }],
    projects,
  };
  return { t: "snapshot", snapshot: snap };
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  went.length = 0;
  forgetFolds();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const settle = async () => {
  for (let i = 0; i < 6; i++) await act(() => new Promise((done) => setTimeout(done, 0)));
};

const mount = async (ui: React.ReactNode, projects: ProjectSummary[], answer: (tool: string, input: unknown) => CallOutcome | undefined = () => undefined, features?: string[]) => {
  let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;
  const calls: { tool: string; input: unknown }[] = [];
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input });
      return Promise.resolve(answer(tool, input) ?? { ok: true, output: {} });
    },
    subscribe: (l) => ((send = l), () => undefined),
    resync: () => (calls.push({ tool: "resync", input: undefined }), Promise.resolve()),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  act(() => {
    root.render(
      <UiProvider>
        <DataProvider layer={createDataLayer(hub)}>{ui}</DataProvider>
      </UiProvider>,
    );
  });
  act(() => {
    send(live(features));
    send(snapshot(1, projects));
  });
  await settle();
  return { calls, send: (f: HubFrame) => act(() => send(f)) };
};

const screen = () => host.querySelector("[data-screen]")?.getAttribute("data-screen");
const buttons = () => [...host.querySelectorAll("button")].map((b) => b.textContent.trim());
const button = (name: string): HTMLButtonElement => {
  const b = [...host.querySelectorAll("button")].find((x) => x.textContent.trim() === name);
  if (b === undefined) throw new Error(`no button ${name} in: ${buttons().join(" | ")}`);
  return b;
};

const READ: NaviAsksOutput = {
  navi: { machineId: "devbox", projectId: "ada" },
  asks: [
    {
      handle: "N4",
      to: { machineId: "devbox", projectId: "billing" },
      toTitle: "billing",
      text: "Is the usage report ready?",
      at: AT,
      orders: [],
    },
    {
      handle: "N3",
      to: { machineId: "devbox", projectId: "storefront" },
      toTitle: "storefront",
      text: "Let people save their cart.",
      at: AT,
      orders: [
        { workstreamId: "W12", title: "Saved carts", state: "open", headline: "A writer adds the table." },
        { workstreamId: "W9", title: "Cart cleanup", state: "done", headline: "Merged #40." },
      ],
    },
  ],
};

const ADA_KEY = { machineId: "devbox", projectId: "ada" };
const ITEM = { id: 1, text: "Ship saved carts", state: "doing", createdAt: AT, updatedAt: AT };
const answers =
  (asks: NaviAsksOutput | "fails", items: readonly unknown[] = []) =>
  (tool: string): CallOutcome | undefined => {
    if (tool === PROJECT_TOOLS.asks) return asks === "fails" ? { ok: false, error: { code: "invalid", message: "no" } } : { ok: true, output: asks };
    if (tool === "checklist_get") return { ok: true, output: { items } };
    return undefined;
  };

describe("Asked work", () => {
  it("reads this project's asks and shows each ask as a row that opens to its words and orders, with no ids", async () => {
    const { calls } = await mount(<ChecklistPane project={ADA_KEY} at="asked" />, [STOREFRONT, ADA], answers(READ));
    expect(calls).toContainEqual({ tool: PROJECT_TOOLS.asks, input: { navi: { machineId: "devbox", projectId: "ada" } } });
    expect(screen()).toBe("asked");
    expect([...host.querySelectorAll("[data-ask]")].map((a) => a.getAttribute("data-ask"))).toEqual(["N4", "N3"]);
    // Closed: the ask in a line, its chip, the project; no order yet is Waiting.
    const waiting = host.querySelector("[data-ask=N4]");
    expect(waiting?.getAttribute("data-state")).toBe("waiting");
    expect(waiting?.textContent).toContain("Is the usage report ready?Waitingbilling");
    const ask = host.querySelector("[data-ask=N3]");
    const row = ask?.querySelector("button[aria-expanded]");
    expect(row?.getAttribute("aria-expanded")).toBe("false");
    expect(ask?.textContent).toContain("Let people save their cart.Workingstorefront");
    expect(ask?.textContent).not.toContain("Saved carts");
    // Open: the orders by title, each linked to its page, the open one with its headline; a finished one without.
    act(() => (row as HTMLButtonElement).click());
    expect(row?.getAttribute("aria-expanded")).toBe("true");
    const links = [...(ask?.querySelectorAll("a") ?? [])].map((a) => [a.textContent, a.getAttribute("href")]);
    expect(links).toEqual([
      ["Saved carts", orderHref("W12")],
      ["Cart cleanup", orderHref("W9")],
    ]);
    expect(ask?.textContent).toContain("Saved cartsWorking");
    expect(ask?.textContent).toContain("A writer adds the table.");
    expect(ask?.textContent).toContain("Cart cleanupDone");
    expect(ask?.textContent).not.toContain("Merged #40.");
    expect(host.textContent).not.toMatch(/\b[WN]\d+\b/u);
    act(() => button("storefront").click());
    expect(went).toEqual([{ id: "project", project: { machineId: "devbox", projectId: "storefront" }, message: null }]);
  });

  it("is a group under the plan's own, with no tab or switch to reach it, and only once there is something asked", async () => {
    await mount(<ChecklistPane project={ADA_KEY} />, [STOREFRONT, ADA], answers(READ, [ITEM]));
    expect(screen()).toBe("checklist");
    expect([...host.querySelectorAll("[data-group-label]")].map((l) => l.textContent)).toEqual(["Doing1", "Asked of other projects2"]);
    expect(host.querySelector("[role='tablist'], [role='tab']")).toBeNull();
    expect(host.querySelectorAll("[data-ask]")).toHaveLength(2);

    act(() => root.unmount());
    root = createRoot(host);
    await mount(<ChecklistPane project={ADA_KEY} />, [STOREFRONT, ADA], answers({ ...READ, asks: [] }, [ITEM]));
    expect([...host.querySelectorAll("[data-group-label]")].map((l) => l.textContent)).toEqual(["Doing1"]);
  });

  it("says in one line that nothing was asked, and a read that failed with Retry, where its old tab's link opens", async () => {
    await mount(<ChecklistPane project={ADA_KEY} at="asked" />, [STOREFRONT, ADA], answers({ ...READ, asks: [] }));
    expect(screen()).toBe("asked");
    expect(host.querySelector("[data-panel-empty]")?.textContent).toBe("Nothing asked yet");

    act(() => root.unmount());
    root = createRoot(host);
    await mount(<ChecklistPane project={ADA_KEY} at="asked" />, [STOREFRONT, ADA], answers({ ...READ, asks: [] }, [ITEM]));
    expect(host.querySelector("section[aria-label='Asked of other projects']")?.textContent).toBe("Asked of other projectsNothing asked yet.");

    act(() => root.unmount());
    root = createRoot(host);
    await mount(<ChecklistPane project={ADA_KEY} at="asked" />, [STOREFRONT, ADA], answers("fails", [ITEM]));
    expect(screen()).toBe("asked.error");
    expect(host.querySelector("section[aria-label='Asked of other projects'] [role='alert']")?.textContent).toContain("Couldn’t read the asked work.");
    expect(button("Retry")).toBeDefined();
  });
});
