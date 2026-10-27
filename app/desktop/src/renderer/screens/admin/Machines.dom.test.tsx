// @vitest-environment happy-dom
// Administration › Machines: the machine list's Repair (over SSH, or a line that enrolls it again) and Remove (asked
// first, then gone), and a machine's page: its checklist read from the hub's checks, each item waiting until checked,
// and Claude's login from the app, its code going to the hub once.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DoctorCheck, Machine, MachineHost } from "../../../shared/contracts";
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
  check("claude_version", "ok", "laptop runs claude 2.1.302, the version fleetd was tested with."),
  check("claude_login", "fail", "laptop: claude is not logged in, so its sessions can't start.", { kind: "manual", label: "Log claude in on laptop", command: "claude auth login" }),
  check("commit_identity", "ok", "laptop commits as 1+ada-lovelace@users.noreply.github.com."),
  check("git_fetch", "ok", "At each project's last start on laptop: storefront fetched its remote."),
  check("android", "warn", "Android screens are off: /dev/kvm isn't readable by ada.", { kind: "manual", label: "Let ada use KVM", command: "sudo usermod -aG kvm ada" }),
];
const READY: DoctorCheck[] = LOGGED_OUT.map((c) => (c.id === "laptop/claude_login" ? check("claude_login", "ok", "laptop: claude is logged in (Max).") : c));
const LOGIN_URL = "https://claude.ai/oauth/authorize?code=true&client_id=9d1c&state=s1";

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ tool: string; input: unknown }>;
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

const render = async (ui: React.ReactNode) => {
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input });
      const code = (input as { code?: string }).code;
      if (tool === "machine_claude_login" && code === "wrong") {
        return Promise.resolve({ ok: false, error: { code: "failed", message: "claude auth login failed: Invalid code", fix: "Start the login again: each sign-in page's code works once." } });
      }
      const output =
        tool === "machine_hosts"
          ? { hosts: HOSTS }
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
    listener({ t: "snapshot", snapshot: { cursor: 1, attention: [], machines: [machine("devbox"), machine("builder-1"), machine("laptop", "offline")], projects: [] } });
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

it("lists the machines, each with its page, Repair and Remove", async () => {
  const repairs: Repair[] = [];
  await render(<MachineList onRepair={(r) => repairs.push(r)} />);
  const names = [...host.querySelectorAll("[role='listitem']")].map((li) => li.getAttribute("aria-label"));
  // Online first, then by name.
  expect(names).toEqual(["builder-1", "devbox", "laptop"]);
  expect(row("laptop")?.textContent).toContain("Offline");
  expect(row("laptop")?.querySelector("a")?.getAttribute("href")).toBe("#/admin/machines/laptop");

  await click(rowButton("builder-1", "Repair"));
  await click(rowButton("laptop", "Repair"));
  await click(rowButton("devbox", "Repair"));
  expect(repairs).toEqual([
    { kind: "plan", host: HOSTS[1] },
    { kind: "line", machineId: "laptop", rejoin: true },
    { kind: "plan", host: HOSTS[0] },
  ]);
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
  expect(row("laptop")).toBeNull();
  expect(row("builder-1")).not.toBeNull();
});

it("says a machine the hub set up loses its service as well as its key", async () => {
  await render(<MachineList onRepair={() => undefined} />);
  await click(rowButton("builder-1", "Remove"));
  expect(document.querySelector("[role='dialog']")?.textContent).toContain("The hub stops and removes builder-1's node service, then revokes its key.");
});

const items = () => [...host.querySelectorAll("li[data-item]")].map((li) => `${li.getAttribute("data-item") ?? ""}:${li.getAttribute("data-state") ?? ""}`);

it("shows a joined machine's checklist, each item waiting until the hub has checked it", async () => {
  checks = [];
  await render(<MachinePage machineId="laptop" />);
  expect(host.textContent).toContain("Offline · fleetd 0.9.0");
  expect(items()).toEqual(["claude:waiting", "identity:waiting", "github:waiting", "capabilities:done"]);
  expect(host.textContent).toContain("Checked when an agent first starts in one of its projects.");
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
  // The checks run again, and claude's item is done.
  expect(calls.some((c) => c.tool === "doctor_list" && (c.input as { rerun?: boolean }).rerun === true)).toBe(true);
  expect(items()[0]).toBe("claude:done");
});

it("says so when the hub has no such machine", async () => {
  await render(<MachinePage machineId="ghost" />);
  expect(host.textContent).toContain("This hub has no such machine. It may have been removed.");
  expect(host.querySelector("li[data-item]")).toBeNull();
});
