// @vitest-environment happy-dom
// Settings › Hub › Every project › Profiles: the hub's profiles listed with the default marked, one created with fast
// mode, one renamed and deleted, fast mode off where the model has none, the default neither unmarked nor deleted; and
// a project's Agents page, where the default is checked for good and another is allowed with project_set.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Profile, ProfileModel } from "../../../shared/contracts";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { AllowedProfiles, ProfilesEditor } from "./Profiles";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AT = "2026-10-28T10:00:00.000Z";
const storefront = { machineId: "devbox", projectId: "storefront" };
const MODELS: ProfileModel[] = [
  { id: "claude-opus-5-5", displayName: "Claude Opus 5.5", fast: true },
  { id: "claude-sonnet-5-5", displayName: "Claude Sonnet 5.5", fast: false },
];
const profile = (id: number, name: string, extra: Partial<Profile> = {}): Profile => ({
  id,
  name,
  note: "",
  model: "claude-opus-5-5",
  effort: "high",
  fast: false,
  default: false,
  updatedAt: AT,
  ...extra,
});

let host: HTMLDivElement;
let root: Root;
let profiles: Profile[];
let allowed: string[];
/** The writes, in turn; the page's reads aside. */
let calls: { tool: string; input: Record<string, unknown> }[];

beforeEach(() => {
  vi.stubGlobal("fleetd", { platform: "linux", fixture: null });
  profiles = [
    profile(1, "high", { default: true, note: "The default." }),
    profile(2, "medium", { effort: "medium", note: "Only for mechanical work." }),
    profile(3, "wide", { model: "claude-sonnet-5-5", effort: "xhigh" }),
  ];
  allowed = ["high", "medium"];
  calls = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const render = async (page: "editor" | "project") => {
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool, raw) => {
      const input = raw as Record<string, unknown>;
      if (tool === "profiles_list") {
        const list = { profiles, models: MODELS, modelsFrom: "builtin", efforts: ["low", "medium", "high", "xhigh", "max"] };
        return Promise.resolve({ ok: true, output: input["projectRef"] === undefined ? list : { ...list, allowed } });
      }
      if (tool.startsWith("profile_") || tool === "project_set") calls.push({ tool, input });
      if (tool === "profile_create") {
        const made = profile(9, String(input["name"]), input);
        profiles = [...profiles, made];
        return Promise.resolve({ ok: true, output: { profile: made, next: `Projects allow ${made.name} once they pick it.` } });
      }
      if (tool === "profile_update") {
        const moves = input["default"] === true;
        profiles = profiles.map((p) => (p.id === input["id"] ? { ...p, ...input } : moves ? { ...p, default: false } : p));
        return Promise.resolve({ ok: true, output: { profile: profiles.find((p) => p.id === input["id"]), next: "Saved." } });
      }
      if (tool === "profile_delete") {
        profiles = profiles.filter((p) => p.id !== input["id"]);
        return Promise.resolve({ ok: true, output: { ok: true, next: "medium is gone." } });
      }
      if (tool === "project_set") {
        allowed = ["high", ...(input["profiles"] as string[])];
        return Promise.resolve({ ok: true, output: { profiles: allowed } });
      }
      return Promise.resolve({ ok: false, error: { code: "not_found", message: `${tool} isn't faked` } });
    },
    subscribe: (l) => ((listener = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  await act(async () => {
    root.render(
      <UiProvider>
        <DataProvider layer={createDataLayer(hub)}>{page === "editor" ? <ProfilesEditor /> : <AllowedProfiles projectRef={storefront} />}</DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    listener({ t: "state", state: { phase: "live", hub: "devbox:4710", protocol: 1 } });
    listener({ t: "snapshot", snapshot: { cursor: 1, attention: [], machines: [], projects: [] } });
    await Promise.resolve();
  });
  await settle();
};

const settle = async () => {
  for (let i = 0; i < 4; i++) await act(() => new Promise((done) => setTimeout(done, 0)));
};
const button = (text: string, within: ParentNode = host) => {
  const b = [...within.querySelectorAll("button")].find((x) => x.textContent.trim() === text || x.getAttribute("aria-label") === text);
  if (b === undefined) throw new Error(`no button ${text}`);
  return b;
};
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
  await settle();
};
const field = (label: string) => {
  const l = [...host.querySelectorAll("label")].find((x) => x.textContent === label);
  const input = host.querySelector<HTMLInputElement>(`#${CSS.escape(l?.getAttribute("for") ?? "")}`);
  if (input === null) throw new Error(`no field ${label}`);
  return input;
};
const type = (input: HTMLInputElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
/** A checkbox or switch by its label's first words. */
const toggle = (role: "checkbox" | "switch", label: string) => {
  const el = [...host.querySelectorAll<HTMLButtonElement>(`[role='${role}']`)].find((x) => x.closest("label")?.textContent.startsWith(label));
  if (el === undefined) throw new Error(`no ${role} ${label}`);
  return el;
};
const rows = () => [...host.querySelectorAll("[data-profile]")].map((r) => r.textContent);

it("lists the hub's profiles, the default marked, and creates one in fast mode", async () => {
  await render("editor");
  expect(rows()).toEqual([
    expect.stringMatching(/^highdefaultClaude Opus 5.5 · high effortEditThe default\.$/u),
    expect.stringMatching(/^mediumClaude Opus 5.5 · medium effortEditOnly for mechanical work\.$/u),
    expect.stringMatching(/^wideClaude Sonnet 5.5 · extra high effortEdit$/u),
  ]);
  expect(host.textContent).toContain("Models from fleetd's own list");
  await click(button("New profile"));
  expect(button("Create profile").disabled).toBe(true);
  type(field("Name"), "Quick fix");
  expect(host.textContent).toContain("Lowercase letters, digits, - _ and ., up to 32.");
  type(field("Name"), "medium");
  expect(host.textContent).toContain("A profile is already named medium.");
  type(field("Name"), "quick");
  type(field("Use for"), "Small, clear fixes where speed matters.");
  // The first model has fast mode.
  expect(toggle("switch", "Fast mode").disabled).toBe(false);
  await click(toggle("switch", "Fast mode"));
  await click(button("Create profile"));
  expect(calls).toEqual([
    {
      tool: "profile_create",
      input: { name: "quick", note: "Small, clear fixes where speed matters.", model: "claude-opus-5-5", effort: "high", fast: true },
    },
  ]);
  expect(rows().at(-1)).toMatch(/^quickClaude Opus 5\.5 · high effort · fastEdit/u);
  expect(host.textContent).toContain("Projects allow quick once they pick it.");
});

it("renames a profile, sends only what changed, and deletes it after a confirm", async () => {
  await render("editor");
  await click(button("Edit medium"));
  expect(button("Save").disabled).toBe(true);
  type(field("Name"), "chores");
  await click(toggle("checkbox", "The default"));
  await click(button("Save"));
  expect(calls).toEqual([{ tool: "profile_update", input: { id: 2, name: "chores", default: true } }]);
  expect(rows()[1]).toMatch(/^choresdefault/u);
  await click(button("Edit chores"));
  // The default can be neither unmarked nor deleted, only replaced.
  expect(toggle("checkbox", "The default").disabled).toBe(true);
  expect(() => button("Delete…")).toThrow();
  await click(button("Cancel"));
  await click(button("Edit high"));
  await click(button("Delete…"));
  expect(host.textContent).toContain("Delete high? No project allows it after.");
  await click(button("Delete"));
  expect(calls.at(-1)).toEqual({ tool: "profile_delete", input: { id: 1 } });
  expect(rows().map((r) => r.split("Claude")[0])).toEqual(["choresdefault", "wide"]);
});

it("offers fast mode only on a model that has it", async () => {
  await render("editor");
  await click(button("Edit wide"));
  const fast = toggle("switch", "Fast mode");
  expect(fast.disabled).toBe(true);
  expect(fast.closest("label")?.textContent).toContain("This model has no fast mode.");
});

it("allows a project the default for good and another with project_set", async () => {
  await render("project");
  const high = toggle("checkbox", "high");
  expect([high.getAttribute("aria-checked"), high.disabled]).toEqual(["true", true]);
  expect(high.closest("label")?.textContent).toContain("Always allowed. The default.");
  expect(toggle("checkbox", "medium").getAttribute("aria-checked")).toBe("true");
  expect(toggle("checkbox", "wide").getAttribute("aria-checked")).toBe("false");
  await click(toggle("checkbox", "wide"));
  expect(calls).toEqual([{ tool: "project_set", input: { ...storefront, profiles: ["medium", "wide"] } }]);
  expect(toggle("checkbox", "wide").getAttribute("aria-checked")).toBe("true");
  await click(toggle("checkbox", "medium"));
  expect(calls.at(-1)).toEqual({ tool: "project_set", input: { ...storefront, profiles: ["wide"] } });
});
