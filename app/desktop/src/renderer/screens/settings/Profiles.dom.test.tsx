// @vitest-environment happy-dom
// Settings › Hub › Every project › Agents: the hub's profiles listed with the default marked, one created with fast
// mode, one renamed and deleted, fast mode off where the model has none, the default neither unmarked nor deleted; Lead
// runs on, picked with profile_update's lead and back on the default when its profile is deleted; and a project's Agents
// page, where the default is checked for good and another is allowed with project_set, and its Lead model: the hub's
// lead profile until the bot picks its own (project_set leadProfile), with Restart lead while its lead runs on another.
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
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

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
/** The bot's own lead profile, and whether its lead runs on another, as profiles_list says them. */
let leadPick: string | undefined;
let leadRestart: boolean;
/** hub_info's person: undefined for a hub from before it (the app lets them try). */
let me: { name: string; role: string } | undefined;
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
  leadPick = undefined;
  leadRestart = false;
  me = undefined;
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
        const bot = { ...list, allowed, ...(leadPick === undefined ? {} : { leadProfile: leadPick }), ...(leadRestart ? { leadRestart } : {}) };
        return Promise.resolve({ ok: true, output: input["projectRef"] === undefined ? list : bot });
      }
      if (tool === "hub_info" && me !== undefined) return Promise.resolve({ ok: true, output: { me, admin: false } });
      if (tool === "people_list") {
        const people = [
          { name: "Ada", role: "owner" },
          { name: "Sam", role: "member" },
        ];
        return Promise.resolve({ ok: true, output: { people } });
      }
      if (tool.startsWith("profile_") || tool === "project_set") calls.push({ tool, input });
      if (tool === "profile_create") {
        const made = profile(9, String(input["name"]), input);
        profiles = [...profiles, made];
        return Promise.resolve({ ok: true, output: { profile: made, next: `Bots allow ${made.name} once they pick it.` } });
      }
      if (tool === "profile_update") {
        const moves = input["default"] === true;
        // As the hub keeps it: the lead's mark moves to the one picked, and never sits on the default.
        const leads = input["lead"] === true;
        profiles = profiles.map((p) =>
          p.id === input["id"] ? { ...p, ...input, lead: leads && !p.default } : { ...p, ...(moves ? { default: false } : {}), ...(leads ? { lead: false } : {}) },
        );
        return Promise.resolve({ ok: true, output: { profile: profiles.find((p) => p.id === input["id"]), next: "Saved." } });
      }
      if (tool === "profile_delete") {
        profiles = profiles.filter((p) => p.id !== input["id"]);
        return Promise.resolve({ ok: true, output: { ok: true, next: "medium is gone." } });
      }
      if (tool === "project_set") {
        if (input["profiles"] !== undefined) allowed = ["high", ...(input["profiles"] as string[])];
        // As the hub keeps it: a pick (or the hub's again) is the lead's at its next start, a restart moves it now.
        if (input["leadProfile"] !== undefined || input["leadDefault"] === true) {
          leadPick = input["leadProfile"] as string | undefined;
          leadRestart = true;
        }
        if (input["leadRestart"] === true) leadRestart = false;
        return Promise.resolve({ ok: true, output: { profiles: allowed, ...(leadPick === undefined ? {} : { leadProfile: leadPick }) } });
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
/** Each profile row's words as shown: its hint (a tooltip, words only for assistive tech) left out. */
const rows = () =>
  [...host.querySelectorAll("[data-profile]")].map((r) => {
    const shown = r.cloneNode(true) as HTMLElement;
    shown.querySelectorAll("[data-hint]").forEach((h) => h.remove());
    return shown.textContent;
  });
/** A profile's editor opens from its name. */
const edit = (name: string) => {
  const b = host.querySelector<HTMLButtonElement>(`[data-profile='${name}'] button`);
  if (b === null) throw new Error(`no row ${name}`);
  return b;
};

it("lists the hub's profiles, the default marked, and creates one in fast mode", async () => {
  await render("editor");
  expect(rows()).toEqual([
    expect.stringMatching(/^highdefault · leadClaude Opus 5.5 · high effort$/u),
    expect.stringMatching(/^mediumClaude Opus 5.5 · medium effort$/u),
    expect.stringMatching(/^wideClaude Sonnet 5.5 · extra high effort$/u),
  ]);
  // Where the models come from is the section's hover, never a line at rest.
  expect(host.textContent).toContain("The models offered are fleetd's own list until a Claude API key is saved in Setup.");
  expect(host.textContent).not.toContain("the hub has no API key");
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
  expect(rows().at(-1)).toMatch(/^quickClaude Opus 5\.5 · high effort · fast/u);
  expect(host.textContent).toContain("Bots allow quick once they pick it.");
});

it("renames a profile, sends only what changed, and deletes it after a confirm", async () => {
  await render("editor");
  await click(edit("medium"));
  expect(button("Save").disabled).toBe(true);
  type(field("Name"), "chores");
  await click(toggle("checkbox", "The default"));
  await click(button("Save"));
  expect(calls).toEqual([{ tool: "profile_update", input: { id: 2, name: "chores", default: true } }]);
  expect(rows()[1]).toMatch(/^choresdefault · lead/u);
  await click(edit("chores"));
  // The default can be neither unmarked nor deleted, only replaced.
  expect(toggle("checkbox", "The default").disabled).toBe(true);
  expect(() => button("Delete…")).toThrow();
  await click(button("Cancel"));
  await click(edit("high"));
  await click(button("Delete…"));
  expect(host.textContent).toContain("Delete high? No bot allows it after.");
  await click(button("Delete"));
  expect(calls.at(-1)).toEqual({ tool: "profile_delete", input: { id: 1 } });
  expect(rows().map((r) => r.split("Claude")[0])).toEqual(["choresdefault · lead", "wide"]);
});

/** The Lead runs on picker's trigger, and the option for `name` once it is open. */
const leadPicker = (label = "Lead runs on") => {
  const trigger = host.querySelector<HTMLButtonElement>(`[aria-label='${label}'][role='combobox']`);
  if (trigger === null) throw new Error(`no ${label} picker`);
  return trigger;
};
const openPicker = async (label = "Lead runs on") => {
  await act(async () => {
    leadPicker(label).dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    leadPicker(label).click();
    await Promise.resolve();
  });
  await settle();
  return [...document.querySelectorAll<HTMLElement>("[role='option']")];
};
const pickLead = async (name: string, label = "Lead runs on") => {
  const option = (await openPicker(label)).find((o) => o.textContent.startsWith(name));
  if (option === undefined) throw new Error(`no option ${name}`);
  await click(option);
};

it("runs leads on the profile picked, back on the default when it is deleted", async () => {
  await render("editor");
  // Nothing picked: leads run on the default.
  expect(leadPicker().textContent).toContain("high");
  expect(host.textContent).toContain("Takes effect at each lead's next start");
  await pickLead("wide");
  expect(calls).toEqual([{ tool: "profile_update", input: { id: 3, lead: true } }]);
  expect(leadPicker().textContent).toContain("wide");
  expect(rows().map((r) => r.split("Claude")[0])).toEqual(["highdefault", "medium", "widelead"]);
  // Deleting it says leads go back to the default, and they do.
  await click(edit("wide"));
  await click(button("Delete…"));
  expect(host.textContent).toContain("Delete wide? No bot allows it after, and leads go back to high at their next start.");
  await click(button("Delete"));
  expect(calls.at(-1)).toEqual({ tool: "profile_delete", input: { id: 3 } });
  expect(leadPicker().textContent).toContain("high");
  expect(rows()[0]).toMatch(/^highdefault · lead/u);
});

it("picks a bot's own lead model, the hub's lead profile first, and restarts its lead on it", async () => {
  profiles = profiles.map((p) => (p.name === "medium" ? { ...p, lead: true } : p.name === "wide" ? { ...p, refused: "claude refused claude-sonnet-5-5 on devbox" } : p));
  await render("project");
  // At rest: the hub's lead profile, named, and no words under it.
  expect(leadPicker("Lead model").textContent).toBe("Hub default (medium)");
  const row = leadPicker("Lead model").closest("section");
  expect(row?.querySelector("[data-hint]")).toBeNull();
  expect(host.textContent).not.toContain("Restart lead");
  // A profile claude refused can't be picked, and its hover says why.
  const wide = (await openPicker("Lead model")).find((o) => o.textContent.startsWith("wide"));
  expect(wide?.getAttribute("aria-disabled")).toBe("true");
  expect(wide?.getAttribute("title")).toBe("claude refused claude-sonnet-5-5 on devbox");
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await Promise.resolve();
  });
  await settle();
  await pickLead("high", "Lead model");
  expect(calls).toEqual([{ tool: "project_set", input: { ...storefront, leadProfile: "high" } }]);
  expect(leadPicker("Lead model").textContent).toMatch(/^high/u);
  // Its lead still runs on the one before: Restart lead moves it now.
  await click(button("Restart lead"));
  expect(calls.at(-1)).toEqual({ tool: "project_set", input: { ...storefront, leadRestart: true } });
  expect(host.textContent).not.toContain("Restart lead");
  await pickLead("Hub default", "Lead model");
  expect(calls.at(-1)).toEqual({ tool: "project_set", input: { ...storefront, leadDefault: true } });
  expect(leadPicker("Lead model").textContent).toBe("Hub default (medium)");
});

