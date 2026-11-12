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
import { resetServes } from "../admin/role";

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

/** The hub's guide for the Mac (setup step "mac"), as setup_list answers it: its parts in order. */
const macPart = (title: string, value: string) => ({ title, links: [], values: [{ label: title, value, command: true }] });
const MAC_STEP = {
  id: "mac",
  group: "hub",
  title: "A Mac for agents",
  why: "why",
  need: { kind: "optional" },
  status: "todo",
  parts: [
    macPart("Xcode, once", "sudo xcodebuild -license accept && sudo xcodebuild -runFirstLaunch"),
    macPart("Join, at the Mac's screen", "curl …"),
    macPart("Two clicks at the Mac", "open Privacy_Accessibility"),
    macPart("A Mac that runs fleetd already", "fleetd machine remove <old name>"),
    macPart("Optional: a user of its own for agents", "sudo sysadminctl -addUser agents"),
  ],
  fields: [],
  ways: [],
};

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ tool: string; input: unknown }>;
let runs: MachineAddRun[];
/** machine_join's code expiry. */
let expiresAt: string;
/** How many codes mac_code_create made, and when its next one expires. */
let macCodes = 0;
let macExpiresAt: string;
/** What mac_code_status says of the code. */
let macStatus: string | undefined;
/** How many more machine_add_plan calls the hub refuses, and what ssh said: by default, the host refused its key. */
let planRefusals = 0;
let sshSaid = "builder-1: Permission denied (publickey).";
/** The hub's frames, for a test to send more. */
let send: (frame: HubFrame) => void = () => undefined;
const LINE = "curl -fsSL https://fleetd.sh | sh -s -- --join http://devbox.example.ts.net:4790 --code K7Q2-M4XP --machine-id laptop";

beforeEach(() => {
  resetServes();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  calls = [];
  runs = [];
  hostName = "laptop";
  computer = { kind: "none" };
  hubInfo = undefined;
  expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  macCodes = 0;
  macStatus = "open";
  macExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  planRefusals = 0;
  sshSaid = "builder-1: Permission denied (publickey).";
  joinHere.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

const render = async (open?: { view: View; at: number }, page: { closed?: boolean; onClose?: () => void } = {}) => {
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input });
      if (tool === "hub_info" && hubInfo !== undefined) return hubInfo;
      if (tool === "machine_add_plan" && planRefusals > 0) {
        planRefusals -= 1;
        return Promise.resolve({
          ok: false,
          error: {
            code: "failed",
            message: `cannot read builder-1 over SSH (exit 255): ${sshSaid}`,
            fix: "make `ssh builder-1 true` work without a password (ssh-copy-id builder-1), then run fleetd machine add builder-1",
          },
        });
      }
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
                  : tool === "mac_code_status"
                    ? { state: macStatus }
                  : tool === "mac_code_create"
                    ? ((macCodes += 1), { code: macCodes === 1 ? "482913" : "107355", expiresAt: macExpiresAt, machineId: "mac", hubUrl: "http://devbox.example.ts.net:4790" })
                  : tool === "setup_list"
                    ? { steps: [MAC_STEP], requiredLeft: 0 }
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
          <AddMachine open={open} {...page} />
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
  // The hosts and runs are read once hub_info says the hub serves them.
  await settle();
  await settle();
};

const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === text);
/** Presses `text`, which starts a read the hub refuses three times, and runs its backoff of 1 s and then 2 s on the
 * fake clock: waited out for real, those 3 s took most of the test's time. */
const giveUp = async (text: string) => {
  const b = button(text);
  if (b === undefined) throw new Error(`no button "${text}" in: ${host.textContent}`);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    act(() => b.click());
    await act(() => vi.advanceTimersByTimeAsync(5_000));
  } finally {
    vi.useRealTimers();
  }
  await settle();
};

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
  expect(host.textContent).toContain("laptop: installs fleetd here and joins the hub.");
  expect(host.textContent).toContain("A machine the hub can reach");
  expect(host.textContent).toContain("Any other machine");
  expect(button("Get the line…")?.disabled).toBe(false);
});

