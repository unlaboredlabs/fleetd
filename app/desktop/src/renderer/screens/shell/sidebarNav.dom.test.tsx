// @vitest-environment happy-dom
// The sidebar's rows under the lists: Status, Factory and Settings, with no Administration row (D211). Time is the
// Factory's Agent time tab and Machines is reached from the hub's footer row, so neither has a row of its own.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
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

const mount = (o: { admin?: boolean; factory?: boolean; screen?: Routed } = {}) =>
  act(() =>
    root.render(
      <UiProvider>
        <DataProvider layer={createDataLayer(hub)}>
          <Sidebar
            projects={[]}
            screen={o.screen ?? { id: "status", at: "hub" }}
            jumpHints={false}
            collapsed={new Set()}
            onToggleHub={() => undefined}
            factory={o.factory ?? true}
            admin={o.admin ?? false}
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

/** The last section's rows: the nav rows, by label. */
const navRows = (): HTMLElement[] => [...([...host.querySelectorAll("section")].at(-1)?.querySelectorAll<HTMLElement>("button") ?? [])];
const labels = () => navRows().map((b) => b.querySelector("[class*=sidebarLabel]")?.textContent ?? b.textContent);
const row = (label: string): HTMLElement => {
  const found = navRows().find((b) => b.textContent.startsWith(label));
  if (found === undefined) throw new Error(`no ${label} in: ${labels().join(", ")}`);
  return found;
};

describe("the sidebar's rows", () => {
  it("are Status, Factory and Settings, with no Time or Machines", () => {
    mount();
    expect(labels()).toEqual(["Status", "Factory", "Settings"]);
    expect(host.textContent).not.toContain("Time");
    expect(host.textContent).not.toContain("Machines");
  });

  it("end with Settings for an admin too: the hub's pages are Settings' Hub group", () => {
    mount({ admin: true });
    expect(labels()).toEqual(["Status", "Factory", "Settings"]);
  });

  it("open the Factory on Output, and on Agent time for a hub without metrics", () => {
    mount();
    act(() => row("Factory").click());
    act(() => row("Settings").click());
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
    expect(row("Status").getAttribute("aria-current")).toBeNull();
  });
});
