// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoApproved } from "../../../shared/contracts";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { ApprovalsSetting } from "./Approvals";
import { PROJECT_TOOLS } from "../projects/model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

const REF = { machineId: "devbox", projectId: "p1" };
const NEWEST = Date.parse("2026-10-31T16:42:00.000Z");

/** A busy project's log, newest first, its row numbers from `size` down: each action runs twice in a row. */
const log = (size: number): Array<{ n: number; entry: AutoApproved }> =>
  Array.from({ length: size }, (_, i) => ({
    n: size - i,
    entry: { at: new Date(NEWEST - i * 60_000).toISOString(), by: "yolo", tool: "WebFetch", what: `Fetch \`site${String(Math.floor(i / 2))}.example\`` },
  }));

let host: HTMLDivElement;
let root: Root;
let calls: Array<Record<string, unknown>>;
let entries: Array<{ n: number; entry: AutoApproved }>;

/** As the hub answers project_approvals: `limit` from the newest, or before the row `before`. */
const answer = (input: Record<string, unknown>) => {
  const before = typeof input["before"] === "number" ? input["before"] : Number.MAX_SAFE_INTEGER;
  const limit = typeof input["limit"] === "number" ? input["limit"] : 200;
  const rows = entries.filter((e) => e.n < before).slice(0, limit + 1);
  const shown = rows.slice(0, limit);
  const last = shown[shown.length - 1];
  return {
    approvals: { mode: "yolo", model: "claude-sonnet-5-5", effort: "medium", defaults: true },
    log: shown.map((e) => e.entry),
    ...(rows.length > limit && last !== undefined ? { older: last.n } : {}),
    total: entries.length,
  };
};

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  calls = [];
  entries = log(400);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

const render = async () => {
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      if (tool === PROJECT_TOOLS.approvals) {
        calls.push(input as Record<string, unknown>);
        return Promise.resolve({ ok: true, output: answer(input as Record<string, unknown>) });
      }
      return Promise.resolve({ ok: false, error: { code: "not_found", message: tool } });
    },
    subscribe: (l) => ((listener = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  const layer = createDataLayer(hub);
  await act(async () => {
    root.render(
      <UiProvider>
        <DataProvider layer={layer}>
          <ApprovalsSetting projectRef={REF} />
        </DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    listener({ t: "state", state: { phase: "live", hub: "devbox:4710", protocol: 1, features: [] } });
    listener({ t: "snapshot", snapshot: { cursor: 1, attention: [], machines: [], projects: [] } });
    await new Promise((r) => setTimeout(r, 0));
  });
  await settle();
};

const button = (text: string) => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === text);
  if (b === undefined) throw new Error(`no button ${text}`);
  return b;
};
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
  await settle();
};
const rows = () => [...document.querySelectorAll('[role="list"][aria-label="Ran without asking"] [role="listitem"]')];

describe("Ran without asking", () => {
  it("shows the newest five, repeats folded, and reads only the first page", async () => {
    await render();
    expect(calls).toEqual([{ ...REF, limit: 25 }]);
    expect(rows()).toHaveLength(5);
    expect(rows()[0]?.textContent).toContain("Fetch site0.example");
    expect(rows()[0]?.textContent).toContain("2 times");
    expect(rows()[1]?.textContent).toContain("Fetch site1.example");
    expect(button("Show all 400").getAttribute("aria-expanded")).toBe("false");
  });

  it("shows the rest in a bounded list that reads older pages, every entry reachable, and folds back", async () => {
    await render();
    await click(button("Show all 400"));
    // The first page as read, folded: 25 entries, 13 rows.
    expect(rows()).toHaveLength(13);
    expect(document.querySelector('[role="list"][aria-label="Ran without asking"]')?.parentElement?.className).toMatch(/logAll/u);
    while ([...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Show older")) await click(button("Show older"));
    expect(calls.slice(1).every((c) => c["limit"] === 50 && typeof c["before"] === "number")).toBe(true);
    expect(calls).toHaveLength(1 + Math.ceil((400 - 25) / 50));
    expect(rows()).toHaveLength(200);
    expect(rows().at(-1)?.textContent).toContain("Fetch site199.example");
    await click(button("Show fewer"));
    expect(rows()).toHaveLength(5);
  });

  it("offers nothing more when the whole log fits", async () => {
    entries = log(6);
    await render();
    expect(rows()).toHaveLength(3);
    expect([...document.querySelectorAll("button")].some((b) => b.textContent.startsWith("Show all"))).toBe(false);
  });
});
