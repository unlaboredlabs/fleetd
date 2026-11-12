// @vitest-environment happy-dom
// Settings › Hub › Machines: the machine list, each row a name that opens its page with one dot where it needs
// someone, the projects left from a removed machine (each with Remove), and a machine's page: its state with Repair
// while it isn't online (over SSH, or a line that enrolls it again), only what is wrong with it, read from the hub's
// checks, a row each with its one fix, Claude's login from the app, its code going to the hub once, its role, screens
// and max agents, and Remove (asked first, then gone).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DoctorCheck, Machine, MachineHost, MachineRolesEntry, ProjectSummary } from "../../../shared/contracts";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { MachineList } from "./MachineList";
import { MachinePage } from "./MachinePage";
import { resetServes } from "./role";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

const AT = "2026-10-27T10:00:00.000Z";
const machine = (machineId: string, status: Machine["status"] = "online"): Machine => ({ machineId, name: machineId, nodeVersion: "0.9.0", status, lastSeenAt: AT, tags: [] });
const HOSTS: MachineHost[] = [
  { machineId: "devbox", source: "hub", joined: true },
  { machineId: "builder-1", host: "builder-1", source: "set_up", joined: true },
];
const check = (name: string, status: DoctorCheck["status"], message: string, fix?: DoctorCheck["fix"]): DoctorCheck => ({
  id: `laptop/${name}`,
  scope: "machine",
  machineId: "laptop",
  status,
  message,
  ...(fix === undefined ? {} : { fix }),
});
/** laptop just joined: claude installed but logged out, its identity set, a project fetched, Android not ready. */
const LOGGED_OUT: DoctorCheck[] = [
  check("online", "ok", "laptop is online."),
  check("claude_version", "ok", "laptop runs claude 2.1.314, the version fleetd was tested with."),
  check("claude_login", "fail", "laptop: claude is not logged in, so its sessions can't start.", { kind: "manual", label: "Log claude in on laptop", command: "claude auth login" }),
  check("commit_identity", "ok", "laptop commits as 1+ada-lovelace@users.noreply.github.com."),
  check("git_fetch", "ok", "At each project's last start on laptop: storefront fetched its remote."),
  check("android", "warn", "Android screens are off: /dev/kvm isn't readable by ada.", { kind: "manual", label: "Let ada use KVM", command: "sudo usermod -aG kvm ada", on: "machine" }),
];
/** The same checks, another machine's. */
const checksOf = (machineId: string): DoctorCheck[] => LOGGED_OUT.map((c) => ({ ...c, id: c.id.replace("laptop/", `${machineId}/`), machineId, message: c.message.replaceAll("laptop", machineId) }));
const READY: DoctorCheck[] = LOGGED_OUT.map((c) => (c.id === "laptop/claude_login" ? check("claude_login", "ok", "laptop: claude is logged in (Max).") : c));
/** What machine_roles says: builder-1 runs agents and hosts screens; laptop runs agents only. */
const ROLES: MachineRolesEntry[] = [
  {
    machineId: "builder-1",
    name: "builder-1",
    online: true,
    roles: ["agents", "sessions"],
    maxSessions: 4,
    maxSessionsWhy: "auto: 8 CPUs, 16 GB",
    sessionsLive: 0,
    hostsOthers: true,
    screenSettings: true,
    hosts: [{ host: "browser", ready: true, detail: "Chrome at /usr/bin/google-chrome", on: true, idleMinutes: 30 }],
  },
  { machineId: "laptop", name: "laptop", online: false, roles: ["agents"], maxSessions: 0, maxSessionsWhy: "auto", sessionsLive: 0, hostsOthers: false },
];
const LOGIN_URL = "https://claude.ai/oauth/authorize?code=true&client_id=9d1c&state=s1";

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ tool: string; input: unknown; timeoutMs?: number | undefined }>;
let checks: DoctorCheck[];
/** hub_info's `leftOut`, as fleetd cloud answers it; undefined, as a self-run hub leaves it out. */
let leftOut: string[] | undefined;
let opened: string[];
/** The hub's next frame, once a page is up. */
let frame: (frame: HubFrame) => void;
const MACHINES = [machine("devbox"), machine("builder-1"), machine("laptop", "offline")];

