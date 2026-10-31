// @vitest-environment happy-dom
// A Navi's Skills: the list in its groups with who changed each and when it was last used, one skill's SKILL.md, the
// person's edit, its history with a diff and Restore, turning it off and deleting it; and the chat's line linking to it.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { FleetStatus, SkillSummary, SkillVersion } from "../../../shared/contracts";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { AT, live } from "../../src/data/fixtures.test-util";
import { UiProvider } from "../../ui";
import { SkillSavedLine } from "../chat/SkillSaved";
import { ProjectPanel } from "../panel/ProjectPanel";
import { forgetViews } from "../panel/Sections";
import { SkillsTabView } from "./SkillsPane";

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

const md = (step: string) => `---\nname: taxes\ndescription: File the taxes.\n---\n\n# Taxes\n\n1. Log in to the portal.\n2. ${step}\n`;
const NEWEST: SkillVersion = { version: 2, author: "agent", by: "Ada", at: AT, why: "The person wants a PDF copy." };
const V: SkillVersion[] = [NEWEST, { version: 1, author: "agent", by: "Ada", at: AT, why: "Worked out where the forms are." }];
const TEXTS: Record<number, string> = { 1: md("Download the CSV."), 2: md("Download the PDF.") };
const SKILLS: SkillSummary[] = [
  { name: "taxes", origin: "project", description: "File the taxes.", changed: NEWEST, lastUsedAt: AT },
  { name: "groceries", origin: "project", description: "Order the groceries.", off: true },
  { name: "standup", origin: "global", description: "Write the standup." },
];

// The markdown parser loads on first use; loaded here, a skill's text renders in the first pass.
beforeAll(async () => {
  await import("../../ui/markdown/MarkdownBody");
});

