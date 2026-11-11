// @vitest-environment happy-dom
// The setup screens on the hub's own answers (fixtures/setup/steps.json, written from hub/setup's catalog): only an
// admin sees them, Test goes to the hub and the step updates in place, each step opens where its result is
// saved, the empty home is the welcome while a required step is left, the first run walks every step left to its end,
// and Settings › Hub › Setup shows the hub's accounts, every one a row that is its state and opens its controls over
// the step's guide, then the other steps left, the done ones folded into one line.
import { act, useEffect, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixtures from "../../../../fixtures/setup/steps.json" with { type: "json" };
import type { GithubApp } from "../../../shared/contracts";
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

/** The hub's GitHub App once made, installed nowhere; and as its Test leaves it, on the hub. */
const made: GithubApp = {
  appId: 4242,
  slug: "fleetd-on-devbox",
  name: "fleetd on devbox",
  clientId: "Iv23liTEST",
  owner: "acme",
  htmlUrl: "https://github.com/apps/fleetd-on-devbox",
  settingsUrl: "https://github.com/organizations/acme/settings/apps/fleetd-on-devbox",
  createdAt: "2026-10-18T10:00:00.000Z",
};
const installed: GithubApp = {
  ...made,
  installations: [{ installationId: 7, account: "acme", allRepositories: false, repositoryCount: 2, repositories: ["acme/web", "acme/api"] }],
  lastTest: { at: "2026-10-19T08:30:00.000Z", ok: true, said: '"fleetd on devbox" is installed on acme (2 repositories), and its tokens work.' },
};

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ tool: string; input: unknown }>;
let admin: boolean;
let scenario: Scenario;
/** The hub's GitHub App; none unless a test makes one. Its GitHub step reads done once the App's test passed. */
let app: GithubApp | undefined;
/** Sends the app a frame, as the hub's feed would. */
let send: (frame: HubFrame) => void = () => undefined;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  calls = [];
  admin = true;
  scenario = scenarios["setup-github"] as Scenario;
  app = undefined;
  vi.stubGlobal("fleetd", {
    platform: "linux",
    openExternal: () => Promise.resolve({ ok: true }),
    github: {
      createApp: (): Promise<CallOutcome> => {
        app = made;
        return Promise.resolve({ ok: true, output: { app: made } });
      },
      cancel: () => Promise.resolve(),
    },
  });
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
    case "setup_list": {
      const reads: Reads = app?.lastTest?.ok === true ? { ...scenario.list, github: scenario.tests.github ?? {} } : scenario.list;
      return { ok: true, output: { steps: guides.map((g) => step(g.id, reads[g.id])), requiredLeft: scenario.requiredLeft } };
    }
    case "setup_test":
      // GitHub's Test runs the App's own, as the hub does.
      if (asked.step === "github" && app !== undefined) app = installed;
      return { ok: true, output: { step: step(asked.step ?? "", scenario.tests[asked.step ?? ""]) } };
    // The hub's own accounts, whose controls Settings › Hub › Setup holds: a key sealed on devbox, and no GitHub App.
    case "claude_accounts_get":
      return {
        ok: true,
        output: {
          hubApi: { sealedOn: [{ machineId: "devbox", fingerprint: "ab12cd34" }], updatedAt: "2026-10-19T08:00:00.000Z" },
          settings: { membersUseHubApi: true },
          leadsRunOn: { kind: "account", account: { kind: "hub" } },
          people: [],
        },
      };
    case "claude_account_test":
      return { ok: true, output: { test: { at: "2026-10-19T08:30:00.000Z", machineId: "devbox", ok: true } } };
    case "usage_status":
      return { ok: true, output: { machines: [] } };
    case "people_list":
      return { ok: true, output: { people: [], devices: [], invites: [] } };
    case "github_app_get":
      return { ok: true, output: { ...(app === undefined ? {} : { app }), permissions: [], authorizeUrl: "https://github.com/login/oauth/authorize", people: [] } };
    case "github_app_test":
      app = installed;
      return { ok: true, output: { app } };
    case "github_app_remove":
      app = undefined;
      return { ok: true, output: { settingsUrl: made.settingsUrl } };
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
    <SetupPage me={undefined} />
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

  it("opens where a step's result is saved: Claude's key on Hub › Setup › Claude, a subscription in Your accounts", async () => {
    await render(<SetupScreen view="claude" />);
    await click(button("Open Hub › Setup › Claude"));
    expect(parseHash(window.location.hash)).toMatchObject({ id: "settings", tab: "hub.setup" });
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
  it("lists the hub's accounts, every one a row saying where it stands, then the other steps left, and the done ones as one line", async () => {
    await render(page);
    // Claude is done and stays listed, saying what it uses; the others say when they are needed.
    expect(rows("Accounts")).toEqual(["claude:ClaudeUses the hub's API key", "github:GitHubBefore the first PR", "onepassword:1PasswordBefore the first login"]);
    expect(rows("Steps left")).toEqual(["people:Invite peopleOptional", "mac:A Mac for agentsOptional"]);
    expect(rows("Steps done")).toEqual([]);
    // Nothing required is left: no line says so. Titles and rows only: no rail, no guide, no control of an account.
    expect(settings()?.textContent).toBe(
      "AccountsClaudeUses the hub's API keyGitHubBefore the first PR1PasswordBefore the first loginThis hubInvite peopleOptionalA Mac for agentsOptional2 done.Show steps",
    );
    expect(document.querySelector("nav [data-step]")).toBeNull();
    expect(pane()).toBeNull();
    expect(settings()?.querySelector("input, [role='switch']")).toBeNull();

    // The done steps are still there to change a value or test one.
    await click(button("Show steps"));
    expect(rows("Steps done")).toEqual(["address:Where the hub listens", "machines:Machines that run agents"]);
    await click(button("Hide steps"));
    expect(rows("Steps done")).toEqual([]);
  });

  it("says how many required steps are left, and puts the account that needs a look first", async () => {
    scenario = scenarios["setup-fresh"] as Scenario;
    await render(page);
    expect(settings()?.textContent).toContain("1 required before agents can run.");
    expect(rows("Accounts")).toEqual(["claude:ClaudeNeeds a look", "github:GitHubBefore the first PR", "onepassword:1PasswordBefore the first login"]);
    expect(settings()?.textContent).toContain("2 done.");
  });

  it("puts another step that needs someone before the accounts, when no account does", async () => {
    const done = scenarios["setup-done"] as Scenario;
    scenario = { ...done, requiredLeft: 1, list: { ...done.list, machines: { status: "look", failing: true, said: "devbox is offline." } } };
    await render(page);
    expect([...(settings()?.querySelectorAll("[role='list']") ?? [])].map((l) => l.getAttribute("aria-label"))).toEqual(["Steps left", "Accounts"]);
    expect(rows("Steps left")[0]).toBe("machines:Machines that run agentsNeeds a look");
  });

  it("keeps every account a row once every step is done, and the rest one quiet line", async () => {
    scenario = scenarios["setup-all"] as Scenario;
    await render(page);
    expect(settings()?.textContent).toBe("AccountsClaudeUses the hub's API keyGitHubUses the hub's GitHub App1PasswordDoneEverything is set up.Show steps");
    expect([...document.querySelectorAll("[role='list']")].map((l) => l.getAttribute("aria-label"))).toEqual(["Accounts"]);
    await click(button("Show steps"));
    expect(rows("Steps done").map((r) => r.slice(0, r.indexOf(":")))).toEqual(["address", "machines", "people", "mac"]);
  });

  it("opens an account in place: its controls, then its guide with its paste values and Test, and the way back", async () => {
    await render(page);
    await click(button("GitHub"));
    expect(document.querySelector("[data-screen='settings.hub.setup.step']")).not.toBeNull();
    expect(settings()).toBeNull();
    expect(pane()?.getAttribute("data-step")).toBe("github");
    // The hub's GitHub App, here and nowhere else: its state, and Create.
    expect(pane()?.querySelector("[data-part='admin.github']")?.textContent).toContain("No App yet");
    expect(pane()?.textContent).toContain("Create the App");
    // Not done yet, so its guide is open under them; the hub's side is this page, so only yours is a button.
    expect(pane()?.textContent).toContain("fleetd github-app create");
    expect([...(pane()?.querySelectorAll("button") ?? [])].map((b) => b.textContent.trim()).filter((t) => t.startsWith("Open "))).toEqual(["Open Your accounts"]);
    await click(button("Test"));
    expect(calls.filter((c) => c.tool === "setup_test")).toEqual([{ tool: "setup_test", input: { step: "github" } }]);
    expect(pane()?.textContent).toContain("is installed on acme (2 repositories), and its tokens work.");
    // Done now, and the guide it was done from stays open, with what the Test said.
    expect(pane()?.textContent).toContain("fleetd github-app create");
    expect(button("Hide the guide")).not.toBeNull();
    // Back: GitHub is done, and still a row, in its place.
    await click(button("‹ Setup"));
    expect(rows("Accounts")).toEqual(["claude:ClaudeUses the hub's API key", "github:GitHubUses the hub's GitHub App", "onepassword:1PasswordBefore the first login"]);
    expect(settings()?.textContent).toContain("2 done.");
  });

  it("keeps GitHub's row, its step and the App's controls saying the same after the App's Test, the step's Test, Remove and Create", async () => {
    const card = () => pane()?.querySelector("[data-part='admin.github']");
    const tests = () => [...(pane()?.querySelectorAll("button") ?? [])].filter((b) => b.textContent.trim() === "Test");
    const asked = (tool: string) => calls.filter((c) => c.tool === tool).length;
    const github = () => rows("Accounts").find((r) => r.startsWith("github:"));
    // An App made and installed nowhere: the step is still to do.
    app = made;
    await render(page);
    expect(github()).toBe("github:GitHubBefore the first PR");
    await click(button("GitHub"));
    expect(card()?.textContent).toContain("Not installed yet");
    expect(tests()).toHaveLength(2);
    // The App's own Test: the step under it reads the hub again, and so does its row.
    let lists = asked("setup_list");
    await click(tests()[0] as HTMLElement);
    expect(asked("github_app_test")).toBe(1);
    expect(asked("setup_list")).toBe(lists + 1);
    expect(card()?.textContent).toContain("acme: acme/web and acme/api");
    // Done now: only a done account's guide can be hidden.
    expect(button("Hide the guide")).not.toBeNull();
    await click(button("‹ Setup"));
    expect(github()).toBe("github:GitHubUses the hub's GitHub App");
    // Remove: the row stops saying the hub uses it.
    await click(button("GitHub"));
    lists = asked("setup_list");
    await click(button("Remove"));
    const confirm = [...document.querySelectorAll<HTMLButtonElement>("[role='dialog'] button")].find((b) => b.textContent.trim() === "Remove");
    if (confirm === undefined) throw new Error("no confirm");
    await click(confirm);
    expect(asked("github_app_remove")).toBe(1);
    expect(asked("setup_list")).toBe(lists + 1);
    expect(card()?.textContent).toContain("No App yet");
    await click(button("‹ Setup"));
    expect(github()).toBe("github:GitHubBefore the first PR");
    // Create: the step is read again with the App made.
    await click(button("GitHub"));
    lists = asked("setup_list");
    await click(button("Create GitHub App"));
    expect(card()?.textContent).toContain("Not installed yet");
    expect(asked("setup_list")).toBe(lists + 1);
    // The step's Test runs the App's on the hub: the App's controls read it again, and say what the step says.
    const gets = asked("github_app_get");
    await click(tests()[tests().length - 1] as HTMLElement);
    expect(asked("setup_test")).toBe(1);
    expect(asked("github_app_get")).toBe(gets + 1);
    expect(pane()?.textContent).toContain("is installed on acme (2 repositories), and its tokens work.");
    expect(card()?.textContent).toContain("acme: acme/web and acme/api");
    expect(card()?.textContent).not.toContain("Not installed yet");
  });

  it("holds every control of the hub's Claude on its page, its guide and the step's Test folded once it is done", async () => {
    await render(page);
    await click(button("Claude"));
    expect(pane()?.getAttribute("data-step")).toBe("claude");
    const key = pane()?.querySelector<HTMLElement>("section[aria-label='Hub API key']");
    expect(key?.textContent).toContain("Sealed on devbox.");
    expect([...(key?.querySelectorAll("button") ?? [])].map((b) => b.textContent.trim())).toEqual(["Test", "Change", "Remove"]);
    expect(pane()?.querySelector("section[aria-label=\"Members may use the hub's API key\"] [role='switch']")).not.toBeNull();
    // The guide and the step's Test wait behind one line: at rest the key's own Test is the only one.
    const tests = () => [...(pane()?.querySelectorAll("button") ?? [])].filter((b) => b.textContent.trim() === "Test");
    expect(pane()?.textContent).not.toContain("Give the hub an API key");
    expect(tests()).toHaveLength(1);
    await click(tests()[0] as HTMLElement);
    expect(calls.filter((c) => c.tool === "claude_account_test").map((c) => c.input)).toEqual([{ account: "hub_api" }]);
    expect(calls.some((c) => c.tool === "setup_test")).toBe(false);
    // Shown, the guide is the first run's, less the button back to this page, and its Test reads all of the hub's
    // checks for Claude.
    await click(button("Show the guide"));
    expect(pane()?.textContent).toContain("Give the hub an API key");
    expect([...(pane()?.querySelectorAll("button") ?? [])].map((b) => b.textContent.trim()).filter((t) => t.startsWith("Open "))).toEqual(["Open Your accounts"]);
    expect(tests()).toHaveLength(2);
    await click(tests()[1] as HTMLElement);
    expect(calls.filter((c) => c.tool === "setup_test").map((c) => c.input)).toEqual([{ step: "claude" }]);
    await click(button("Hide the guide"));
    expect(pane()?.textContent).not.toContain("Give the hub an API key");
    expect(tests()).toHaveLength(1);
  });

  it("opens a step that is no account as before: its guide, and where its result is saved", async () => {
    await render(page);
    await click(button("Invite people"));
    expect(pane()?.getAttribute("data-step")).toBe("people");
    expect(pane()?.querySelector("[data-part]")).toBeNull();
    expect(pane()?.textContent).not.toContain("Show the guide");
    await click(button("Open Hub › People"));
    expect(parseHash(window.location.hash)).toMatchObject({ id: "settings", tab: "hub.people" });
  });
});