beforeEach(() => {
  resetServes();
  calls = [];
  leftOut = undefined;
  checks = LOGGED_OUT;
  opened = [];
  vi.stubGlobal("fleetd", {
    platform: "linux",
    fixture: null,
    copy: () => Promise.resolve(),
    openExternal: (url: string) => (opened.push(url), Promise.resolve({ ok: true })),
    // Repair opens in Add machine, which asks what this computer is.
    system: { hostName: () => Promise.resolve("desk") },
    machines: { thisComputer: () => new Promise(() => undefined), joinHereState: () => new Promise(() => undefined), onJoinHere: () => () => undefined },
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

const render = async (ui: React.ReactNode, projects: ProjectSummary[] = []) => {
  let listener: (frame: HubFrame) => void = () => undefined;
  frame = (f) => listener(f);
  const hub: HubApi = {
    call: (tool, input, options) => {
      calls.push({ tool, input, timeoutMs: options?.timeoutMs });
      const code = (input as { code?: string }).code;
      if (tool === "machine_remove" && (input as { machineId: string }).machineId === "devbox" && (input as { force?: boolean }).force !== true) {
        return Promise.resolve({
          ok: false,
          error: {
            code: "invalid",
            message: "devbox runs the leads of 2 projects (app, site): removing it stops them and erases its projects, with their chats and history.",
            fix: "to repair devbox instead, run fleetd pair --worker devbox on the hub and the line it prints on devbox with --rejoin; to remove it anyway, call machine_remove again with force: true (Remove anyway in the app)",
          },
        });
      }
      if (tool === "machine_claude_login" && code === "wrong") {
        return Promise.resolve({ ok: false, error: { code: "failed", message: "claude auth login failed: Invalid code", fix: "Start the login again: each sign-in page's code works once." } });
      }
      const output =
        tool === "hub_info"
          ? { version: "0.9.0", protocol: 1, busy: [], admin: true, ...(leftOut === undefined ? {} : { leftOut }) }
          : tool === "machine_hosts"
          ? { hosts: HOSTS }
          : tool === "machine_roles"
            ? { machines: ROLES }
          : tool === "doctor_list"
            ? { checks, checkedAt: AT }
            : tool === "machine_remove"
              ? { machineId: (input as { machineId: string }).machineId, steps: [], revoked: true }
              : tool === "machine_claude_login"
                ? code === undefined
                  ? { machineId: "laptop", loginUrl: LOGIN_URL, message: "sign in at the URL, then give the code it shows" }
                  : ((checks = READY), { machineId: "laptop", loggedIn: true, message: "Login successful." })
                : tool === "machine_add_status"
                  ? { runs: [] }
                  : tool === "machine_join"
                    ? { machineId: "laptop", hubUrl: "http://devbox:4790", code: "K7QM-4XWD", expiresAt: AT, line: "curl -fsSL https://fleetd.sh | sh -s -- --join http://devbox:4790 --rejoin" }
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
        <DataProvider layer={createDataLayer(hub)}>{ui}</DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    listener({ t: "state", state: { phase: "live", hub: "devbox:4790", protocol: 1 } });
    listener({ t: "snapshot", snapshot: { cursor: 1, attention: [], machines: MACHINES, projects } });
    await new Promise((r) => setTimeout(r, 0));
  });
  // The checks and hosts are read once hub_info says the hub serves them.
  await settle();
  await settle();
};

const button = (text: string) => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === text);
  if (b === undefined) throw new Error(`no button "${text}" in: ${document.body.textContent}`);
  return b;
};
const click = async (b: HTMLElement) => {
  await act(async () => {
    b.click();
    await Promise.resolve();
  });
  await settle();
};
const row = (name: string) => host.querySelector<HTMLElement>(`[role='listitem'][aria-label='${name}']`);
const rowButton = (name: string, text: string): HTMLElement => {
  const b = [...(row(name)?.querySelectorAll("button") ?? [])].find((x) => x.textContent.trim() === text);
  if (b === undefined) throw new Error(`no ${text} on ${name}`);
  return b;
};
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};

it("lists the machines, each a name that opens its page, with one dot on the one that needs someone", async () => {
  await render(<MachineList />);
  const names = [...host.querySelectorAll("[role='listitem']")].map((li) => li.getAttribute("aria-label"));
  // Online first, then by name.
  expect(names).toEqual(["builder-1", "devbox", "laptop"]);
  expect(row("laptop")?.querySelector("a")?.getAttribute("href")).toBe("#/settings/hub/machines/laptop");
  // Every row ends in a chevron, so it reads as one that opens without a hover.
  for (const name of names) expect(row(name ?? "")?.lastElementChild?.lastElementChild?.matches("svg[aria-hidden='true']")).toBe(true);

  // What it needs is one dot, the words its name and the row's tooltip: no state word, and none on a row that is well.
  expect(row("laptop")?.querySelector("[role='img']")?.getAttribute("aria-label")).toMatch(/^Offline since /u);
  expect(row("laptop")?.querySelector("a")?.title).toMatch(/^Offline since /u);
  expect(row("devbox")?.querySelector("[role='img']")).toBeNull();
  // A role other than the usual both is a quiet word beside the name, and all the words a row has.
  expect(row("laptop")?.textContent).toBe("laptopAgents only");
  expect(row("builder-1")?.textContent).toBe("builder-1");

  // No raw version on a row, and nothing to press but the row: Repair and Remove are on the machine's page.
  expect(row("devbox")?.textContent).not.toContain("0.9.0");
  expect(host.querySelector("[role='list'][aria-label='Machines'] button")).toBeNull();
});

it("marks a machine that is online with claude logged out, saying which check failed", async () => {
  checks = checksOf("builder-1");
  await render(<MachineList />);
  expect(row("builder-1")?.querySelector("[role='img']")?.getAttribute("aria-label")).toBe("Claude is not logged in, so its sessions can't start");
});

it("says a machine's state first on its page, and offers Repair only while it isn't online", async () => {
  await render(<MachinePage machineId="laptop" />);
  expect(host.textContent).toMatch(/Offline since [^·]+ · fleetd 0\.9\.0/u);
  // laptop joined by itself: a line that enrolls it again, in place.
  await click(button("Repair…"));
  expect(calls.filter((c) => c.tool === "machine_join").map((c) => c.input)).toEqual([{ machineId: "laptop", rejoin: true }]);
  expect(host.textContent).toContain("Repair laptop");
  expect(host.textContent).toContain("--rejoin");

  act(() => root.unmount());
  root = createRoot(host);
  await render(<MachinePage machineId="builder-1" />);
  expect(host.textContent).toContain("Online · fleetd 0.9.0");
  expect(() => button("Repair…")).toThrow();
});

it("reads a machine's state from the live feed when it is newer than the snapshot, as the list does", async () => {
  await render(<MachinePage machineId="builder-1" />);
  await act(async () => {
    frame({ t: "live", frame: { at: AT, full: true, lanes: [], machines: [{ machineId: "builder-1", name: "builder-1", status: "offline", asOf: AT, running: 0 }] } });
    await Promise.resolve();
  });
  expect(host.textContent).toMatch(/Offline since /u);
  expect(button("Repair…")).not.toBeNull();
});

it("asks before it removes a machine, then says it is removed and goes back to the list once the hub has dropped it", async () => {
  await render(<MachinePage machineId="laptop" />);
  await click(button("Remove…"));
  const dialog = document.querySelector("[role='dialog']");
  expect(dialog?.textContent).toContain("Remove laptop?");
  expect(dialog?.textContent).toContain("It joined by itself, so stop its node on it by hand.");
  expect(calls.some((c) => c.tool === "machine_remove")).toBe(false);
  await click(button("Remove laptop"));
  expect(calls.filter((c) => c.tool === "machine_remove").map((c) => c.input)).toEqual([{ machineId: "laptop" }]);
  // Removing waits on SSH: longer than the app's usual 30 s.
  expect(calls.find((c) => c.tool === "machine_remove")?.timeoutMs).toBe(100_000);
  // At once, whatever the snapshot still holds: nothing of the machine left to press.
  expect(host.textContent).toContain("Removed laptop.");
  expect(host.querySelector("[data-problem]")).toBeNull();
  expect(() => button("Remove…")).toThrow();
  // The hub's resync drops it: back to the list.
  window.location.hash = "#/settings/hub/machines/laptop";
  await act(async () => {
    frame({ t: "snapshot", snapshot: { cursor: 2, attention: [], machines: MACHINES.filter((m) => m.machineId !== "laptop"), projects: [] } });
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(window.location.hash).toBe("#/settings/hub/machines");
});

it("says what removing a machine that runs leads stops, and removes it only on Remove anyway", async () => {
  await render(<MachinePage machineId="devbox" />);
  await click(button("Remove…"));
  await click(button("Remove devbox"));
  const dialog = document.querySelector("[role='dialog']");
  expect(dialog?.textContent).toContain("Not removed: devbox runs the leads of 2 projects (app, site)");
  expect(host.textContent).not.toContain("Removed devbox.");
  await click(button("Remove anyway"));
  expect(calls.filter((c) => c.tool === "machine_remove").map((c) => c.input)).toEqual([{ machineId: "devbox" }, { machineId: "devbox", force: true }]);
  expect(host.textContent).toContain("Removed devbox.");
});

it("says a machine the hub set up loses its service as well as its key", async () => {
  await render(<MachinePage machineId="builder-1" />);
  await click(button("Remove…"));
  expect(document.querySelector("[role='dialog']")?.textContent).toContain("The hub stops and removes builder-1's node service, then revokes its key.");
  // Its projects and their history go with it, and the confirm says so.
  expect(document.querySelector("[role='dialog']")?.textContent).toContain("its projects are deleted from fleetd with their chats, memory, skills, files and orders");
});

const problems = () => [...host.querySelectorAll("[data-problem]")].map((row) => `${row.getAttribute("data-problem") ?? ""}:${row.getAttribute("data-state") ?? ""}`);

it("shows nothing about a machine's checks while they all pass, or before the hub has checked it", async () => {
  checks = READY.filter((c) => c.id !== "laptop/android");
  await render(<MachinePage machineId="laptop" />);
  expect(host.textContent).toMatch(/Offline since [^·]+ · fleetd 0\.9\.0/u);
  expect(host.querySelector("[data-problems]")).toBeNull();
  expect(problems()).toEqual([]);
  expect(host.textContent).not.toContain("Checklist");
  expect(host.textContent).not.toContain("laptop runs claude 2.1.314");
  // Nothing wrong: nothing to check again.
  expect(() => button("Check again")).toThrow();

  act(() => root.unmount());
  root = createRoot(host);
  checks = [];
  await render(<MachinePage machineId="laptop" />);
  expect(problems()).toEqual([]);
  expect(() => button("Check again")).toThrow();
});

it("reads no checks and no hosts on fleetd cloud, which leaves its doctor and SSH out: no problems, no error, Remove stays", async () => {
  leftOut = ["doctor_list", "doctor_fix", "machine_add_plan", "machine_add", "machine_add_status", "machine_hosts"];
  // The app knows the hub's answer before it opens the page (Settings' Hub group waits for hub_info): a first mount
  // learns it, and the page that opens next asks nothing left out.
  await render(<MachinePage machineId="laptop" />);
  act(() => root.unmount());
  root = createRoot(host);
  calls = [];
  await render(<MachinePage machineId="laptop" />);
  expect(problems()).toEqual([]);
  expect(host.textContent).not.toContain("Couldn't read");
  expect(() => button("Check again")).toThrow();
  expect(button("Remove…")).toBeDefined();
  expect(calls.filter((c) => c.tool === "doctor_list" || c.tool === "machine_hosts")).toEqual([]);
});

it("shows each check that failed or warns as one row, failed first, with Check again under them", async () => {
  await render(<MachinePage machineId="laptop" />);
  expect(problems()).toEqual(["claude_login:failed", "android:warn"]);
  expect(host.querySelector("[data-problems]")?.getAttribute("data-problems")).toBe("2");
  // What is wrong in the hub's words, without the machine's name in front; the checks that passed say nothing.
  expect(host.querySelector("[data-problem='claude_login']")?.textContent).toBe("Claude is not logged in, so its sessions can't startLog in…");
  expect(host.textContent).not.toContain("laptop commits as");
  await click(button("Check again"));
  expect(calls.filter((c) => c.tool === "doctor_list" && (c.input as { rerun?: boolean }).rerun === true)).toHaveLength(1);
});

it("checks a machine the hub hasn't checked yet as its page opens, once", async () => {
  checks = [];
  await render(<MachinePage machineId="builder-1" />);
  const reruns = () => calls.filter((c) => c.tool === "doctor_list" && (c.input as { rerun?: boolean }).rerun === true);
  expect(reruns()).toHaveLength(1);
  await settle();
  expect(reruns()).toHaveLength(1);
});

it("checks a machine again as its page opens when the hub couldn't answer some of its checks, unless it is offline", async () => {
  const reruns = () => calls.filter((c) => c.tool === "doctor_list" && (c.input as { rerun?: boolean }).rerun === true);
  checks = [
    { id: "builder-1/commit_identity", scope: "machine", machineId: "builder-1", status: "unknown", message: "builder-1's node is not linked to the hub" },
    check("commit_identity", "unknown", "laptop's node is not linked to the hub"),
  ];
  await render(<MachinePage machineId="builder-1" />);
  expect(reruns()).toHaveLength(1);
  act(() => root.unmount());
  root = createRoot(host);
  calls = [];
  // laptop is offline: nothing to ask it.
  await render(<MachinePage machineId="laptop" />);
  expect(reruns()).toHaveLength(0);
});

it("gives each fix as the command to run on the machine, with Copy", async () => {
  await render(<MachinePage machineId="laptop" />);
  const android = host.querySelector("[data-problem='android']");
  expect(android?.getAttribute("aria-label")).toBe("Android screens are off: /dev/kvm isn't readable by ada");
  expect(android?.getAttribute("data-fix")).toBe("laptop");
  expect(android?.textContent).toContain("Let ada use KVM. Run on laptop:");
  expect(android?.querySelector("button")?.previousElementSibling?.textContent).toBe("sudo usermod -aG kvm ada");
  expect([...(android?.querySelectorAll("button") ?? [])].map((b) => b.textContent.trim())).toEqual(["Copy"]);
});

it("gives a fix that runs on the hub as the command to run on the hub's machine, not the machine's", async () => {
  checks = LOGGED_OUT.map((c) =>
    c.id === "laptop/commit_identity"
      ? check("commit_identity", "warn", "Commits on laptop use ada@home.example; the hub's identity is 1+ada-lovelace@users.noreply.github.com.", {
          kind: "manual",
          label: "Join laptop again: run this on the hub, then the line it prints on laptop; it carries the identity",
          command: "fleetd pair --worker laptop",
          on: "hub",
        })
      : c,
  );
  await render(<MachinePage machineId="laptop" />);
  const identity = () => host.querySelector("[data-problem='commit_identity']");
  // Named once the hub has said which machine it runs on (machine_hosts, asked as the fix shows).
  await vi.waitFor(() => expect(identity()?.getAttribute("data-fix")).toBe("devbox, the hub"));
  expect(identity()?.textContent).toContain("Commits on laptop use ada@home.example; the hub's identity is 1+ada-lovelace@users.noreply.github.com");
  expect(identity()?.textContent).toContain("Run on devbox, the hub:");
  expect(identity()?.querySelector("button")?.previousElementSibling?.textContent).toBe("fleetd pair --worker laptop");
});

it("points a screen kind the hub has no command for at Screens, where it turns on", async () => {
  checks = [...checksOf("builder-1").filter((c) => c.status === "ok"), { ...check("desktop", "fail", "Linux desktop screens need docker, which builder-1 doesn't have. Install docker, then turn them on."), id: "builder-1/desktop", machineId: "builder-1" }];
  await render(<MachinePage machineId="builder-1" />);
  const desktop = host.querySelector("[data-problem='desktop']");
  expect(desktop?.textContent).toBe("Linux desktop screens need docker, which builder-1 doesn't haveScreens");
  expect(desktop?.getAttribute("data-fix")).toBeNull();
});

it("logs claude in from the app: the URL to sign in at, then the code, once", async () => {
  await render(<MachinePage machineId="laptop" />);
  expect(problems()).toEqual(["claude_login:failed", "android:warn"]);
  expect(host.textContent).toContain("Claude is not logged in, so its sessions can't start");

  await click(button("Log in…"));
  expect(calls.filter((c) => c.tool === "machine_claude_login").map((c) => c.input)).toEqual([{ machineId: "laptop" }]);
  expect(host.textContent).toContain("Open this page and sign in with the Claude account laptop should use.");
  expect(host.textContent).toContain(LOGIN_URL);
  await click(button("Open"));
  expect(opened).toEqual([LOGIN_URL]);

  const code = host.querySelector<HTMLInputElement>("form[aria-label='Sign in'] input");
  expect(button("Log in").disabled).toBe(true);
  if (code === null) throw new Error("no code field");
  await type(code, "wrong");
  await click(button("Log in"));
  expect(host.textContent).toContain("claude auth login failed: Invalid code");
  // A spent code: the login starts again.
  await click(button("Try again"));
  const again = host.querySelector<HTMLInputElement>("form[aria-label='Sign in'] input");
  if (again === null) throw new Error("no code field");
  await type(again, " abc#s1 ");
  await click(button("Log in"));
  await settle();
  expect(calls.filter((c) => c.tool === "machine_claude_login").map((c) => c.input)).toEqual([
    { machineId: "laptop" },
    { machineId: "laptop", code: "wrong" },
    { machineId: "laptop" },
    { machineId: "laptop", code: "abc#s1" },
  ]);
  // Each waits as long as the hub waits on the node (90 s), not the app's usual 30 s.
  expect(calls.filter((c) => c.tool === "machine_claude_login").every((c) => c.timeoutMs === 100_000)).toBe(true);
  // The checks run again, and claude's row goes with its check.
  expect(calls.some((c) => c.tool === "doctor_list" && (c.input as { rerun?: boolean }).rerun === true)).toBe(true);
  expect(problems()).toEqual(["android:warn"]);
});

it("holds a machine's role, screens and max agents on its page, under what is wrong with it", async () => {
  checks = checksOf("builder-1");
  await render(<MachinePage machineId="builder-1" />);
  const parts = [...host.querySelectorAll("section[data-part]")].map((s) => s.getAttribute("data-part"));
  expect(parts).toEqual(["hub.roles", "hub.screens", "hub.caps"]);
  expect(host.querySelector("[data-roles='builder-1'] button[aria-pressed='true']")?.textContent).toBe("Both");
  expect(host.querySelector("[data-screens='builder-1']")?.textContent).toContain("0 of 4 screens now (auto: 8 CPUs, 16 GB)");
  expect(host.querySelector("[data-screens='builder-1']")?.textContent).toContain("An idle screen ends after 30 minutes.");
  // What is wrong comes first.
  const wrong = host.querySelector("[data-problems]");
  const role = host.querySelector("section[data-part='hub.roles']");
  expect(wrong !== null && role !== null && (wrong.compareDocumentPosition(role) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true);

  // A machine that runs agents only has no Screens part.
  act(() => root.unmount());
  root = createRoot(host);
  await render(<MachinePage machineId="laptop" />);
  expect([...host.querySelectorAll("section[data-part]")].map((s) => s.getAttribute("data-part"))).toEqual(["hub.roles", "hub.caps"]);
});

it("says so when the hub has no such machine", async () => {
  await render(<MachinePage machineId="ghost" />);
  expect(host.textContent).toContain("This hub has no such machine. It may have been removed.");
  expect(host.querySelector("[data-problem]")).toBeNull();
});

it("lists the projects left from a removed machine, and Remove only forgets one in fleetd", async () => {
  const project = (machineId: string, projectId: string): ProjectSummary => ({
    machineId,
    projectId,
    title: projectId,
    workspaceRoot: `/home/dev/src/${projectId}`,
    lastActivityAt: AT,
    threads: { running: 0, waiting: 0, idle: 0, failed: 0 },
  });
  await render(<MachineList />, [project("devbox", "fleetd"), project("worker", "fleetd")]);
  const leftovers = host.querySelector("[aria-label='Projects left from removed machines']");
  expect([...(leftovers?.querySelectorAll("[role='listitem']") ?? [])].map((li) => li.textContent)).toEqual([
    "fleetdworker · /home/dev/src/fleetdRemove",
  ]);
  await click(rowButton("fleetd", "Remove"));
  expect(document.querySelector("[role='dialog']")?.textContent).toContain("Forget fleetd?");
  await click(button("Forget project"));
  expect(calls.filter((c) => c.tool === "project_remove").map((c) => c.input)).toEqual([{ machineId: "worker", projectId: "fleetd" }]);
});

it("lists no leftovers while every project's machine is in the hub", async () => {
  await render(<MachineList />);
  expect(document.body.textContent).not.toContain("Left from removed machines");
});
