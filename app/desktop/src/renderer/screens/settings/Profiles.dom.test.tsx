// @vitest-environment happy-dom
// Settings › Hub › Providers: the hub's profiles listed under their provider with the default marked, one added under
// Anthropic with fast mode and one under Google, unusable while Google isn't connected, one renamed and deleted, fast
// mode off where the model has none, the default never deleted; Every project › Agents' Default profile and Lead runs
// on, picked with profile_update's default and lead, leads back on the default when their profile is deleted; and a
// project's Agents page, where the default is checked for good and another is allowed with project_set, and its Lead
// model: the hub's lead profile until the bot picks its own (project_set leadProfile), with Restart lead always beside
// it, which starts a lead on a Gemini model no profile runs on yet.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AntigravityStatusOutput, Profile, ProfileModel } from "../../../shared/contracts";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { ProvidersPage } from "./AgentProviders";
import { AllowedProfiles, ProfilePicks } from "./Profiles";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

const AT = "2026-10-28T10:00:00.000Z";
const storefront = { machineId: "devbox", projectId: "storefront" };
const MODELS: ProfileModel[] = [
  { id: "claude-opus-5-5", displayName: "Claude Opus 5.5", fast: true },
  { id: "claude-sonnet-5-5", displayName: "Claude Sonnet 5.5", fast: false },
  { id: "gemini-4-neon", displayName: "Gemini 4 Neon (Antigravity)", fast: false },
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
/** Its lead is mid-turn and its machine can't stop the turn: a restart waits for the turn to end. */
let midTurn: boolean;
let leadRestarting: boolean;
/** hub_info's person: undefined for a hub from before it (the app lets them try). */
let me: { name: string; role: string } | undefined;
/** antigravity_status's answer; undefined: a hub that doesn't serve it (machine_roles says who can sign in). */
let google: AntigravityStatusOutput | undefined;
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
  midTurn = false;
  leadRestarting = false;
  me = undefined;
  google = { machines: [{ machineId: "devbox", checked: true }], keyIn: [] };
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
        const bot = { ...list, allowed, ...(leadPick === undefined ? {} : { leadProfile: leadPick }), ...(leadRestart ? { leadRestart } : {}), ...(leadRestarting ? { leadRestarting } : {}) };
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
      if (tool === "antigravity_status" && google !== undefined) return Promise.resolve({ ok: true, output: google });
      if (tool === "machine_roles") return Promise.resolve({ ok: true, output: { machines: [{ machineId: "devbox", antigravityLogin: true }] } });
      if (tool.startsWith("profile_") || tool === "project_set" || tool === "machine_antigravity_login") calls.push({ tool, input });
      if (tool === "machine_antigravity_login") {
        if (input["code"] === undefined) return Promise.resolve({ ok: true, output: { machineId: "devbox", message: "sign in", loginUrl: "https://accounts.google.com/o/oauth2/auth?state=g1" } });
        google = { machines: [{ machineId: "devbox", checked: true, signedIn: "Google AI Pro" }], keyIn: [] };
        return Promise.resolve({ ok: true, output: { machineId: "devbox", message: "signed in", signedIn: "Google AI Pro" } });
      }
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
        // As the hub keeps it: a pick (or the hub's again) is the lead's at its next idle moment, a restart moves it now.
        if (input["leadProfile"] !== undefined || input["leadDefault"] === true) {
          leadPick = input["leadProfile"] as string | undefined;
          leadRestart = true;
        }
        if (input["leadRestart"] === true) {
          leadRestart = false;
          leadRestarting = midTurn;
        }
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
        <DataProvider layer={createDataLayer(hub)}>{page === "editor" ? (
            <>
              <ProvidersPage me={undefined} />
              <ProfilePicks />
            </>
          ) : (
            <AllowedProfiles projectRef={storefront} />
          )}</DataProvider>
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
  // Each under its provider: Anthropic's three, none under Google.
  expect([...host.querySelectorAll("[data-provider-group='anthropic'] [data-profile]")].map((r) => r.getAttribute("data-profile"))).toEqual(["high", "medium", "wide"]);
  expect(host.querySelector("[data-provider-group='google'] [data-profile]")).toBeNull();
  // Google has none yet: it says so; its row's plus adds one.
  expect(host.querySelector("[data-provider-group='google']")?.textContent).toContain("No profiles yet");
  expect(host.textContent).not.toContain("the hub has no API key");
  await click(button("Add Anthropic profile"));
  expect(host.textContent).toContain("New Anthropic profile");
  // Where the models come from is said at the model picker, the only place the models show.
  expect(host.textContent).toContain("The models are fleetd's own list until a Claude API key is saved in Setup.");
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
  // Which is the default is Every project › Agents' pick, not the editor's.
  expect(() => toggle("checkbox", "The default")).toThrow();
  await click(button("Save"));
  expect(calls).toEqual([{ tool: "profile_update", input: { id: 2, name: "chores" } }]);
  await pickLead("chores", "Default profile");
  expect(calls.at(-1)).toEqual({ tool: "profile_update", input: { id: 2, default: true } });
  expect(leadPicker("Default profile").textContent).toContain("chores");
  expect(rows()[1]).toMatch(/^choresdefault · lead/u);
  await click(edit("chores"));
  // The default can't be deleted, only replaced.
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
  expect(host.textContent).toContain("Each running lead switches to it at its next idle moment");
  await pickLead("wide");
  expect(calls).toEqual([{ tool: "profile_update", input: { id: 3, lead: true } }]);
  expect(leadPicker().textContent).toContain("wide");
  expect(rows().map((r) => r.split("Claude")[0])).toEqual(["highdefault", "medium", "widelead"]);
  // Deleting it says leads go back to the default, and they do.
  await click(edit("wide"));
  await click(button("Delete…"));
  expect(host.textContent).toContain("Delete wide? No bot allows it after, and leads switch back to high at their next idle moment.");
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
  // Restart lead is there at rest too: a stuck lead starts again on the model it runs on, with no switch away and back.
  await click(button("Restart lead"));
  expect(calls).toEqual([{ tool: "project_set", input: { ...storefront, leadRestart: true } }]);
  calls = [];
  // A profile claude refused can't be picked, and its hover says why.
  const wide = (await openPicker("Lead model")).find((o) => o.textContent.startsWith("wide"));
  expect(wide?.getAttribute("aria-disabled")).toBe("true");
  // On its label, which takes the pointer the disabled item gives up (Overlay.module.css .itemWhy).
  expect(wide?.querySelector("[title]")?.getAttribute("title")).toBe("claude refused claude-sonnet-5-5 on devbox");
  expect(wide?.querySelector("[title]")?.className).toMatch(/itemWhy/u);
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
  // Started again, it can be restarted again.
  expect(button("Restart lead")).toBeDefined();
  // A turn its machine can't stop yet: it waits for the turn to end, and says so instead of offering the button again.
  midTurn = true;
  await pickLead("medium", "Lead model");
  await click(button("Restart lead"));
  expect(host.textContent).toContain("Restarts after its turn");
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

/** The open picker's groups, each its word and its options' words. */
const groups = () =>
  [...document.querySelectorAll<HTMLElement>("[role='group']")].map((g) => [g.querySelector("[id]")?.textContent ?? "", ...[...g.querySelectorAll("[role='option']")].map((o) => o.textContent)]);

it("offers a profile only its provider's models; one added under Google is unusable until Google connects", async () => {
  await render("editor");
  await click(edit("medium"));
  expect((await openPicker("Model")).map((o) => o.textContent)).toEqual(["Claude Opus 5.5", "Claude Sonnet 5.5"]);
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  await settle();
  await click(button("Cancel"));
  await click(button("Add Google profile"));
  expect(leadPicker("Model").textContent).toBe("Gemini 4 Neon");
  type(field("Name"), "neon");
  await click(button("Create profile"));
  expect(calls).toEqual([{ tool: "profile_create", input: { name: "neon", note: "", model: "gemini-4-neon", effort: "high", fast: false } }]);
  const neon = host.querySelector("[data-provider-group='google'] [data-profile='neon']");
  expect(neon?.hasAttribute("data-unusable")).toBe(true);
  expect(neon?.textContent).toContain("Unusable until Google connects");
  // Anthropic's are usable all the while.
  expect(host.querySelectorAll("[data-unusable]")).toHaveLength(1);
});

it("marks no profile unusable once Google is connected, or on a hub that can't say", async () => {
  profiles = [...profiles, profile(4, "neon", { model: "gemini-4-neon" })];
  google = { machines: [{ machineId: "devbox", checked: true, signedIn: "Google AI Pro" }], keyIn: [] };
  await render("editor");
  expect(host.querySelector("[data-provider-group='google'] [data-profile='neon']")).not.toBeNull();
  expect(host.querySelector("[data-unusable]")).toBeNull();
  act(() => root.unmount());
  root = createRoot(host);
  google = undefined;
  await render("editor");
  expect(host.querySelector("[data-unusable]")).toBeNull();
});

it("lists only profiles in every picker, by provider, and Add profile… opens Providers", async () => {
  // A Google profile, and Google models no profile runs on: those are never offered as they are.
  profiles = [...profiles, profile(4, "neon", { model: "gemini-4-neon" })];
  const more = [...MODELS, { id: "gemini-4-argon", displayName: "Gemini 4 Argon (Antigravity)", fast: false }];
  MODELS.push(more[3] as ProfileModel);
  try {
    await render("project");
    await openPicker("Lead model");
    expect(groups()).toEqual([
      ["Anthropic", "high Claude Opus 5.5 · high effort", "medium Claude Opus 5.5 · medium effort", "wide Claude Sonnet 5.5 · extra high effort"],
      ["Google", "neon Gemini 4 Neon · high effort"],
    ]);
    const words = [...document.querySelectorAll<HTMLElement>("[role='option']")].map((o) => o.textContent);
    expect(words.at(-1)).toBe("Add profile…");
    expect(words.some((w) => w.startsWith("Gemini"))).toBe(false);
    const add = [...document.querySelectorAll<HTMLElement>("[role='option']")].at(-1);
    if (add === undefined) throw new Error("no Add profile…");
    await click(add);
    // No profile is made and nothing is set: Providers opens, where one is.
    expect(calls).toEqual([]);
    expect(window.location.hash).toBe("#/settings/hub/providers");
    act(() => root.unmount());
    root = createRoot(host);
    await render("editor");
    for (const label of ["Default profile", "Lead runs on"]) {
      window.location.hash = "";
      const shown = (await openPicker(label)).map((o) => o.textContent);
      expect(shown.at(-1), label).toBe("Add profile…");
      expect(shown.some((w) => w.startsWith("Gemini")), label).toBe(false);
      act(() => {
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      await settle();
    }
  } finally {
    MODELS.pop();
  }
});
