// @vitest-environment happy-dom
// Reordering the sidebar (W214): a project or a Navi dragged, or moved with ⌥↑ / ⌥↓, takes its new place within its own
// section, says so to a screen reader, and the hub keeps the order for you (sidebar_order_set) with the other section
// as it was. A press that doesn't move is still a click; Esc puts a lifted row back.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSummary } from "../../../shared/contracts";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { SETTLE_MS } from "../../ui/lib/reorder";
import type { SidebarProject } from "./model";
import type { Screen } from "./routes";
import { Sidebar } from "./Sidebar";

vi.hoisted(() => {
  (window as unknown as { fleetd: object }).fleetd = {
    platform: "linux",
    fixture: null,
    copy: () => Promise.resolve(),
    updates: { subscribe: () => () => undefined, state: () => new Promise(() => undefined) },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROW = 28;

const row = (title: string, extra: Partial<ProjectSummary> = {}): SidebarProject => ({
  key: `devbox/${title}`,
  project: {
    machineId: "devbox",
    projectId: title,
    title,
    workspaceRoot: `/srv/${title}`,
    lastActivityAt: "2026-10-26T09:00:00.000Z",
    threads: { failed: 0, idle: 0, running: 0, waiting: 0 },
    ...extra,
  },
  needsYou: false,
  state: "idle",
  working: false,
  running: 0,
  want: undefined,
  unread: false,
});

const ROWS = [row("ada", { kind: "assistant" }), row("home", { kind: "assistant" }), row("api"), row("docs"), row("web")];

let host: HTMLDivElement;
let root: Root;
let went: Screen[];
let calls: { tool: string; input: unknown }[];

const mount = () => {
  const hub: HubApi = {
    call: (tool, input) => (calls.push({ tool, input }), Promise.resolve({ ok: true, output: { order: [] } })),
    subscribe: () => () => undefined,
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  act(() =>
    root.render(
      <UiProvider>
        <DataProvider layer={createDataLayer(hub)}>
          <Sidebar
            projects={ROWS.map((p) => ({ ...p, hub: "hub" }))}
            screen={{ id: "status", at: "hub" }}
            jumpHints={false}
            collapsed={new Set()}
            onToggleHub={() => undefined}
            factory={false}
            admin={false}
            go={(s) => went.push(s)}
          />
        </DataProvider>
      </UiProvider>,
    ),
  );
};

// happy-dom lays nothing out: each row is ROW px tall, stacked in its list.
const layout = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");

beforeEach(() => {
  went = [];
  calls = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  layout.mockImplementation(function (this: HTMLElement) {
    const at = this.parentElement === null ? 0 : [...this.parentElement.children].indexOf(this);
    return DOMRect.fromRect({ x: 0, y: at * ROW, width: 200, height: ROW });
  });
});
afterEach(() => {
  // A press a failed test left open.
  window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1 }));
  act(() => root.unmount());
  host.remove();
});

const settle = async (ms = 0) => {
  await act(() => new Promise((done) => setTimeout(done, ms)));
  for (let i = 0; i < 3; i++) await act(() => new Promise((done) => setTimeout(done, 0)));
};
const section = (label: string): HTMLElement => {
  const found = host.querySelector<HTMLElement>(`section[aria-label='${label}']`) ?? [...host.querySelectorAll<HTMLElement>("section")].find((s) => s.textContent.startsWith(label));
  if (found === undefined) throw new Error(`no ${label} section`);
  return found;
};
const titles = (label: string) => [...section(label).querySelectorAll("[data-reorder-row]")].map((r) => r.querySelector("[class*=sidebarLabel]")?.textContent);
const button = (title: string): HTMLElement => {
  const found = [...host.querySelectorAll<HTMLElement>("[data-reorder-row] button")].find((b) => b.textContent.startsWith(title));
  if (found === undefined) throw new Error(`no ${title}`);
  return found;
};
const saved = () => calls.filter((c) => c.tool === "sidebar_order_set").map((c) => (c.input as { order: { projectId: string }[] }).order.map((r) => r.projectId));
const announced = (label: string) => section(label).querySelector("[role='status']")?.textContent;

const pointer = (target: EventTarget, type: string, y: number) =>
  act(() => {
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientY: y }));
  });

/** Presses `title` at its middle, moves it `dy` px in steps, and lets go. */
const drag = async (title: string, dy: number, opts: { cancel?: boolean } = {}) => {
  const el = button(title);
  const y = el.closest("[data-reorder-row]")?.getBoundingClientRect().top ?? 0;
  pointer(el, "pointerdown", y + ROW / 2);
  for (let step = 1; step <= 4; step++) pointer(window, "pointermove", y + ROW / 2 + (dy * step) / 4);
  if (opts.cancel === true) act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  else pointer(window, "pointerup", y + ROW / 2 + dy);
  await settle(SETTLE_MS + 20);
};