/** hub_info as fleetd cloud answers it: no computer of the team runs the hub, and no machine is reached over SSH. */
const CLOUD_LEFT_OUT = ["hub_update", "hub_update_settings", "hub_update_status", "hub_restart", "doctor_list", "doctor_fix", "setup_list", "setup_test", "machine_add_plan", "machine_add", "machine_add_status", "machine_hosts"];

it("offers no SSH way on fleetd cloud, says how machines join there, and adds this computer with a line", async () => {
  hubInfo = Promise.resolve({ ok: true, output: { version: "0.9.0", protocol: 1, busy: [], admin: true, leftOut: CLOUD_LEFT_OUT } });
  // The app knows the hub's answer before it opens the page (Settings' Hub group waits for hub_info): a first mount
  // learns it, and the page that opens next asks nothing left out.
  await render();
  act(() => root.unmount());
  root = createRoot(host);
  calls = [];
  await render();
  expect(state()).toBe("choose");
  expect(host.textContent).not.toContain("A machine the hub can reach");
  expect(button("Choose…")).toBeUndefined();
  expect(host.textContent).toContain("Another machine");
  expect(host.textContent).toContain("On fleetd cloud, machines join this way, not over SSH.");
  // This computer joins with a line through main, as on any hub that isn't on this computer.
  expect(host.textContent).toContain("laptop: installs fleetd here and joins the hub.");
  await click("Add this computer");
  expect(joinHere).toHaveBeenCalledWith("laptop");
  expect(calls.filter((c) => c.tool.startsWith("machine_add") || c.tool === "machine_hosts" || c.tool === "setup_list")).toEqual([]);
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
  expect(window.location.hash).toBe("#/settings/hub/machines/laptop");
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

it("gives a host the hub can't log in to the command to run on the hub's machine, then tries again", async () => {
  // The query asks three times before it gives up.
  planRefusals = 3;
  await render();
  await click("Choose…");
  await giveUp("Plan…");
  expect(button("Try again")).toBeDefined();
  expect(host.textContent).toContain("Cannot read builder-1 over SSH");
  // The values row of the hub's setup guide: where, the command, and Copy.
  expect(host.querySelector("dt")?.textContent).toBe("Run on devbox");
  expect(host.querySelector("dd [data-text='code']")?.textContent).toBe("ssh-copy-id builder-1");
  expect(button("Add builder-1")).toBeUndefined();
  await click("Try again");
  await vi.waitFor(() => expect(button("Add builder-1")).toBeDefined());
  expect(host.textContent).toContain("Install fleetd 0.9.0");
});

it("says a host that didn't answer is down or unreachable, and offers no key to copy", async () => {
  planRefusals = 3;
  sshSaid = "ssh: connect to host builder-1 port 22: Connection timed out";
  await render();
  await click("Choose…");
  await giveUp("Plan…");
  expect(button("Try again")).toBeDefined();
  expect(host.querySelector("[data-ssh]")?.getAttribute("data-ssh")).toBe("unreachable");
  expect(host.querySelector("dd [data-text='code']")?.textContent).toBe("ssh builder-1 true");
  expect(host.textContent).not.toContain("ssh-copy-id");
  expect(host.textContent).toContain("check it is on and awake");
});

it("opens on a run still going, step by step", async () => {
  runs = [RUNNING];
  await render();
  expect(state()).toBe("run");
  expect(steps().map((x) => x.split(" ")[0])).toEqual(["done", "done", "running", "planned", "planned", "planned", "planned"]);
});

// Behind a page's plus (Machines), or a machine's Repair: nothing until there is something to follow.
it("shows nothing while closed", async () => {
  await render(undefined, { closed: true });
  expect(state()).toBeUndefined();
  expect(host.textContent).toBe("");
});

it("shows a run still going even while closed", async () => {
  runs = [RUNNING];
  await render(undefined, { closed: true });
  expect(state()).toBe("run");
});

it("closes the ways in from their own Close, which only a page that can close them shows", async () => {
  const onClose = vi.fn();
  await render(undefined, { onClose });
  expect(state()).toBe("choose");
  const close = host.querySelector<HTMLButtonElement>("button[aria-label='Close']");
  act(() => close?.click());
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("has no Close where nothing closes the ways in", async () => {
  await render();
  expect(state()).toBe("choose");
  expect(host.querySelector("button[aria-label='Close']")).toBeNull();
});

it("leaves on Back from a view asked for from outside, which has no ways in behind it", async () => {
  const onClose = vi.fn();
  await render({ view: { kind: "line", machineId: "laptop", rejoin: true }, at: 1 }, { closed: true, onClose });
  expect(state()).toBe("line");
  await click("Back");
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(state()).toBeUndefined();
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
          { title: "check it against the release's checksum", state: "failed" },
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
  // Then its hosts, which it serves.
  await settle();
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

it("shows A Mac for agents' 6-digit code, made once, with the hub's address, and turns its wait into joined", async () => {
  await render();
  await click("Set up…");
  expect(state()).toBe("mac");
  expect(host.querySelector("[aria-label='Setup code']")?.textContent).toContain("482 913");
  expect(host.textContent).toContain("Should the Mac ask for the hub: http://devbox.example.ts.net:4790");
  expect(host.textContent).toContain("Waiting for the Mac…");
  expect(calls.filter((c) => c.tool === "mac_code_create").map((c) => c.input)).toEqual([{ hubUrl: "devbox:4790" }]);
  // Frames and re-renders mint nothing more: one code per open view.
  await snapshot([DEVBOX]);
  expect(calls.filter((c) => c.tool === "mac_code_create")).toHaveLength(1);
  await snapshot([DEVBOX, { ...DEVBOX, machineId: "mac", name: "mac" }]);
  expect(host.textContent).toContain("mac joined. The Mac's window finishes the setup");
  await click("Open the Mac's checks");
  expect(window.location.hash).toBe("#/setup/mac");
});

it("sends a Mac that joined fleetd cloud, which has no Setup step for it, to its own page, by code or by line", async () => {
  hubInfo = Promise.resolve({ ok: true, output: { version: "0.9.0", protocol: 1, busy: [], admin: true, leftOut: CLOUD_LEFT_OUT } });
  await render();
  await click("Set up…");
  await snapshot([DEVBOX, { ...DEVBOX, machineId: "mac", name: "mac" }]);
  expect(button("Open the Mac's checks")).toBeUndefined();
  await click("Open mac");
  expect(window.location.hash).toBe("#/settings/hub/machines/mac");

  act(() => root.unmount());
  root = createRoot(host);
  await render();
  await click("Set up…");
  await click("Use Terminal instead");
  // No hub's guide, and no Setup step to point at: the user of its own is only said.
  expect(host.textContent).toContain("give them their own user.");
  expect(host.textContent).not.toContain("see Setup");
  expect(button("Open Setup")).toBeUndefined();
  await click("Make the line");
  await snapshot([DEVBOX, { ...DEVBOX, machineId: "mac", name: "mac" }]);
  expect(button("Open the Mac's checks")).toBeUndefined();
  await click("Open mac");
  expect(window.location.hash).toBe("#/settings/hub/machines/mac");
  expect(calls.some((c) => c.tool === "setup_list")).toBe(false);
});

it("says when A Mac for agents' code closed after ten wrong codes, or the Mac took it, from the hub's word", async () => {
  macStatus = "closed";
  await render();
  await click("Set up…");
  expect(calls.filter((c) => c.tool === "mac_code_status").map((c) => c.input)).toContainEqual({ code: "482913" });
  expect(host.textContent).toContain("Ten wrong codes were tried while this one was open, so it closed. Make a new one.");
  expect(host.querySelector("[aria-label='Setup code']")?.textContent).not.toContain("482 913");
  macStatus = "open";
  await click("New code");
  expect(host.querySelector("[aria-label='Setup code']")?.textContent).toContain("107 355");
  expect(host.textContent).toContain("Waiting for the Mac…");

  act(() => root.unmount());
  root = createRoot(host);
  macStatus = "used";
  await render();
  await click("Set up…");
  expect(host.textContent).toContain("The Mac took the code and is joining as mac…");
  // The Mac's join may stop short (a replace declined, a failed join): a new code is one click away meanwhile.
  expect(host.textContent).toContain("Should its window say setup stopped, make a new code.");
  macStatus = "open";
  await click("New code");
  expect(host.querySelector("[aria-label='Setup code']")?.textContent).toContain("107 355");
  expect(host.textContent).toContain("Waiting for the Mac…");
});

it("says when A Mac for agents' code expired, and makes a new one only when asked", async () => {
  macExpiresAt = new Date(Date.now() - 1000).toISOString();
  await render();
  await click("Set up…");
  expect(host.textContent).toContain("This code expired before the Mac used it");
  expect(host.querySelector("[aria-label='Setup code']")?.textContent).not.toContain("482 913");
  expect(calls.filter((c) => c.tool === "mac_code_create")).toHaveLength(1);
  macExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  await click("New code");
  expect(calls.filter((c) => c.tool === "mac_code_create")).toHaveLength(2);
  expect(host.querySelector("[aria-label='Setup code']")?.textContent).toContain("107 355");
});

it("sets up a Mac for agents in Terminal between the hub's own guide, and replaces one that is a machine already", async () => {
  await render();
  expect(host.textContent).toContain("A Mac for agents");
  await click("Set up…");
  await click("Use Terminal instead");
  expect(state()).toBe("line");
  // The Xcode block first, from the hub's guide; the name defaults to mac. A user of its own is only pointed to.
  expect(host.textContent).toContain("sudo xcodebuild -license accept");
  expect(host.textContent).not.toContain("sudo sysadminctl -addUser agents");
  expect(host.textContent).toContain("give them their own user (see Setup › A Mac for agents)");
  expect(host.textContent).not.toContain("open Privacy_Accessibility");
  expect(host.querySelector<HTMLInputElement>("form[aria-label='Name the machine'] input")?.value).toBe("mac");
  await click("Make the line");
  expect(calls.filter((c) => c.tool === "machine_join").map((c) => c.input)).toEqual([{ machineId: "mac", mac: true }]);
  expect(host.textContent).toContain("logged in at its screen (su and ssh won't do)");
  // Then the two clicks at the Mac; a new Mac has nothing to move.
  expect(host.textContent).toContain("open Privacy_Accessibility");
  expect(host.textContent).not.toContain("fleetd machine remove");
  await snapshot([DEVBOX, { ...DEVBOX, machineId: "mac", name: "mac" }]);
  await click("Open the Mac's checks");
  expect(window.location.hash).toBe("#/setup/mac");

  // A machine of that name already: its line makes it the agents' Mac, and says what to do about one of another name.
  act(() => root.unmount());
  root = createRoot(host);
  calls = [];
  await render();
  await snapshot([DEVBOX, { ...DEVBOX, machineId: "mac", name: "mac" }]);
  await click("Set up…");
  await click("Use Terminal instead");
  expect(host.textContent).toContain("its line makes it the agents' Mac");
  await click("Make the line");
  expect(calls.filter((c) => c.tool === "machine_join").map((c) => c.input)).toEqual([{ machineId: "mac", rejoin: true, mac: true }]);
  expect(host.textContent).toContain("fleetd machine remove");
});
