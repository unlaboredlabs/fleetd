// @vitest-environment happy-dom
// #/navi: the first run says what Navi is and has one button, which makes a Navi (called Navi when unnamed) and opens
// its chat once the hub has added it; with Navis, the list and the archived ones, each a click from coming back.
// With more than one machine it could live on, a choice of them, each with its Navi sandbox: a missing one can't be
// picked. Asked work, in a Navi's panel: each ask with its orders, or a plain sentence on a hub that doesn't serve it.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetStatus, MachineRolesEntry, MachineRolesOutput, NaviAsksOutput, ProjectSummary } from "../../../shared/contracts";
import type { CallOutcome, HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { AT, live } from "../../src/data/fixtures.test-util";
import { UiProvider } from "../../ui";
import { AskedPane } from "./AskedPane";
import { NaviScreen } from "./NaviScreen";

const went = vi.hoisted(() => [] as unknown[]);
vi.mock("../shell/navigation", () => ({ navigate: (s: unknown) => went.push(s) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const summary = (title: string, extra: Partial<ProjectSummary> = {}): ProjectSummary => ({
  machineId: "devbox",
  projectId: title.toLowerCase(),
  title,
  workspaceRoot: `/home/dev/${title.toLowerCase()}`,
  lastActivityAt: AT,
  threads: { running: 0, waiting: 0, idle: 0, failed: 0 },
  ...extra,
});
const STOREFRONT = summary("storefront");
const ADA = summary("Ada", { kind: "assistant" });
const TAXES = summary("Taxes", { kind: "assistant", archivedAt: AT });

const snapshot = (cursor: number, projects: ProjectSummary[]): HubFrame => {
  const snap: FleetStatus = {
    cursor,
    attention: [],
    machines: [{ machineId: "devbox", name: "devbox", nodeVersion: "1", status: "online", lastSeenAt: AT, tags: [] }],
    projects,
  };
  return { t: "snapshot", snapshot: snap };
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  went.length = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const settle = async () => {
  for (let i = 0; i < 6; i++) await act(() => new Promise((done) => setTimeout(done, 0)));
};

const mount = async (ui: React.ReactNode, projects: ProjectSummary[], answer: (tool: string, input: unknown) => CallOutcome | undefined = () => undefined, features?: string[]) => {
  let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;
  const calls: { tool: string; input: unknown }[] = [];
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input });
      return Promise.resolve(answer(tool, input) ?? { ok: true, output: {} });
    },
    subscribe: (l) => ((send = l), () => undefined),
    resync: () => (calls.push({ tool: "resync", input: undefined }), Promise.resolve()),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  act(() => {
    root.render(
      <UiProvider>
        <DataProvider layer={createDataLayer(hub)}>{ui}</DataProvider>
      </UiProvider>,
    );
  });
  act(() => {
    send(live(features));
    send(snapshot(1, projects));
  });
  await settle();
  return { calls, send: (f: HubFrame) => act(() => send(f)) };
};

const screen = () => host.querySelector("[data-screen]")?.getAttribute("data-screen");
const buttons = () => [...host.querySelectorAll("button")].map((b) => b.textContent.trim());
const button = (name: string): HTMLButtonElement => {
  const b = [...host.querySelectorAll("button")].find((x) => x.textContent.trim() === name);
  if (b === undefined) throw new Error(`no button ${name} in: ${buttons().join(" | ")}`);
  return b;
};

describe("Navi's first run", () => {
  it("says what Navi does and what it asks first, with one button", async () => {
    await mount(<NaviScreen />, [STOREFRONT]);
    expect(screen()).toBe("navi.empty");
    expect(host.textContent).toContain("Meet Navi");
    expect(host.textContent).toContain("never sends, posts, pays or deletes without asking you first");
    expect(buttons()).toEqual(["Create your Navi"]);
  });

  it("makes a Navi called Navi when unnamed, and opens its chat once the hub has added it", async () => {
    const made = summary("Navi", { kind: "assistant", projectId: "navi" });
    const { calls, send } = await mount(<NaviScreen />, [STOREFRONT], (tool) => (tool === "navi_create" ? { ok: true, output: { navi: made } } : undefined));
    act(() => button("Create your Navi").click());
    await settle();
    expect(calls.filter((c) => c.tool === "navi_create")).toEqual([{ tool: "navi_create", input: { name: "Navi" } }]);
    expect(button("Creating…").disabled).toBe(true);
    expect(went).toEqual([]);
    // project.added, then the resync's snapshot with it.
    send(snapshot(2, [STOREFRONT, made]));
    await settle();
    expect(went).toEqual([{ id: "project", project: { machineId: "devbox", projectId: "navi" }, message: null }]);
  });

  it("never stays on Creating…: it reads the projects again, then opens the Navi from the create call's reply", async () => {
    const made = summary("Navi", { kind: "assistant", projectId: "navi" });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { calls } = await mount(<NaviScreen />, [STOREFRONT], (tool) => (tool === "navi_create" ? { ok: true, output: { navi: made } } : undefined));
      act(() => button("Create your Navi").click());
      await settle();
      expect(button("Creating…").disabled).toBe(true);
      // The hub's word that it added it never comes.
      await act(() => vi.advanceTimersByTimeAsync(3_000));
      expect(calls.filter((c) => c.tool === "resync")).toHaveLength(1);
      expect(went).toEqual([]);
      await act(() => vi.advanceTimersByTimeAsync(5_000));
      expect(went).toEqual([{ id: "project", project: { machineId: "devbox", projectId: "navi" }, message: null }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the hub's reason when it can't make one", async () => {
    await mount(<NaviScreen />, [STOREFRONT], (tool) =>
      tool === "navi_create" ? { ok: false, error: { code: "unavailable", message: "No machine can hold a Navi yet.", fix: "Run `fleetd update` on devbox." } } : undefined,
    );
    act(() => button("Create your Navi").click());
    await settle();
    expect(host.querySelector("[role=alert]")?.textContent).toContain("No machine can hold a Navi yet.");
    expect(host.querySelector("[role=alert] code")?.textContent).toBe("fleetd update");
    // The one button tries again.
    expect(button("Retry").disabled).toBe(false);
  });
});

const machine = (machineId: string, extra: Partial<MachineRolesEntry> = {}): MachineRolesEntry => ({
  machineId,
  name: machineId,
  online: true,
  operates: true,
  roles: ["agents"],
  maxSessions: 4,
  maxSessionsWhy: "auto: 8 CPUs, 32 GB",
  sessionsLive: 0,
  hostsOthers: true,
  ...extra,
});
const MAC = machine("mac", { naviSandbox: { status: "ready", line: "Navis run in sandbox-exec." } });
const DEVBOX = machine("devbox", {
  naviSandbox: { status: "gap", line: "Navis run in bubblewrap, but this kernel can't scope abstract sockets.", fix: "Update the kernel to Linux 6.12 or later." },
});
const NO_BWRAP = { status: "missing", line: "A Navi runs only inside a sandbox, and this machine has no bubblewrap (bwrap).", fix: "Install bubblewrap on this machine." } as const;
const PI = machine("pi", { naviSandbox: NO_BWRAP });
const roles = (machines: MachineRolesEntry[], best?: string) => (tool: string) => {
  const output: MachineRolesOutput = { machines, ...(best === undefined ? {} : { best }) };
  if (tool === "machine_roles") return { ok: true as const, output };
  if (tool === "navi_create") return { ok: true as const, output: { navi: summary("Navi", { kind: "assistant", projectId: "navi" }) } };
  return undefined;
};
const radio = (name: string): HTMLButtonElement => {
  const r = [...host.querySelectorAll<HTMLButtonElement>("[role=radio]")].find((x) => x.closest("label")?.textContent.startsWith(name));
  if (r === undefined) throw new Error(`no machine ${name}`);
  return r;
};
const created = (calls: { tool: string; input: unknown }[]) => calls.filter((c) => c.tool === "navi_create").map((c) => c.input);

describe("where a new Navi lives", () => {
  it("offers no choice with one machine to put it on, and leaves it to the hub", async () => {
    // pi is offline and the person can't work on buildbox: devbox is the one machine left.
    const { calls } = await mount(<NaviScreen />, [STOREFRONT], roles([DEVBOX, machine("pi", { online: false }), machine("buildbox", { operates: false })], "devbox"));
    expect(host.querySelector("[role=radiogroup]")).toBeNull();
    act(() => button("Create your Navi").click());
    await settle();
    expect(created(calls)).toEqual([{ name: "Navi" }]);
  });

  it("starts on the machine the hub would pick, each with its sandbox, and makes it on the one picked", async () => {
    const { calls } = await mount(<NaviScreen />, [STOREFRONT], roles([DEVBOX, MAC], "mac"));
    expect(host.textContent).toContain("Lives on");
    expect(radio("mac").getAttribute("aria-checked")).toBe("true");
    expect(radio("devbox").getAttribute("aria-checked")).toBe("false");
    expect(radio("mac").closest("label")?.textContent).toContain("Navis run in sandbox-exec.");
    // A gap can be picked, with its warning and fix.
    const gap = radio("devbox").closest("label")?.textContent;
    expect(gap).toContain("can't scope abstract sockets");
    expect(gap).toContain("Update the kernel to Linux 6.12 or later.");
    expect(radio("devbox").disabled).toBe(false);
    act(() => radio("devbox").click());
    expect(radio("devbox").getAttribute("aria-checked")).toBe("true");
    act(() => button("Create your Navi").click());
    await settle();
    expect(created(calls)).toEqual([{ name: "Navi", machineId: "devbox" }]);
  });

  it("shows why a machine without a sandbox can't hold one, and its fix, and never picks it", async () => {
    // The hub's own pick has no sandbox: the choice starts on the first that has one.
    const { calls } = await mount(<NaviScreen />, [STOREFRONT], roles([PI, MAC], "pi"));
    const missing = radio("pi");
    expect(missing.disabled).toBe(true);
    expect(missing.getAttribute("aria-checked")).toBe("false");
    expect(missing.closest("label")?.textContent).toContain("has no bubblewrap (bwrap).");
    expect(missing.closest("label")?.textContent).toContain("Install bubblewrap on this machine.");
    expect(radio("mac").getAttribute("aria-checked")).toBe("true");
    act(() => missing.click());
    expect(radio("mac").getAttribute("aria-checked")).toBe("true");
    act(() => button("Create your Navi").click());
    await settle();
    expect(created(calls)).toEqual([{ name: "Navi", machineId: "mac" }]);
  });

  it("can't create while no machine has a sandbox", async () => {
    const { calls } = await mount(<NaviScreen />, [STOREFRONT], roles([PI, machine("pi2", { naviSandbox: NO_BWRAP })]));
    expect(button("Create your Navi").disabled).toBe(true);
    expect(created(calls)).toEqual([]);
  });
});

describe("with Navis", () => {
  it("lists only the person's own: a teammate's Navi isn't theirs to see", async () => {
    const me = { personId: "p_aaaaaaaa", name: "Alex", role: "member", createdAt: AT };
    const theirs = summary("Bee", { kind: "assistant", owner: "p_bbbbbbbb" });
    const mine = summary("Cal", { kind: "assistant", owner: me.personId });
    const old = summary("Dot", { kind: "assistant", archivedAt: AT, owner: "p_bbbbbbbb" });
    await mount(<NaviScreen />, [STOREFRONT, ADA, theirs, mine, old], (tool) => (tool === "hub_info" ? { ok: true, output: { version: "1", protocol: 1, busy: [], me } } : undefined));
    // Ada, from before people, and Cal are Alex's; Bee and the archived Dot are Bea's.
    const listed = host.querySelector("[aria-label='Your Navis']")?.textContent;
    expect(listed).toContain("Ada");
    expect(listed).toContain("Cal");
    expect(host.textContent).not.toContain("Bee");
    expect(host.textContent).not.toContain("Dot");
  });

  it("lists them with the archived ones, which come back in a click", async () => {
    const { calls } = await mount(<NaviScreen />, [STOREFRONT, ADA, TAXES]);
    expect(screen()).toBe("navi");
    expect(host.querySelector("[aria-label='Your Navis']")?.textContent).toContain("AdaOn devbox");
    expect(host.querySelector("[aria-label='Archived']")?.textContent).toContain("Taxes");
    act(() => button("Bring back").click());
    await settle();
    expect(calls).toContainEqual({ tool: "navi_archive", input: { machineId: "devbox", projectId: "taxes", archived: false } });
    act(() => button("AdaOn devbox").click());
    expect(went).toEqual([{ id: "project", project: { machineId: "devbox", projectId: "ada" }, message: null }]);
  });
});

const READ: NaviAsksOutput = {
  navi: { machineId: "devbox", projectId: "ada" },
  asks: [
    {
      handle: "N4",
      to: { machineId: "devbox", projectId: "billing" },
      toTitle: "billing",
      text: "Is the usage report ready?",
      at: AT,
      orders: [],
    },
    {
      handle: "N3",
      to: { machineId: "devbox", projectId: "storefront" },
      toTitle: "storefront",
      text: "Let people save their cart.",
      at: AT,
      orders: [
        { workstreamId: "W12", title: "Saved carts", state: "open", headline: "A writer adds the table." },
        { workstreamId: "W9", title: "Cart cleanup", state: "done", headline: "Merged #40." },
      ],
    },
  ],
};

describe("Asked work", () => {
  it("reads navi_asks for this Navi and shows each ask with its orders, in the hub's order, linking to the project", async () => {
    const { calls } = await mount(<AskedPane project={{ machineId: "devbox", projectId: "ada" }} />, [STOREFRONT, ADA], (tool) => (tool === "navi_asks" ? { ok: true, output: READ } : undefined), ["navi_asks"]);
    expect(calls).toContainEqual({ tool: "navi_asks", input: { navi: { machineId: "devbox", projectId: "ada" } } });
    expect(screen()).toBe("asked");
    expect([...host.querySelectorAll("[data-ask]")].map((a) => a.getAttribute("data-ask"))).toEqual(["N4", "N3"]);
    expect(host.querySelector("[data-ask=N4]")?.textContent).toContain("No order opened for it yet");
    const ask = host.querySelector("[data-ask=N3]");
    expect(ask?.textContent).toContain("Let people save their cart.");
    expect(ask?.textContent).toContain("W12Saved cartsIn progress");
    expect(ask?.textContent).toContain("A writer adds the table.");
    // A finished order says so, without its last headline.
    expect(ask?.textContent).toContain("W9Cart cleanupDone");
    expect(ask?.textContent).not.toContain("Merged #40.");
    act(() => button("storefront").click());
    expect(went).toEqual([{ id: "project", project: { machineId: "devbox", projectId: "storefront" }, message: null }]);
  });

  it("says plainly when the hub doesn't serve it, and asks nothing", async () => {
    const { calls } = await mount(<AskedPane project={{ machineId: "devbox", projectId: "ada" }} />, [STOREFRONT, ADA]);
    expect(screen()).toBe("asked.unserved");
    expect(calls.map((c) => c.tool)).not.toContain("navi_asks");
  });
});
