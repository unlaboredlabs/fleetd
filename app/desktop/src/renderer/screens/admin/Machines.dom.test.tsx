// @vitest-environment happy-dom
// Settings › Hub › Machines: the machine list's Repair for a machine that isn't well (over SSH, or a line that enrolls
// it again) and Remove (asked first, then gone), the projects left from a removed machine (each with Remove), and a
// machine's page: its checklist read from the hub's checks, each item waiting until checked, Claude's login from the
// app, its code going to the hub once, and its role, screens and max agents.
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
import type { Repair } from "./machines";

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
let opened: string[];

beforeEach(() => {
  calls = [];
  checks = LOGGED_OUT;
  opened = [];
  vi.stubGlobal("fleetd", {
    platform: "linux",
    fixture: null,
    copy: () => Promise.resolve(),
    openExternal: (url: string) => (opened.push(url), Promise.resolve({ ok: true })),
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
        tool === "machine_hosts"
          ? { hosts: HOSTS }
          : tool === "machine_roles"
            ? { machines: ROLES }
          : tool === "doctor_list"
            ? { checks, checkedAt: AT }
            : tool === "machine_remove"
              ? { machineId: "laptop", steps: [], revoked: true }
              : tool === "machine_claude_login"
                ? code === undefined
                  ? { machineId: "laptop", loginUrl: LOGIN_URL, message: "sign in at the URL, then give the code it shows" }
                  : ((checks = READY), { machineId: "laptop", loggedIn: true, message: "Login successful." })
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
    listener({ t: "snapshot", snapshot: { cursor: 1, attention: [], machines: [machine("devbox"), machine("builder-1"), machine("laptop", "offline")], projects } });
    await new Promise((r) => setTimeout(r, 0));
  });
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

it("lists the machines, each with its page and Remove, and Repair only for one that isn't well", async () => {
  const repairs: Repair[] = [];
  await render(<MachineList onRepair={(r) => repairs.push(r)} />);
  const names = [...host.querySelectorAll("[role='listitem']")].map((li) => li.getAttribute("aria-label"));
  // Online first, then by name.
  expect(names).toEqual(["builder-1", "devbox", "laptop"]);
  expect(row("laptop")?.textContent).toContain("Offline");
  // What brings it back, and nothing under one that is online.
  expect(row("laptop")?.textContent).toContain("If the machine is on, Repair sets its node up again.");
  expect(row("devbox")?.textContent).not.toContain("Repair sets");
  expect(row("laptop")?.querySelector("a")?.getAttribute("href")).toBe("#/settings/hub/machines/laptop");
  // Every row ends in a chevron, so it reads as one that opens without a hover.
  for (const name of names) expect(row(name ?? "")?.lastElementChild?.matches("svg[aria-hidden='true']")).toBe(true);

  // No raw version on a row: the machine's page says it.
  expect(row("devbox")?.textContent).not.toContain("0.9.0");
  expect(() => rowButton("devbox", "Repair")).toThrow();
  expect(() => rowButton("builder-1", "Repair")).toThrow();
  await click(rowButton("laptop", "Repair"));
  expect(repairs).toEqual([{ kind: "line", machineId: "laptop", rejoin: true }]);
});

it("asks before it removes a machine, then takes it off the list", async () => {
  await render(<MachineList onRepair={() => undefined} />);
  await click(rowButton("laptop", "Remove"));
  const dialog = document.querySelector("[role='dialog']");
  expect(dialog?.textContent).toContain("Remove laptop?");
  expect(dialog?.textContent).toContain("It joined by itself, so stop its node on it by hand.");
  expect(calls.some((c) => c.tool === "machine_remove")).toBe(false);
  await click(button("Remove laptop"));
  expect(calls.filter((c) => c.tool === "machine_remove").map((c) => c.input)).toEqual([{ machineId: "laptop" }]);
  // Removing waits on SSH: longer than the app's usual 30 s.
  expect(calls.find((c) => c.tool === "machine_remove")?.timeoutMs).toBe(100_000);
  expect(row("laptop")).toBeNull();
  expect(row("builder-1")).not.toBeNull();
});

it("says what removing a machine that runs leads stops, and removes it only on Remove anyway", async () => {
  await render(<MachineList onRepair={() => undefined} />);
  await click(rowButton("devbox", "Remove"));
  await click(button("Remove devbox"));
  const dialog = document.querySelector("[role='dialog']");
  expect(dialog?.textContent).toContain("Not removed: devbox runs the leads of 2 projects (app, site)");
  expect(row("devbox")).not.toBeNull();
  await click(button("Remove anyway"));
  expect(calls.filter((c) => c.tool === "machine_remove").map((c) => c.input)).toEqual([{ machineId: "devbox" }, { machineId: "devbox", force: true }]);
  expect(row("devbox")).toBeNull();
});

it("says a machine the hub set up loses its service as well as its key", async () => {
  await render(<MachineList onRepair={() => undefined} />);
  await click(rowButton("builder-1", "Remove"));
  expect(document.querySelector("[role='dialog']")?.textContent).toContain("The hub stops and removes builder-1's node service, then revokes its key.");
  // Its projects and their history go with it, and the confirm says so.
  expect(document.querySelector("[role='dialog']")?.textContent).toContain("its projects are deleted from fleetd with their chats, memory, skills, files and orders");
});

const items = () => [...host.querySelectorAll("li[data-item]")].map((li) => `${li.getAttribute("data-item") ?? ""}:${li.getAttribute("data-state") ?? ""}`);

it("shows a joined machine's checklist, each item waiting until the hub has checked it", async () => {
  checks = [];
  await render(<MachinePage machineId="laptop" />);
  expect(host.textContent).toContain("Offline · fleetd 0.9.0");
  expect(items()).toEqual(["claude:waiting", "identity:waiting", "github:waiting", "capabilities:done"]);
  expect(host.textContent).toContain("Checked when an agent first starts in one of its projects.");
});

it("says when the hub last checked the machine, beside its checklist: its own run, not a later one of another's", async () => {
  // The answer's checkedAt (Oct 27 10:00) moves with every machine's run; laptop's own ran on Oct 25.
  checks = LOGGED_OUT.map((c) => ({ ...c, checkedAt: "2026-10-25T10:00:00.000Z" }));
  await render(<MachinePage machineId="laptop" />);
  expect(host.textContent).toContain("Offline · fleetd 0.9.0 · checked Oct 25");
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
  const android = host.querySelector("li[data-item='capabilities']");
  expect(android?.querySelector("dt")?.textContent).toBe("Run on laptop");
  expect(android?.querySelector("dd [data-text='code']")?.textContent).toBe("sudo usermod -aG kvm ada");
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
  const identity = host.querySelector("li[data-item='identity']");
  // Named once the hub has said which machine it runs on (machine_hosts, asked as the fix shows).
  await vi.waitFor(() => expect(identity?.querySelector("dt")?.textContent).toBe("Run on devbox, the hub"));
  expect(identity?.querySelector("dd [data-text='code']")?.textContent).toBe("fleetd pair --worker laptop");
});

it("logs claude in from the app: the URL to sign in at, then the code, once", async () => {
  await render(<MachinePage machineId="laptop" />);
  expect(items()).toEqual(["claude:failed", "identity:done", "github:done", "capabilities:warn"]);
  expect(host.textContent).toContain("laptop: claude is not logged in, so its sessions can't start.");

  await click(button("Log in…"));
  expect(calls.filter((c) => c.tool === "machine_claude_login").map((c) => c.input)).toEqual([{ machineId: "laptop" }]);
  expect(host.textContent).toContain("1. Open this page and sign in with the Claude account laptop should use.");
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
  // The checks run again, and claude's item is done.
  expect(calls.some((c) => c.tool === "doctor_list" && (c.input as { rerun?: boolean }).rerun === true)).toBe(true);
  expect(items()[0]).toBe("claude:done");
});

it("holds a machine's role, screens and max agents on its page, under its checklist", async () => {
  checks = [];
  await render(<MachinePage machineId="builder-1" />);
  const parts = [...host.querySelectorAll("section[data-part]")].map((s) => s.getAttribute("data-part"));
  expect(parts).toEqual(["hub.roles", "hub.screens", "hub.caps"]);
  expect(host.querySelector("[data-roles='builder-1'] button[aria-pressed='true']")?.textContent).toBe("Both");
  expect(host.querySelector("[data-screens='builder-1']")?.textContent).toContain("0 of 4 screens now (auto: 8 CPUs, 16 GB)");
  expect(host.querySelector("[data-screens='builder-1']")?.textContent).toContain("An idle screen ends after 30 minutes.");
  // The checklist comes first.
  const checklist = host.querySelector("section[aria-label='Checklist']");
  const role = host.querySelector("section[data-part='hub.roles']");
  expect(checklist !== null && role !== null && (checklist.compareDocumentPosition(role) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true);

  // A machine that runs agents only has no Screens part.
  act(() => root.unmount());
  root = createRoot(host);
  await render(<MachinePage machineId="laptop" />);
  expect([...host.querySelectorAll("section[data-part]")].map((s) => s.getAttribute("data-part"))).toEqual(["hub.roles", "hub.caps"]);
});

it("says so when the hub has no such machine", async () => {
  await render(<MachinePage machineId="ghost" />);
  expect(host.textContent).toContain("This hub has no such machine. It may have been removed.");
  expect(host.querySelector("li[data-item]")).toBeNull();
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
  await render(<MachineList onRepair={() => undefined} />, [project("devbox", "fleetd"), project("worker", "fleetd")]);
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
  await render(<MachineList onRepair={() => undefined} />);
  expect(document.body.textContent).not.toContain("Left from removed machines");
});
