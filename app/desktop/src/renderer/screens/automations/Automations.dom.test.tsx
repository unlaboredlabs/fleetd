// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Automation, AutomationRun, MemoryRefreshJob, ToolInput, ToolName, WatchKind } from "../../../shared/contracts";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { event, live, project, snapshot } from "../../src/data/fixtures.test-util";
import { TooltipProvider } from "../../ui/primitives/Tooltip";
import { Automations } from "./Automations";
import { chooseFromRow } from "../settings/rowMenu.testing";

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
  vi.restoreAllMocks();
});

/** A hub that keeps automations and their runs in memory, as automation_* answer them. */
function fakeHub() {
  const automations: Automation[] = [];
  const runs: AutomationRun[] = [];
  const calls: Array<{ tool: string; input: unknown }> = [];
  // The nightly memory refresh, as automation_list lists it.
  const refresh: { job: MemoryRefreshJob; why?: string } = { job: { on: true, at: "04:00", tz: "Europe/Berlin", nextRunAt: "2026-10-18T02:00:00.000Z" } };
  // What the bot can watch: its repo's CI, or (no repo) only Something else.
  const bot: { watchable: WatchKind[] } = { watchable: ["main_ci", "other"] };
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
          watchable: bot.watchable,
        });
      }
      if (name === "profiles_list") return ok({ profiles: [{ id: 1, name: "opus", default: true }], allowed: ["opus", "sonnet"], efforts: [], models: [] });
      if (name === "memory_refresh_run") {
        if (refresh.why === undefined) refresh.job = { ...refresh.job, lastRun: { at: AT, trigger: "manual", state: "running", added: 0, replaced: 0, removed: 0 } };
        return ok({ memoryRefresh: refresh.job, ...(refresh.why === undefined ? {} : { why: refresh.why }) });
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
          ...(input.watch ? { watch: input.watch, lastDay: { runs: 3, spoke: 1, costUsd: 0.042 } } : {}),
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
        const a = { ...find(input.automationId), ...(input.name ? { name: input.name } : {}), ...(input.watch ? { watch: input.watch } : {}) };
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
  return { api, calls, automations, runs, refresh, bot, send: (f: Parameters<typeof send>[0]) => send(f) };
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
          <Automations route={{ tab: "automations", prompt: null, for: `${project.machineId}/${project.projectId}` }} />
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
  const found = [...within.querySelectorAll("button")].find((b) => b.textContent.trim() === label || b.getAttribute("aria-label") === label);
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

it("makes, edits, pauses, runs and deletes an automation and shows its runs, each linked to its message in the chat", async () => {
  // Its zone is this computer's, named in the preview.
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({ ...new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Berlin" }).resolvedOptions() });
  const hub = await mount();
  expect(host.querySelector("[data-screen]")?.getAttribute("data-screen")).toBe("settings.automations");
  expect(host.textContent).toContain("storefront has no automations yet.");

  // Create: the editor previews the schedule in words, and the new webhook's URL is shown once.
  await click(button("New automation", host));
  const form = editor();
  const [name, cron] = [...form.querySelectorAll("input")] as HTMLInputElement[];
  fill(name as HTMLInputElement, "Dependency check");
  fill(form.querySelector("textarea") as HTMLTextAreaElement, "Check the dependencies for updates.");
  fill(cron as HTMLInputElement, "0 9 * * 1-5");
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

  // Run now: the run opens an order, and Runs lists it, with no order number.
  await click(button("Run now", c));
  expect(c.textContent).toContain("Running. Follow it in the chat.");
  const after = card("Dependency check") as HTMLElement;
  await click(button("Runs", after));
  const runs = () => after.querySelector("ul[aria-label='Runs']") as HTMLElement;
  expect(runs().textContent).toContain("Run now");
  expect(runs().textContent).not.toContain("W7");
  expect(runs().querySelector("a")).toBeNull();
  expect(after.textContent).toContain("Last run Sat 17 Oct, 10:00: running");
  // Its end comes as an event: the row stops saying Running, and the run opens its message in the chat.
  hub.runs[0] = { ...(hub.runs[0] as AutomationRun), state: "done", endedAt: AT, messageId: "m42", said: "3 dependencies have updates" };
  await act(async () => {
    hub.send(event(2, "automation.run", { automationId: "au_test001", runId: hub.runs[0]?.runId, state: "done", projectRef: project }));
    await new Promise((done) => setTimeout(done, 150));
  });
  await flush();
  expect(runs().textContent).not.toContain("Running");
  expect(after.textContent).toContain("Last run Sat 17 Oct, 10:00: done");
  const link = runs().querySelector("a") as HTMLAnchorElement;
  expect(link.textContent).toBe("3 dependencies have updates");
  expect(link.getAttribute("href")).toBe("#/project/devbox/storefront?message=m42");

  // Pause and resume.
  await chooseFromRow("Dependency check", "Pause");
  await flush();
  expect(hub.calls.filter((x) => x.tool === "automation_pause").map((x) => x.input)).toEqual([{ automationId: "au_test001", paused: true }]);
  expect((card("Dependency check") as HTMLElement).textContent).toContain("Paused");
  await chooseFromRow("Dependency check", "Resume");
  await flush();
  expect(hub.automations[0]?.paused).toBe(false);

  // Edit sends only what changed.
  await chooseFromRow("Dependency check", "Edit");
  await flush();
  fill(editor().querySelector("input") as HTMLInputElement, "Weekday dependency check");
  await click(button("Save", editor()));
  expect(hub.calls.find((x) => x.tool === "automation_update")?.input).toEqual({ automationId: "au_test001", name: "Weekday dependency check" });
  expect(card("Weekday dependency check")).not.toBeNull();

  // Delete asks first.
  await chooseFromRow("Weekday dependency check", "Delete");
  await flush();
  expect(document.body.textContent).toContain("Orders its runs opened stay.");
  await click(button("Delete", [...document.querySelectorAll<HTMLElement>("[role='dialog']")].at(-1) ?? document.body));
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
  // The schedule's problem is said once, under its field, not again in the preview below it.
  expect(form.textContent.split("day of week 9 is outside 0-7.").length).toBe(2);
  expect(hub.calls.some((c) => c.tool === "automation_create")).toBe(false);
});

it("makes a one-time run: Once offers tomorrow at 09:00, and Repeats goes back to the cron", async () => {
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({ ...new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Berlin" }).resolvedOptions() });
  const hub = await mount();
  await click(button("New automation", host));
  const form = editor();
  fill(form.querySelector("input") as HTMLInputElement, "Release notes");
  fill(form.querySelector("textarea") as HTMLTextAreaElement, "Write the release notes.");
  await click(button("Once", form));
  const at = form.querySelector("input[type='datetime-local']") as HTMLInputElement;
  const tomorrow = new Date(NOW);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const day = `${String(tomorrow.getFullYear())}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
  expect(at.value).toBe(`${day}T09:00`);
  await click(button("Repeats", form));
  expect(form.querySelector("input[type='datetime-local']")).toBeNull();
  await click(button("Once", form));
  fill(form.querySelector("input[type='datetime-local']") as HTMLInputElement, "2026-11-03T18:00");
  expect(form.textContent).toContain("Once, Tue 3 Nov 2026 at 18:00 (Europe/Berlin)");
  await click(button("Create", form));
  expect(hub.calls.find((c) => c.tool === "automation_create")?.input).toMatchObject({ name: "Release notes", schedule: { at: "2026-11-03T18:00", tz: "Europe/Berlin" } });
});

it("leaves the nightly memory refresh to Instructions & memory, and the time zone to this computer", async () => {
  await mount();
  expect(card("Nightly memory refresh")).toBeNull();
  expect(host.querySelector("[data-builtin]")).toBeNull();
  await click(button("New automation", host));
  expect(editor().textContent).not.toContain("Time zone");
  expect(editor().querySelector("[aria-label='Schedule preview']")?.textContent).toMatch(/\(.+\)$/u);
});

it("watches Main's CI from the Watching group: + picks it, how often and the profile; its row shows them and its cost", async () => {
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({ ...new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Berlin" }).resolvedOptions() });
  const hub = await mount();
  const group = () => host.querySelector("[data-group='watching']") as HTMLElement;
  expect(group().textContent).toContain("Nothing watched yet.");
  // Deploys isn't offered: this bot's repo has no GitHub deployments.
  await click(button("New watcher", group()));
  expect(button("Main's CI", group())).toBeTruthy();
  expect(() => button("Deploys", group())).toThrow();
  await click(button("15 min", group()));
  await click(button("Watch", group()));
  expect(hub.calls.find((c) => c.tool === "automation_create")?.input).toMatchObject({
    projectRef: project,
    name: "Main's CI",
    schedule: { tz: "Europe/Berlin" },
    watch: { kind: "main_ci", every: "15m" },
  });
  const row = host.querySelector("[data-watcher]") as HTMLElement;
  expect(row.textContent).toContain("Main's CI");
  expect(row.textContent).toContain("Every 15 min · opus · $0.0420 in 24 h");
  // It isn't one of the automations below.
  expect(host.textContent).toContain("storefront has no automations yet.");
  // A preset is one per bot: the + now offers only Something else, which needs its sentence.
  await click(button("New watcher", group()));
  expect(() => button("Main's CI", group())).toThrow();
  await click(button("Watch", group()));
  expect(group().textContent).toContain("Say in one sentence what to watch.");
  await click(button("Cancel", group()));

  // Its switch pauses it; Edit changes how often.
  act(() => (row.querySelector("button[role='switch']") as HTMLElement).click());
  await flush();
  expect(hub.calls.filter((c) => c.tool === "automation_pause").map((c) => c.input)).toEqual([{ automationId: "au_test001", paused: true }]);
  // Its menu, by its label: a name with an apostrophe makes no selector.
  const more = [...row.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Main's CI: more") as HTMLElement;
  act(() => void more.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" })));
  const edit = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find((i) => i.textContent.trim() === "Edit") as HTMLElement;
  await click(edit);
  await click(button("Daily", group()));
  await click(button("Save", group()));
  expect(hub.calls.find((c) => c.tool === "automation_update")?.input).toEqual({ automationId: "au_test001", watch: { kind: "main_ci", every: "day" } });
});

it("on a bot with no repo, says watchers check anything and asks only what to watch, with no switch of one", async () => {
  const hub = await mount((h) => (h.bot.watchable = ["other"]));
  const group = () => host.querySelector("[data-group='watching']") as HTMLElement;
  expect(group().textContent).toContain("Watchers check something on a schedule and say one line in the chat only when it changes.");
  expect(group().textContent).not.toContain("your software");
  await click(button("New watcher", group()));
  expect(() => button("Something else", group())).toThrow();
  expect(group().querySelector("[role='radiogroup'][aria-label='Watch']")).toBeNull();
  fill(group().querySelector("input") as HTMLInputElement, "Tell me if the headphones drop below 300 dollars");
  await click(button("Watch", group()));
  expect(hub.calls.find((c) => c.tool === "automation_create")?.input).toMatchObject({
    name: "Tell me if the headphones drop below 300 dollars",
    watch: { kind: "other", every: "hour" },
  });
});
