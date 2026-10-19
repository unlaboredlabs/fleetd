// What each budget runs against. First paint and idle memory measure the app as it launches (the shell, or the
// screen FLEETD_PERF_FIXTURE opens it on). Scroll and keypress run on stand-ins (src/renderer/perf, built from the
// design system's VirtualList and Textarea) until the real screens exist; then:
//   scroll:   the order conversation on fixture "conversation-20k" (E3b: 20k lines of streamed live text), its route
//             from F1's route table, the scroller the conversation's VirtualList;
//   composer: the board composer (F2), which carries data-composer="ready" for FLEETD_DEMO_TYPE anyway.
import path from "node:path";
import type { Page } from "@playwright/test";

export const desktopDir = path.resolve(import.meta.dirname, "..");
const standIn = "app://fleetd/perf/index.html";

export interface Target {
  readonly label: string;
  readonly open: (page: Page) => Promise<unknown>;
  readonly selector: string;
}

const openStandIn = (page: Page) => page.goto(standIn, { waitUntil: "load" });

export const SCROLL: Target = {
  label: "stand-in log, 20,000 lines",
  open: openStandIn,
  selector: '[data-perf="log"] [role="list"]',
};

export const COMPOSER: Target = {
  label: "stand-in composer",
  open: openStandIn,
  selector: '[data-composer="ready"]',
};
