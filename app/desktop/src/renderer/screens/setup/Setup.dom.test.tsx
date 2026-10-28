// @vitest-environment happy-dom
// The setup screens on the hub's own answers (fixtures/setup/steps.json, written from hub/setup's catalog): only an
// admin sees them, Test and Skip go to the hub and the step updates in place, each step opens where its result is
// saved, the empty home is the welcome while a required step is left, and Administration's entry counts them.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixtures from "../../../../fixtures/setup/steps.json" with { type: "json" };
import type { CallOutcome, HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { FirstRun } from "./FirstRun";
import { SetupScreen } from "./SetupScreen";
import type { SetupStep } from "./steps";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

type Reads = Readonly<Record<string, Partial<SetupStep>>>;
type Scenario = { requiredLeft: number; list: Reads; tests: Reads; skips: Reads; unskips: Reads };
const scenarios = fixtures.scenarios as unknown as Readonly<Record<string, Scenario>>;
const guides = fixtures.guides as unknown as ReadonlyArray<SetupStep>;
const step = (id: string, read: Partial<SetupStep> | undefined): SetupStep => ({ ...(guides.find((g) => g.id === id) as SetupStep), ...read });

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ tool: string; input: unknown }>;
let admin: boolean;
let scenario: Scenario;
/** Sends the app a frame, as the hub's feed would. */
let send: (frame: HubFrame) => void = () => undefined;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  calls = [];
  admin = true;
  scenario = scenarios["setup-github"] as Scenario;
  vi.stubGlobal("fleetd", { platform: "linux", openExternal: () => Promise.resolve({ ok: true }) });
  window.location.hash = "#/setup";
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const answer = (tool: string, input: unknown): CallOutcome => {
  const asked = input as { step?: string; skipped?: boolean };
  switch (tool) {
    case "hub_info":
      return { ok: true, output: { version: "0.9.0", protocol: 1, busy: [], admin } };
    case "setup_list":
      return { ok: true, output: { steps: guides.map((g) => step(g.id, scenario.list[g.id])), requiredLeft: scenario.requiredLeft } };
    case "setup_test":
      return { ok: true, output: { step: step(asked.step ?? "", scenario.tests[asked.step ?? ""]) } };
    case "setup_skip": {
      const reads = asked.skipped === true ? scenario.skips : scenario.unskips;
      return { ok: true, output: { step: step(asked.step ?? "", reads[asked.step ?? ""]) } };
    }
    default:
      return { ok: true, output: {} };
  }
};

const render = async (node: ReactNode) => {
  // A fresh root each time, so nothing a render kept carries into the next.
  act(() => root.unmount());
  root = createRoot(host);
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input });
      return Promise.resolve(answer(tool, input));
    },
    subscribe: (l) => ((listener = l), (send = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  const layer = createDataLayer(hub);
  await act(async () => {
    root.render(
      <UiProvider>
        <DataProvider layer={layer}>{node}</DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    listener({ t: "state", state: { phase: "live", hub: "devbox:4790", protocol: 1 } });
    listener({ t: "snapshot", snapshot: { cursor: 1, attention: [], machines: [], projects: [] } });
    await new Promise((r) => setTimeout(r, 0));
  });
  await settle();
  await settle();
};

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const button = (text: string) => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === text);
  if (b === undefined) throw new Error(`no button ${text} in: ${document.body.textContent}`);
  return b;
};
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
  await settle();
};
const pane = () => document.querySelector("article[data-step]");
const rail = (id: string) => document.querySelector(`nav [data-step="${id}"]`)?.textContent ?? "";

