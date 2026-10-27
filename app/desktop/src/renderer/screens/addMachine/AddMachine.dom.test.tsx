// @vitest-environment happy-dom
// Add machine: the three ways in, a host the hub can reach planned, added with its live steps, a failed step with
// its output and Retry, this computer joined by main, and any other machine's paste line from waiting to joined.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Machine, MachineAddRun, MachineHost, MachineLive } from "../../../shared/contracts";
import type { HubFrame } from "../../../shared/hub";
import type { JoinHere, ThisComputer } from "../../../shared/joinHere";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { AddMachine, type View } from "./AddMachine";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const joinListeners = new Set<(j: JoinHere) => void>();
const joinHere = vi.fn((_machineId: string) => Promise.resolve<JoinHere | null>(null));
let hostName = "laptop";
let computer: ThisComputer = { kind: "none" };
/** hub_info's answer, when a test holds it back. */
let hubInfo: Promise<{ ok: true; output: unknown }> | undefined;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});
Object.assign(window, {
  fleetd: {
    platform: "linux",
    system: { hostName: () => Promise.resolve(hostName) },
    machines: {
      joinHere: (_hub: string, id: string) => joinHere(id),
      joinHereState: () => Promise.resolve(null),
      thisComputer: () => Promise.resolve(computer),
      onJoinHere: (_hub: string, l: (j: JoinHere) => void) => (joinListeners.add(l), () => joinListeners.delete(l)),
    },
  },
});

const AT = "2026-10-26T10:00:00.000Z";
/** The fingerprint hub_info gives for the hub's own computer. */
const HUB_FP = "a".repeat(64);
const HOSTS: MachineHost[] = [
  { machineId: "devbox", source: "hub", joined: true },
  { machineId: "mac-mini", host: "mac-mini.tail1234.ts.net", source: "tailnet", joined: true },
  { machineId: "builder-1", host: "builder-1", source: "ssh_config", joined: false },
];
const step = (title: string, state: "planned" | "running" | "done" | "failed", extra: object = {}) => ({ title, state, ...extra });
const PLAN = [
  step("create fleetd's directories", "planned", { command: "mkdir -p '/home/ada/.fleetd/node'" }),
  step("install fleetd 0.9.0", "planned", { command: "cat > '/home/ada/.fleetd/bin/fleetd.fleetd-tmp'", stdin: "stdin: the fleetd binary (31 MB)" }),
  step("write the node service", "planned"),
  step("enroll the node with a one-time token (sent on stdin)", "planned"),
  step("(re)start the node", "planned"),
  step("waiting until builder-1 is online (up to 2 min)", "planned"),
];
const run = (over: Partial<MachineAddRun>): MachineAddRun => ({
  runId: "M0123456789abcdef0123456789abcdef",
  machineId: "builder-1",
  host: "builder-1",
  state: "running",
  steps: [],
  notes: [],
  startedAt: AT,
  ...over,
});
const RUNNING = run({
  steps: [step("read the machine's state (read-only)", "done"), step("create fleetd's directories", "done"), step("install fleetd 0.9.0", "running"), ...PLAN.slice(2)],
});
const FAILED = run({
  state: "failed",
  steps: [
    step("read the machine's state (read-only)", "done"),
    step("create fleetd's directories", "done"),
    step("install fleetd 0.9.0", "done"),
    step("write the node service", "failed", { output: "mkdir: cannot create directory: Permission denied" }),
    ...PLAN.slice(3),
  ],
  message: "step 3 failed (exit 1):\nmkdir: cannot create directory: Permission denied",
  fix: "fix that, then run fleetd machine add builder-1; finished steps are skipped.",
  finishedAt: AT,
});

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ tool: string; input: unknown }>;
let runs: MachineAddRun[];
/** machine_join's code expiry. */
let expiresAt: string;
/** The hub's frames, for a test to send more. */
let send: (frame: HubFrame) => void = () => undefined;
const LINE = "curl -fsSL https://fleetd.sh | sh -s -- --join http://devbox.example.ts.net:4790 --code K7Q2-M4XP --machine-id laptop";

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  calls = [];
  runs = [];
  hostName = "laptop";
  computer = { kind: "none" };
  hubInfo = undefined;
  expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  joinHere.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

