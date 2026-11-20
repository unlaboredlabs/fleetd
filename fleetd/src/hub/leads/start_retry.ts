// A lead whose start didn't come up (its hosted sandbox didn't, so its claude never started: `not_started` in
// ./cut_off.ts) is started again by itself once its provider is offered again: a wake, which the node sends with the
// person's kept message ahead of it. Each start that didn't come up says why in the chat; the waits double (10, 20,
// 40 minutes) and stop after START_RETRIES, until a turn completes. How many in a row is read off the event log
// (`failedRun`), so a hub restart (an update) between two tries keeps the next one, at the same time.
import type { HubEvent, ProjectRef } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { events } from "../store/events.ts";
import { nowMs, parseMs } from "../store/time.ts";
import { failedRun, RETRY_LINE, retryWaitMs } from "./cut_off.ts";
import type { StoredLead } from "./stored.ts";

/** How far back in the project's events a run of starts that didn't come up is looked for. */
const SCAN = 2_000;
const PAGE = 200;

export type Sleep = (ms: number) => Promise<void>;

/** The lead's starts in a row that didn't come up (`failedRun`), off the hub's event log. */
export function failedStarts(hub: Hub, lead: StoredLead): ReturnType<typeof failedRun> {
  return failedRun(newestFirst(hub, lead.projectRef), lead);
}

function* newestFirst(hub: Hub, r: ProjectRef): Generator<HubEvent> {
  let before: number | undefined;
  for (let scanned = 0; scanned < SCAN; scanned += PAGE) {
    const page = events(hub).projectPage(r, before, ["thread.failed", "thread.completed"], false, PAGE);
    yield* page.events;
    if (!page.more || page.events.length === 0) return;
    before = page.events.at(-1)!.seq;
  }
}

/** Sleeps until the lead's next start again is due and wakes it then with RETRY_LINE, unless something else ended its
 * thread first (a turn, another failed start, a fresh lead). A no-op past START_RETRIES, and, with `seq`, unless that
 * event is the newest failed start (one wait per start, not per event of it). */
export function retryWhenDue(hub: Hub, r: ProjectRef, lead: StoredLead, wake: (r: ProjectRef, line: string) => void, sleep: Sleep, leadNow: () => StoredLead | undefined, seq?: number): void {
  const f = failedStarts(hub, lead);
  const wait = f ? retryWaitMs(f.n) : undefined;
  if (!f || wait === undefined || (seq !== undefined && f.seq !== seq)) return;
  void sleep(Math.max(0, (parseMs(f.at) ?? nowMs(hub.clock)) + wait - nowMs(hub.clock))).then(() => {
    if (hub.shutdown.signal.aborted) return;
    const current = leadNow();
    if (!current || current.threadId !== lead.threadId) return;
    if (failedStarts(hub, current)?.seq !== f.seq) return;
    wake(r, RETRY_LINE);
  });
}

/** Resolves after `ms`, or never once the hub stops. */
export function hubSleep(hub: Hub): Sleep {
  return (ms) =>
    new Promise((resolve) => {
      const signal = hub.shutdown.signal;
      if (signal.aborted) return;
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", stop);
        resolve();
      }, ms);
      const stop = () => clearTimeout(timer);
      signal.addEventListener("abort", stop, { once: true });
    });
}
