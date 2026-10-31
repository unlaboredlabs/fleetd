// @vitest-environment happy-dom
// Your sidebar order through the data layer (W214): the order the hub keeps for you puts the sidebar's rows in it,
// new ones after; a move from another desktop (sidebar.order) moves them live. Quick moves in a row each show at once,
// go to the hub one at a time (only the newest of those made meanwhile), and a read older than the last of them,
// such as the refetch your own earlier move's event made, never puts a row back. A row dropped in the sidebar stays
// put through the hub's answer and its echo (W219).
import { act, Profiler } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectRef, ProjectSummary } from "../../../shared/contracts";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type DataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider, useDataLayer } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { SETTLE_MS } from "../../ui/lib/reorder";
import { useSidebarProjects } from "./data";
import { Sidebar } from "./Sidebar";
import { saveOrder } from "./yourOrder";

vi.hoisted(() => {
  (window as unknown as { fleetd: object }).fleetd = {
    platform: "linux",
    fixture: null,
    copy: () => Promise.resolve(),
    updates: { subscribe: () => () => undefined, state: () => new Promise(() => undefined) },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const project = (title: string, kind?: "assistant"): ProjectSummary => ({
  machineId: "devbox",
  projectId: title,
  title,
  workspaceRoot: `/srv/${title}`,
  lastActivityAt: "2026-10-26T09:00:00.000Z",
  threads: { failed: 0, idle: 0, running: 0, waiting: 0 },
  ...(kind === undefined ? {} : { kind }),
});
const ref = (id: string): ProjectRef => ({ machineId: "devbox", projectId: id });
const refs = (...ids: string[]) => ids.map(ref);

let host: HTMLDivElement;
let root: Root;
let layer: DataLayer;
let listener: (frame: HubFrame) => void;
/** What the hub keeps. */
let stored: ProjectRef[];
/** The sets on their way, each landing when the test says. */
let sets: { order: ProjectRef[]; land: () => void }[];
/** Hold reads of the order until the test lets them answer, with what the hub kept when they were asked. */
let holdReads: boolean;
let heldReads: (() => void)[];
let seq: number;

beforeEach(() => {
  stored = [];
  sets = [];
  holdReads = false;
  heldReads = [];
  seq = 10;
  const hub: HubApi = {
    call: (tool, input) => {
      if (tool === "sidebar_order_get") {
        const answer = { ok: true as const, output: { order: stored } };
        if (!holdReads) return Promise.resolve(answer);
        return new Promise((done) => heldReads.push(() => done(answer)));
      }
      if (tool === "sidebar_order_set") {
        const order = (input as { order: ProjectRef[] }).order;
        return new Promise((done) =>
          sets.push({
            order,
            land: () => {
              stored = order;
              done({ ok: true, output: { order } });
            },
          }),
        );
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

/** The sidebar's rows from the data layer, as the frame gets them for each hub. */
function Rows() {
  const rows = useSidebarProjects(null);
  return <ol>{rows?.map((r) => <li key={r.key}>{r.project.title}</li>)}</ol>;
}
const shown = () => [...host.querySelectorAll("li")].map((li) => li.textContent);

const mount = async (projects: ProjectSummary[]) => {
  act(() =>
    root.render(
      <DataProvider layer={layer}>
        <Rows />
      </DataProvider>,
    ),
  );
  act(() => {
    listener({ t: "state", state: { phase: "live", hub: "devbox:4710", protocol: 1 } });
    listener({ t: "snapshot", snapshot: { cursor: 1, attention: [], machines: [], projects } });
  });
  await settle();
};

/** The hub announces your order changed (your own set, or another desktop's); the layer reads it again. */
const announced = async () => {
  act(() => listener({ t: "event", event: { seq: seq++, at: "2026-10-26T09:01:00.000Z", type: "sidebar.order", summary: "", data: { personId: "p_abcd2345" } } }));
  // Events' refetches go out together, 100 ms after the first.
  await settle(120);
};

const PROJECTS = [project("Ada", "assistant"), project("Home", "assistant"), project("api"), project("docs"), project("web"), project("new")];

describe("the order the hub keeps for you", () => {
  it("puts the sidebar's rows in it, each section on its own, the new ones after, and follows another desktop's move live", async () => {
    stored = refs("Home", "Ada", "web", "api", "docs");
    await mount(PROJECTS);
    expect(shown()).toEqual(["Home", "Ada", "web", "api", "docs", "new"]);

    // Moved on another desktop.
    stored = refs("Ada", "Home", "docs", "new", "web", "api");
    await announced();
    expect(shown()).toEqual(["Ada", "Home", "docs", "new", "web", "api"]);
  });
});

describe("quick moves in a row", () => {
  it("each show at once, reach the hub one at a time, newest only, and an older read never puts a row back", async () => {
    await mount([project("a"), project("b"), project("c")]);
    expect(shown()).toEqual(["a", "b", "c"]);

    act(() => void saveOrder(layer, refs("c", "a", "b")));
    expect(shown()).toEqual(["c", "a", "b"]);
    act(() => void saveOrder(layer, refs("b", "c", "a")));
    act(() => void saveOrder(layer, refs("a", "c", "b")));
    expect(shown()).toEqual(["a", "c", "b"]);
    // One set on its way at a time.
    expect(sets.map((s) => s.order)).toEqual([refs("c", "a", "b")]);

    // The first lands, and its own event reads the order the hub has now: the first move's, older than what shows.
    act(() => sets[0]?.land());
    await settle();
    await announced();
    expect(shown()).toEqual(["a", "c", "b"]);
    // Then the newest goes, not the one between.
    expect(sets.map((s) => s.order)).toEqual([refs("c", "a", "b"), refs("a", "c", "b")]);

    // A read asked before the last set landed answers after it: still older, and still never shown.
    holdReads = true;
    await announced();
    act(() => sets[1]?.land());
    await settle();
    act(() => heldReads.splice(0).forEach((answer) => answer()));
    await settle();
    expect(shown()).toEqual(["a", "c", "b"]);

    // A read after it takes over, as does a later move from another desktop.
    holdReads = false;
    await announced();
    expect(shown()).toEqual(["a", "c", "b"]);
    stored = refs("b", "a", "c");
    await announced();
    expect(shown()).toEqual(["b", "a", "c"]);
  });
});

/** The sidebar itself, its rows from the data layer as the frame gives them. */
function Bar() {
  const rows = useSidebarProjects(null);
  const { hub } = useDataLayer();
  return (
    <Sidebar
      projects={rows?.map((p) => ({ ...p, hub }))}
      screen={{ id: "status", at: hub }}
      jumpHints={false}
      collapsed={new Set()}
      onToggleHub={() => undefined}
      factory={false}
      admin={false}
      go={() => undefined}
    />
  );
}

describe("a row dropped in the sidebar", () => {
  const ROW = 28;
  // Each row ROW px tall in its list, drawn as far off its place as its transform says.
  const layout = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
  afterEach(() => layout.mockReset());

  it("stays put through the hub's answer, a read from before it and the hub's echo", async () => {
    layout.mockImplementation(function (this: HTMLElement) {
      const at = this.parentElement === null ? 0 : [...this.parentElement.children].indexOf(this);
      const by = Number(/translateY\((-?[\d.]+)px\)/.exec(this.style.transform)?.[1] ?? 0);
      return DOMRect.fromRect({ x: 0, y: at * ROW + by, width: 200, height: ROW });
    });
    act(() =>
      root.render(
        <UiProvider>
          <DataProvider layer={layer}>
            <Bar />
          </DataProvider>
        </UiProvider>,
      ),
    );
    act(() => {
      listener({ t: "state", state: { phase: "live", hub: "devbox:4710", protocol: 1 } });
      listener({ t: "snapshot", snapshot: { cursor: 1, attention: [], machines: [], projects: [project("a"), project("b"), project("c")] } });
    });
    await settle();
    const rows = () => [...host.querySelectorAll<HTMLElement>("[data-reorder-row]")];
    const titles = () => rows().map((r) => r.querySelector("[class*=sidebarLabel]")?.textContent);
    expect(titles()).toEqual(["a", "b", "c"]);

    // a dragged past b and let go.
    const press = (type: string, y: number, at: EventTarget = window) =>
      act(() => void at.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: "mouse", clientY: y })));
    press("pointerdown", ROW / 2, rows()[0]?.querySelector("button") ?? window);
    press("pointermove", ROW / 2 + 10);
    press("pointermove", ROW / 2 + ROW + 6);
    press("pointerup", ROW / 2 + ROW + 6);
    expect(titles()).toEqual(["b", "a", "c"]);
    await settle(SETTLE_MS + 20);
    expect(rows().map((r) => r.style.transform)).toEqual(["", "", ""]);

    // From here nothing in the list may change: no row moved in the DOM, no row's style touched.
    const changes = new MutationObserver(() => undefined);
    const list = rows()[0]?.parentElement;
    if (list === null || list === undefined) throw new Error("no list");
    changes.observe(list, { childList: true, attributes: true, attributeFilter: ["style"], subtree: true });
    // A read asked before the set lands answers with the order from before: never shown.
    holdReads = true;
    await announced();
    act(() => sets[0]?.land());
    await settle();
    act(() => heldReads.splice(0).forEach((answer) => answer()));
    await settle(SETTLE_MS + 20);
    // The hub's echo reads it again: the same order.
    holdReads = false;
    await announced();
    await settle(SETTLE_MS + 20);
    expect(sets.map((x) => x.order)).toEqual([refs("b", "a", "c")]);
    expect(titles()).toEqual(["b", "a", "c"]);
    expect(changes.takeRecords()).toEqual([]);
    changes.disconnect();
  });
});

describe("the rows around a row dragged in the sidebar", () => {
  const ROW = 28;
  const layout = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
  afterEach(() => layout.mockReset());
  const rows = () => [...host.querySelectorAll<HTMLElement>("[data-reorder-row]")];
  const nameOf = (r: HTMLElement) => r.querySelector("[class*=sidebarLabel]")?.textContent ?? "";
  const titles = () => rows().map(nameOf);
  const translated = (el: HTMLElement) => Number(/translateY\((-?[\d.]+)px\)/.exec(el.style.transform)?.[1] ?? 0);
  const slot = (el: HTMLElement) => (el.parentElement === null ? 0 : [...el.parentElement.children].indexOf(el) * ROW);

  /**
   * The sidebar on a, b, c, d from the data layer, `name` dragged `dy` and let go, with every commit React makes
   * looked at: where `watch` (a row the drag never passes) and `passed` (the one it does) are drawn, and whether the
   * list took a new order while its rows were still making way for the drag. These guard the render ordering only:
   * here act() makes the renders one commit and nothing is painted between them, so the jump a split render painted
   * on #868's parent (the row above jumping up, W219) doesn't show; perf:drops, in the built app, guards the frames.
   */
  const drag = async (name: string, dy: number, watch: string, passed: string) => {
    // Where each row was drawn at the last read of the layout: a transition set after it starts there.
    const drawn = new Map<HTMLElement, number>();
    layout.mockImplementation(function (this: HTMLElement) {
      for (const r of rows()) drawn.set(r, slot(r) + translated(r));
      return DOMRect.fromRect({ x: 0, y: slot(this) + translated(this), width: 200, height: ROW });
    });
    const at = (n: string) => {
      const r = rows().find((x) => nameOf(x) === n);
      return r === undefined ? undefined : r.style.transition.includes("transform") ? drawn.get(r) : slot(r) + translated(r);
    };
    const commits: { order: string; making: boolean; watch: number | undefined; passed: number | undefined }[] = [];
    const looked = () => commits.push({ order: titles().join(" "), making: host.querySelector("[data-reorder]") !== null, watch: at(watch), passed: at(passed) });
    act(() =>
      root.render(
        <UiProvider>
          <DataProvider layer={layer}>
            <Profiler id="sidebar" onRender={looked}>
              <Bar />
            </Profiler>
          </DataProvider>
        </UiProvider>,
      ),
    );
    act(() => {
      listener({ t: "state", state: { phase: "live", hub: "devbox:4710", protocol: 1 } });
      listener({ t: "snapshot", snapshot: { cursor: 1, attention: [], machines: [], projects: ["a", "b", "c", "d"].map((t) => project(t)) } });
    });
    await settle();
    expect(titles()).toEqual(["a", "b", "c", "d"]);
    const y = (rows().findIndex((r) => nameOf(r) === name) + 0.5) * ROW;
    const press = (type: string, to: number, target: EventTarget = window) =>
      act(() => void target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: "mouse", clientY: to })));
    commits.length = 0;
    press("pointerdown", y, rows().find((r) => nameOf(r) === name)?.querySelector("button") ?? window);
    for (const step of [6, dy / 2, dy]) press("pointermove", y + step);
    press("pointerup", y + dy);
    await settle(SETTLE_MS + 20);
    act(() => sets[0]?.land());
    await announced();
    await settle(SETTLE_MS + 20);
    return commits;
  };

  it("in every commit, keeps the row above a row dragged down in its place and the row passed in its slot or the gap's", async () => {
    // b down past c: a, above it, never moves; c slides up into b's place and stays there.
    const commits = await drag("b", ROW + 6, "a", "c");
    expect(commits.length).toBeGreaterThan(2);
    expect(commits.filter((c) => c.making && c.order !== "a b c d")).toEqual([]);
    expect(new Set(commits.map((c) => c.watch))).toEqual(new Set([0]));
    expect(commits.filter((c) => c.passed !== 2 * ROW && c.passed !== ROW)).toEqual([]);
    expect(commits.at(-1)).toEqual({ order: "a c b d", making: false, watch: 0, passed: ROW });
    expect(sets.map((x) => x.order)).toEqual([refs("a", "c", "b", "d")]);
  });

  it("in every commit, keeps the row below a row dragged up in its place and the row passed in its slot or the gap's", async () => {
    // c up past b: d, below it, never moves; b slides down into c's place and stays there.
    const commits = await drag("c", -(ROW + 6), "d", "b");
    expect(commits.filter((c) => c.making && c.order !== "a b c d")).toEqual([]);
    expect(new Set(commits.map((c) => c.watch))).toEqual(new Set([3 * ROW]));
    expect(commits.filter((c) => c.passed !== ROW && c.passed !== 2 * ROW)).toEqual([]);
    expect(commits.at(-1)).toEqual({ order: "a c b d", making: false, watch: 3 * ROW, passed: 2 * ROW });
  });
});
