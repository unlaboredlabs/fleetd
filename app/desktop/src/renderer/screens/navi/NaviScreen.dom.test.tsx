// @vitest-environment happy-dom
// #/navi: the first run says what Navi is and has one button, which makes a Navi (called Navi when unnamed) and opens
// its chat once the hub has added it; with Navis, the list and the archived ones, each a click from coming back.
// Asked work, in a Navi's panel: each ask with its orders, or a plain sentence on a hub that doesn't serve it.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetStatus, ProjectSummary } from "../../../shared/contracts";
import type { CallOutcome, HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { AT, live } from "../../src/data/fixtures.test-util";
import { UiProvider } from "../../ui";
import { AskedPane } from "./AskedPane";
import type { AskedWorkRead } from "./model";
import { NaviScreen } from "./NaviScreen";

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
const ADA = summary("Ada", { kind: "assistant" });
const TAXES = summary("Taxes", { kind: "assistant", archivedAt: AT });

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
    resync: () => Promise.resolve(),
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

describe("Navi's first run", () => {
  it("says what Navi does and what it asks first, with one button", async () => {
    await mount(<NaviScreen />, [STOREFRONT]);
    expect(screen()).toBe("navi.empty");
    expect(host.textContent).toContain("Meet Navi");
    expect(host.textContent).toContain("never sends, posts, pays or deletes without asking you first");
    expect(buttons()).toEqual(["Create your Navi"]);
  });

  it("makes a Navi called Navi when unnamed, and opens its chat once the hub has added it", async () => {
    const made = summary("Navi", { kind: "assistant", projectId: "navi" });
    const { calls, send } = await mount(<NaviScreen />, [STOREFRONT], (tool) => (tool === "navi_create" ? { ok: true, output: { navi: made } } : undefined));
    act(() => button("Create your Navi").click());
    await settle();
    expect(calls.filter((c) => c.tool === "navi_create")).toEqual([{ tool: "navi_create", input: { name: "Navi" } }]);
    expect(button("Creating…").disabled).toBe(true);
    expect(went).toEqual([]);
    // project.added, then the resync's snapshot with it.
    send(snapshot(2, [STOREFRONT, made]));
    await settle();
    expect(went).toEqual([{ id: "project", project: { machineId: "devbox", projectId: "navi" }, message: null }]);
  });

  it("shows the hub's reason when it can't make one", async () => {
    await mount(<NaviScreen />, [STOREFRONT], (tool) =>
      tool === "navi_create" ? { ok: false, error: { code: "unavailable", message: "No machine can hold a Navi yet.", fix: "Run `fleetd update` on devbox." } } : undefined,
    );
    act(() => button("Create your Navi").click());
    await settle();
    expect(host.querySelector("[role=alert]")?.textContent).toContain("No machine can hold a Navi yet.");
    expect(host.querySelector("[role=alert] code")?.textContent).toBe("fleetd update");
    expect(button("Create your Navi").disabled).toBe(false);
  });
});

describe("with Navis", () => {
  it("lists them with the archived ones, which come back in a click", async () => {
    const { calls } = await mount(<NaviScreen />, [STOREFRONT, ADA, TAXES]);
    expect(screen()).toBe("navi");
    expect(host.querySelector("[aria-label='Your Navis']")?.textContent).toContain("AdaOn devbox");
    expect(host.querySelector("[aria-label='Archived']")?.textContent).toContain("Taxes");
    act(() => button("Bring back").click());
    await settle();
    expect(calls).toContainEqual({ tool: "navi_archive", input: { machineId: "devbox", projectId: "taxes", archived: false } });
    act(() => button("AdaOn devbox").click());
    expect(went).toEqual([{ id: "project", project: { machineId: "devbox", projectId: "ada" }, message: null }]);
  });
});

const READ: AskedWorkRead = {
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

describe("Asked work", () => {
  it("reads navi_asks for this Navi and shows each ask with its orders, in the hub's order, linking to the project", async () => {
    const { calls } = await mount(<AskedPane project={{ machineId: "devbox", projectId: "ada" }} />, [STOREFRONT, ADA], (tool) => (tool === "navi_asks" ? { ok: true, output: READ } : undefined), ["navi_asks"]);
    expect(calls).toContainEqual({ tool: "navi_asks", input: { navi: { machineId: "devbox", projectId: "ada" } } });
    expect(screen()).toBe("asked");
    expect([...host.querySelectorAll("[data-ask]")].map((a) => a.getAttribute("data-ask"))).toEqual(["N4", "N3"]);
    expect(host.querySelector("[data-ask=N4]")?.textContent).toContain("No order opened for it yet");
    const ask = host.querySelector("[data-ask=N3]");
    expect(ask?.textContent).toContain("Let people save their cart.");
    expect(ask?.textContent).toContain("W12Saved cartsIn progress");
    expect(ask?.textContent).toContain("A writer adds the table.");
    // A finished order says so, without its last headline.
    expect(ask?.textContent).toContain("W9Cart cleanupDone");
    expect(ask?.textContent).not.toContain("Merged #40.");
    act(() => button("storefront").click());
    expect(went).toEqual([{ id: "project", project: { machineId: "devbox", projectId: "storefront" }, message: null }]);
  });

  it("says plainly when the hub doesn't serve it, and asks nothing", async () => {
    const { calls } = await mount(<AskedPane project={{ machineId: "devbox", projectId: "ada" }} />, [STOREFRONT, ADA]);
    expect(screen()).toBe("asked.unserved");
    expect(calls.map((c) => c.tool)).not.toContain("navi_asks");
  });
});
