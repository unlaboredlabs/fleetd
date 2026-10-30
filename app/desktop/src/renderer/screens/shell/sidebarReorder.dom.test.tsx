// @vitest-environment happy-dom
// Reordering the sidebar (W214): a project or a Navi dragged, or moved with ⌥↑ / ⌥↓, takes its new place within its own
// section, says so to a screen reader, and the hub keeps the order for you (sidebar_order_set) with the other section
// as it was. A press that doesn't move is still a click; Esc puts a lifted row back.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSummary } from "../../../shared/contracts";
import { createDataLayer, type DataLayer } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { DWELL_MS, SETTLE_MS } from "../../ui/lib/reorder";
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
let layer: DataLayer;

/** The sidebar with `rows`; again with other rows, the same sidebar drawing them (its state kept). */
const mount = (rows: SidebarProject[] = ROWS) => {
  act(() =>
    root.render(
      <UiProvider>
        <DataProvider layer={layer}>
          <Sidebar
            projects={rows.map((p) => ({ ...p, hub: "hub" }))}
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

// happy-dom lays nothing out: each row is ROW px tall, stacked in its list, and drawn as far off its place as its
// transform says.
const layout = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
const translated = (el: HTMLElement) => Number(/translateY\((-?[\d.]+)px\)/.exec(el.style.transform)?.[1] ?? 0);
/**
 * Where each row was drawn at the last read of the layout (as a browser recalculates styles then): a transition set
 * after it starts there. A row's whole path in a glide is from that place to its own: no frame anywhere else.
 */
let drawn: Map<HTMLElement, number>;

beforeEach(() => {
  went = [];
  calls = [];
  layer = createDataLayer({
    call: (tool, input) => (calls.push({ tool, input }), Promise.resolve({ ok: true, output: { order: [] } })),
    subscribe: () => () => undefined,
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  drawn = new Map();
  layout.mockImplementation(function (this: HTMLElement) {
    for (const r of host.querySelectorAll<HTMLElement>("[data-reorder-row]")) drawn.set(r, slot(r) + translated(r));
    const at = this.parentElement === null ? 0 : [...this.parentElement.children].indexOf(this);
    return DOMRect.fromRect({ x: 0, y: at * ROW + translated(this), width: 200, height: ROW });
  });
});
/** A row's own place in its list, no transform. */
const slot = (el: HTMLElement) => (el.parentElement === null ? 0 : [...el.parentElement.children].indexOf(el) * ROW);
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
const rows = (label: string) => [...section(label).querySelectorAll<HTMLElement>("[data-reorder-row]")];
const nameOf = (r: HTMLElement) => r.querySelector("[class*=sidebarLabel]")?.textContent ?? "";
/** Where each row of a section is on screen now, by name. */
const onScreen = (label: string) => new Map(rows(label).map((r) => [nameOf(r), slot(r) + translated(r)]));
/** Each row's path from here: where its first frame draws it and where it ends, the same for a row that stays. */
const paths = (label: string) =>
  new Map(
    rows(label).map((r) => {
      const to = slot(r) + translated(r);
      return [nameOf(r), { from: r.style.transition.includes("transform") ? drawn.get(r) : to, to }];
    }),
  );
/** Every row of `label` starts where `was` had it and ends in its slot in `order`: never anywhere else. */
const glidesFrom = (label: string, was: ReadonlyMap<string, number>, order: string[]) => {
  expect(titles(label)).toEqual(order);
  expect(Object.fromEntries(paths(label))).toEqual(Object.fromEntries(order.map((name, i) => [name, { from: was.get(name) ?? i * ROW, to: i * ROW }])));
};
const announced = (label: string) => section(label).querySelector("[role='status']")?.textContent;

const pointer = (target: EventTarget, type: string, y: number) =>
  act(() => {
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: "mouse", clientY: y }));
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

describe("letting go", () => {
  /** api lifted and held just past docs: api 34 px down, docs slid up into its place. */
  const lift = () => {
    mount();
    pointer(button("api"), "pointerdown", ROW / 2);
    pointer(window, "pointermove", ROW / 2 + 10);
    pointer(window, "pointermove", ROW / 2 + ROW + 6);
    expect(Object.fromEntries(onScreen("Projects"))).toEqual({ api: ROW + 6, docs: 0, web: 2 * ROW });
  };

  it("takes the new order in that frame, and glides each row from where it was on screen into its slot", async () => {
    lift();
    const was = onScreen("Projects");
    pointer(window, "pointerup", ROW / 2 + ROW + 6);
    // One render: the new order, each row drawn where it was, then gliding home over the settle's time.
    glidesFrom("Projects", was, ["docs", "api", "web"]);
    const api = rows("Projects")[1];
    expect(api?.style.transition).toBe(`transform ${String(SETTLE_MS)}ms var(--ease-out)`);
    expect(api?.style.transform).toBe("");
    // Raised until it lands; the others no longer make way.
    expect(api?.hasAttribute("data-lifted")).toBe(true);
    expect(section("Projects").querySelector("[data-reorder]")).toBeNull();
    expect(saved()).toEqual([["ada", "home", "docs", "api", "web"]]);

    await settle(SETTLE_MS + 20);
    expect(section("Projects").querySelector("[data-lifted]")).toBeNull();
    expect(rows("Projects").map((r) => [r.style.transform, r.style.transition])).toEqual([
      ["", ""],
      ["", ""],
      ["", ""],
    ]);
  });

  it("glides it back on Esc, and the rows that made way with it", async () => {
    lift();
    const was = onScreen("Projects");
    act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    glidesFrom("Projects", was, ["api", "docs", "web"]);
    await settle(SETTLE_MS + 20);
    expect(saved()).toEqual([]);
  });

  it("with reduced motion, lands at once: nothing glides", () => {
    const media = vi.spyOn(window, "matchMedia").mockImplementation(
      (query) => ({ matches: query.includes("reduce"), media: query, onchange: null, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false }) as MediaQueryList,
    );
    try {
      lift();
      pointer(window, "pointerup", ROW / 2 + ROW + 6);
      expect(titles("Projects")).toEqual(["docs", "api", "web"]);
      expect(rows("Projects").map((r) => [r.style.transform, r.style.transition])).toEqual([
        ["", ""],
        ["", ""],
        ["", ""],
      ]);
      expect(section("Projects").querySelector("[data-lifted]")).toBeNull();
    } finally {
      media.mockRestore();
    }
  });

  it("moves nothing when the same order comes back, as the hub's own echo does", async () => {
    lift();
    pointer(window, "pointerup", ROW / 2 + ROW + 6);
    await settle(SETTLE_MS + 20);
    const was = onScreen("Projects");
    const styles = new MutationObserver(() => undefined);
    styles.observe(section("Projects"), { attributes: true, attributeFilter: ["style"], subtree: true });
    // The order the hub kept, as the sidebar's rows after the read: the same rows drawn again, then in that order.
    mount();
    mount([...ROWS.slice(0, 2), ROWS[3], ROWS[2], ROWS[4]].filter((r) => r !== undefined));
    await settle(SETTLE_MS + 20);
    expect(styles.takeRecords()).toEqual([]);
    styles.disconnect();
    glidesFrom("Projects", was, ["docs", "api", "web"]);
  });
});

describe("a list that changes under a drag", () => {
  // A new project, first by title among the projects.
  const WITH_NEW = [...ROWS.slice(0, 2), row("aaa"), ...ROWS.slice(2)];

  it("puts a lifted row back, and moves nothing, when another desktop's move or a new project arrives", async () => {
    mount();
    const docs = button("docs");
    pointer(docs, "pointerdown", ROW + ROW / 2);
    pointer(window, "pointermove", ROW + ROW / 2 + 10);
    pointer(window, "pointermove", 3 * ROW);
    expect(section("Projects").querySelector("[data-lifted]")?.textContent).toContain("docs");
    // A project comes first: by index, "docs" would now be "api".
    mount(WITH_NEW);
    // It goes back to its place: the pointer no longer moves it, and letting go drops nothing.
    pointer(window, "pointermove", 4 * ROW);
    pointer(window, "pointerup", 4 * ROW);
    await settle(SETTLE_MS + 20);
    expect(section("Projects").querySelector("[data-lifted], [data-reorder]")).toBeNull();
    expect(titles("Projects")).toEqual(["aaa", "api", "docs", "web"]);
    expect(saved()).toEqual([]);
  });

  it("glides every row on from where it is when it changes while a dropped row glides", async () => {
    mount();
    pointer(button("api"), "pointerdown", ROW / 2);
    pointer(window, "pointermove", ROW / 2 + 10);
    pointer(window, "pointermove", 2 * ROW + 2);
    pointer(window, "pointerup", 2 * ROW + 2);
    expect(saved()).toEqual([["ada", "home", "docs", "api", "web"]]);
    // Another desktop's order arrives mid-glide, with a new project: they turn toward their places in it.
    const was = onScreen("Projects");
    mount(WITH_NEW);
    glidesFrom("Projects", was, ["aaa", "api", "docs", "web"]);
    await settle(SETTLE_MS + 20);
    expect(section("Projects").querySelector("[data-lifted]")).toBeNull();
  });

  it("finds a pressed row by its key at the lift, the list changed since the press", async () => {
    mount();
    pointer(button("web"), "pointerdown", 2 * ROW + ROW / 2);
    // "api" goes before the lift: web is second now, not third.
    mount(ROWS.filter((p) => p.project.title !== "api"));
    pointer(window, "pointermove", 2 * ROW + ROW / 2 - 10);
    expect(section("Projects").querySelector("[data-lifted]")?.textContent).toContain("web");
    pointer(window, "pointermove", 0);
    pointer(window, "pointerup", 0);
    await settle(SETTLE_MS + 20);
    expect(titles("Projects")).toEqual(["web", "docs"]);
    expect(saved()).toEqual([["ada", "home", "web", "docs"]]);
  });
});

describe("a section that goes mid-drag", () => {
  it("leaves no listener on the window, and nothing glides or saves after it", async () => {
    const removed = vi.spyOn(window, "removeEventListener");
    mount();
    pointer(button("api"), "pointerdown", ROW / 2);
    pointer(window, "pointermove", ROW / 2 + 10);
    act(() => root.render(<div />));
    for (const type of ["pointermove", "pointerup", "pointercancel", "keydown"]) expect(removed.mock.calls.some(([t]) => t === type)).toBe(true);
    removed.mockRestore();

    // Gone mid-glide: the drop saved, and its timer goes with it.
    const timers = vi.spyOn(window, "clearTimeout");
    mount();
    pointer(button("api"), "pointerdown", ROW / 2);
    pointer(window, "pointermove", ROW / 2 + 10);
    pointer(window, "pointermove", 2 * ROW + 2);
    pointer(window, "pointerup", 2 * ROW + 2);
    act(() => root.render(<div />));
    expect(timers).toHaveBeenCalled();
    timers.mockRestore();
    await settle(SETTLE_MS + 20);
    expect(saved()).toEqual([["ada", "home", "docs", "api", "web"]]);
  });
});

describe("near the edge of a long sidebar", () => {
  /** Fourteen projects in a sidebar body that scrolls, 200 px of it on screen, scrolled to `start`; frames by hand. */
  const longSidebar = (start = 0) => {
    const many = Array.from({ length: 14 }, (_, i) => row(`p${String(i).padStart(2, "0")}`));
    mount(many);
    const body = host.querySelector<HTMLElement>("nav[aria-label='Sidebar'] > div");
    if (body === null) throw new Error("no sidebar body");
    body.style.overflowY = "auto";
    let scrollTop = start;
    Object.defineProperty(body, "scrollTop", { get: () => scrollTop, set: (v: number) => (scrollTop = Math.max(0, Math.min(400, v))) });
    const rect = layout.getMockImplementation();
    layout.mockImplementation(function (this: HTMLElement) {
      return this === body ? DOMRect.fromRect({ x: 0, y: 0, width: 240, height: 200 }) : (rect?.call(this) ?? new DOMRect());
    });
    let queued: FrameRequestCallback[] = [];
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((f) => queued.push(f));
    const caf = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => (queued = []));
    const frames = (n: number) =>
      act(() => {
        for (let i = 0; i < n; i++) {
          const run = queued;
          queued = [];
          for (const f of run) f(0);
        }
      });
    const restore = () => {
      raf.mockRestore();
      caf.mockRestore();
    };
    return { scrolled: () => scrollTop, frames, restore };
  };

  it("scrolls it, keeping the lifted row under the pointer, and stops when you let go", async () => {
    const { scrolled, frames, restore } = longSidebar();
    // p00 (0 to 28 in its list) lifted, the pointer 12 px above the body's bottom.
    pointer(button("p00"), "pointerdown", ROW / 2);
    pointer(window, "pointermove", ROW / 2 + 10);
    pointer(window, "pointermove", 188);
    frames(3);
    const slow = scrolled();
    expect(slow).toBeGreaterThan(0);
    // Under the pointer: as far as the pointer went, plus what the list scrolled under it.
    const lifted = section("Projects").querySelector<HTMLElement>("[data-lifted]");
    expect(lifted?.style.transform).toBe(`translateY(${String(188 - ROW / 2 + scrolled())}px)`);

    // Nearer the edge, faster.
    pointer(window, "pointermove", 198);
    const before = scrolled();
    frames(3);
    expect(scrolled() - before).toBeGreaterThan(slow);
    expect(lifted?.style.transform).toBe(`translateY(${String(198 - ROW / 2 + scrolled())}px)`);

    // Away from the edge it stops.
    pointer(window, "pointermove", 100);
    const held = scrolled();
    frames(3);
    expect(scrolled()).toBe(held);

    // Letting go drops the row where it is, and the list stays put.
    const at = Math.floor((100 - ROW / 2 + scrolled()) / ROW);
    pointer(window, "pointerup", 100);
    frames(3);
    expect(scrolled()).toBe(held);
    restore();
    await settle(SETTLE_MS + 20);
    expect(titles("Projects").indexOf("p00")).toBe(at);
    expect(at).toBeGreaterThan(3);
  });

  it("doesn't scroll a scrolled sidebar for a row picked up near its top until the pointer heads for the edge", async () => {
    const { scrolled, frames, restore } = longSidebar(100);
    // p00 sits in the top edge's band; picked up there and lifted by a small move away from the edge.
    pointer(button("p00"), "pointerdown", 20);
    pointer(window, "pointermove", 26);
    frames(5);
    expect(scrolled()).toBe(100);
    // Wandering in the band, never nearer the edge than the lift: still.
    pointer(window, "pointermove", 30);
    pointer(window, "pointermove", 25);
    frames(5);
    expect(scrolled()).toBe(100);
    // Heading for it: up it goes.
    pointer(window, "pointermove", 20);
    frames(3);
    expect(scrolled()).toBeLessThan(100);
    pointer(window, "pointerup", 20);
    restore();
    await settle(SETTLE_MS + 20);
  });

  it("scrolls once the pointer rests near the edge a moment", async () => {
    const { scrolled, frames, restore } = longSidebar(100);
    pointer(button("p00"), "pointerdown", 20);
    pointer(window, "pointermove", 26);
    frames(3);
    expect(scrolled()).toBe(100);
    await act(() => new Promise((done) => setTimeout(done, DWELL_MS - 150)));
    frames(3);
    expect(scrolled()).toBe(100);
    await act(() => new Promise((done) => setTimeout(done, 200)));
    frames(3);
    expect(scrolled()).toBeLessThan(100);
    pointer(window, "pointerup", 26);
    restore();
    await settle(SETTLE_MS + 20);
  });
});

describe("the keyboard", () => {
  it("moves the focused row with Alt+↑ and Alt+↓, keeps its focus, and says where it went", async () => {
    mount();
    const docs = button("docs");
    act(() => docs.focus());
    const key = (k: string, alt = true) =>
      act(() => void document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: k, altKey: alt, bubbles: true, cancelable: true })));
    const was = onScreen("Projects");
    key("ArrowUp");
    // It glides there, as a drop does.
    glidesFrom("Projects", was, ["docs", "api", "web"]);
    await settle();
    expect(document.activeElement).toBe(button("docs"));
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
    expect(document.activeElement).toBe(button("docs"));
    expect(announced("Projects")).toBe("docs moved to 3 of 3");
  });
});
