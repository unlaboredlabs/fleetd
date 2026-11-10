// @vitest-environment happy-dom
// Reordering the sidebar's pinned chats (W214, W530, W565): a pin dragged inside their grid, or moved with ⌥← / ⌥→ (a
// cell) and ⌥↑ / ⌥↓ (a row), takes its new place, gliding on the sidebar's spring, says so to a screen reader, and the
// hub keeps your pins in that order (chat_pins_set). A chat dragged up past the others joins the pins where it is let
// go, and a pin dragged down out of them leaves them (W574). A chat with new activity climbs to its place in the list on the
// same spring. A press that doesn't move is still a click; Esc puts a lifted pin back.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectRef, ProjectSummary } from "../../../shared/contracts";
import { callKey, createDataLayer, type DataLayer } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { DWELL_MS } from "../../ui/lib/reorder";
import type { SidebarProject } from "./model";
import type { Screen } from "./routes";
import { pinPlace, Sidebar, SPRING } from "./Sidebar";

const SETTLE_MS = SPRING.ms;

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
  line: "",
  at: "2026-10-26T09:00:00.000Z",
  // Only pinned chats lift.
  pinned: true,
});

const ROWS = [row("api"), row("docs"), row("web")];

let host: HTMLDivElement;
let root: Root;
let went: Screen[];
let calls: { tool: string; input: unknown }[];
let layer: DataLayer;
let pins: ProjectRef[];

/**
 * The sidebar with `rows`; again with other rows, the same sidebar drawing them (its state kept). The hub's pins are
 * the rows', already read: the Shell takes the rows' from the hub (pins.ts), and a change is made to the hub's list.
 */
const mount = (rows: SidebarProject[] = ROWS) => {
  pins = rows.filter((p) => p.pinned).map((p) => ({ machineId: p.project.machineId, projectId: p.project.projectId }));
  layer.queryClient.setQueryData(callKey("chat_pins_get", {}), { pins, set: true });
  act(() =>
    root.render(
      <UiProvider>
        <DataProvider layer={layer}>
          <Sidebar
            projects={rows.map((p) => ({ ...p, hub: "hub" }))}
            screen={{ id: "home", at: "hub" }}
            jumpHints={false}
            collapsed={new Set()}
            onToggleHub={() => undefined}
            folded={new Set()}
            onToggleSection={() => undefined}
            factory={false}
            go={(s) => went.push(s)}
          />
        </DataProvider>
      </UiProvider>,
    ),
  );
};

// happy-dom lays nothing out: each row, and each pin, is ROW px tall, stacked in its list, and drawn as far off its
// place as its transform says. Stacked so, the pins' grid is one column, and moves only up and down; "the pins' grid"
// below lays them out two to a row, as the sidebar does.
const layout = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
const translated = (el: HTMLElement) => Number(/translateY\((-?[\d.]+)px\)/.exec(el.style.transform)?.[1] ?? 0);
/** A row's name, or a pin's. */
const NAME = "[class*=name], [class*=pinTitle]";
/**
 * Where each row was drawn at the last read of the layout (as a browser recalculates styles then): a transition set
 * after it starts there. A row's whole path in a glide is from that place to its own: no frame anywhere else.
 */
let drawn: Map<HTMLElement, number>;
/** And each row's clip and mask then: what a glide's first frame shows of it. */
let cutThen: Map<HTMLElement, readonly [string, string]>;

