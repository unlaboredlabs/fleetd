// @vitest-environment happy-dom
// Removing a project left over from a machine the hub no longer has (`worker`): the dialog says it only forgets the
// project in fleetd, and sends no worktree or folder removal, since no machine holds its files.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { live, snapshot } from "../../src/data/fixtures.test-util";
import { RemoveProjectDialog, type RemoveTarget } from "./RemoveProjectDialog";

vi.hoisted(() => vi.stubGlobal("fleetd", { platform: "linux", fixture: null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ tool: string; input: unknown }>;

beforeEach(() => {
  calls = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function open(target: RemoveTarget) {
  let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => (calls.push({ tool, input }), Promise.resolve({ ok: true, output: { ok: true } })),
    subscribe: (l) => ((send = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  act(() => {
    root.render(
      <DataProvider layer={createDataLayer(hub)}>
        <RemoveProjectDialog project={target} onClose={() => undefined} />
      </DataProvider>,
    );
  });
  // The hub's snapshot lists devbox alone.
  await act(async () => {
    send(live());
    send(snapshot(1));
    await Promise.resolve();
  });
}

const dialog = () => document.querySelector("[role='dialog']");
const button = (label: string) => [...(dialog()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => b.textContent === label);

it("a project on a removed machine is only forgotten in fleetd", async () => {
  await open({
    machineId: "worker",
    projectId: "fleetd",
    title: "fleetd",
    path: "/home/dev/src/fleetd",
    deleting: { unsaved: [{ path: "/home/dev/.fleetd/node/worktrees/fleetd/t1" }] },
  });
  expect(dialog()?.textContent).toContain("Forget fleetd?");
  expect(dialog()?.textContent).toContain("worker is no longer in this hub, so no machine holds its files");
  expect(dialog()?.textContent).not.toContain("uncommitted");
  expect(dialog()?.querySelector("input")).toBeNull();
  await act(async () => {
    button("Forget project")?.click();
    await new Promise((done) => setTimeout(done, 0));
  });
  expect(calls.filter((c) => c.tool === "project_remove").map((c) => c.input)).toEqual([{ machineId: "worker", projectId: "fleetd" }]);
});

it("a project on a machine the hub has is removed from it, as before", async () => {
  await open({ machineId: "devbox", projectId: "storefront", title: "storefront", path: "/srv/storefront" });
  expect(dialog()?.textContent).toContain("Remove storefront from devbox?");
  expect(button("Remove project")).toBeDefined();
});
