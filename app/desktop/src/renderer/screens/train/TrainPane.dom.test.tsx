// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Change, ChangesListInput } from "../../../shared/contracts";
import type { CallOutcome } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { AT, event, live, project, snapshot } from "../../src/data/fixtures.test-util";
import { UiProvider } from "../../ui";
import { trainFixture } from "./fixture";
import { OPEN_STATES } from "./model";
import { TrainPane } from "./TrainPane";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const settle = async () => {
  for (let i = 0; i < 5; i++) await act(() => new Promise((done) => setTimeout(done, 0)));
};

type Answer = (tool: string, input: unknown) => CallOutcome | Promise<CallOutcome>;

/** changes_list as the hub answers it, one state a read, from `changes()`; pr_list and pr_get from the fixture. */
const hubOf = (changes: () => readonly Change[], batch = false, cut: ReadonlySet<string> = new Set()): Answer => {
  const t = trainFixture(project, AT, batch);
  return (tool, input) => {
    if (tool === "changes_list") {
      const { state } = input as ChangesListInput;
      return { ok: true, output: { changes: changes().filter((c) => c.state === state), ...(state !== undefined && cut.has(state) ? { truncated: true } : {}) } };
    }
    if (tool === "pr_list") return { ok: true, output: { at: AT, prs: t.prs } };
    if (tool === "pr_get") {
      const n = (input as { number: number }).number;
      const head = t.heads.find((h) => h.pr.number === n);
      return head === undefined ? { ok: false, error: { code: "not_found", message: "no such PR" } } : { ok: true, output: head };
    }
    return { ok: true, output: {} };
  };
};

const mount = async (answer: Answer, { online = true, of = project }: { online?: boolean; of?: typeof project } = {}) => {
  let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;
  const calls: { tool: string; input: unknown }[] = [];
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input });
      return Promise.resolve(answer(tool, input));
    },
    subscribe: (l) => ((send = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  act(() => {
    root.render(
      <UiProvider>
        <DataProvider layer={createDataLayer(hub)}>
          <TrainPane project={of} />
        </DataProvider>
      </UiProvider>,
    );
  });
  if (online) {
    act(() => {
      send(live());
      send(snapshot(1));
    });
  }
  await settle();
  return { calls, send: (f: Parameters<typeof send>[0]) => act(() => send(f)) };
};

const screen = () => host.querySelector("[data-screen]")?.getAttribute("data-screen");
const section = (label: string) => host.querySelector(`section[aria-label='${label}']`);
const prs = (el: Element | null) => [...(el?.querySelectorAll<HTMLAnchorElement>("a[data-pr]") ?? [])].map((a) => Number(a.dataset["pr"]));

describe("the Train pane", () => {
  it("shows what merges now with its checks, the line in order with why each is held, and what landed", async () => {
    const { changes } = trainFixture(project, AT);
    await mount(hubOf(() => changes));
    expect(screen()).toBe("train");

    const head = section("Merging now");
    expect(prs(head)).toEqual([20]);
    expect(head?.textContent).toContain("Running CI");
    expect([...(head?.querySelectorAll("[aria-label='Checks'] li") ?? [])].map((li) => li.textContent)).toEqual([
      "e2e (chromium)running",
      "unit testsrunning",
      "buildpassed",
      "lintpassed",
      "typecheckpassed",
      "licensesskipped",
    ]);

    const line = section("In line");
    expect(prs(line)).toEqual([21, 22, 23, 24, 19]);
    expect(line?.textContent).toContain("the PR has the hold label; the train takes it once the label is gone");
    expect(line?.textContent).toContain("Conflicts with the base");
    expect(line?.querySelector("code")?.textContent).toBe("src/shipping/zones.ts, src/shipping/rates.ts");

    const recent = section("Recent");
    expect(prs(recent)).toEqual([18, 15, 16, 17, 14, 12]);
    expect(recent?.querySelector("[role='group']")?.getAttribute("aria-label")).toBe("Batch of 3, merged together");
    expect(recent?.textContent).toContain("refused");
    // Each row opens its PR in the PRs tab.
    expect(host.querySelector("a[data-pr='21']")?.getAttribute("href")).toBe("#/project/devbox/storefront/prs/acme/storefront/21");
  });

  it("reads each open state whole, never just the newest changes, and says when the hub cut one", async () => {
    const { changes } = trainFixture(project, AT);
    const { calls } = await mount(hubOf(() => changes, false, new Set(["queued"])));
    const reads = calls.filter((c) => c.tool === "changes_list").map((c) => c.input as ChangesListInput);
    expect(reads.every((r) => r.state !== undefined)).toBe(true);
    for (const state of OPEN_STATES) expect(reads).toContainEqual({ projectRef: project, state, limit: 100 });
    expect(host.textContent).toContain("More PRs wait than the hub sends at once");
  });

  it("shows a batch as one group, and asks for no PR's checks for it", async () => {
    const { changes } = trainFixture(project, AT, true);
    const { calls } = await mount(hubOf(() => changes, true));
    const head = section("Merging now");
    expect(head?.textContent).toContain("Batch of 3");
    expect(head?.textContent).toContain("One CI run for all 3; green, they land together.");
    expect(prs(head)).toEqual([25, 26, 27]);
    expect(calls.some((c) => c.tool === "pr_get")).toBe(false);
  });

  it("follows the train live on the hub's change events", async () => {
    const { changes } = trainFixture(project, AT);
    let now = changes;
    const hub = await mount(hubOf(() => now));
    expect(prs(section("Merging now"))).toEqual([20]);
    now = changes.map((c) => (c.prNumber === 20 ? { ...c, state: "merged", mergedSha: "c".repeat(40), updatedAt: "2026-10-19T10:01:00.000Z" } : c));
    hub.send(event(2, "change.state", { changeId: "X20", from: "ci", to: "merged", prNumber: 20, repo: "acme/storefront" }));
    await act(() => new Promise((done) => setTimeout(done, 150)));
    await settle();
    expect(section("Merging now")?.textContent).toContain("Nothing is merging right now.");
    expect(prs(section("Recent"))[0]).toBe(20);
  });

  it("has an empty state, an error with Retry, a loading state, and says so offline or for a project the hub lacks", async () => {
    await mount(hubOf(() => []));
    expect(screen()).toBe("train.empty");
    expect(host.textContent).toContain("Nothing on the train");

    act(() => root.unmount());
    root = createRoot(host);
    let fail = true;
    const { changes } = trainFixture(project, AT);
    const ok = hubOf(() => changes);
    await mount((tool, input) => (tool === "changes_list" && fail ? { ok: false, error: { code: "invalid", message: "no" } } : ok(tool, input)));
    expect(screen()).toBe("train.error");
    fail = false;
    const retry = [...host.querySelectorAll("button")].find((b) => b.textContent === "Retry");
    act(() => retry?.click());
    await settle();
    expect(screen()).toBe("train");

    act(() => root.unmount());
    root = createRoot(host);
    await mount((tool, input) => (tool === "changes_list" ? new Promise(() => undefined) : ok(tool, input)));
    expect(screen()).toBe("train.loading");
    expect(host.querySelector("[aria-label='Loading the merge train']")).not.toBeNull();

    act(() => root.unmount());
    root = createRoot(host);
    await mount(ok, { online: false });
    expect(host.textContent).toContain("The train shows once you’re connected.");

    act(() => root.unmount());
    root = createRoot(host);
    await mount(ok, { of: { machineId: "devbox", projectId: "gone" } as unknown as typeof project });
    expect(screen()).toBe("train.missing");
  });
});
