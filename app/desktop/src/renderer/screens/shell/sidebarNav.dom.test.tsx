// @vitest-environment happy-dom
// The places to go at the sidebar's foot (W530): Screens and Factory as round buttons beside your name, and Settings in
// the card your name opens, with no Administration row (D211). Time is the Factory's Agent time tab and Machines is
// reached from the hub's card, so neither has a place of its own.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { live, snapshot } from "../../src/data/fixtures.test-util";
import { UiProvider } from "../../ui";
import type { Routed } from "./navigation";
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

let host: HTMLDivElement;
let root: Root;
let went: Screen[];

const hub: HubApi = {
  call: () => Promise.resolve({ ok: true, output: {} }),
  subscribe: () => () => undefined,
  resync: () => Promise.resolve(),
  focus: () => Promise.resolve(),
  chat: () => Promise.resolve(),
};

const mount = (o: { factory?: boolean; screen?: Routed } = {}) =>
  act(() =>
    root.render(
      <UiProvider>
        <DataProvider layer={createDataLayer(hub)}>
          <Sidebar
            projects={[]}
            screen={o.screen ?? { id: "home", at: "hub" }}
            jumpHints={false}
            collapsed={new Set()}
            onToggleHub={() => undefined}
            factory={o.factory ?? true}
            go={(s) => went.push(s)}
          />
        </DataProvider>
      </UiProvider>,
    ),
  );

beforeEach(() => {
  went = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/** The foot's round buttons, by their names. */
const navRows = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>("[class*=tools] button")];
const labels = () => navRows().map((b) => b.getAttribute("aria-label") ?? "");
const row = (label: string): HTMLElement => {
  const found = navRows().find((b) => b.getAttribute("aria-label")?.startsWith(label) === true);
  if (found === undefined) throw new Error(`no ${label} in: ${labels().join(", ")}`);
  return found;
};
/** Opens the card under your name and picks Settings. */
const settings = () => {
  act(() => host.querySelector<HTMLElement>("[data-opens='you']")?.click());
  act(() => document.querySelector<HTMLElement>("[aria-label='You'] [data-opens='settings']")?.click());
};

describe("the sidebar's places", () => {
  it("are Screens and Factory, with no Status, Time or Machines", () => {
    mount();
    expect(labels()).toEqual(["Screens", "Factory"]);
    expect(host.textContent).not.toMatch(/Status|Time|Machines/u);
  });

  it("open the Factory on Output, Settings from your card, and the Agent time for a hub without metrics", () => {
    mount();
    act(() => row("Factory").click());
    settings();
    expect(went).toEqual([
      { id: "factory", project: null },
      { id: "settings", tab: "general" },
    ]);
    went = [];
    mount({ factory: false });
    act(() => row("Factory").click());
    expect(went).toEqual([{ id: "time", orderId: null }]);
  });

  it("mark the Factory as the page you're on from either tab", () => {
    mount({ screen: { id: "time", orderId: "W8", at: "hub" } });
    expect(row("Factory").getAttribute("aria-current")).toBe("page");
    mount({ screen: { id: "factory", project: null, at: "hub" } });
    expect(row("Factory").getAttribute("aria-current")).toBe("page");
    expect(row("Screens").getAttribute("aria-current")).toBeNull();
  });
});

describe("the Screens button", () => {
  const counted = async (count: { live: number; asking: number }, features: readonly string[] = ["browser_sessions", "screen_thumbs"]) => {
    const calls: string[] = [];
    let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;
    const counting: HubApi = {
      ...hub,
      call: (tool) => {
        calls.push(tool);
        return Promise.resolve({ ok: true, output: tool === "screens_count" ? count : {} });
      },
      subscribe: (l) => ((send = l), () => undefined),
    };
    act(() =>
      root.render(
        <UiProvider>
          <DataProvider layer={createDataLayer(counting)}>
            <Sidebar projects={[]} screen={{ id: "home", at: "hub" }} jumpHints={false} collapsed={new Set()} onToggleHub={() => undefined} factory go={(s) => went.push(s)} />
          </DataProvider>
        </UiProvider>,
      ),
    );
    act(() => {
      send(live(features));
      send(snapshot(1));
    });
    for (let i = 0; i < 6; i++) await act(() => new Promise((done) => setTimeout(done, 0)));
    return calls;
  };

  it("says how many are live from one hub-wide count, never a project's list", async () => {
    const calls = await counted({ live: 3, asking: 0 });
    expect(row("Screens").getAttribute("aria-label")).toBe("Screens · 3 live");
    expect(calls.filter((t) => t === "screens_count")).toHaveLength(1);
    expect(calls).not.toContain("browser_sessions");
  });

  it("is marked when one asks for you", async () => {
    await counted({ live: 3, asking: 1 });
    expect(row("Screens").getAttribute("aria-label")).toBe("Screens · 3 live: one needs you");
    expect(row("Screens").querySelector("[class*=roundMark]")).not.toBeNull();
  });

  it("asks a hub without the count for nothing", async () => {
    const calls = await counted({ live: 3, asking: 1 }, ["browser_sessions"]);
    expect(row("Screens").getAttribute("aria-label")).toBe("Screens");
    expect(row("Screens").querySelector("[class*=roundMark]")).toBeNull();
    expect(calls).not.toContain("screens_count");
    expect(calls).not.toContain("browser_sessions");
  });
});
