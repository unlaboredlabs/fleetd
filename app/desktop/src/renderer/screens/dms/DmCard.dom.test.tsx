// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { project } from "../../src/data/fixtures.test-util";
import { TooltipProvider } from "../../ui/primitives/Tooltip";
import { DmCard } from "./DmCard";
import type { AgentMessage } from "./model";

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

const render = (dm: AgentMessage, self: string) =>
  act(() =>
    root.render(
      <TooltipProvider>
        <DmCard dm={dm} self={self} project={project} />
      </TooltipProvider>,
    ),
  );

const local = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

const ANSWER: AgentMessage = {
  id: "M20",
  from: { taskId: "T2573", title: "Quiet update states on the phone" },
  text: "Yes: ws.ts redials at 250 ms on 1001 and 1006, then backs off.",
  sentAt: "2026-11-08T23:09:00.000Z",
  to: [{ taskId: "T2577", title: "A stopping hub closes node links as a restart", outcome: "woke", at: "2026-11-08T23:09:00.000Z", detail: "it answers what T2577 asked at 23:05" }],
};

it("shows a DM it got as from the other agent, a link to it, with how it reached it", () => {
  render(ANSWER, "T2577");
  const card = host.querySelector("[data-dm=M20]");
  expect(card?.getAttribute("aria-label")).toBe("DM from T2573");
  expect(card?.textContent).toContain("From");
  expect(card?.querySelector("a")?.getAttribute("href")).toBe("#/project/devbox/storefront/agents/T2573");
  expect(card?.querySelector("[data-outcome=woke]")?.textContent).toBe(`Woke it, ${local(ANSWER.sentAt)}: it answers what T2577 asked at 23:05.`);
});

it("shows a DM it sent to several with a receipt for each, and the guard's refusal in words", () => {
  render(
    {
      ...ANSWER,
      id: "M21",
      to: [
        { taskId: "T2577", title: "A stopping hub", outcome: "delivered", at: "2026-11-08T23:02:00.000Z" },
        { taskId: "T2567", title: "Reply shows its quote", outcome: "not_woken", detail: "T2567 has finished and isn't waiting on T2573: it gets this only if a Monitor or wait_ci of its own wakes it, or its lead continues it" },
      ],
    },
    "T2573",
  );
  const card = host.querySelector("[data-dm=M21]");
  expect(card?.getAttribute("aria-label")).toBe("DM to T2577, T2567");
  expect([...(card?.querySelectorAll("a") ?? [])].map((a) => a.textContent)).toEqual(["T2577", "T2567"]);
  expect(card?.querySelector("[data-outcome=delivered]")?.textContent).toMatch(/^T2577: Delivered at its next step, \d\d:\d\d\.$/u);
  expect(card?.querySelector("[data-outcome=not_woken]")?.textContent).toBe("T2567: Didn’t wake T2567: it has finished and isn't waiting on T2573. Held for its next run.");
});
