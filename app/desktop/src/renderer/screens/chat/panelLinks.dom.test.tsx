// @vitest-environment happy-dom
// The chat's ways into the panel: the island's card opens its agents in the Agents tab, and a PR named in the chat opens that PR there.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { PrGetOutput, PrRow } from "../../../shared/contracts";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { AT, card, lane, live, project, snapshot } from "../../src/data/fixtures.test-util";
import { TooltipProvider } from "../../ui/primitives/Tooltip";
import { useRoute } from "../shell/navigation";
import { PanelSlot, useProjectPanel } from "../shell/panel";
import { Island } from "./Island";
import { InlineText, Message } from "./text";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CHAT = "#/project/devbox/storefront";

const pr = (number: number, repo = "acme/storefront"): PrRow => ({
  repo,
  number,
  url: `https://github.com/${repo}/pull/${String(number)}`,
  title: `Change ${String(number)}`,
  state: "open",
  review: { state: "pending", done: 0, needed: 1 },
  author: { role: "implementer" },
  createdAt: AT,
  updatedAt: AT,
});
const detail = (p: PrRow): PrGetOutput => ({ pr: p, body: "", checks: [], reviews: [], history: [], links: { checks: "", files: "", pr: p.url } });

const PRS = [pr(12), pr(7, "acme/ui-kit")];
const writer = { ...lane("T1", "working"), pr: { changeId: "X12", repo: "acme/storefront", number: 12, url: PRS[0]?.url ?? "", state: "reviewing" as const, reviewsDone: 0, reviewsNeeded: 1 } };

const answer = (tool: string, input: Record<string, unknown>): unknown => {
  switch (tool) {
    case "orders_board":
      return { at: AT, trains: [], orders: [card("W1", { lanes: [writer], prs: [writer.pr] })] };
    case "agents_list":
      return { at: AT, agents: [] };
    case "work_list":
      return { scope: { repoKey: "github.com/acme/storefront", base: "main" }, items: [], recentLandings: [] };
    case "pr_list":
      return { at: AT, prs: PRS };
    case "changes_list":
      return { changes: [] };
    case "decisions_list":
      return { decisions: [], orders: [] };
    case "pr_get": {
      const found = PRS.find((p) => p.number === input["number"] && (input["repo"] === undefined || p.repo === input["repo"]));
      return found === undefined ? {} : detail(found);
    }
    default:
      return {};
  }
};

const openExternal = vi.fn();
let host: HTMLDivElement;
let root: Root | undefined;

// The panel's chunks (its frame and its tabs' panes) and the markdown parser, loaded once up front as the app's first
// opening would: on a busy machine a pane still loading when a step looks reads as the panel not opening.
beforeAll(async () => {
  await Promise.all([import("../panel/ProjectPanel"), import("../panel/panes"), import("../../ui/markdown/MarkdownBody")]);
});