beforeEach(() => {
  went = [];
  calls = [];
  layer = createDataLayer({
    call: (tool, input) => {
      calls.push({ tool, input });
      if (tool === "chat_pins_set") pins = (input as { pins: ProjectRef[] }).pins;
      return Promise.resolve({ ok: true, output: { pins, set: true } });
    },
    subscribe: () => () => undefined,
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  drawn = new Map();
  cutThen = new Map();
  layout.mockImplementation(function (this: HTMLElement) {
    for (const r of host.querySelectorAll<HTMLElement>("[data-reorder-row]")) {
      drawn.set(r, slot(r) + translated(r));
      cutThen.set(r, [r.style.clipPath, r.style.mask]);
    }
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
const titles = (label: string) => [...section(label).querySelectorAll("[data-reorder-row]")].map((r) => r.querySelector(NAME)?.textContent);
const button = (title: string): HTMLElement => {
  const found = [...host.querySelectorAll<HTMLElement>("[data-reorder-row] button")].find((b) => b.textContent.startsWith(title));
  if (found === undefined) throw new Error(`no ${title}`);
  return found;
};
const saved = () => calls.filter((c) => c.tool === "chat_pins_set").map((c) => (c.input as { pins: { projectId: string }[] }).pins.map((r) => r.projectId));
const rows = (label: string) => [...section(label).querySelectorAll<HTMLElement>("[data-reorder-row]")];
const nameOf = (r: HTMLElement) => r.querySelector(NAME)?.textContent ?? "";
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
/**
 * What a clip and a mask show of their row: down to `bottom` px under the row's top (10000: all of it), but for
 * `holes`, each the full width of a row, from its top to its bottom. None: the row is whole.
 */
const shows = ([clip, mask]: readonly [string, string] = ["", ""]) => {
  if (clip === "" && mask === "") return null;
  // Open far past its top and sides, and cut that far up from the row's lower edge.
  const cut = /^inset\(-10000px -10000px (-?[\d.]+)px\)$/u.exec(clip);
  expect(cut).not.toBeNull();
  // All of the row, less each hole.
  const [all, ...layers] = mask.split(", linear-gradient");
  expect(all).toBe("linear-gradient(#000, #000) no-clip subtract");
  const holes = layers.map((layer) => /^\(#000, #000\) 0px (-?[\d.]+)px \/ 200px ([\d.]+)px no-repeat no-clip add$/u.exec(layer));
  expect(holes).not.toContain(null);
  return { bottom: ROW - Number(cut?.[1]), holes: holes.map((m) => [Number(m?.[1]), Number(m?.[1]) + Number(m?.[2])]) };
};
/** A row's clip and mask as they are. */
const cutNow = (r: HTMLElement) => [r.style.clipPath, r.style.mask] as const;
/** Each row's cut over a glide: in its first frame, and where it ends. */
const cutsOf = (label: string) => Object.fromEntries(rows(label).map((r) => [nameOf(r), [shows(cutThen.get(r)), shows(cutNow(r))]]));
const announced = (label: string) => section(label).querySelector("[role='status']")?.textContent;
/** The window asking for reduced motion, until the spy is restored. */
const reducedMotion = () =>
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query) => ({ matches: query.includes("reduce"), media: query, onchange: null, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false }) as MediaQueryList,
  );

const pointer = (target: EventTarget, type: string, y: number, x = 0) =>
  act(() => {
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: "mouse", clientX: x, clientY: y }));
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
    // Held past the last row's middle: it takes the last place, under the pointer (past the list's end it would leave
    // the pins).
    expect(lifted?.style.transform).toBe(`translateY(${String(2 * ROW + 2)}px)`);
    expect(section("Projects").querySelector("[data-reorder]")).not.toBeNull();
    const shifted = [...section("Projects").querySelectorAll<HTMLElement>("[data-reorder-row]:not([data-lifted])")].map((r) => r.style.transform);
    expect(shifted).toEqual([`translateY(-${String(ROW)}px)`, `translateY(-${String(ROW)}px)`]);
    pointer(window, "pointerup", ROW / 2 + 2 * ROW + 2);
    await settle(SETTLE_MS + 20);

    expect(titles("Projects")).toEqual(["docs", "web", "api"]);
    expect(section("Projects").querySelector("[data-lifted], [data-reorder]")).toBeNull();
    // The hub keeps the whole order.
    expect(saved()).toEqual([["docs", "web", "api"]]);
    expect(announced("Projects")).toBe("api moved to 3 of 3");
    // The release was the drop's, not a click on the row.
    expect(went).toEqual([]);
  });

  it("moves an Only-me project among the others: one list", async () => {
    mount([row("ada", { onlyMe: true }), ...ROWS]);
    await drag("ada", 3 * ROW);
    expect(titles("Projects")).toEqual(["api", "docs", "web", "ada"]);
    expect(saved()).toEqual([["api", "docs", "web", "ada"]]);
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
    expect(api?.style.transition).toBe(`transform ${String(SETTLE_MS)}ms var(--ease-spring)`);
    // A pin rides raised over the ones it passes, with its own shade: none of them is cut.
    expect(cutsOf("Projects")).toEqual({ docs: [null, null], api: [null, null], web: [null, null] });
    expect(api?.style.transform).toBe("");
    // Raised until it lands; the others no longer make way.
    expect(api?.hasAttribute("data-lifted")).toBe(true);
    expect(section("Projects").querySelector("[data-reorder]")).toBeNull();
    expect(saved()).toEqual([["docs", "api", "web"]]);

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
    const media = reducedMotion();
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
    mount([ROWS[1], ROWS[0], ROWS[2]].filter((r) => r !== undefined));
    await settle(SETTLE_MS + 20);
    expect(styles.takeRecords()).toEqual([]);
    styles.disconnect();
    glidesFrom("Projects", was, ["docs", "api", "web"]);
  });
});

describe("a list that changes under a drag", () => {
  // A new project, first by title among the projects.
  const WITH_NEW = [row("aaa"), ...ROWS];

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
    pointer(window, "pointermove", ROW / 2 + ROW + 6);
    pointer(window, "pointerup", ROW / 2 + ROW + 6);
    expect(saved()).toEqual([["docs", "api", "web"]]);
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
    expect(saved()).toEqual([["web", "docs"]]);
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
    pointer(window, "pointermove", ROW / 2 + ROW + 6);
    pointer(window, "pointerup", ROW / 2 + ROW + 6);
    act(() => root.render(<div />));
    expect(timers).toHaveBeenCalled();
    timers.mockRestore();
    await settle(SETTLE_MS + 20);
    expect(saved()).toEqual([["docs", "api", "web"]]);
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

    // Letting go drops the row on the place nearest it, and the list stays put.
    const at = Math.round((100 - ROW / 2 + scrolled()) / ROW);
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
  const key = (k: string, alt = true) =>
    act(() => void document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: k, altKey: alt, bubbles: true, cancelable: true })));

  it("moves the focused pin a cell with Alt+← and Alt+→, keeps its focus, and says where it went", async () => {
    mount();
    const docs = button("docs");
    act(() => docs.focus());
    const was = onScreen("Projects");
    key("ArrowLeft");
    // It glides there, as a drop does.
    glidesFrom("Projects", was, ["docs", "api", "web"]);
    await settle();
    expect(document.activeElement).toBe(button("docs"));
    expect(announced("Projects")).toBe("docs moved to 1 of 3");
    expect(saved().at(-1)).toEqual(["docs", "api", "web"]);

    // At the start it stays, and says so.
    key("ArrowLeft");
    await settle();
    expect(announced("Projects")).toBe("docs is already first");
    expect(saved()).toHaveLength(1);

    // Without Alt an arrow is just an arrow.
    key("ArrowRight", false);
    await settle();
    expect(titles("Projects")).toEqual(["docs", "api", "web"]);

    key("ArrowRight");
    key("ArrowRight");
    await settle();
    expect(titles("Projects")).toEqual(["api", "web", "docs"]);
    expect(document.activeElement).toBe(button("docs"));
    expect(announced("Projects")).toBe("docs moved to 3 of 3");
  });

  it("moves it a row with Alt+↑ and Alt+↓", async () => {
    mount([...ROWS, row("ada"), row("box")]);
    act(() => button("api").focus());
    key("ArrowDown");
    await settle();
    expect(titles("Projects")).toEqual(["docs", "web", "api", "ada", "box"]);
    expect(announced("Projects")).toBe("api moved to 3 of 5");
    key("ArrowUp");
    await settle();
    expect(titles("Projects")).toEqual(["api", "docs", "web", "ada", "box"]);
  });
});