const render = async (open?: { view: View; at: number }) => {
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input });
      if (tool === "hub_info" && hubInfo !== undefined) return hubInfo;
      const output =
        tool === "hub_info"
          ? { version: "0.9.0", protocol: 1, busy: [], admin: true, machineFingerprint: HUB_FP }
          : tool === "machine_hosts"
          ? { hosts: HOSTS }
          : tool === "machine_add_status"
            ? { runs }
            : tool === "machine_add_plan"
              ? { machineId: "builder-1", host: "builder-1", platform: "linux-x64", steps: PLAN, notes: ["linger is no for ada, so the node stops when ada logs out. Fix: sudo loginctl enable-linger ada"], joined: false }
              : tool === "machine_add"
                ? ((runs = [run({ runId: "Mfedcba9876543210fedcba9876543210", steps: [step("read the machine's state (read-only)", "running")] }), ...runs]), { run: runs[0] })
                : tool === "machine_join"
                  ? {
                      machineId: (input as { machineId: string }).machineId,
                      hubUrl: "http://devbox.example.ts.net:4790",
                      code: "K7Q2-M4XP",
                      expiresAt,
                      gitIdentity: "ada-lovelace <1+ada-lovelace@users.noreply.github.com>",
                      line: (input as { rejoin?: boolean }).rejoin ? `${LINE} --rejoin` : LINE,
                    }
                  : {};
      return Promise.resolve({ ok: true, output });
    },
    subscribe: (l) => ((listener = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  await act(async () => {
    root.render(
      <UiProvider>
        <DataProvider layer={createDataLayer(hub)}>
          <AddMachine open={open} />
        </DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  send = listener;
  await act(async () => {
    listener({ t: "state", state: { phase: "live", hub: "devbox:4790", protocol: 1 } });
    listener({ t: "snapshot", snapshot: { cursor: 1, attention: [], machines: [{ machineId: "devbox", name: "devbox", nodeVersion: "1", status: "online", lastSeenAt: AT, tags: [] }], projects: [] } });
    await new Promise((r) => setTimeout(r, 0));
  });
  await settle();
};

const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === text);
const click = async (text: string) => {
  const b = button(text);
  if (b === undefined) throw new Error(`no button "${text}" in: ${host.textContent}`);
  await act(async () => {
    b.click();
    await Promise.resolve();
  });
  await settle();
};
const state = () => host.querySelector("section[aria-label='Add machine']")?.getAttribute("data-state");
const steps = () => [...host.querySelectorAll("ol[aria-label='Steps'] li")].map((li) => `${li.getAttribute("data-step")} ${li.querySelector("span, p, div")?.textContent ?? ""}`);

it("offers this computer, a machine the hub can reach, and any other machine", async () => {
  await render();
  expect(state()).toBe("choose");
  expect(host.textContent).toContain("This computer");
  expect(host.textContent).toContain("laptop: downloads the hub's fleetd for this computer");
  expect(host.textContent).toContain("A machine the hub can reach");
  expect(host.textContent).toContain("Any other machine");
  expect(button("Get the line…")?.disabled).toBe(false);
});

const typeName = async (name: string) => {
  const input = host.querySelector<HTMLInputElement>("form[aria-label='Name the machine'] input");
  if (input === null) throw new Error("no name field");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, name);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};
const waitLine = () => host.querySelector("[data-line]");
const snapshot = (machines: Machine[]) =>
  act(async () => {
    send({ t: "snapshot", snapshot: { cursor: 2, attention: [], machines, projects: [] } });
    await new Promise((r) => setTimeout(r, 0));
  });
const DEVBOX: Machine = { machineId: "devbox", name: "devbox", nodeVersion: "1", status: "online", lastSeenAt: AT, tags: [] };

it("gives any other machine one line to paste, and turns its wait into Joined once its node is online", async () => {
  await render();
  await click("Get the line…");
  expect(state()).toBe("line");
  await typeName("Laptop!");
  await click("Make the line");
  expect(host.textContent).toContain("Lower-case letters, digits and dashes");
  expect(calls.some((c) => c.tool === "machine_join")).toBe(false);
  await typeName("devbox");
  await click("Make the line");
  expect(host.textContent).toContain("devbox is a machine already: Repair it from the list.");
  await typeName("laptop");
  await click("Make the line");
  expect(calls.filter((c) => c.tool === "machine_join").map((c) => c.input)).toEqual([{ machineId: "laptop" }]);
  expect(host.querySelector("[aria-label='The line'] code")?.textContent).toBe(LINE);
  expect(host.textContent).toContain("The code works once, until");
  expect(host.textContent).toContain("committing as ada-lovelace <1+ada-lovelace@users.noreply.github.com>");
  expect(button("Copy")).toBeDefined();
  expect(waitLine()?.getAttribute("data-line")).toBe("waiting");
  expect(waitLine()?.textContent).toBe("Waiting for laptop…");
  expect(button("Open laptop")).toBeUndefined();

  await snapshot([DEVBOX, { ...DEVBOX, machineId: "laptop", name: "laptop" }]);
  expect(waitLine()?.getAttribute("data-line")).toBe("joined");
  expect(waitLine()?.textContent).toBe("laptop joined.");
  await click("Open laptop");
  expect(window.location.hash).toBe("#/admin/machines/laptop");
});

it("says when the code expired before the line ran, and makes a new one", async () => {
  expiresAt = new Date(Date.now() - 1000).toISOString();
  await render();
  await click("Get the line…");
  await typeName("laptop");
  await click("Make the line");
  expect(waitLine()?.getAttribute("data-line")).toBe("expired");
  expect(host.textContent).toContain("The code expired before the line ran. Make a new one.");
  expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  await click("Make a new line");
  expect(calls.filter((c) => c.tool === "machine_join")).toHaveLength(2);
  expect(waitLine()?.getAttribute("data-line")).toBe("waiting");
});

it("repairs a machine that joined by itself with a line that enrolls it again, made at once", async () => {
  await render({ view: { kind: "line", machineId: "laptop", rejoin: true }, at: 1 });
  expect(state()).toBe("line");
  expect(host.textContent).toContain("Repair laptop");
  expect(host.querySelector("form[aria-label='Name the machine']")).toBeNull();
  expect(calls.filter((c) => c.tool === "machine_join").map((c) => c.input)).toEqual([{ machineId: "laptop", rejoin: true }]);
  expect(host.querySelector("[aria-label='The line'] code")?.textContent).toBe(`${LINE} --rejoin`);
  expect(waitLine()?.textContent).toBe("Waiting for laptop…");
});

it("plans a host the hub can reach, adds it and follows its steps", async () => {
  await render();
  await click("Choose…");
  expect(state()).toBe("hosts");
  // Not yet a machine first; the hub's own and mac-mini are machines already.
  const names = [...host.querySelectorAll("ul[aria-label='Hosts'] li")].map((li) => li.textContent);
  expect(names[0]).toContain("builder-1");
  expect(names[2]).toContain("mac-mini.tail1234.ts.net · tailnet · a machine already");
  await click("Plan…");
  expect(state()).toBe("plan");
  expect(calls.find((c) => c.tool === "machine_add_plan")?.input).toEqual({ host: "builder-1" });
  expect(host.textContent).toContain("linux-x64 · ~/.ssh/config. Nothing has changed on it yet.");
  expect(host.textContent).toContain("Install fleetd 0.9.0");
  expect(host.textContent).toContain("sudo loginctl enable-linger ada");
  await click("Add builder-1");
  expect(calls.find((c) => c.tool === "machine_add")?.input).toEqual({ host: "builder-1" });
  expect(state()).toBe("run");
  expect(host.textContent).toContain("Adding builder-1.");
  expect(button("Retry")).toBeUndefined();
});

it("opens on a run still going, step by step", async () => {
  runs = [RUNNING];
  await render();
  expect(state()).toBe("run");
  expect(steps().map((x) => x.split(" ")[0])).toEqual(["done", "done", "running", "planned", "planned", "planned", "planned"]);
});

it("shows a failed step's output and retries the same host", async () => {
  runs = [FAILED];
  await render();
  expect(state()).toBe("run");
  expect(host.querySelector("li[data-step='failed'] pre")?.textContent).toContain("Permission denied");
  expect(host.textContent).toContain("Couldn't add builder-1.");
  expect(host.textContent).toContain("finished steps are skipped");
  await click("Retry");
  expect(calls.filter((c) => c.tool === "machine_add").map((c) => c.input)).toEqual([{ host: "builder-1" }]);
  expect(host.textContent).toContain("Adding builder-1.");
});

it("adds the hub's own machine through the hub, and any other computer through main", async () => {
  hostName = "devbox";
  computer = { kind: "hub", fingerprint: HUB_FP };
  await render();
  expect(host.textContent).toContain("devbox is a machine of this hub already");
  await click("Repair");
  expect(calls.find((c) => c.tool === "machine_add")?.input).toEqual({ local: true });
  expect(joinHere).not.toHaveBeenCalled();

  act(() => root.unmount());
  root = createRoot(host);
  hostName = "laptop";
  computer = { kind: "none" };
  calls = [];
  runs = [];
  await render();
  await click("Add this computer");
  expect(joinHere).toHaveBeenCalledWith("laptop");
  expect(calls.some((c) => c.tool === "machine_add")).toBe(false);
  await act(async () => {
    for (const l of joinListeners)
      l({
        machineId: "laptop",
        state: "failed",
        steps: [
          { title: "get a one-time code from the hub", state: "done" },
          { title: "download fleetd-linux-x64", state: "done" },
          { title: "check it against the release's SHA256SUMS", state: "failed" },
          { title: "put it in place", state: "planned" },
          { title: "enroll the node and start its service", state: "planned" },
        ],
        message: "fleetd-linux-x64 doesn't match SHA256SUMS; nothing was installed.",
      });
    await Promise.resolve();
  });
  expect(state()).toBe("here");
  expect(host.textContent).toContain("doesn't match SHA256SUMS");
  expect(steps().map((x) => x.split(" ")[0])).toEqual(["done", "done", "failed", "planned", "planned", "planned"]);
  await click("Retry");
  expect(joinHere).toHaveBeenCalledTimes(2);
});

it("adds the hub's machine through the hub even when its name doesn't match, and never joins an enrolled node", async () => {
  // The hub's machine, added as devbox, now named studio-2: its fleetd dir holds this very hub.
  hostName = "studio-2";
  computer = { kind: "hub", fingerprint: HUB_FP };
  await render();
  expect(host.textContent).toContain("devbox is a machine of this hub already");
  await click("Repair");
  expect(calls.find((c) => c.tool === "machine_add")?.input).toEqual({ local: true });
  expect(joinHere).not.toHaveBeenCalled();

  act(() => root.unmount());
  root = createRoot(host);
  calls = [];
  runs = [];
  computer = { kind: "node", machineId: "studio", hub: "http://devbox:4790" };
  await render();
  expect(host.textContent).toContain("This computer is already part of another hub (http://devbox:4790) as studio.");
  expect(button("Add this computer")).toBeUndefined();
  expect(button("Repair")).toBeUndefined();
  expect(joinHere).not.toHaveBeenCalled();
});

it("adds nothing on a computer that runs a different hub", async () => {
  computer = { kind: "hub", fingerprint: "b".repeat(64) };
  await render();
  expect(host.textContent).toContain("This computer runs a different hub, so it can't be one of this hub's machines.");
  expect(button("Add this computer")).toBeUndefined();
  expect(button("Repair")).toBeUndefined();
  expect(calls.some((c) => c.tool === "machine_add")).toBe(false);
  expect(joinHere).not.toHaveBeenCalled();
});

it("reads this computer again once its join ends, so it never offers a stale Repair", async () => {
  await render();
  await click("Add this computer");
  // The node is enrolled now: main's next read finds it.
  computer = { kind: "node", machineId: "laptop", hub: "http://devbox:4790" };
  await act(async () => {
    for (const l of joinListeners)
      l({ machineId: "laptop", state: "done", steps: [{ title: "enroll the node and start its service", state: "done" }] });
    await Promise.resolve();
  });
  await settle();
  await click("Done");
  expect(state()).toBe("choose");
  expect(host.textContent).toContain("This computer is already part of");
  expect(host.textContent).toContain("as laptop.");
  expect(button("Repair")).toBeUndefined();
  expect(button("Add this computer")).toBeUndefined();
});

it("decides nothing about this computer before the hub says which computer it runs on", async () => {
  let answer: (v: { ok: true; output: unknown }) => void = () => undefined;
  hubInfo = new Promise((resolve) => (answer = resolve));
  computer = { kind: "none", fingerprint: HUB_FP };
  await render();
  expect(host.textContent).toContain("Looking at this computer…");
  expect(button("Add this computer")?.disabled).toBe(true);
  await act(async () => {
    answer({ ok: true, output: { version: "0.9.0", protocol: 1, busy: [], admin: true, machineFingerprint: HUB_FP } });
    await Promise.resolve();
  });
  await settle();
  // It is the hub's own computer: the hub repairs it, nothing is joined.
  expect(host.textContent).toContain("devbox is a machine of this hub already");
  await click("Repair");
  expect(calls.find((c) => c.tool === "machine_add")?.input).toEqual({ local: true });
  expect(joinHere).not.toHaveBeenCalled();
});

const live = (machines: MachineLive[]) =>
  act(async () => {
    send({ t: "live", frame: { at: AT, full: false, lanes: [], machines } });
    await new Promise((r) => setTimeout(r, 0));
  });
const devboxLive = (linkedSince: string): MachineLive => ({ machineId: "devbox", name: "devbox", status: "online", running: 0, asOf: AT, linkedSince });

it("waits on a repair of a machine still online until its node links again, then says it joined", async () => {
  await render({ view: { kind: "line", machineId: "devbox", rejoin: true }, at: 1 });
  await live([devboxLive("2026-10-26T09:00:00.000Z")]);
  expect(waitLine()?.getAttribute("data-line")).toBe("online");
  expect(waitLine()?.textContent).toContain("devbox is online on its old enrollment.");
  expect(button("Open devbox")).toBeUndefined();
  // The hub's link to its node is the same: nothing ran yet.
  await live([{ ...devboxLive("2026-10-26T09:00:00.000Z"), asOf: "2026-10-26T10:00:15.000Z" }]);
  expect(waitLine()?.getAttribute("data-line")).toBe("online");
  // A quick restart: the hub never shows it offline, but its link is new.
  await live([devboxLive("2026-10-26T10:00:20.000Z")]);
  expect(waitLine()?.getAttribute("data-line")).toBe("joined");
  expect(button("Open devbox")).toBeDefined();
});
