// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Decision, DecisionsListOutput } from "../../../shared/contracts";
import type { CallOutcome } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { event, live, project, snapshot } from "../../src/data/fixtures.test-util";
import { UiProvider } from "../../ui";
import { forgetFolds } from "../panel/folds";
import { DecisionsPane } from "./DecisionsPane";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const scope = { kind: "project", projectRef: project } as const;
const health: Decision = {
  decisionId: "D12",
  key: "api.health.path",
  scope,
  value: "/healthz",
  why: "the load balancer's default",
  source: "lead",
  by: "lead:devbox/storefront",
  state: "active",
  at: "2026-10-19T09:00:00.000Z",
};
const provider: Decision = {
  decisionId: "D14",
  key: "payments.provider",
  scope: { kind: "workstream", workstreamId: "W3" },
  value: "adyen",
  source: "human",
  by: "human:desk",
  state: "active",
  at: "2026-10-19T09:30:00.000Z",
  supersedes: "D13",
};
const { supersedes: _replaced, ...first } = provider;
const before: Decision = { ...first, decisionId: "D13", value: "stripe", source: "lead", by: "lead:devbox/storefront", state: "superseded", at: "2026-10-18T09:30:00.000Z" };
const LIST: DecisionsListOutput = { decisions: [provider, health, before], orders: [{ workstreamId: "W3", title: "Checkout v2" }] };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  forgetFolds();
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

/** A hub whose decisions_list answers `list()` and whose decisions_overturn answers `overturn`. */
const mount = async (list: () => CallOutcome, overturn: (input: unknown) => CallOutcome = () => ({ ok: true, output: {} })) => {
  let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;
  const calls: { tool: string; input: unknown }[] = [];
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input });
      if (tool === "decisions_list") return Promise.resolve(list());
      if (tool === "decisions_overturn") return Promise.resolve(overturn(input));
      return Promise.resolve({ ok: true, output: {} });
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
          <DecisionsPane project={project} />
        </DataProvider>
      </UiProvider>,
    );
  });
  act(() => {
    send(live());
    send(snapshot(1));
  });
  await settle();
  return { calls, send: (f: Parameters<typeof send>[0]) => act(() => send(f)) };
};