describe("the pins' grid", () => {
  // Two to a row, each cell CELL_W wide and CELL_H tall: api and docs on the first row, web and ada on the second.
  const CELL_W = 120;
  const CELL_H = 92;
  const PINS = [...ROWS, row("ada")];
  const moved = (el: HTMLElement) => {
    const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(el.style.transform);
    return m === null ? [0, translated(el)] : [Number(m[1]), Number(m[2])];
  };
  const cell = (title: string) => rows("Projects").find((r) => nameOf(r) === title) ?? host;
  beforeEach(() => {
    layout.mockImplementation(function (this: HTMLElement) {
      const list = this.parentElement;
      const at = list === null ? 0 : [...list.children].indexOf(this);
      const [dx, dy] = moved(this);
      return DOMRect.fromRect({ x: (at % 2) * CELL_W + (dx ?? 0), y: Math.floor(at / 2) * CELL_H + (dy ?? 0), width: CELL_W, height: CELL_H });
    });
  });

  it("carries a pin across its row, the one it passes sliding back a cell, and drops it there", async () => {
    mount(PINS);
    const y = CELL_H / 2;
    pointer(button("api"), "pointerdown", y, CELL_W / 2);
    pointer(window, "pointermove", y, CELL_W / 2 + 20);
    pointer(window, "pointermove", y - 4, CELL_W / 2 + 2 * CELL_W);
    // Riding the pointer both ways, but never out of the grid's sides.
    expect(moved(cell("api"))).toEqual([CELL_W, -4]);
    expect(moved(cell("docs"))).toEqual([-CELL_W, 0]);
    expect(moved(cell("web"))).toEqual([0, 0]);
    pointer(window, "pointerup", y - 4, CELL_W / 2 + 2 * CELL_W);
    await settle(SETTLE_MS + 20);
    expect(titles("Projects")).toEqual(["docs", "api", "web", "ada"]);
    expect(saved()).toEqual([["docs", "api", "web", "ada"]]);
    expect(announced("Projects")).toBe("api moved to 2 of 4");
  });

  it("carries one up a row, the cells it passes sliding on in reading order, a row's last down to the next", async () => {
    mount(PINS);
    const y = CELL_H + CELL_H / 2;
    const x = CELL_W + CELL_W / 2;
    pointer(button("ada"), "pointerdown", y, x);
    pointer(window, "pointermove", y - 20, x);
    pointer(window, "pointermove", CELL_H / 2, CELL_W / 2);
    expect(moved(cell("api"))).toEqual([CELL_W, 0]);
    expect(moved(cell("docs"))).toEqual([-CELL_W, CELL_H]);
    expect(moved(cell("web"))).toEqual([CELL_W, 0]);
    pointer(window, "pointerup", CELL_H / 2, CELL_W / 2);
    await settle(SETTLE_MS + 20);
    expect(titles("Projects")).toEqual(["ada", "api", "docs", "web"]);
    expect(saved()).toEqual([["ada", "api", "docs", "web"]]);
  });

  it("keeps the pins apart from the list: no line between them, and a chat that isn't pinned never joins the grid", () => {
    mount([...PINS, { ...row("misc"), pinned: false }]);
    const grid = rows("Projects").filter((r) => r.parentElement?.className.includes("pins") === true);
    expect(grid.map(nameOf)).toEqual(["api", "docs", "web", "ada"]);
    expect(host.querySelector("[data-pins-end]")).toBeNull();
  });
});

