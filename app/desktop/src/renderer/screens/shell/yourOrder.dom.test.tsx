// @vitest-environment happy-dom
// Your sidebar order through the data layer (W214): the order the hub keeps for you puts the sidebar's rows in it,
// new ones after; a move from another desktop (sidebar.order) moves them live. Quick moves in a row each show at once,
// go to the hub one at a time (only the newest of those made meanwhile), and a read older than the last of them,
// such as the refetch your own earlier move's event made, never puts a row back.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectRef, ProjectSummary } from "../../../shared/contracts";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type DataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { useSidebarProjects } from "./data";
import { saveOrder } from "./yourOrder";

vi.hoisted(() => {
  (window as unknown as { fleetd: object }).fleetd = { platform: "linux", fixture: null };
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