it("offers fast mode only on a model that has it", async () => {
  await render("editor");
  await click(edit("wide"));
  const fast = toggle("switch", "Fast mode");
  expect(fast.disabled).toBe(true);
  expect(fast.closest("label")?.textContent).toContain("This model has no fast mode.");
});

it("allows a bot the default for good and another with project_set", async () => {
  await render("project");
  // The default has no switch: it is always allowed, and its hint says why.
  expect(host.querySelector("[aria-label='Allow high']")).toBeNull();
  expect(host.querySelector("section[aria-label='high']")?.textContent).toContain("Always allowed: the hub's default.");
  const allow = (name: string) => {
    const el = host.querySelector<HTMLButtonElement>(`[aria-label='Allow ${name}']`);
    if (el === null) throw new Error(`no switch for ${name}`);
    return el;
  };
  expect(allow("medium").getAttribute("aria-checked")).toBe("true");
  expect(allow("wide").getAttribute("aria-checked")).toBe("false");
  await click(allow("wide"));
  expect(calls).toEqual([{ tool: "project_set", input: { ...storefront, profiles: ["medium", "wide"] } }]);
  expect(allow("wide").getAttribute("aria-checked")).toBe("true");
  await click(allow("medium"));
  expect(calls.at(-1)).toEqual({ tool: "project_set", input: { ...storefront, profiles: ["wide"] } });
});
