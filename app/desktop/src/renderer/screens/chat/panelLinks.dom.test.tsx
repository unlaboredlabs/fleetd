// @vitest-environment happy-dom
// The chat's ways into the panel: the live strip opens its Agents tab, and a PR named in the chat opens that PR there.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { PrGetOutput, PrRow } from "../../../shared/contracts";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { AT, card, lane, live, project, snapshot } from "../../src/data/fixtures.test-util";
import { TooltipProvider } from "../../ui/primitives/Tooltip";
import { LiveStrip } from "../live";
import { useRoute } from "../shell/navigation";
import { PanelSlot, PanelToggle, useProjectPanel } from "../shell/panel";
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

// The panel's chunk and the markdown parser, loaded once up front as the app's first opening would.
beforeAll(async () => {
  await Promise.all([import("../panel/ProjectPanel"), import("../../ui/markdown/MarkdownBody")]);
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
      <LiveStrip project={project} />
      <div data-testid="message">
        <Message text={text} project={project} />
      </div>
      <div data-testid="event">
        <InlineText text={text} project={project} />
      </div>
      <PanelToggle panel={panel} />
      <PanelSlot panel={panel} />
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

const panel = () => host.querySelector("aside[aria-label='Agents and pull requests']");
const links = (where: string) => [...host.querySelectorAll<HTMLAnchorElement>(`[data-testid='${where}'] a`)];
/** Follows a link as the window's hash router does. */
const follow = async (a: HTMLAnchorElement | undefined) => {
  if (a === undefined) throw new Error("no link");
  act(() => {
    window.location.hash = a.getAttribute("href") ?? "";
  });
  await settle();
};

it("opens the panel's agents from the strip's headline, even when the panel was closed or on a PR", async () => {
  await mount("");
  act(() => host.querySelector<HTMLButtonElement>("button[aria-label='Hide agents and PRs']")?.click());
  expect(panel()).toBeNull();

  const headline = [...host.querySelectorAll("section button")].find((b) => b.textContent === "1 agent working");
  act(() => (headline as HTMLButtonElement | undefined)?.click());
  await settle();
  expect(window.location.hash).toBe(`${CHAT}/agents`);
  expect(panel()?.querySelector("[data-screen='agents']")).not.toBeNull();

  // The strip names the PR its agent is on; it opens there too, and the headline goes back to the agents.
  const onPr = host.querySelector<HTMLAnchorElement>("section a");
  expect(onPr?.textContent).toBe("#12");
  await follow(onPr ?? undefined);
  expect(panel()?.querySelector("[data-screen^='prs.detail']")).not.toBeNull();
  act(() => (headline as HTMLButtonElement | undefined)?.click());
  await settle();
  expect(panel()?.querySelector("[data-screen='agents']")).not.toBeNull();
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
