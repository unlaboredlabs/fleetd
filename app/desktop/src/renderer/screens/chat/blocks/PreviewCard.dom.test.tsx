// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { ShareLink } from "../../../../shared/contracts";
import { createDataLayer, type HubApi } from "../../../src/data/queries";
import { DataProvider } from "../../../src/data/react";
import { live, snapshot } from "../../../src/data/fixtures.test-util";
import { TooltipProvider } from "../../../ui/primitives/Tooltip";
import { PreviewCard } from "./PreviewCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

const link = (name: string, machineId: string): ShareLink => ({
  name,
  url: `https://${name}.preview.example.com`,
  machineId,
  port: 5173,
  createdBy: { kind: "agent", name: "An agent" },
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
});

const links = [link("k7f3q9m2x8ab", "devbox"), link("h4n8t2v6c3pw", "hosted")];
let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;
const hub: HubApi = {
  call: (tool) => Promise.resolve({ ok: true, output: tool === "share_links_list" ? { enabled: true, links, previewUrl: "https://preview.example.com" } : {} } as never),
  subscribe: (l) => ((send = l), () => undefined),
  resync: () => Promise.resolve(),
  focus: () => Promise.resolve(),
  chat: () => Promise.resolve(),
};

/** The card of link `name` once the workspace's list has answered: its line on keeping the computer running, if any. */
const card = async (name: string) => {
  root = createRoot(host);
  act(() => {
    root?.render(
      <DataProvider layer={createDataLayer(hub)}>
        <TooltipProvider>
          <PreviewCard preview={{ name, port: 5173 }} />
        </TooltipProvider>
      </DataProvider>,
    );
  });
  await act(async () => {
    send(live());
    send(snapshot(1));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
  return { kept: host.querySelector("[data-kept]")?.textContent };
};

it("says a link on fleetd's computers keeps its computer running, and names no machine id", async () => {
  const { kept } = await card("h4n8t2v6c3pw");
  expect(kept).toBe("Its computer keeps running, and uses computer time, up to 2 hours after the agent finishes or until the link ends. Renew to keep it longer.");
  expect(host.textContent).toContain("Port 5173 · ends");
  expect(host.textContent).not.toContain("hosted");
});

it("adds no line to a link on one of the team's own machines", async () => {
  const { kept } = await card("k7f3q9m2x8ab");
  expect(kept).toBeUndefined();
  expect(host.textContent).toContain("devbox:5173");
});