beforeEach(() => {
  vi.stubGlobal("fleetd", { platform: "darwin", fixture: null, openExternal });
  window.localStorage.clear();
  window.location.hash = CHAT;
  host = document.createElement("div");
  document.body.appendChild(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  vi.unstubAllGlobals();
});

function Harness({ text }: { text: string }) {
  const panel = useProjectPanel(useRoute());
  return (
    <TooltipProvider>
      <Island project={project} warning={undefined} />
      <div data-testid="message">
        <Message text={text} project={project} />
      </div>
      <div data-testid="event">
        <InlineText text={text} project={project} />
      </div>
      {/* The chat's pill, which opens and closes the panel. */}
      <button type="button" data-opens="panel" aria-pressed={panel.shown} onClick={panel.toggle} />
      <PanelSlot panel={panel} sidebarPx={240} />
    </TooltipProvider>
  );
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await act(() => new Promise((done) => setTimeout(done, 0)));
};

const mount = async (text: string) => {
  let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => Promise.resolve({ ok: true, output: answer(tool, input as Record<string, unknown>) }),
    subscribe: (l) => ((send = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  root = createRoot(host);
  act(() => {
    root?.render(
      <DataProvider layer={createDataLayer(hub)}>
        <Harness text={text} />
      </DataProvider>,
    );
  });
  act(() => {
    send(live());
    send(snapshot(1));
  });
  await settle();
};

const panel = () => host.querySelector("aside[aria-label='Project panel']");
const links = (where: string) => [...host.querySelectorAll<HTMLAnchorElement>(`[data-testid='${where}'] a`)];
/** Follows a link as the window's hash router does. */
const follow = async (a: HTMLAnchorElement | undefined) => {
  if (a === undefined) throw new Error("no link");
  act(() => {
    window.location.hash = a.getAttribute("href") ?? "";
  });
  await settle();
};

it("opens an agent, the panel's agents and its PRs from the island's card, even when the panel was closed", async () => {
  await mount("");
  act(() => host.querySelector<HTMLButtonElement>("button[data-opens='panel'][aria-pressed='true']")?.click());
  expect(panel()).toBeNull();

  // The island: a glyph for the agent and how many, its words for a screen reader.
  const island = host.querySelector("[data-island]");
  const toggle = island?.querySelector<HTMLButtonElement>("button[aria-expanded]");
  expect(toggle?.getAttribute("aria-label")).toBe("1 agent working");
  expect(toggle?.textContent).toBe("1");
  expect(island?.querySelector("ul")).toBeNull();

  // A click opens its card: a row per agent, and the PRs they are on.
  act(() => toggle?.click());
  expect(toggle?.getAttribute("aria-expanded")).toBe("true");
  const lanes = () => [...(island?.querySelectorAll<HTMLAnchorElement>("ul[aria-label='Agents at work'] a") ?? [])];
  expect(lanes().map((a) => a.getAttribute("href"))).toEqual([`${CHAT}/agents/T1`]);

  // An agent opens in the panel's agents, and the card closes behind it.
  const agent = lanes()[0];
  act(() => agent?.click());
  await follow(agent);
  expect(window.location.hash).toBe(`${CHAT}/agents/T1`);
  expect(panel()?.querySelector("[data-screen^='agents.work']")).not.toBeNull();
  expect(island?.querySelector("ul")).toBeNull();

  // Opened again, the card names the PR the agent is on and leads to the panel's list.
  act(() => toggle?.click());
  const onPr = [...(island?.querySelectorAll<HTMLAnchorElement>("a") ?? [])].find((a) => a.textContent === "#12");
  await follow(onPr);
  expect(panel()?.querySelector("[data-screen^='prs.detail']")).not.toBeNull();
  await follow([...(island?.querySelectorAll<HTMLAnchorElement>("a") ?? [])].find((a) => a.textContent === "Open in the panel"));
  expect(window.location.hash).toBe(`${CHAT}/agents`);
  expect(panel()?.querySelector("[data-screen='agents']")).not.toBeNull();
});

it("closes the island's card on a second click, a press outside it, or Escape; Tab reaches it after the island", async () => {
  await mount("");
  const island = host.querySelector("[data-island]");
  const toggle = island?.querySelector<HTMLButtonElement>("button[aria-expanded]");
  const opened = () => island?.querySelector("ul[aria-label='Agents at work']") != null;

  act(() => toggle?.click());
  expect(opened()).toBe(true);
  // The island comes before its card, so Tab goes from it into the card.
  const focusable = [...(island?.querySelectorAll<HTMLElement>("button, a") ?? [])];
  const card = island?.querySelector("ul");
  expect(focusable.indexOf(toggle as HTMLElement)).toBeLessThan(focusable.findIndex((el) => card?.contains(el) === true));
  act(() => toggle?.click());
  expect(opened()).toBe(false);

  // A press inside leaves it open; one outside closes it.
  act(() => toggle?.click());
  act(() => {
    island?.querySelector("ul")?.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true }));
  });
  expect(opened()).toBe(true);
  act(() => {
    host.querySelector("[data-testid='message']")?.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true }));
  });
  expect(opened()).toBe(false);

  act(() => toggle?.click());
  act(() => {
    toggle?.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(opened()).toBe(false);
  expect(toggle?.getAttribute("aria-expanded")).toBe("false");
});

it("opens a PR named in a message or an event line, by number or by its GitHub URL, in the panel", async () => {
  await mount("Opened #12, and https://github.com/acme/ui-kit/pull/7 is next.");
  for (const where of ["message", "event"]) {
    const [byNumber, byUrl] = links(where);
    expect([byNumber?.textContent, byUrl?.textContent]).toEqual(["#12", "https://github.com/acme/ui-kit/pull/7"]);

    await follow(byNumber);
    expect(window.location.hash).toBe(`${CHAT}/prs/12`);
    expect(panel()?.querySelector("[data-screen^='prs.detail']")?.textContent).toContain("Change 12");

    await follow(byUrl);
    expect(window.location.hash).toBe(`${CHAT}/prs/acme/ui-kit/7`);
    expect(panel()?.querySelector("[data-screen^='prs.detail']")?.textContent).toContain("Change 7");
    // Into the app, never out to the browser.
    expect(openExternal).not.toHaveBeenCalled();
    window.location.hash = CHAT;
    await settle();
  }
});

it("leaves # text that names no PR as text", async () => {
  await mount("Step #0 of `make #12`, see issue#4 and C#7.");
  expect(links("message")).toEqual([]);
  expect(links("event")).toEqual([]);
  expect(host.querySelector("[data-testid='message']")?.textContent).toContain("Step #0 of make #12, see issue#4 and C#7.");
});
