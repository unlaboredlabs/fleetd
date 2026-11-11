// @vitest-environment happy-dom
// The setup screens on the hub's own answers (fixtures/setup/steps.json, written from hub/setup's catalog): only an
// admin sees them, Test goes to the hub and the step updates in place, each step opens where its result is
// saved, the empty home is the welcome while a required step is left, the first run walks every step left to its end,
// and Settings › Hub › Setup shows only the steps left, a row each that opens the step's guide, the done ones folded
// into one line.
import { act, useEffect, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixtures from "../../../../fixtures/setup/steps.json" with { type: "json" };
import type { CallOutcome, HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { AppFrame, TopBar, UiProvider } from "../../ui";
import { SetupPage } from "../admin/SetupPage";
import { parseHash } from "../shell/routes";
import { FirstRun } from "./FirstRun";
import { SetupScreen } from "./SetupScreen";
import type { SetupStep } from "./steps";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

type Reads = Readonly<Record<string, Partial<SetupStep>>>;
type Scenario = { requiredLeft: number; list: Reads; tests: Reads };
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
  const asked = input as { step?: string };
  switch (tool) {
    case "hub_info":
      return { ok: true, output: { version: "0.9.0", protocol: 1, busy: [], admin } };
    case "setup_list":
      return { ok: true, output: { steps: guides.map((g) => step(g.id, scenario.list[g.id])), requiredLeft: scenario.requiredLeft } };
    case "setup_test":
      return { ok: true, output: { step: step(asked.step ?? "", scenario.tests[asked.step ?? ""]) } };
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
/** The first run as the app routes it: #/setup's view, followed as the flow moves on. */
function Routed() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const screen = parseHash(hash);
  return <SetupScreen view={screen.id === "setup" ? screen.view : null} />;
}
/** A press that moves the flow on: the hash changes, and the route follows. */
const go = async (el: HTMLElement) => {
  await click(el);
  await act(async () => {
    window.dispatchEvent(new Event("hashchange"));
    await Promise.resolve();
  });
  await settle();
};
/** Settings › Hub › Setup in the window's frame, whose top row holds a step's name and the way back. */
const page = (
  <AppFrame topBar={<TopBar />} sidebar={null}>
    <SetupPage />
  </AppFrame>
);
const settings = () => document.querySelector("[data-screen='settings.hub.setup']");
const rows = (label: string) => [...document.querySelectorAll(`[role='list'][aria-label='${label}'] [data-step]`)].map((r) => `${r.getAttribute("data-step") ?? ""}:${r.textContent}`);
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

  it("opens where a step's result is saved: Claude's key on Hub accounts, a subscription in Your accounts", async () => {
    await render(<SetupScreen view="claude" />);
    await click(button("Open Hub accounts"));
    expect(window.location.hash).toContain("settings/hub/accounts");
    await click(button("Open Your accounts"));
    expect(window.location.hash).toContain("settings/accounts");
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

  it("walks the first run end to end: the welcome, every step left with its guide and Test, then the end", async () => {
    scenario = scenarios["setup-github"] as Scenario;
    window.location.hash = "#/setup/welcome";
    await render(<Routed />);
    expect(document.querySelector("[data-screen='setup.welcome']")).not.toBeNull();
    await go(button("Start setup"));
    // The steps down the left under their groups, every one of them, done or not.
    expect([...document.querySelectorAll("nav [data-step]")].map((b) => b.getAttribute("data-step")).sort()).toEqual(guides.map((g) => g.id).sort());
    expect(pane()?.getAttribute("data-step")).toBe("github");
    await click(button("Test"));
    expect(rail("github")).toContain("Done");
    const walked: string[] = [];
    for (const id of ["onepassword", "people", "mac"]) {
      await go(button("Continue"));
      expect(pane()?.getAttribute("data-step")).toBe(id);
      walked.push(pane()?.querySelector("h2")?.textContent ?? "");
    }
    expect(walked).toEqual(["1Password", "Invite people", "A Mac for agents"]);
    await go(button("Finish"));
    expect(document.querySelector("[data-screen='setup.done']")).not.toBeNull();
    expect(document.body.textContent).toContain("fleetd is ready");
    await click(button("Add a project"));
    expect(window.location.hash).toBe("#/projects/add");
  });
});

describe("Settings › Hub › Setup", () => {
  it("shows only the steps left, one row each with when it is needed, and the done ones as one line", async () => {
    await render(page);
    expect(rows("Steps left")).toEqual(["github:GitHubBefore the first PR", "onepassword:1PasswordBefore the first login", "people:Invite peopleOptional", "mac:A Mac for agentsOptional"]);
    expect(rows("Steps done")).toEqual([]);
    // Nothing required is left: no line says so. No rail, no guide, no step that is done.
    expect(settings()?.textContent).toBe("GitHubBefore the first PR1PasswordBefore the first loginInvite peopleOptionalA Mac for agentsOptional3 done.Show steps");
    expect(document.querySelector("nav [data-step]")).toBeNull();
    expect(pane()).toBeNull();

    // The done steps are still there to change a value or test one.
    await click(button("Show steps"));
    expect(rows("Steps done")).toEqual(["address:Where the hub listens", "machines:Machines that run agents", "claude:Claude"]);
    await click(button("Hide steps"));
    expect(rows("Steps done")).toEqual([]);
  });

  it("says how many required steps are left, and marks one that needs a look", async () => {
    scenario = scenarios["setup-fresh"] as Scenario;
    await render(page);
    expect(settings()?.textContent).toContain("1 required before agents can run.");
    expect(rows("Steps left")[0]).toBe("claude:ClaudeNeeds a look");
    expect(settings()?.textContent).toContain("2 done.");
  });

  it("is one quiet line once every step is done", async () => {
    scenario = scenarios["setup-all"] as Scenario;
    await render(page);
    expect(settings()?.textContent).toBe("Everything is set up.Show steps");
    expect(document.querySelector("[role='list']")).toBeNull();
    await click(button("Show steps"));
    expect(rows("Steps done").map((r) => r.slice(0, r.indexOf(":")))).toEqual(guides.map((g) => g.id));
  });

  it("opens a step's guide in place, with its paste values and Test, and the way back to the steps", async () => {
    await render(page);
    await click(button("GitHub"));
    expect(document.querySelector("[data-screen='settings.hub.setup.step']")).not.toBeNull();
    expect(settings()).toBeNull();
    expect(pane()?.getAttribute("data-step")).toBe("github");
    expect(pane()?.textContent).toContain("fleetd github-app create");
    await click(button("Test"));
    expect(calls.filter((c) => c.tool === "setup_test")).toEqual([{ tool: "setup_test", input: { step: "github" } }]);
    expect(pane()?.textContent).toContain("is installed on acme (2 repositories), and its tokens work.");
    // Back: GitHub is done, so it is no longer a step left.
    await click(button("‹ Setup"));
    expect(rows("Steps left").map((r) => r.slice(0, r.indexOf(":")))).toEqual(["onepassword", "people", "mac"]);
    expect(settings()?.textContent).toContain("4 done.");
  });
});