describe("pinning and unpinning by drag", () => {
  // The pins stacked from the top, ROW apart; the other chats' list GAP below them. The sidebar's rows come from the
  // Shell, which takes the pins saved (pins.ts usePins, pins.dom.test.tsx): here, what is saved is the pins.
  // With no pins, the first pin's drop zone, while it shows, pushes the list ZONE further down. The hub's group ends at
  // its last row, as a browser lays it out: below it is the sidebar's empty space (or the next hub's group).
  const GAP = 100;
  const ZONE = 48;
  let group: DOMRect;
  const unpinned = (title: string) => ({ ...row(title), pinned: false });
  const zone = () => host.querySelector<HTMLElement>("[class*=pinZone]");
  beforeEach(() => {
    group = DOMRect.fromRect({ x: 0, y: 0, width: 240, height: GAP + 3 * ROW });
    layout.mockImplementation(function (this: HTMLElement) {
      if (this.tagName === "SECTION") return group;
      const list = this.parentElement;
      const at = list === null ? 0 : [...list.children].indexOf(this);
      const top = list?.className.includes("rows") === true ? GAP + (zone() === null ? 0 : ZONE) : 0;
      return DOMRect.fromRect({ x: 0, y: top + at * ROW + translated(this), width: 200, height: ROW });
    });
  });
  const grid = () => host.querySelector<HTMLElement>("[class*=pins]");
  /** Presses `title` at its middle, moves it to `y` (on screen) in steps, and, unless `hold`, lets go there. */
  const carry = async (title: string, y: number, opts: { hold?: boolean } = {}) => {
    const el = button(title);
    const box = el.closest("[data-reorder-row]")?.getBoundingClientRect();
    const from = (box?.top ?? 0) + ROW / 2;
    pointer(el, "pointerdown", from);
    for (let step = 1; step <= 4; step++) pointer(window, "pointermove", from + ((y - from) * step) / 4);
    if (opts.hold === true) return;
    pointer(window, "pointerup", y);
    await settle(SETTLE_MS + 20);
  };

  it("pins a chat dragged up past the others where it is let go among the pins, the grid shaded while it would", async () => {
    mount([row("api"), row("docs"), unpinned("web"), unpinned("misc")]);
    await carry("misc", ROW + 4, { hold: true });
    expect(grid()?.hasAttribute("data-pinning")).toBe(true);
    pointer(window, "pointerup", ROW + 4);
    await settle(SETTLE_MS + 20);
    expect(grid()?.hasAttribute("data-pinning")).toBe(false);
    // Below api's middle, above docs': between them.
    expect(saved()).toEqual([["api", "misc", "docs"]]);
    expect(went).toEqual([]);
  });

  it("pins it first above the pins, and last between them and the list", async () => {
    mount([row("api"), unpinned("web"), unpinned("misc")]);
    await carry("web", -10);
    expect(saved()).toEqual([["web", "api"]]);
    calls.length = 0;
    // Made to the hub's list, which has web by now.
    await carry("misc", GAP - 10);
    expect(saved()).toEqual([["web", "api", "misc"]]);
  });

  it("pins the first one with no pins yet", async () => {
    mount([unpinned("web"), unpinned("misc")]);
    await carry("misc", GAP - 10);
    expect(saved()).toEqual([["misc"]]);
  });

  it("unpins a pin dragged down out of the pins, fading it on the way, a lone one too", async () => {
    mount([row("api"), row("docs"), unpinned("web")]);
    await carry("api", GAP + 10, { hold: true });
    expect(grid()?.hasAttribute("data-unpinning")).toBe(true);
    pointer(window, "pointerup", GAP + 10);
    await settle(SETTLE_MS + 20);
    expect(saved()).toEqual([["docs"]]);
    expect(grid()?.hasAttribute("data-unpinning")).toBe(false);
    mount([row("docs"), unpinned("api"), unpinned("web")]);
    calls.length = 0;
    await carry("docs", GAP + 10);
    expect(saved()).toEqual([[]]);
  });

  it("puts back a chat let go inside the list, whose order is its activity's, and a pin let go above the pins", async () => {
    mount([row("api"), unpinned("web"), unpinned("misc")]);
    await carry("web", GAP + 2 * ROW);
    expect(titles("Projects")).toEqual(["api", "web", "misc"]);
    await carry("api", -40);
    expect(titles("Projects")).toEqual(["api", "web", "misc"]);
    expect(saved()).toEqual([]);
    // The release was the drop's, not a click on the row.
    expect(went).toEqual([]);
  });

  it("opens a chat on a press that wobbles inside its row, and lifts it only once the pointer leaves the row", async () => {
    mount([row("api"), unpinned("web"), unpinned("misc")]);
    const el = button("web");
    const middle = GAP + ROW / 2;
    pointer(el, "pointerdown", middle);
    pointer(window, "pointermove", middle + 6, 3);
    pointer(window, "pointermove", middle - 10, -2);
    expect(host.querySelector("[data-lifted]")).toBeNull();
    pointer(el, "pointerup", middle - 10);
    act(() => el.click());
    expect(went).toEqual([{ id: "project", project: { machineId: "devbox", projectId: "web" }, message: null }]);
    pointer(el, "pointerdown", middle);
    pointer(window, "pointermove", middle - ROW);
    expect(host.querySelector("[data-lifted]")?.textContent).toContain("web");
    pointer(window, "pointerup", middle - ROW);
    await settle(SETTLE_MS + 20);
  });

  it("shows the first pin's place while a chat is dragged with none pinned, keeping the chat under the pointer", async () => {
    mount([unpinned("web"), unpinned("misc")]);
    expect(zone()).toBeNull();
    // misc lifted: the zone pushed the list down under it, and it stays where the pointer is.
    const from = GAP + ROW + ROW / 2;
    pointer(button("misc"), "pointerdown", from);
    pointer(window, "pointermove", from + ROW);
    expect(zone()?.textContent).toBe("Drop here to pin");
    expect(zone()?.hasAttribute("data-pinning")).toBe(false);
    const lifted = host.querySelector<HTMLElement>("[data-lifted]");
    expect((lifted?.getBoundingClientRect().top ?? 0) + ROW / 2).toBe(from + ROW);
    // Over the zone (above the list), it would pin, and says so.
    pointer(window, "pointermove", GAP + ZONE / 2);
    expect((lifted?.getBoundingClientRect().top ?? 0) + ROW / 2).toBe(GAP + ZONE / 2);
    expect(zone()?.hasAttribute("data-pinning")).toBe(true);
    pointer(window, "pointerup", GAP + ZONE / 2);
    await settle(SETTLE_MS + 20);
    expect(saved()).toEqual([["misc"]]);
    expect(zone()).toBeNull();
  });

  it("shows no zone with pins already: the pins are the place", async () => {
    mount([row("api"), unpinned("web"), unpinned("misc")]);
    await carry("misc", GAP - 10, { hold: true });
    expect(zone()).toBeNull();
    expect(grid()?.hasAttribute("data-pinning")).toBe(true);
    pointer(window, "pointerup", GAP - 10);
    await settle(SETTLE_MS + 20);
  });

  it("unpins a pin let go below a short list, in the sidebar's empty space, with every chat pinned too", async () => {
    mount([row("api"), row("docs"), unpinned("web")]);
    await carry("api", 400);
    expect(saved()).toEqual([["docs"]]);
    calls.length = 0;
    // Every chat pinned, the lone pin's case among them: its group ends at the pins.
    group = DOMRect.fromRect({ x: 0, y: 0, width: 240, height: ROW });
    mount([row("docs")]);
    await carry("docs", 400);
    expect(saved()).toEqual([[]]);
  });

  it("keeps a drop out of another hub's group: let go over one, above or below, it goes back", async () => {
    mount([row("api"), unpinned("web"), unpinned("misc")]);
    // Another hub's group either side of this one's.
    const own = section("Projects");
    const other = () => Object.assign(document.createElement("section"), { ariaLabel: "Other" });
    own.before(other());
    own.after(other());
    await carry("misc", -40, { hold: true });
    expect(grid()?.hasAttribute("data-pinning")).toBe(false);
    pointer(window, "pointerup", -40);
    await settle(SETTLE_MS + 20);
    await carry("api", GAP + 3 * ROW + 40);
    expect(saved()).toEqual([]);
    expect(titles("Projects")).toEqual(["api", "web", "misc"]);
    // Inside it, the same drags pin and unpin: api leaves the hub's list, where misc is by now.
    await carry("misc", 10);
    await carry("api", GAP + 2 * ROW);
    expect(saved()).toEqual([["misc", "api"], ["misc"]]);
  });

  it("pins no tenth chat: it goes back, and says why", async () => {
    const nine = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((t) => row(t));
    mount([...nine, unpinned("web")]);
    await carry("web", -10);
    expect(saved()).toEqual([]);
    expect(document.body.textContent).toContain("Up to 9 chats can be pinned");
  });
});