let host: HTMLDivElement;
let root: Root;
let calls: { tool: string; input: Record<string, unknown> }[];
beforeEach(() => {
  forgetViews();
  calls = [];
  window.location.hash = "";
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

const answer = (tool: string, input: Record<string, unknown>): unknown => {
  switch (tool) {
    case "skills_list":
      return { skills: SKILLS };
    case "skill_get": {
      const version = typeof input["version"] === "number" ? input["version"] : 2;
      return { skill: SKILLS[0], text: TEXTS[version] ?? "", versions: V };
    }
    case "skill_set":
    case "skill_revert":
      return { skill: { ...SKILLS[0], changed: { ...NEWEST, version: 3, author: "person", by: "Ana" } } };
    case "skill_off":
    case "skill_delete":
      return { ok: true };
    default:
      return {};
  }
};

const settle = async () => {
  for (let i = 0; i < 8; i++) await act(() => new Promise((done) => setTimeout(done, 0)));
};

const mount = async (ui: ReactNode, features: string[] = ["navi_skills"]) => {
  let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input: input as Record<string, unknown> });
      return Promise.resolve({ ok: true, output: answer(tool, input as Record<string, unknown>) } as never);
    },
    subscribe: (l) => ((send = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  const layer = createDataLayer(hub);
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
  await settle();
};

const click = async (el: Element | null | undefined) => {
  if (!(el instanceof HTMLElement)) throw new Error("nothing to click");
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
  await settle();
};
const button = (words: string) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === words);
const type = async (field: HTMLInputElement | HTMLTextAreaElement | null, value: string) => {
  if (field === null) throw new Error("no field");
  await act(async () => {
    const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};
const view = (skill: string | null) => <SkillsTabView project={ADA} skill={skill} onWide={() => undefined} />;

it("gives a Navi's panel a Skills section once the hub serves it", async () => {
  await mount(<ProjectPanel project={ADA} view={{ tab: "skills", skill: null }} onWide={() => undefined} />);
  expect([...host.querySelectorAll("[data-section]")].map((t) => t.getAttribute("data-section"))).toEqual(["plan", "skills", "history"]);
  act(() => root.unmount());
  root = createRoot(host);
  await mount(<ProjectPanel project={ADA} view={{ tab: "checklist" }} onWide={() => undefined} />, []);
  expect(host.querySelector("[data-section=skills]")).toBeNull();
});

it("lists what it learned and what every project has, with who changed each and its last use, and opens one", async () => {
  await mount(view(null));
  const groups = [...host.querySelectorAll("section[aria-label]")].map((g) => [g.getAttribute("aria-label"), [...g.querySelectorAll("[data-skill]")].map((r) => r.getAttribute("data-skill"))]);
  expect(groups).toEqual([
    ["Learned", ["groceries", "taxes"]],
    ["From every project", ["standup"]],
  ]);
  const taxes = host.querySelector("[data-skill=taxes]");
  expect(taxes?.textContent).toContain("by Ada");
  expect(taxes?.textContent).toContain("used ");
  expect(host.querySelector("[data-skill=groceries]")?.textContent).toContain("Off · ");
  await click(taxes);
  expect(window.location.hash).toBe("#/project/devbox/ada/skills/taxes");
});

it("shows the skill rendered, and the person's edit saves with their line", async () => {
  await mount(view("taxes"));
  expect(host.querySelector("[data-screen=skill]")).not.toBeNull();
  expect(host.textContent).toContain("Download the PDF.");
  expect(host.textContent).not.toContain("description: File the taxes.");
  await click(button("Edit"));
  await type(host.querySelector("textarea"), md("Download the PDF and file it."));
  await type(host.querySelector("input"), "Keep a copy");
  await click(button("Save"));
  expect(calls.find((c) => c.tool === "skill_set")?.input).toEqual({
    scope: "project",
    projectRef: ADA,
    name: "taxes",
    text: md("Download the PDF and file it."),
    why: "Keep a copy",
  });
  expect(host.querySelector("[data-screen=skill]")).not.toBeNull();
});

it("shows every version with who, when and why, a version's diff, and restores an older one as a new version", async () => {
  await mount(view("taxes"));
  await click(button("History2"));
  expect(host.querySelector("[data-screen='skill.history']")).not.toBeNull();
  const rows = [...host.querySelectorAll("[data-version]")];
  expect(rows.map((r) => r.getAttribute("data-version"))).toEqual(["2", "1"]);
  expect(rows[0]?.textContent).toContain("The person wants a PDF copy.");
  // The newest opens to what it changed: the CSV step became the PDF one.
  const diff = host.querySelector("[role=region]");
  expect(diff?.getAttribute("aria-label")).toBe("Version 1 to 2");
  expect(diff?.textContent).toContain("Removed: ");
  expect(diff?.textContent).toContain("PDF");
  expect(button("Restore version 2")).toBeUndefined();
  await click(rows[1]?.querySelector("button"));
  expect(host.querySelector("[role=region]")?.getAttribute("aria-label")).toBe("Version 1, as first kept");
  await click(button("Restore version 1"));
  expect(calls.find((c) => c.tool === "skill_revert")?.input).toEqual({ scope: "project", projectRef: ADA, name: "taxes", version: 1 });
  expect(host.textContent).toContain("Restored as version 3.");
});

it("turns a skill off, and deletes it after asking", async () => {
  await mount(view("taxes"));
  await click(host.querySelector("[role=switch]"));
  expect(calls.find((c) => c.tool === "skill_off")?.input).toEqual({ projectRef: ADA, name: "taxes", off: true });
  await click(button("Delete"));
  const confirm = [...document.querySelectorAll("[role=dialog] button")].find((b) => b.textContent === "Delete");
  await click(confirm);
  expect(calls.find((c) => c.tool === "skill_delete")?.input).toEqual({ scope: "project", projectRef: ADA, name: "taxes" });
  expect(window.location.hash).toBe("#/project/devbox/ada/skills");
});

it("offers no off switch for a skill in its folder, which reaches its sessions from there", async () => {
  SKILLS.push({ name: "notes", origin: "repo_claude", description: "Notes.", path: ".claude/skills/notes/SKILL.md" });
  try {
    await mount(view("notes"));
    expect(host.querySelector("[data-screen=skill]")).not.toBeNull();
    expect(host.querySelector("[role=switch]")).toBeNull();
    expect(button("Edit")).toBeUndefined();
  } finally {
    SKILLS.pop();
  }
});

it("puts one quiet line in the chat, linking to the skill", async () => {
  await mount(<SkillSavedLine project={ADA} saved={{ name: "taxes", version: 2, created: false, why: "The person wants a PDF copy." }} />);
  expect(host.textContent).toBe("Updated the skill taxes: The person wants a PDF copy.");
  expect(host.querySelector("a")?.getAttribute("href")).toBe("#/project/devbox/ada/skills/taxes");
});
