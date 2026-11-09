// @vitest-environment happy-dom
// Your sections in the sidebar, through the data layer (W580): the chats in none on top with no label, then each
// section under its own, a pinned chat among the pins only. A row's menu moves it to a section, out of them or into a
// new one you name; a label's click folds its section (kept on this computer, its chats without a ⌘ number), its menu
// renames it, moves it or removes it; a chat dragged onto a label or a chat in a section joins it. Each change shows at
// once and goes to the hub as the whole list; one the hub refuses is taken back, with why; another device's arrives
// live.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSection, ProjectRef, ProjectSummary } from "../../../shared/contracts";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type DataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider, useDataLayer } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { useSidebarProjects } from "./data";
import { Sidebar } from "./Sidebar";
import { useFoldedSections } from "./sidebarState";

vi.hoisted(() => {
  (window as unknown as { fleetd: object }).fleetd = {
    platform: "linux",
    fixture: null,
    copy: () => Promise.resolve(),
    updates: { subscribe: () => () => undefined, state: () => new Promise(() => undefined) },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const project = (title: string, at = "09:00"): ProjectSummary => ({
  machineId: "devbox",
  projectId: title,
  title,
  workspaceRoot: `/srv/${title}`,
  lastActivityAt: `2026-10-26T${at}:00.000Z`,
  threads: { failed: 0, idle: 0, running: 0, waiting: 0 },
});
const ref = (id: string): ProjectRef => ({ machineId: "devbox", projectId: id });
const section = (id: string, name: string, ...chats: string[]): ChatSection => ({ id, name, chats: chats.map(ref) });
const said = (sections: readonly ChatSection[]) => sections.map((s) => `${s.name}: ${s.chats.map((c) => c.projectId).join(" ")}`);

let host: HTMLDivElement;
let root: Root;
let layer: DataLayer;
let listener: (frame: HubFrame) => void;
/** What the hub keeps: your pins and your sections. */
let pins: ProjectRef[];
let stored: ChatSection[];
/** Every list sent to the hub, in order. */
let sets: ChatSection[][];
/** Why the hub refuses the next set, if it does. */
let refuse: { code: string; message: string } | undefined;
let seq: number;

beforeEach(() => {
  window.localStorage.clear();
  pins = [];
  stored = [];
  sets = [];
  refuse = undefined;
  seq = 10;
  const hub: HubApi = {
    call: (tool, input) => {
      if (tool === "chat_pins_get") return Promise.resolve({ ok: true, output: { pins, set: true } });
      if (tool === "chat_sections_get") return Promise.resolve({ ok: true, output: { sections: stored } });
      if (tool === "chat_sections_set") {
        const { sections } = input as { sections: ChatSection[] };
        sets.push(sections);
        if (refuse !== undefined) return Promise.resolve({ ok: false, error: refuse });
        stored = sections;
        return Promise.resolve({ ok: true, output: { sections } });
      }
      return Promise.resolve({ ok: true, output: {} });
    },
    subscribe: (l) => ((listener = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  layer = createDataLayer(hub);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const settle = async (ms = 0) => {
  await act(() => new Promise((done) => setTimeout(done, ms)));
  for (let i = 0; i < 4; i++) await act(() => new Promise((done) => setTimeout(done, 0)));
};

/** The sidebar as the frame draws it: its rows from the data layer, the folded sections kept on this computer. */
function Bar({ jumpHints }: { jumpHints: boolean }) {
  const rows = useSidebarProjects(null);
  const { hub } = useDataLayer();
  const [folded, toggle] = useFoldedSections();
  return (
    <Sidebar
      projects={rows?.map((p) => ({ ...p, hub }))}
      screen={{ id: "home", at: hub }}
      jumpHints={jumpHints}
      collapsed={new Set()}
      onToggleHub={() => undefined}
      folded={folded}
      onToggleSection={toggle}
      factory={false}
      go={() => undefined}
    />
  );
}

// Newest first: new, docs, garden, web, api; old last.
const PROJECTS = [project("api", "09:01"), project("web", "09:02"), project("garden", "09:03"), project("docs", "09:04"), project("new", "09:05"), project("old", "08:00")];

const mount = async (jumpHints = false) => {
  act(() =>
    root.render(
      <UiProvider>
        <DataProvider layer={layer}>
          <Bar jumpHints={jumpHints} />
        </DataProvider>
      </UiProvider>,
    ),
  );
  act(() => {
    listener({ t: "state", state: { phase: "live", hub: "devbox:4710", protocol: 1 } });
    listener({ t: "snapshot", snapshot: { cursor: 1, attention: [], machines: [], projects: PROJECTS } });
  });
  await settle();
};

/** The hub announces your sections changed (your own set, or another device's); the layer reads them again. */
const announced = async () => {
  act(() => listener({ t: "event", event: { seq: seq++, at: "2026-10-26T09:06:00.000Z", type: "chat.sections", summary: "", data: { personId: "p_abcd2345" } } }));
  // Events' refetches go out together, 100 ms after the first.
  await settle(120);
};

const label = (name: string): HTMLElement => {
  const found = [...host.querySelectorAll<HTMLElement>("[data-section-label]")].find((b) => b.textContent.startsWith(name));
  if (found === undefined) throw new Error(`no section ${name}`);
  return found;
};
const row = (title: string): HTMLElement => {
  const found = [...host.querySelectorAll<HTMLElement>("[data-reorder-row] > button")].find((b) => b.querySelector("[class*=name], [class*=pinTitle]")?.textContent === title);
  if (found === undefined) throw new Error(`no chat ${title}`);
  return found;
};
/** The list under the pins, top to bottom: a chat's name, a label in brackets. */
const lines = () =>
  [...host.querySelectorAll<HTMLElement>("[class*=rows] > [data-reorder-row]")].map((el) => {
    const head = el.querySelector("[data-section-label]");
    return head === null ? (el.querySelector("[class*=name]")?.textContent ?? "") : `[${head.textContent}]`;
  });
const pinned = () => [...host.querySelectorAll("[class*=pinTitle]")].map((p) => p.textContent);

const rightClick = (el: HTMLElement) => act(() => void el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })));
const menu = () => [...document.querySelectorAll<HTMLElement>("[role='menuitem'], [role='menuitemradio']")];
const choose = async (text: string) => {
  const found = menu().find((i) => i.textContent === text);
  if (found === undefined) throw new Error(`no ${text} in ${menu().map((i) => i.textContent).join(", ")}`);
  act(() => found.click());
  await settle();
};
/** A chat's Move to section, opened: its choices, the ticked one starred. */
const moveTo = async (title: string) => {
  rightClick(row(title));
  await choose("Move to section");
  // The submenu is a menu of its own, after the row's.
  const sub = [...document.querySelectorAll("[role='menu']")].at(-1);
  return [...(sub?.querySelectorAll("[role='menuitem'], [role='menuitemradio']") ?? [])].map((i) => `${i.textContent}${i.getAttribute("aria-checked") === "true" ? "*" : ""}`);
};
const type = (text: string) => {
  const input = document.querySelector<HTMLInputElement>("[role='dialog'] input");
  if (input === null) throw new Error("no name asked");
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const press = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll<HTMLButtonElement>("[role='dialog'] button")].find((b) => b.textContent === name);
  if (found === undefined) throw new Error(`no ${name} button`);
  return found;
};

describe("your sections in the sidebar", () => {
  it("has the chats in none on top with no label, then each section in your order, a pinned chat among the pins only", async () => {
    pins = [ref("web")];
    stored = [section("s1", "Work", "api", "web"), section("s2", "All pinned", "web"), section("s3", "Home", "garden", "old")];
    await mount();
    expect(pinned()).toEqual(["web"]);
    expect(lines()).toEqual(["new", "docs", "[Work]", "api", "[Home]", "garden", "old"]);
    // A label is a button that says it is open; no count while it is.
    expect(label("Work").getAttribute("aria-expanded")).toBe("true");
    expect(label("Work").hasAttribute("aria-description")).toBe(false);
    // The pinned chat kept its section: its menu has it ticked.
    expect(await moveTo("web")).toEqual(["Work*", "All pinned", "Home", "No section", "New section…"]);
  });

  it("follows another device's change live", async () => {
    stored = [section("s1", "Work", "api")];
    await mount();
    expect(lines()).toEqual(["new", "docs", "garden", "web", "old", "[Work]", "api"]);
    stored = [section("s2", "Home", "garden"), section("s1", "Job", "api", "docs")];
    await announced();
    expect(lines()).toEqual(["new", "web", "old", "[Home]", "garden", "[Job]", "docs", "api"]);
    expect(sets).toEqual([]);
  });

  it("folds a section to one line that says what it holds, kept on this computer, its chats without a ⌘ number", async () => {
    stored = [section("s1", "Work", "api", "web"), section("s2", "Home", "garden")];
    await mount(true);
    const jumps = () => [...host.querySelectorAll("[class*=jump]")].map((j) => j.textContent);
    expect(jumps()).toEqual(["1", "2", "3", "4", "5", "6"]);
    act(() => label("Work").click());
    expect(lines()).toEqual(["new", "docs", "old", "[Work2]", "[Home]", "garden"]);
    expect(label("Work").getAttribute("aria-expanded")).toBe("false");
    expect(label("Work").getAttribute("aria-description")).toBe("2 chats");
    expect(label("Work").querySelector("[class*=dot]")).toBeNull();
    // The numbers go on past it: garden is the fourth chat on show.
    expect(jumps()).toEqual(["1", "2", "3", "4"]);
    expect(window.localStorage.getItem("fleetd.foldedSections")).toBe(JSON.stringify(["hub/s1"]));

    // The next launch finds it folded; open again, its chats are back.
    act(() => root.unmount());
    root = createRoot(host);
    await mount();
    expect(lines()).toEqual(["new", "docs", "old", "[Work2]", "[Home]", "garden"]);
    act(() => label("Work").click());
    expect(lines()).toEqual(["new", "docs", "old", "[Work]", "web", "api", "[Home]", "garden"]);
  });

  it("moves a chat to a section, out of them, and into a new one it asks the name of", async () => {
    stored = [section("s1", "Work", "api"), section("s2", "Home", "garden")];
    await mount();
    expect(await moveTo("docs")).toEqual(["Work", "Home", "No section*", "New section…"]);
    await choose("Home");
    // At once, newest first in its section; the hub gets the whole list.
    expect(lines()).toEqual(["new", "web", "old", "[Work]", "api", "[Home]", "docs", "garden"]);
    expect(sets.map(said)).toEqual([["Work: api", "Home: garden docs"]]);

    // Out of its section, the last of it: the section goes too.
    expect(await moveTo("api")).toEqual(["Work*", "Home", "No section", "New section…"]);
    await choose("No section");
    expect(lines()).toEqual(["new", "web", "api", "old", "[Home]", "docs", "garden"]);
    expect(said(sets.at(-1) ?? [])).toEqual(["Home: garden docs"]);

    // A new one: a name the hub would refuse is said before it is sent.
    await moveTo("new");
    await choose("New section…");
    expect(document.querySelector("[role='dialog']")?.textContent).toContain("new moves into it");
    expect(press("Create").disabled).toBe(true);
    type(" Home ");
    expect(document.querySelector("[role='dialog']")?.textContent).toContain("You already have a section named “Home”");
    expect(press("Create").disabled).toBe(true);
    type(" Later ");
    act(() => press("Create").click());
    await settle();
    expect(document.querySelector("[role='dialog']")).toBeNull();
    expect(lines()).toEqual(["web", "api", "old", "[Home]", "docs", "garden", "[Later]", "new"]);
    const made = sets.at(-1) ?? [];
    expect(said(made)).toEqual(["Home: garden docs", "Later: new"]);
    expect(made[1]?.id).toMatch(/^[\da-f-]{36}$/u);
  });

  it("offers only New section… while you have none", async () => {
    await mount();
    expect(await moveTo("docs")).toEqual(["New section…"]);
    expect(host.querySelector("[data-section-label]")).toBeNull();
  });

  it("renames a section, moves it up or down where there is one to pass, and removes it", async () => {
    stored = [section("s1", "Work", "api"), section("s2", "Home", "garden"), section("s3", "Later", "old")];
    await mount();
    const offered = (name: string) => {
      rightClick(label(name));
      const all = menu().map((i) => i.textContent);
      act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      return all;
    };
    expect(offered("Work")).toEqual(["Rename…", "Move down", "Remove section"]);
    expect(offered("Home")).toEqual(["Rename…", "Move up", "Move down", "Remove section"]);
    expect(offered("Later")).toEqual(["Rename…", "Move up", "Remove section"]);
    await settle();

    rightClick(label("Later"));
    await choose("Move up");
    expect(lines()).toEqual(["new", "docs", "web", "[Work]", "api", "[Later]", "old", "[Home]", "garden"]);
    expect(said(sets.at(-1) ?? [])).toEqual(["Work: api", "Later: old", "Home: garden"]);

    rightClick(label("Work"));
    await choose("Rename…");
    expect(document.querySelector("[role='dialog']")?.textContent).toContain("Rename Work");
    // Its own name is no change, and no clash.
    expect(press("Rename").disabled).toBe(true);
    type("Job");
    act(() => press("Rename").click());
    await settle();
    expect(sets.at(-1)).toEqual([section("s1", "Job", "api"), section("s3", "Later", "old"), section("s2", "Home", "garden")]);

    // Removed, its chats are in none, back on top.
    rightClick(label("Later"));
    await choose("Remove section");
    expect(lines()).toEqual(["new", "docs", "web", "old", "[Job]", "api", "[Home]", "garden"]);
    expect(said(sets.at(-1) ?? [])).toEqual(["Job: api", "Home: garden"]);
  });

  it("takes back a change the hub refuses, and says why", async () => {
    stored = [section("s1", "Work", "api")];
    await mount();
    refuse = { code: "invalid", message: "A section's name is up to 40 characters." };
    await moveTo("docs");
    await choose("Work");
    await settle();
    expect(lines()).toEqual(["new", "docs", "garden", "web", "old", "[Work]", "api"]);
    expect(document.body.textContent).toContain("Couldn’t save your sections");
    expect(document.body.textContent).toContain("A section's name is up to 40 characters.");

    // A hub from before sections has no such tool: said in plain words.
    refuse = { code: "not_found", message: "unknown tool chat_sections_set" };
    await moveTo("docs");
    await choose("Work");
    await settle();
    expect(lines()).toEqual(["new", "docs", "garden", "web", "old", "[Work]", "api"]);
    expect(document.body.textContent).toContain("This hub doesn’t keep sections yet. Update it to use them.");
    expect(document.body.textContent).not.toContain("unknown tool");
  });
});

describe("a chat dragged in the sidebar", () => {
  const ROW = 28;
  // Each line ROW px tall in its list, drawn as far off its place as its transform says.
  const layout = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
  afterEach(() => layout.mockReset());
  const place = () =>
    layout.mockImplementation(function (this: HTMLElement) {
      const at = this.parentElement === null ? 0 : [...this.parentElement.children].indexOf(this);
      const by = Number(/translateY\((-?[\d.]+)px\)/.exec(this.style.transform)?.[1] ?? 0);
      return DOMRect.fromRect({ x: 0, y: at * ROW + by, width: 200, height: ROW });
    });
  const point = (type: string, y: number, at: EventTarget = window) =>
    act(() => void at.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: "mouse", clientX: 100, clientY: y })));
  /** `title` pressed, carried to the middle of line `to` (counted from the top of the list), and held there. */
  const carry = (title: string, to: number) => {
    const from = (lines().indexOf(title) + 0.5) * ROW;
    point("pointerdown", from, row(title));
    point("pointermove", from + 10);
    point("pointermove", (to + 0.5) * ROW);
    return (to + 0.5) * ROW;
  };

  it("joins the section whose label it is let go on, which says so while it is held there", async () => {
    stored = [section("s1", "Work", "api"), section("s2", "Home", "garden")];
    place();
    await mount();
    expect(lines()).toEqual(["new", "docs", "web", "old", "[Work]", "api", "[Home]", "garden"]);
    const y = carry("docs", 4);
    expect(label("Work").hasAttribute("data-taking")).toBe(true);
    expect(label("Home").hasAttribute("data-taking")).toBe(false);
    // The lifted row may cover the label, so it says where it would go, in place of its time.
    expect(host.querySelector("[data-lifted] [class*='into']")?.textContent).toBe("Work");
    point("pointerup", y);
    await settle();
    expect(host.querySelector("[class*='into']")).toBeNull();
    expect(lines()).toEqual(["new", "web", "old", "[Work]", "docs", "api", "[Home]", "garden"]);
    expect(sets.map(said)).toEqual([["Work: api docs", "Home: garden"]]);
  });

  it("joins the section of the chat it is let go on, and stays where it is over its own or over none", async () => {
    stored = [section("s1", "Work", "api", "web"), section("s2", "Home", "garden")];
    place();
    await mount();
    expect(lines()).toEqual(["new", "docs", "old", "[Work]", "web", "api", "[Home]", "garden"]);
    // Onto garden, in Home.
    point("pointerup", carry("api", 7));
    await settle();
    expect(lines()).toEqual(["new", "docs", "old", "[Work]", "web", "[Home]", "garden", "api"]);
    expect(said(sets.at(-1) ?? [])).toEqual(["Work: web", "Home: garden api"]);

    // Over a chat in none, and over its own section's label: nothing takes it, and nothing is sent.
    const y = carry("web", 1);
    expect(host.querySelector("[data-taking]")).toBeNull();
    point("pointerup", y);
    point("pointerup", carry("web", 3));
    await settle();
    expect(lines()).toEqual(["new", "docs", "old", "[Work]", "web", "[Home]", "garden", "api"]);
    expect(sets).toHaveLength(1);
  });
});