describe("pinPlace", () => {
  // Two to a row, 100 px square.
  const cells = [0, 1, 2].map((i) => DOMRect.fromRect({ x: (i % 2) * 100, y: Math.floor(i / 2) * 100, width: 100, height: 100 }));
  it("counts the pins before the pointer in reading order", () => {
    expect(pinPlace(cells, { x: 10, y: -5 })).toBe(0);
    expect(pinPlace(cells, { x: 10, y: 50 })).toBe(0);
    expect(pinPlace(cells, { x: 60, y: 50 })).toBe(1);
    expect(pinPlace(cells, { x: 190, y: 50 })).toBe(2);
    expect(pinPlace(cells, { x: 190, y: 150 })).toBe(3);
    expect(pinPlace(cells, { x: 0, y: 250 })).toBe(3);
    expect(pinPlace([], { x: 0, y: 0 })).toBe(0);
  });
});

describe("a chat with new activity", () => {
  const unpinned = (title: string, at: string) => ({ ...row(title), pinned: false, at });

  it("climbs to its place on the spring, drawn over the rows it passes, which make way below it", async () => {
    mount([unpinned("api", "09:03"), unpinned("docs", "09:02"), unpinned("web", "09:01")]);
    const was = onScreen("Projects");
    // web gets a message: its row is newest now.
    mount([unpinned("web", "09:04"), unpinned("api", "09:03"), unpinned("docs", "09:02")]);
    glidesFrom("Projects", was, ["web", "api", "docs"]);
    const [web, api] = rows("Projects");
    expect(web?.style.transition).toBe(`transform ${String(SETTLE_MS)}ms var(--ease-spring)`);
    expect(web?.dataset["gliding"]).toBe("up");
    expect(api?.dataset["gliding"]).toBe("down");
    await settle(SETTLE_MS + 20);
    expect(rows("Projects").map((r) => [r.style.transform, r.dataset["gliding"]])).toEqual([
      ["", undefined],
      ["", undefined],
      ["", undefined],
    ]);
    // Nothing was saved: activity is no order of yours.
    expect(saved()).toEqual([]);
  });

  it("cuts the rows it passes where it is over them, so no frame draws its words on theirs, whatever is behind", async () => {
    mount([unpinned("api", "09:03"), unpinned("docs", "09:02"), unpinned("web", "09:01")]);
    mount([unpinned("web", "09:04"), unpinned("api", "09:03"), unpinned("docs", "09:02")]);
    // web starts two rows down, right under docs' first place and a row under api's, and ends over both. Each hole
    // is where web is, seen from the row it is cut out of, and goes with it on the same spring.
    expect(cutsOf("Projects")).toEqual({
      web: [null, null],
      api: [
        { bottom: 10000, holes: [[2 * ROW, 3 * ROW]] },
        { bottom: 10000, holes: [[-ROW, 0]] },
      ],
      docs: [
        { bottom: 10000, holes: [[ROW, 2 * ROW]] },
        { bottom: 10000, holes: [[-2 * ROW, -ROW]] },
      ],
    });
    const over = `${String(SETTLE_MS)}ms var(--ease-spring)`;
    const cut = `clip-path ${over}, mask-position ${over}`;
    expect(rows("Projects").map((r) => r.style.transition)).toEqual([`transform ${over}`, `transform ${over}, ${cut}`, `transform ${over}, ${cut}`]);
    await settle(SETTLE_MS + 20);
    expect(rows("Projects").map((r) => [...cutNow(r), r.style.transition])).toEqual([
      ["", "", ""],
      ["", "", ""],
      ["", "", ""],
    ]);
  });

  it("cuts one of two climbing at once where the other, drawn over it, crosses it, and the rows under both", () => {
    mount([unpinned("api", "09:04"), unpinned("docs", "09:03"), unpinned("misc", "09:02"), unpinned("web", "09:01")]);
    const was = onScreen("Projects");
    // web and misc both get a message, web's the newer: web goes up three rows and passes misc, which goes up one.
    mount([unpinned("web", "09:06"), unpinned("misc", "09:05"), unpinned("api", "09:04"), unpinned("docs", "09:03")]);
    glidesFrom("Projects", was, ["web", "misc", "api", "docs"]);
    expect(rows("Projects").map((r) => r.dataset["gliding"])).toEqual(["up", "up", "down", "down"]);
    // misc is the lower of the two going up, so the page draws it over web: web is cut where misc is. api and docs
    // are under both, whose holes lie on each other half way.
    expect(cutsOf("Projects")).toEqual({
      web: [
        { bottom: 10000, holes: [[-ROW, 0]] },
        { bottom: 10000, holes: [[ROW, 2 * ROW]] },
      ],
      misc: [null, null],
      api: [
        { bottom: 10000, holes: [[3 * ROW, 4 * ROW], [2 * ROW, 3 * ROW]] },
        { bottom: 10000, holes: [[-2 * ROW, -ROW], [-ROW, 0]] },
      ],
      docs: [
        { bottom: 10000, holes: [[2 * ROW, 3 * ROW], [ROW, 2 * ROW]] },
        { bottom: 10000, holes: [[-3 * ROW, -2 * ROW], [-2 * ROW, -ROW]] },
      ],
    });
  });

  it("leaves a row let go whole, over the others: one going up with it is cut where it is", async () => {
    // With a pin, so no place for a first one comes and goes over the list.
    mount([row("pin"), unpinned("api", "09:03"), unpinned("docs", "09:02"), unpinned("web", "09:01")]);
    // api is carried two rows down when web gets a message: api goes back, now to the place under web's.
    pointer(button("api"), "pointerdown", ROW / 2);
    pointer(window, "pointermove", ROW / 2 + 10);
    pointer(window, "pointermove", 2 * ROW + ROW / 2);
    expect(section("Projects").querySelector("[data-lifted]")?.textContent).toContain("api");
    expect(Object.fromEntries(onScreen("Projects"))).toEqual({ pin: 0, api: 2 * ROW, docs: ROW, web: 2 * ROW });
    mount([row("pin"), unpinned("web", "09:04"), unpinned("api", "09:03"), unpinned("docs", "09:02")]);
    expect(Object.fromEntries(paths("Projects"))).toEqual({ pin: { from: 0, to: 0 }, web: { from: 2 * ROW, to: 0 }, api: { from: 2 * ROW, to: ROW }, docs: { from: ROW, to: 2 * ROW } });
    const [, web, api, docs] = rows("Projects");
    expect([web, api, docs].map((r) => [r?.dataset["gliding"], r?.hasAttribute("data-lifted")])).toEqual([
      ["up", false],
      ["up", true],
      ["down", false],
    ]);
    // api starts where web does and ends under it; docs is under both.
    expect(cutsOf("Projects")).toEqual({
      pin: [null, null],
      web: [
        { bottom: 10000, holes: [[0, ROW]] },
        { bottom: 10000, holes: [[ROW, 2 * ROW]] },
      ],
      api: [null, null],
      docs: [
        { bottom: 10000, holes: [[ROW, 2 * ROW], [ROW, 2 * ROW]] },
        { bottom: 10000, holes: [[-2 * ROW, -ROW], [-ROW, 0]] },
      ],
    });
    pointer(window, "pointerup", 2 * ROW + ROW / 2);
    await settle(SETTLE_MS + 20);
    expect(rows("Projects").map((r) => [...cutNow(r), r.hasAttribute("data-lifted")])).toEqual([
      ["", "", false],
      ["", "", false],
      ["", "", false],
      ["", "", false],
    ]);
  });

  it("uncovers a row the list has only now got as the rows under it make room: none of them is drawn on it", async () => {
    mount([unpinned("api", "09:04"), unpinned("web", "09:01")]);
    const was = onScreen("Projects");
    // A section unfolding, or a chat that is new: docs and misc come between api and web.
    mount([unpinned("api", "09:04"), unpinned("docs", "09:03"), unpinned("misc", "09:02"), unpinned("web", "09:01")]);
    glidesFrom("Projects", was, ["api", "docs", "misc", "web"]);
    // web starts where docs is: nothing of docs or misc shows yet. Its upper edge uncovers them on its way down, and
    // web itself is a hole in each, as any row drawn over another is.
    expect(cutsOf("Projects")).toEqual({
      api: [null, null],
      docs: [
        { bottom: 0, holes: [[0, ROW]] },
        { bottom: 2 * ROW, holes: [[2 * ROW, 3 * ROW]] },
      ],
      misc: [
        { bottom: -ROW, holes: [[-ROW, 0]] },
        { bottom: ROW, holes: [[ROW, 2 * ROW]] },
      ],
      web: [null, null],
    });
    const over = `${String(SETTLE_MS)}ms var(--ease-spring)`;
    const cut = `clip-path ${over}, mask-position ${over}`;
    expect(rows("Projects").map((r) => r.style.transition)).toEqual(["", cut, cut, `transform ${over}`]);
    await settle(SETTLE_MS + 20);
    expect(rows("Projects").map((r) => [...cutNow(r), r.style.transition])).toEqual([
      ["", "", ""],
      ["", "", ""],
      ["", "", ""],
      ["", "", ""],
    ]);
  });

  it("with reduced motion, shows a new row at once: nothing glides, so nothing is cut", () => {
    const media = reducedMotion();
    try {
      mount([unpinned("api", "09:04"), unpinned("web", "09:01")]);
      mount([unpinned("api", "09:04"), unpinned("docs", "09:03"), unpinned("web", "09:01")]);
      expect(rows("Projects").map((r) => [r.style.transform, ...cutNow(r), r.style.transition])).toEqual([
        ["", "", "", ""],
        ["", "", "", ""],
        ["", "", "", ""],
      ]);
    } finally {
      media.mockRestore();
    }
  });

  it("can't be dragged or moved with the keyboard: only a pinned chat can", async () => {
    mount([unpinned("api", "09:03"), unpinned("docs", "09:02"), unpinned("web", "09:01")]);
    await drag("api", ROW + 6);
    expect(titles("Projects")).toEqual(["api", "docs", "web"]);
    expect(section("Projects").querySelector("[data-lifted]")).toBeNull();
    act(() => button("docs").focus());
    act(() => void document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true, cancelable: true })));
    await settle();
    expect(titles("Projects")).toEqual(["api", "docs", "web"]);
    expect(saved()).toEqual([]);
  });
});
