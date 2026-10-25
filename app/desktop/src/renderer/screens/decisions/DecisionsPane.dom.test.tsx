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
    expect(rows[0]?.textContent).toContain("You · Checkout v2 · 1 earlier");
    expect(rows[1]?.textContent).toContain("API health path");
    expect(rows[1]?.textContent).toContain("Lead · Whole project");
    expect(host.textContent).not.toMatch(/\b[DW]\d+\b/u);
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
    expect(host.textContent).toContain("Nothing decided yet");
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