describe("dragging a row", () => {
  it("lifts it, opens a gap as it passes the others, and drops it there", async () => {
    mount();
    expect(titles("Projects")).toEqual(["api", "docs", "web"]);
    const el = button("api");
    pointer(el, "pointerdown", ROW / 2);
    pointer(window, "pointermove", ROW / 2 + 20);
    pointer(window, "pointermove", ROW / 2 + 2 * ROW + 2);
    // Lifted, riding the pointer, the two rows it passed slid up into its place.
    const lifted = section("Projects").querySelector<HTMLElement>("[data-lifted]");
    expect(lifted?.textContent).toContain("api");
    // Held at the list's end: it goes no further than the last row.
    expect(lifted?.style.transform).toBe(`translateY(${String(2 * ROW)}px)`);
    expect(section("Projects").querySelector("[data-reorder]")).not.toBeNull();
    const shifted = [...section("Projects").querySelectorAll<HTMLElement>("[data-reorder-row]:not([data-lifted])")].map((r) => r.style.transform);
    expect(shifted).toEqual([`translateY(-${String(ROW)}px)`, `translateY(-${String(ROW)}px)`]);
    pointer(window, "pointerup", ROW / 2 + 2 * ROW + 2);
    await settle(SETTLE_MS + 20);

    expect(titles("Projects")).toEqual(["docs", "web", "api"]);
    expect(section("Projects").querySelector("[data-lifted], [data-reorder]")).toBeNull();
    // The hub keeps the whole order: the Navis as they were, then the projects as dragged.
    expect(saved()).toEqual([["ada", "home", "docs", "web", "api"]]);
    expect(announced("Projects")).toBe("api moved to 3 of 3");
    // The release was the drop's, not a click on the row.
    expect(went).toEqual([]);
  });

  it("moves a Navi among the Navis only", async () => {
    mount();
    await drag("home", -ROW);
    expect(titles("Navi")).toEqual(["home", "ada"]);
    expect(titles("Projects")).toEqual(["api", "docs", "web"]);
    expect(saved()).toEqual([["home", "ada", "api", "docs", "web"]]);
    // Far down: it stops at the last Navi, never among the projects.
    await drag("home", 10 * ROW);
    expect(titles("Navi")).toEqual(["ada", "home"]);
  });

  it("is still a click when it doesn't move, and Esc puts a lifted row back", async () => {
    mount();
    const el = button("docs");
    pointer(el, "pointerdown", ROW + ROW / 2);
    pointer(window, "pointermove", ROW + ROW / 2 + 2);
    pointer(el, "pointerup", ROW + ROW / 2 + 2);
    act(() => el.click());
    expect(went).toEqual([{ id: "project", project: { machineId: "devbox", projectId: "docs" }, message: null }]);

    await drag("docs", ROW, { cancel: true });
    expect(titles("Projects")).toEqual(["api", "docs", "web"]);
    expect(saved()).toEqual([]);
  });
});

describe("the keyboard", () => {
  it("moves the focused row with Alt+↑ and Alt+↓, keeps its focus, and says where it went", async () => {
    mount();
    const docs = button("docs");
    act(() => docs.focus());
    const key = (k: string, alt = true) =>
      act(() => void document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: k, altKey: alt, bubbles: true, cancelable: true })));
    key("ArrowUp");
    await settle();
    expect(titles("Projects")).toEqual(["docs", "api", "web"]);
    expect(document.activeElement?.textContent).toContain("docs");
    expect(announced("Projects")).toBe("docs moved to 1 of 3");
    expect(saved().at(-1)).toEqual(["ada", "home", "docs", "api", "web"]);

    // At the top it stays, and says so.
    key("ArrowUp");
    await settle();
    expect(announced("Projects")).toBe("docs is already first");
    expect(saved()).toHaveLength(1);

    // Without Alt an arrow is just an arrow.
    key("ArrowDown", false);
    await settle();
    expect(titles("Projects")).toEqual(["docs", "api", "web"]);

    key("ArrowDown");
    key("ArrowDown");
    await settle();
    expect(titles("Projects")).toEqual(["api", "web", "docs"]);
    expect(document.activeElement?.textContent).toContain("docs");
    expect(announced("Projects")).toBe("docs moved to 3 of 3");
  });
});