const screen = () => host.querySelector("[data-screen]")?.getAttribute("data-screen");
const button = (name: string | RegExp): HTMLButtonElement => {
  const b = [...host.querySelectorAll("button")].find((x) => (typeof name === "string" ? x.textContent.trim() === name : name.test(x.textContent)));
  if (b === undefined) throw new Error(`no button ${String(name)} in: ${host.textContent}`);
  return b;
};
const type = (el: HTMLInputElement | HTMLTextAreaElement, text: string) => {
  act(() => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("the Decisions pane", () => {
  it("shows each value first, the key in words and who decided where, never an id", async () => {
    await mount(() => ({ ok: true, output: LIST }));
    expect(screen()).toBe("decisions");
    const rows = [...host.querySelectorAll("[data-decision]")];
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining("adyen"), expect.stringContaining("/healthz")]);
    expect(rows[0]?.textContent).toContain("Payments provider");
    expect(rows[1]?.textContent).toContain("API health path");
    // Who decided, where it applies and how many came before are a row's hover, not a line under it.
    expect(host.textContent).not.toMatch(/Checkout v2|Whole project|earlier/u);
    act(() => rows[0]?.querySelector("button")?.focus());
    expect(document.querySelector("[role='tooltip']")?.textContent).toBe("You · Checkout v2 · 1 earlier");
    act(() => rows[1]?.querySelector("button")?.focus());
    expect(document.querySelector("[role='tooltip']")?.textContent).toBe("Lead · Whole project");
    expect(host.textContent).not.toMatch(/\b[DW]\d+\b/u);
  });

  it("has one line above the list: the way back to History, the search, and one filter; no selects and no tabs", async () => {
    await mount(() => ({ ok: true, output: LIST }));
    const toolbar = host.querySelector("[data-screen] > div");
    expect([...(toolbar?.querySelectorAll("button, input") ?? [])].map((c) => c.getAttribute("aria-label"))).toEqual(["History", "Search decisions", "Filter decisions"]);
    expect(host.querySelector("select, [role='tablist'], [role='tab'], [role='combobox']")).toBeNull();
    expect([...host.querySelectorAll("[data-group-label]")].map((l) => l.textContent)).toEqual(["In force2"]);
    // The filter is who decided and where it applies, in one menu.
    act(() => void host.querySelector("[aria-label='Filter decisions']")?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    const choices = [...document.querySelectorAll<HTMLElement>("[role='menuitemradio']")];
    expect(choices.map((i) => i.textContent)).toEqual(["Anyone", "The lead", "You", "Everywhere", "Whole project", "Checkout v2"]);
    act(() => choices[2]?.click());
    await settle();
    expect([...host.querySelectorAll("[data-decision]")].map((r) => r.textContent)).toEqual([expect.stringContaining("adyen")]);
    expect(host.querySelector("[aria-label='Filter decisions']")?.getAttribute("aria-pressed")).toBe("true");

    window.location.hash = "";
    act(() => host.querySelector<HTMLButtonElement>("[aria-label='History']")?.click());
    expect(window.location.hash).toBe("#/project/devbox/storefront/activity");
  });

  it("folds the revoked ones under their count at the list's end", async () => {
    const gone: Decision = { ...health, decisionId: "D9", key: "api.port", value: "8080", state: "retired", retired: { by: "human:desk", at: "2026-10-19T11:00:00.000Z", why: "moved" } };
    await mount(() => ({ ok: true, output: { ...LIST, decisions: [...LIST.decisions, gone] } }));
    expect([...host.querySelectorAll("[data-group-label]")].map((l) => l.textContent)).toEqual(["In force2", "Revoked1"]);
    expect(host.querySelectorAll("[data-decision='revoked']")).toHaveLength(0);
    act(() => button(/^Revoked/u).click());
    expect([...host.querySelectorAll("[data-decision='revoked']")].map((r) => r.textContent)).toEqual([expect.stringContaining("8080")]);
  });

  it("lists the revoked ones under a plain label while a search narrows the list, and leaves their fold as you left it", async () => {
    const gone: Decision = { ...health, decisionId: "D9", key: "api.port", value: "8080", state: "retired", retired: { by: "human:desk", at: "2026-10-19T11:00:00.000Z", why: "moved" } };
    await mount(() => ({ ok: true, output: { ...LIST, decisions: [...LIST.decisions, gone] } }));
    const fold = () => host.querySelector<HTMLButtonElement>("[data-group-label] button[aria-expanded]");
    const revoked = () => [...host.querySelectorAll("[data-decision='revoked']")].map((r) => r.textContent);
    expect(fold()?.getAttribute("aria-expanded")).toBe("false");

    const search = host.querySelector<HTMLInputElement>("input[type=search]");
    if (search === null) throw new Error("no search");
    // "balancer" is the why of both /healthz and the revoked 8080.
    type(search, "balancer");
    expect([...host.querySelectorAll("[data-group-label]")].map((l) => l.textContent)).toEqual(["In force1", "Revoked1"]);
    expect(revoked()).toEqual([expect.stringContaining("8080")]);
    // Nothing to click that would do nothing: the label is no button while the list is narrowed.
    expect(fold()).toBeNull();
    expect(host.querySelector("[aria-label='Revoked'] [role='heading']")?.textContent).toBe("Revoked");

    // Cleared, the fold is back, closed as it was left.
    type(search, "");
    expect(fold()?.getAttribute("aria-expanded")).toBe("false");
    expect(revoked()).toEqual([]);

    // And open as it was left: unfolded, searched, cleared.
    act(() => fold()?.click());
    type(search, "balancer");
    expect(fold()).toBeNull();
    type(search, "");
    expect(fold()?.getAttribute("aria-expanded")).toBe("true");
    expect(revoked()).toEqual([expect.stringContaining("8080")]);
  });

  it("lists the revoked ones under a plain label when nothing is in force", async () => {
    const gone: Decision = { ...health, state: "retired", retired: { by: "human:desk", at: "2026-10-19T11:00:00.000Z", why: "moved" } };
    await mount(() => ({ ok: true, output: { decisions: [gone], orders: [] } }));
    expect([...host.querySelectorAll("[data-group-label]")].map((l) => l.textContent)).toEqual(["Revoked1"]);
    expect(host.querySelector("[data-group-label] button")).toBeNull();
    expect(host.querySelectorAll("[data-decision='revoked']")).toHaveLength(1);
  });

  it("opens a row to its why and what it replaced", async () => {
    await mount(() => ({ ok: true, output: LIST }));
    act(() => button(/adyen/u).click());
    expect(button(/adyen/u).getAttribute("aria-expanded")).toBe("true");
    expect(host.textContent).toContain("No reason was given.");
    expect(host.textContent).toContain("stripe");
    expect(host.textContent).toContain("Lead · ");
    expect(host.textContent).toContain("Replaced");
  });

  it("searches and filters, and says when nothing matches", async () => {
    await mount(() => ({ ok: true, output: LIST }));
    const search = host.querySelector<HTMLInputElement>("input[type=search]");
    if (search === null) throw new Error("no search");
    type(search, "balancer");
    expect([...host.querySelectorAll("[data-decision]")].map((r) => r.textContent)).toEqual([expect.stringContaining("/healthz")]);
    type(search, "nothing like this");
    expect(host.textContent).toContain("No decision matches.");
    act(() => button("Clear search and filters").click());
    expect(host.querySelectorAll("[data-decision]")).toHaveLength(2);
  });

  it("revokes with a why, asks for one first, and reads the list again", async () => {
    const hub = await mount(() => ({ ok: true, output: LIST }));
    act(() => button(/healthz/u).click());
    act(() => button("Revoke…").click());
    act(() => button("Revoke").click());
    expect(host.textContent).toContain("Say why, in a few words");
    expect(hub.calls.some((c) => c.tool === "decisions_overturn")).toBe(false);
    const why = host.querySelector<HTMLTextAreaElement>("form textarea");
    if (why === null) throw new Error("no why");
    type(why, "the probe moved to /livez");
    const reads = hub.calls.filter((c) => c.tool === "decisions_list").length;
    act(() => button("Revoke").click());
    await settle();
    expect(hub.calls.find((c) => c.tool === "decisions_overturn")?.input).toEqual({ decisionId: "D12", why: "the probe moved to /livez" });
    expect(host.querySelector("form")).toBeNull();
    expect(hub.calls.filter((c) => c.tool === "decisions_list").length).toBeGreaterThan(reads);
  });

  it("changes a value, and shows the hub's refusal in place", async () => {
    const hub = await mount(
      () => ({ ok: true, output: LIST }),
      () => ({ ok: false, error: { code: "forbidden", message: "decisions_overturn speaks for the human, and this is an agent key.", fix: "Send it from the desktop app." } }),
    );
    act(() => button(/healthz/u).click());
    act(() => button("Change…").click());
    const [value, why] = [...host.querySelectorAll<HTMLTextAreaElement>("form textarea")];
    if (value === undefined || why === undefined) throw new Error("no fields");
    expect(value.value).toBe("/healthz");
    type(value, "/livez");
    type(why, "the probe moved");
    act(() => button("Save change").click());
    await settle();
    expect(hub.calls.find((c) => c.tool === "decisions_overturn")?.input).toEqual({ decisionId: "D12", value: "/livez", why: "the probe moved" });
    expect(host.querySelector("[role=alert]")?.textContent).toContain("Send it from the desktop app.");
  });

  it("reads again on the hub's decision events", async () => {
    let answer = LIST;
    const hub = await mount(() => ({ ok: true, output: answer }));
    answer = { ...LIST, decisions: [{ ...health, state: "retired", retired: { by: "human:desk", at: "2026-10-19T11:00:00.000Z", why: "moved" } }] };
    hub.send(event(2, "decision.retired", { decisionId: "D12" }));
    await act(() => new Promise((done) => setTimeout(done, 150)));
    await settle();
    expect(host.textContent).toContain("Revoked");
    expect(host.querySelector("[data-decision]")?.getAttribute("data-decision")).toBe("revoked");
  });

  it("has an empty state, an error with Retry, and a loading state", async () => {
    await mount(() => ({ ok: true, output: { decisions: [], orders: [] } }));
    // The way back, by its word where there is nothing to search, and one short line.
    expect(host.textContent).toBe("HistoryNothing decided yet");
    act(() => root.unmount());
    root = createRoot(host);
    await mount(() => ({ ok: false, error: { code: "invalid", message: "no" } }));
    expect(screen()).toBe("decisions.error");
    expect(button("Retry")).toBeDefined();
    act(() => root.unmount());
    root = createRoot(host);
    let hubListen: Parameters<HubApi["subscribe"]>[0] = () => undefined;
    const never: HubApi = {
      call: () => new Promise(() => undefined),
      subscribe: (l) => ((hubListen = l), () => undefined),
      resync: () => Promise.resolve(),
      focus: () => Promise.resolve(),
      chat: () => Promise.resolve(),
    };
    act(() => {
      root.render(
        <UiProvider>
          <DataProvider layer={createDataLayer(never)}>
            <DecisionsPane project={project} />
          </DataProvider>
        </UiProvider>,
      );
    });
    act(() => {
      hubListen(live());
      hubListen(snapshot(1));
    });
    await settle();
    expect(screen()).toBe("decisions.loading");
  });
});
