// @vitest-environment happy-dom
// The merge line in the Shipping list (prs/PrsPane at `/train`): what merges now as a card among the PRs, read from
// the hub's changes and followed on its events.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Change, ChangesListInput } from "../../../shared/contracts";
import type { CallOutcome } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { AT, event, live, project, snapshot } from "../../src/data/fixtures.test-util";
import { UiProvider } from "../../ui";
import { forgetFolds } from "../panel/folds";
import { PrsPane } from "../prs/PrsPane";
import { trainFixture } from "./fixture";
import { LINE_STATES } from "./model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
// happy-dom has no layout: the list is 900 px tall and a row 56 px, so every row renders.
const heightOf = (el: Element): number => (el.getAttribute("role") === "list" ? 900 : el instanceof HTMLElement && el.dataset["index"] !== undefined ? 56 : 0);

beforeEach(() => {
  const proto = HTMLElement.prototype;
  const rect = proto.getBoundingClientRect.bind(proto);
  vi.spyOn(proto, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const h = heightOf(this);
    return h > 0 ? new DOMRect(0, 0, 400, h) : rect.call(this);
  });
  // offsetHeight too: the list's own first measure of a row reads it, and a row of no height above the fold scrolls the list.
  for (const height of ["clientHeight", "offsetHeight"]) Object.defineProperty(proto, height, { configurable: true, get: function (this: HTMLElement) { return heightOf(this); } });
  forgetFolds();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const settle = async () => {
  for (let i = 0; i < 5; i++) await act(() => new Promise((done) => setTimeout(done, 0)));
};

type Answer = (tool: string, input: unknown) => CallOutcome | Promise<CallOutcome>;

/** changes_list as the hub answers it, one state a read, from `changes()`; pr_list and pr_get from the fixture. */
const hubOf = (changes: () => readonly Change[], batch = false): Answer => {
  const t = trainFixture(project, AT, batch);
  return (tool, input) => {
    if (tool === "changes_list") {
      const { state } = input as ChangesListInput;
      return { ok: true, output: { changes: changes().filter((c) => c.state === state) } };
    }
    // pr_list says where each PR stands as the changes do.
    if (tool === "pr_list") {
      const now = new Map(changes().map((c) => [c.prNumber, c.state]));
      return { ok: true, output: { at: AT, prs: t.prs.map((r) => (now.get(r.number) === "merged" ? { ...r, state: "merged" as const, queue: undefined } : r)) } };
    }
    if (tool === "pr_get") {
      const n = (input as { number: number }).number;
      const head = t.heads.find((h) => h.pr.number === n);
      return head === undefined ? { ok: false, error: { code: "not_found", message: "no such PR" } } : { ok: true, output: head };
    }
    return { ok: true, output: {} };
  };
};

const mount = async (answer: Answer, { online = true, of = project, at = "train" }: { online?: boolean; of?: typeof project; at?: "train" | null } = {}) => {
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
          <PrsPane project={of} pr={null} tab="overview" onTab={() => undefined} at={at} />
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
/** The card, unless it is one fading where it stood. */
const card = () => [...host.querySelectorAll("[data-moving]")].find((el) => el.closest("[data-leaving]") === null) ?? null;
const prs = (el: Element | null) => [...(el?.querySelectorAll<HTMLAnchorElement>("a[data-pr]") ?? [])].map((a) => Number(a.dataset["pr"]));
/** The list top to bottom: a label's words, the card, a row's number. */
const order = () =>
  [...host.querySelectorAll<HTMLElement>("[data-group-label], [data-moving], a[data-pr]")]
    .filter((el) => el.closest("[data-leaving]") === null && (el.closest("[data-moving]") === null || el.matches("[data-moving]")))
    .map((el) => (el.matches("[data-moving]") ? "card" : el.dataset["pr"] !== undefined ? Number(el.dataset["pr"]) : el.textContent));

describe("the merge line in Shipping", () => {
  it("shows what merges now as a card with its checks, the PRs that need a look above it, and the line behind it in the train's order", async () => {
    const { changes } = trainFixture(project, AT);
    // From the top, as the tab opens it; a link to the merge line (`/train`) opens the same list at the card.
    await mount(hubOf(() => changes), { at: null });
    expect(screen()).toBe("prs");
    expect(order()).toEqual(["Needs a look2", 23, 19, "Merging now", "card", "In line3", 21, 22, 24, "Merged and closed6"]);

    expect(prs(card())).toEqual([20]);
    expect(card()?.textContent).toContain("Running CI");
    expect([...(card()?.querySelectorAll("[aria-label='Checks'] li") ?? [])].map((li) => li.textContent)).toEqual([
      "e2e (chromium)running",
      "unit testsrunning",
      "buildpassed",
      "lintpassed",
      "typecheckpassed",
      "licensesskipped",
    ]);

    // A row is its title and where it stands; why the train holds it is its hover's, with its number and branch.
    const held = host.querySelector<HTMLAnchorElement>("a[data-pr='23']");
    expect(held?.textContent).toContain("held");
    expect(host.textContent).not.toContain("the PR has the hold label");
    act(() => held?.focus());
    expect(document.querySelector("[role='tooltip']")?.textContent).toBe("the PR has the hold label; the train takes it once the label is gone" + "storefront#23 · fleetd/webhook-backoff");
    expect(host.querySelector("a[data-pr='19']")?.textContent).toContain("conflicts");
    // Each row, and the card's, opens its PR.
    expect(host.querySelector("a[data-pr='21']")?.getAttribute("href")).toBe("#/project/devbox/storefront/prs/acme/storefront/21");
    expect(card()?.querySelector("a[data-pr]")?.getAttribute("href")).toBe("#/project/devbox/storefront/prs/acme/storefront/20");
  });

  it("reads the line, each state whole, never just the newest changes", async () => {
    const { changes } = trainFixture(project, AT);
    const { calls } = await mount(hubOf(() => changes));
    const reads = calls.filter((c) => c.tool === "changes_list").map((c) => c.input as ChangesListInput);
    expect(reads).toHaveLength(LINE_STATES.length);
    for (const state of LINE_STATES) expect(reads).toContainEqual({ projectRef: project, state, limit: 100 });
  });

  it("shows a batch as one card, and asks for no PR's checks for it", async () => {
    const { changes } = trainFixture(project, AT, true);
    const { calls } = await mount(hubOf(() => changes, true));
    expect(card()?.textContent).toContain("Batch of 3");
    expect(prs(card())).toEqual([25, 26, 27]);
    // What the train does with a batch is its stage's hover.
    act(() => card()?.querySelector<HTMLElement>("[tabindex='0']")?.focus());
    expect(document.querySelector("[role='tooltip']")?.textContent).toBe("One CI run for all 3; green, they land together.");
    expect(calls.some((c) => c.tool === "pr_get")).toBe(false);
  });

  it("follows the train live on the hub's change events", async () => {
    const { changes } = trainFixture(project, AT);
    let now = changes;
    const hub = await mount(hubOf(() => now), { at: null });
    expect(prs(card())).toEqual([20]);
    now = changes.map((c) => (c.prNumber === 20 ? { ...c, state: "merged", mergedSha: "c".repeat(40), updatedAt: "2026-10-19T10:01:00.000Z" } : c));
    hub.send(event(2, "change.state", { changeId: "X20", from: "ci", to: "merged", prNumber: 20, repo: "acme/storefront" }));
    await act(() => new Promise((done) => setTimeout(done, 150)));
    await settle();
    expect(card()).toBeNull();
    expect(order()).toContain("Merged and closed7");
  });

  it("says a train with nothing on it by the list alone, a train it couldn't read above the list with Retry, and so offline or for a project the hub lacks", async () => {
    const { changes, prs: rows } = trainFixture(project, AT);
    const ok = hubOf(() => changes);
    await mount((tool, input) => (tool === "changes_list" ? { ok: true, output: { changes: [] } } : tool === "pr_list" ? { ok: true, output: { at: AT, prs: rows.filter((r) => r.state !== "open") } } : ok(tool, input)));
    expect(screen()).toBe("train.empty");
    expect(card()).toBeNull();
    expect(host.querySelector("[data-list-note]")?.textContent).toBe("Nothing open.");

    act(() => root.unmount());
    root = createRoot(host);
    let fail = true;
    await mount((tool, input) => (tool === "changes_list" && fail ? { ok: false, error: { code: "invalid", message: "no" } } : ok(tool, input)));
    expect(screen()).toBe("train.error");
    expect(host.querySelector("[role='alert']")?.textContent).toContain("Couldn’t read what merges now");
    // The PRs are still listed: only the card is missing, so its PR waits with the line.
    expect(order()).toEqual(["Needs a look2", 23, 19, "In line4", 21, 22, 24, 20, "Merged and closed6"]);
    fail = false;
    const retry = [...host.querySelectorAll("button")].find((b) => b.textContent === "Retry");
    act(() => retry?.click());
    await settle();
    expect(screen()).toBe("train");
    expect(host.querySelector("[role='alert']")).toBeNull();

    act(() => root.unmount());
    root = createRoot(host);
    await mount((tool, input) => (tool === "changes_list" ? new Promise(() => undefined) : ok(tool, input)));
    expect(screen()).toBe("train.loading");
    expect(card()).toBeNull();
    expect(prs(host)).toContain(21);

    act(() => root.unmount());
    root = createRoot(host);
    await mount(ok, { online: false });
    expect(host.textContent).toContain("Pull requests show once you’re connected.");

    act(() => root.unmount());
    root = createRoot(host);
    await mount(ok, { of: { machineId: "devbox", projectId: "gone" } as unknown as typeof project });
    expect(screen()).toBe("prs.missing");
  });
});
