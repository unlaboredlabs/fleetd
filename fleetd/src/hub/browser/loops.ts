// Starts live screens' wiring and loops: the node frames and heartbeat steps this
// area reads, the rewatch when a node links, the app's live-view messages, the lead calls a node makes for a
// session, and the loops `run_end_outlived`, `run_prune` and `thumbs::run`. Each loop stops on `hub.shutdown`.
import type { BrowserFrame } from "../../shared/contracts.ts";
import type { ScreenStep } from "../../shared/screens_wire.ts";
import type { Hub } from "../api/hub.ts";
import { appWs } from "../app_ws/index.ts";
import { appBound, bindApp } from "./app.ts";
import { registerLeadCalls } from "./calls.ts";
import { registerLeadCalls as registerPurchases } from "./purchases.ts";
import { live } from "./live.ts";
import { events } from "../store/events.ts";
import { link } from "../link/index.ts";
import { endOutlived, prune, sweepLost, tellNodes, type Told } from "./store.ts";
import { run as runThumbs, sleep } from "./thumbs.ts";

export function start(hub: Hub): void {
  const nodes = link(hub);
  nodes.on("browser_frame", (machine, frame) => live(hub).frame(machine, frame as unknown as BrowserFrame));
  // The link keeps each heartbeat's load itself (link.load); its steps are this area's.
  nodes.on("hb", (machine, frame) => live(hub).stepsReported(machine, (frame.steps as ScreenStep[] | undefined) ?? []));
  nodes.onLinked((linked) => live(hub).rewatch(linked.machineId));
  if (!appBound(hub)) bindApp(hub, appWs(hub));
  registerLeadCalls(hub);
  registerPurchases(hub);
  void runEndOutlived(hub);
  void runPrune(hub);
  void runThumbs(hub, live(hub).thumbs);
}

/**
 * `endOutlived` and `tellNodes` as the hub starts, after each event (a task's cancel is one, a node's link another)
 * and every minute, until the hub stops.
 */
export async function runEndOutlived(hub: Hub): Promise<void> {
  const signal = hub.shutdown.signal;
  const told: Told = new Map();
  let wake: (() => void) | undefined;
  let busy = false;
  const unsubscribe = events(hub).subscribe(() => {
    // Its own browser.session events would wake it again at once: they follow from what it just did.
    if (!busy) wake?.();
  });
  try {
    while (!signal.aborted) {
      busy = true;
      try {
        endOutlived(hub);
        tellNodes(hub, told);
      } catch (e) {
        console.warn("screens of ended tasks not ended:", e);
      } finally {
        busy = false;
      }
      await Promise.race([sleep(60_000, signal), new Promise<void>((resolve) => (wake = resolve))]);
      wake = undefined;
    }
  } finally {
    unsubscribe();
  }
}

/** The hourly prune, with a sweep of lost recordings before each, until the hub stops. */
export async function runPrune(hub: Hub): Promise<void> {
  const signal = hub.shutdown.signal;
  while (!signal.aborted) {
    try {
      const n = sweepLost(hub);
      if (n > 0) console.info(`${n} lost browser recordings removed`);
    } catch (e) {
      console.warn("lost browser recordings not removed:", e);
    }
    try {
      const n = prune(hub);
      if (n > 0) console.info(`${n} browser recordings expired`);
    } catch (e) {
      console.warn("browser recordings not pruned:", e);
    }
    await sleep(3_600_000, signal);
  }
}