describe("setup", () => {
  it("opens the first step not done, with the hub's guide, and Test runs that step's checks on the hub", async () => {
    await render(<SetupScreen view={null} />);
    expect(document.querySelector("[data-screen='setup']")).not.toBeNull();
    expect(document.body.textContent).toContain("3 of 7 done.");
    // Claude is done with the hub's key; GitHub is next, to do before the first PR (no project yet), not failing.
    expect(rail("claude")).toContain("Done");
    expect(rail("github")).toContain("Before the first PR");
    expect(pane()?.getAttribute("data-step")).toBe("github");
    expect(pane()?.textContent).toContain("fleetd github-app create");
    await click(button("Test"));
    expect(calls.filter((c) => c.tool === "setup_test")).toEqual([{ tool: "setup_test", input: { step: "github" } }]);
    expect(pane()?.textContent).toContain("is installed on acme (2 repositories), and its tokens work.");
    expect(rail("github")).toContain("Done");
  });

  it("asks the hub again when its checks change, and each time a setup view opens, so a save elsewhere shows", async () => {
    await render(<SetupScreen view="claude" />);
    expect(rail("github")).toContain("Before the first PR");
    // gh logged in on the hub (fleetd init, or a terminal): the doctor's next run says so, and the steps follow.
    scenario = { ...scenario, list: { ...scenario.list, github: scenario.tests["github"] ?? {} } };
    await act(async () => {
      send({ t: "event", event: { seq: 2, at: "2026-10-19T10:00:00.000Z", type: "doctor.changed", summary: "doctor: hub/gh_auth fail → ok", data: {} } });
      await new Promise((r) => setTimeout(r, 300));
    });
    await settle();
    expect(rail("github")).toContain("Done");
    // Opening a setup view reads them again, whatever was cached.
    const lists = () => calls.filter((c) => c.tool === "setup_list").length;
    const before = lists();
    await render(<FirstRun onAddProject={() => undefined} />);
    expect(lists()).toBeGreaterThan(before);
  });

  it("puts an optional step off for later on the hub, and back", async () => {
    await render(<SetupScreen view="google" />);
    await click(button("Skip for now"));
    expect(calls.find((c) => c.tool === "setup_skip")?.input).toEqual({ step: "google", skipped: true });
    expect(rail("google")).toContain("Later");
    // Skip went on to the next step; the screen here stays on Google, now later.
    expect(window.location.hash).toBe("#/setup/notion");
    await click(button("Back on the list"));
    expect(calls.filter((c) => c.tool === "setup_skip").at(-1)?.input).toEqual({ step: "google", skipped: false });
    expect(rail("google")).toContain("Optional");
    // A required step can't wait.
    await render(<SetupScreen view="machines" />);
    expect([...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Skip for now")).toBe(false);
  });

  it("opens where a step's result is saved: Claude's key on Administration, a subscription in Settings", async () => {
    await render(<SetupScreen view="claude" />);
    await click(button("Open Administration › Claude"));
    expect(window.location.hash).toContain("admin/claude");
    await click(button("Open Settings › Claude"));
    expect(window.location.hash).toContain("settings/claude");
  });

  it("is for admins only", async () => {
    admin = false;
    await render(<SetupScreen view={null} />);
    expect(document.querySelector("[data-screen='setup.denied']")).not.toBeNull();
    expect(calls.some((c) => c.tool === "setup_test")).toBe(false);
  });

  it("makes the empty home setup's welcome while a required step is left, and Get started after", async () => {
    scenario = scenarios["setup-fresh"] as Scenario;
    await render(<FirstRun onAddProject={() => undefined} />);
    expect(document.querySelector("[data-screen='setup.welcome']")).not.toBeNull();
    expect(document.body.textContent).toContain("Needed before agents can run");
    scenario = scenarios["setup-done"] as Scenario;
    await render(<FirstRun onAddProject={() => undefined} />);
    expect(document.querySelector("[data-screen='setup.welcome']")).toBeNull();
    expect(document.body.textContent).toContain("Add a project to chat with its lead");
    // A member never sees setup, and the hub isn't asked.
    admin = false;
    scenario = scenarios["setup-fresh"] as Scenario;
    calls = [];
    await render(<FirstRun onAddProject={() => undefined} />);
    expect(document.body.textContent).toContain("Add a project to chat with its lead");
    expect(calls.some((c) => c.tool === "setup_list")).toBe(false);
  });
});
