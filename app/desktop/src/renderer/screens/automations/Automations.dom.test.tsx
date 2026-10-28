// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Automation, AutomationRun, MemoryRefreshJob, ToolInput, ToolName } from "../../../shared/contracts";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { live, project, snapshot } from "../../src/data/fixtures.test-util";
import { TooltipProvider } from "../../ui/primitives/Tooltip";
import { Automations } from "./Automations";

const NOW = Date.parse("2026-10-17T10:00:00.000Z");
const AT = new Date(NOW).toISOString();

vi.hoisted(() => vi.stubGlobal("fleetd", { platform: "linux", fixture: null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

/** A hub that keeps automations and their runs in memory, as automation_* answer them. */
function fakeHub() {
  const automations: Automation[] = [];
  const runs: AutomationRun[] = [];
  const calls: Array<{ tool: string; input: unknown }> = [];
  // The nightly memory refresh, as automation_list lists it.
  const refresh: { job: MemoryRefreshJob; why?: string } = { job: { on: true, at: "04:00", tz: "Europe/Berlin", nextRunAt: "2026-10-18T02:00:00.000Z" } };
  let n = 0;
  const ok = (output: unknown) => Promise.resolve({ ok: true as const, output });
  const find = (id: string) => automations.find((a) => a.automationId === id) as Automation;
  const put = (a: Automation) => automations.splice(automations.indexOf(find(a.automationId)), 1, a);
  const api: HubApi = {
    call: (tool, raw) => {
      calls.push({ tool, input: raw });
      const name = tool as ToolName;
      if (name === "automation_list") {
        return ok({
          automations: automations.map((a) => ({ ...a, ...(runs.find((r) => r.automationId === a.automationId) ? { lastRun: runs.find((r) => r.automationId === a.automationId) } : {}) })),
          memoryRefresh: refresh.job,
        });
      }
      if (name === "memory_refresh_run") {
        if (refresh.why === undefined) refresh.job = { ...refresh.job, lastRun: { at: AT, trigger: "manual", state: "running", added: 0, replaced: 0, removed: 0 } };
        return ok({ memoryRefresh: refresh.job, ...(refresh.why === undefined ? {} : { why: refresh.why }) });
      }
      if (name === "project_settings_set") {
        const on = (raw as ToolInput<"project_settings_set">).memoryRefresh ?? true;
        const { nextRunAt: _, ...rest } = refresh.job;
        refresh.job = on ? { ...rest, on, nextRunAt: "2026-10-18T02:00:00.000Z" } : { ...rest, on };
        return ok({});
      }
      if (name === "automation_create") {
        const input = raw as ToolInput<"automation_create">;
        const a: Automation = {
          automationId: `au_test00${++n}`,
          projectRef: input.projectRef,
          name: input.name,
          prompt: input.prompt,
          ...(input.schedule ? { schedule: input.schedule, nextRunAt: "2026-10-19T07:00:00.000Z" } : {}),
          webhook: input.webhook ?? false,
          paused: false,
          createdBy: "human",
          createdAt: AT,
          updatedAt: AT,
        };
        automations.push(a);
        return ok({ automation: a, ...(a.webhook ? { webhookUrl: `http://hub.test/hooks/${a.automationId}/s3cr3t` } : {}) });
      }
      if (name === "automation_update") {
        const input = raw as ToolInput<"automation_update">;
        const a = { ...find(input.automationId), ...(input.name ? { name: input.name } : {}) };
        put(a);
        return ok({ automation: a });
      }
      if (name === "automation_pause") {
        const input = raw as ToolInput<"automation_pause">;
        const a = { ...find(input.automationId), paused: input.paused };
        put(a);
        return ok({ automation: a });
      }
      if (name === "automation_run") {
        const input = raw as ToolInput<"automation_run">;
        const run: AutomationRun = { runId: `ar_run0000${++n}`, automationId: input.automationId, trigger: "manual", at: AT, state: "running", workstreamId: "W7", by: "human" };
        runs.unshift(run);
        return ok({ run });
      }
      if (name === "automation_runs") {
        const input = raw as ToolInput<"automation_runs">;
        return ok({ runs: runs.filter((r) => r.automationId === input.automationId) });
      }
      if (name === "automation_delete") {
        const input = raw as ToolInput<"automation_delete">;
        automations.splice(automations.indexOf(find(input.automationId)), 1);
        return ok({ ok: true });
      }
      return ok({});
    },
    subscribe: (l) => ((send = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;
  return { api, calls, automations, runs, refresh, send: (f: Parameters<typeof send>[0]) => send(f) };
}

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
};

async function mount(prepare?: (hub: ReturnType<typeof fakeHub>) => void) {
  const hub = fakeHub();
  prepare?.(hub);
  act(() => {
    root.render(
      <DataProvider layer={createDataLayer(hub.api)}>
        <TooltipProvider>
          <Automations route={{ tab: "automations", prompt: null, for: `${project.machineId}/${project.projectId}`, view: "edit" }} />
        </TooltipProvider>
      </DataProvider>,
    );
  });
  await act(async () => {
    hub.send(live());
    hub.send(snapshot(1));
    await Promise.resolve();
  });
  await flush();
  return hub;
}

const button = (label: string, within: ParentNode = document.body): HTMLButtonElement => {
  const found = [...within.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
  if (!found) throw new Error(`no button ${label} in: ${within.textContent ?? ""}`);
  return found;
};
const click = async (b: HTMLElement) => {
  act(() => b.click());
  await flush();
};
const fill = (field: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const editor = () => host.querySelector("section[aria-label='New automation'], section[aria-label^='Edit ']") as HTMLElement;
const card = (name: string) => host.querySelector<HTMLElement>(`section[aria-label='${name}']`);

it("makes, edits, pauses, runs and deletes an automation and shows its runs with their orders", async () => {
  const hub = await mount();
  expect(host.querySelector("[data-screen]")?.getAttribute("data-screen")).toBe("settings.automations");
  expect(host.textContent).toContain("storefront has no automations yet.");

  // Create: the editor previews the schedule in words, and the new webhook's URL is shown once.
  await click(button("New automation", host));
  const form = editor();
  const [name, cron, tz] = [...form.querySelectorAll("input")] as HTMLInputElement[];
  fill(name as HTMLInputElement, "Dependency check");
  fill(form.querySelector("textarea") as HTMLTextAreaElement, "Check the dependencies for updates.");
  fill(cron as HTMLInputElement, "0 9 * * 1-5");
  fill(tz as HTMLInputElement, "Europe/Berlin");
  expect(form.textContent).toContain("At 09:00, Monday to Friday (Europe/Berlin)");
  act(() => (form.querySelectorAll("button[role='switch']")[1] as HTMLElement).click());
  await click(button("Create", form));
  expect(hub.calls.find((c) => c.tool === "automation_create")?.input).toMatchObject({
    projectRef: project,
    name: "Dependency check",
    schedule: { cron: "0 9 * * 1-5", tz: "Europe/Berlin" },
    webhook: true,
  });
  const url = host.querySelector("input[aria-label='Webhook URL']") as HTMLInputElement;
  expect(url.value).toBe("http://hub.test/hooks/au_test001/s3cr3t");
  await click(button("Done", host));
  expect(host.querySelector("input[aria-label='Webhook URL']")).toBeNull();
  const c = card("Dependency check") as HTMLElement;
  expect(c.textContent).toContain("At 09:00, Monday to Friday (Europe/Berlin) · Webhook");
  expect(c.textContent).toContain("Not run yet");

  // Run now: the run opens an order, and Runs lists it linked to the order's page.
  await click(button("Run now", c));
  expect(c.textContent).toContain("Running: it opened W7 for the lead.");
  const after = card("Dependency check") as HTMLElement;
  await click(button("Runs", after));
  const link = after.querySelector("ul[aria-label='Runs'] a") as HTMLAnchorElement;
  expect(link.getAttribute("href")).toBe("#/factory/time/order/W7");
  expect(after.querySelector("ul[aria-label='Runs']")?.textContent).toContain("Run now");

  // Pause and resume.
  await click(button("Pause", after));
  expect(hub.calls.filter((x) => x.tool === "automation_pause").map((x) => x.input)).toEqual([{ automationId: "au_test001", paused: true }]);
  expect((card("Dependency check") as HTMLElement).textContent).toContain("Paused");
  await click(button("Resume", card("Dependency check") as HTMLElement));
  expect(hub.automations[0]?.paused).toBe(false);

  // Edit sends only what changed.
  await click(button("Edit", card("Dependency check") as HTMLElement));
  fill(editor().querySelector("input") as HTMLInputElement, "Weekday dependency check");
  await click(button("Save", editor()));
  expect(hub.calls.find((x) => x.tool === "automation_update")?.input).toEqual({ automationId: "au_test001", name: "Weekday dependency check" });
  expect(card("Weekday dependency check")).not.toBeNull();

  // Delete asks first.
  await click(button("Delete", card("Weekday dependency check") as HTMLElement));
  expect(document.body.textContent).toContain("Orders its runs opened stay.");
  await click(button("Delete", document.querySelector("[role='dialog']") as HTMLElement));
  expect(hub.automations).toEqual([]);
  expect(host.textContent).toContain("storefront has no automations yet.");
});

it("says what is wrong before it saves", async () => {
  const hub = await mount();
  await click(button("New automation", host));
  const form = editor();
  fill(form.querySelectorAll("input")[1] as HTMLInputElement, "0 9 * * 9");
  expect(form.textContent).toContain("day of week 9 is outside 0-7.");
  await click(button("Create", form));
  expect(form.textContent).toContain("Give it a name.");
  expect(hub.calls.some((c) => c.tool === "automation_create")).toBe(false);
});

it("lists the nightly memory refresh as a built-in row with its hour, last run, switch and Run now", async () => {
  const hub = await mount((h) => {
    h.refresh.job = { ...h.refresh.job, lastRun: { at: "2026-10-17T02:00:00.000Z", trigger: "schedule", state: "done", added: 2, replaced: 1, removed: 1 } };
    h.refresh.why = "Nothing new in the chat or its orders since the last refresh.";
  });
  const row = card("Nightly memory refresh") as HTMLElement;
  expect(row.getAttribute("data-builtin")).toBe("memory-refresh");
  expect(row.textContent).toContain("Built-in");
  expect(row.textContent).toContain("Every night at 04:00 (Europe/Berlin)");
  expect(row.textContent).toContain("Next run");
  expect(row.textContent).toContain(": done, 2 added, 1 updated, 1 removed");
  // A hub job: no prompt to edit, no webhook, no delete.
  for (const label of ["Edit", "Delete", "Rotate webhook URL", "Pause"]) expect(() => button(label, row)).toThrow();

  // Run now, held by the refresh's rules: the hub says why it didn't start.
  await click(button("Run now", row));
  expect(hub.calls.find((c) => c.tool === "memory_refresh_run")?.input).toEqual({ projectRef: project });
  expect(row.textContent).toContain("Not run: Nothing new in the chat or its orders since the last refresh.");
  delete hub.refresh.why;
  await click(button("Run now", card("Nightly memory refresh") as HTMLElement));
  const started = card("Nightly memory refresh") as HTMLElement;
  expect(started.textContent).toContain("Refreshing: a line in the chat lists what it changed.");
  expect(started.textContent).toContain("Running");
  expect(started.textContent).toContain("(Run now): running, no changes");
  expect(button("Run now", started).disabled).toBe(true);

  // The switch is the project's own setting.
  act(() => (started.querySelector("button[role='switch']") as HTMLElement).click());
  await flush();
  expect(hub.calls.find((c) => c.tool === "project_settings_set")?.input).toEqual({ ...project, memoryRefresh: false });
  const off = card("Nightly memory refresh") as HTMLElement;
  expect(off.textContent).toContain("Off");
  expect(off.textContent).not.toContain("Next run");
});
