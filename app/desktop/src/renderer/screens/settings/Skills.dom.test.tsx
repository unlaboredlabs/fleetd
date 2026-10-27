// @vitest-environment happy-dom
// Skills, a member's and an admin's: Settings → Skills shows a project's own and repo skills, and names the hub-wide
// ones on a read-only line (with the way to Administration for an owner or admin only); Administration → Skills is
// where the hub-wide ones are installed, updated and removed, and a member never reaches it.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SkillSummary } from "../../../shared/contracts";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { AdminScreen } from "../admin/AdminScreen";
import { Skills } from "./Skills";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

const AT = "2026-10-26T10:00:00.000Z";
const PIN = "4f2a9c1e7b3d5a8c0e6f1b2d4a7c9e0f3b5d8a1c";
const storefront = { machineId: "devbox", projectId: "storefront" };
const install = { source: "acme/agent-skills@pr-review", url: "https://github.com/acme/agent-skills.git", ref: "HEAD", commit: PIN, path: "skills/pr-review", installedAt: AT };
const GLOBAL: SkillSummary[] = [
  { name: "pr-review", origin: "global", description: "Review a pull request.", files: [], install },
  { name: "standup", origin: "global", description: "Write the daily standup.", files: [] },
];
const PROJECT: SkillSummary[] = [
  { name: "triage", origin: "repo_claude", description: "Sort new issues.", files: [], path: ".claude/skills/triage/SKILL.md" },
  { name: "checkout-qa", origin: "project", description: "Walk the checkout flow.", files: [] },
];

const snapshot: HubFrame = {
  t: "snapshot",
  snapshot: {
    cursor: 1,
    attention: [],
    machines: [],
    projects: [
      { machineId: "devbox", projectId: "storefront", title: "storefront", workspaceRoot: "/home/w/src/storefront", threads: { running: 0, waiting: 0, idle: 0, failed: 0 }, lastActivityAt: AT },
    ],
  },
};

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ tool: string; input: unknown }>;

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fleetd", { platform: "linux", fixture: null });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  window.location.hash = "";
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

/** `page`: Settings → Skills or Administration → Skills. `admin`: what hub_info says of this app's person. */
const render = async (page: "settings" | "admin", admin: boolean) => {
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input });
      const project = (input as { projectRef?: unknown }).projectRef !== undefined;
      const output =
        tool === "hub_info"
          ? { version: "0.0.0", protocol: 1, busy: [], admin }
          : tool === "skills_list"
            ? { skills: project ? [...PROJECT, ...GLOBAL] : GLOBAL }
            : tool === "skill_get"
              ? { skill: GLOBAL[0], text: "---\nname: pr-review\n---\n" }
              : tool === "skill_install"
                ? { installed: [GLOBAL[0]], next: "" }
                : {};
      return Promise.resolve({ ok: true, output });
    },
    subscribe: (l) => ((listener = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  if (page === "admin") window.location.hash = "#/admin/skills";
  await act(async () => {
    root.render(
      <UiProvider>
        <DataProvider layer={createDataLayer(hub)}>{page === "admin" ? <AdminScreen /> : <Skills route={{ tab: "skills", prompt: null, for: null, view: "edit" }} />}</DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    listener({ t: "state", state: { phase: "live", hub: "devbox:4790", protocol: 1 } });
    listener(snapshot);
    await new Promise((r) => setTimeout(r, 0));
  });
  for (let i = 0; i < 3; i++) await settle();
};

const texts = () => [...document.querySelectorAll("button")].map((b) => b.textContent.trim());
const rowNamed = (name: string) => [...document.querySelectorAll("button")].find((b) => b.textContent.startsWith(name));
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
  await settle();
};
const sent = (tool: string) => calls.filter((c) => c.tool === tool).map((c) => c.input);

it("shows a member a project's skills and only names the hub-wide ones", async () => {
  await render("settings", false);
  expect(sent("skills_list")).toEqual([{ projectRef: storefront }]);
  expect(rowNamed("checkout-qa")).toBeDefined();
  expect(rowNamed("triage")).toBeDefined();
  // The hub-wide ones are a line, not rows: nothing to open, edit, update or delete.
  expect(rowNamed("pr-review")).toBeUndefined();
  expect(rowNamed("standup")).toBeUndefined();
  const line = document.querySelector("[aria-label='Hub-wide skills']");
  expect(line?.textContent).toContain("Hub-wide, for every project: pr-review, standup.");
  expect(texts()).not.toContain("Hub-wide skills in Administration");
  expect(texts()).not.toContain("Update");
  expect(document.body.textContent).not.toMatch(/Global/u);
});

it("writes a member's install into the project, never hub-wide", async () => {
  await render("settings", false);
  await click([...document.querySelectorAll("button")].find((b) => b.textContent === "Install from a source…") as HTMLElement);
  const source = document.querySelector<HTMLInputElement>("input[placeholder='vercel-labs/agent-skills']");
  if (source === null) throw new Error("no source field");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(source, "acme/agent-skills");
    source.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
  await click([...document.querySelectorAll("button")].find((b) => b.textContent === "Install") as HTMLElement);
  expect(sent("skill_install")).toEqual([{ scope: "project", projectRef: storefront, source: "acme/agent-skills" }]);
});

it("gives an admin on Settings only the way to Administration", async () => {
  await render("settings", true);
  expect(rowNamed("pr-review")).toBeUndefined();
  expect(texts()).toContain("Hub-wide skills in Administration");
});

it("keeps Administration → Skills from a member, and reads none of it", async () => {
  await render("admin", false);
  expect(document.querySelector("[data-screen='admin.denied']")).not.toBeNull();
  expect(sent("skills_list")).toEqual([]);
  expect(texts()).not.toContain("Install from a source…");
});

it("lets an admin install, update and remove hub-wide skills on Administration", async () => {
  await render("admin", true);
  expect(document.querySelector("[data-screen='admin.skills']")).not.toBeNull();
  expect(sent("skills_list")).toEqual([{}]);
  expect(texts()).toContain("Install from a source…");
  const pr = rowNamed("pr-review");
  expect(pr).toBeDefined();
  await click(pr as HTMLElement);
  expect(texts()).toEqual(expect.arrayContaining(["Update", "Delete"]));
  await click([...document.querySelectorAll("button")].find((b) => b.textContent === "Update") as HTMLElement);
  expect(sent("skill_update")).toEqual([{ scope: "global", name: "pr-review" }]);
});
