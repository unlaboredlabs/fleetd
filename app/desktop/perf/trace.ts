// Keypress-to-screen from Chromium's own trace: each key's EventLatency slice runs from the input event's OS
// timestamp to the presentation feedback of the frame that showed its effect (compositing, GPU and the swap
// included). On a real display that ends at vsync; under Xvfb there is no vsync, so CI's figures end at the swap.
import type { Browser } from "@playwright/test";

export interface TraceEvent {
  readonly name: string;
  readonly ph: string;
  readonly pid: number;
  readonly ts: number;
  readonly id?: string;
  readonly id2?: { readonly local?: string; readonly global?: string };
  readonly args?: { readonly event_latency?: { readonly event_type?: string } };
}

/** KEY_PRESSED latencies, ms, from paired EventLatency begin/end events. */
export const keyLatencies = (events: ReadonlyArray<TraceEvent>): Array<number> => {
  const key = (e: TraceEvent) => `${e.pid}:${e.id2?.local ?? e.id2?.global ?? e.id ?? ""}`;
  const open = new Map<string, TraceEvent>();
  const out: Array<number> = [];
  for (const e of events) {
    if (e.name !== "EventLatency") continue;
    if (e.ph === "b") open.set(key(e), e);
    else if (e.ph === "e") {
      const begin = open.get(key(e));
      open.delete(key(e));
      if (begin?.args?.event_latency?.event_type === "KEY_PRESSED") out.push((e.ts - begin.ts) / 1000);
    }
  }
  return out;
};

/** Traces the browser while `during` runs and returns the events. */
export const traced = async (browser: Browser, during: () => Promise<unknown>): Promise<Array<TraceEvent>> => {
  const cdp = await browser.newBrowserCDPSession();
  const events: Array<TraceEvent> = [];
  // The protocol types trace events as string maps; they are JSON objects with numbers in them.
  cdp.on("Tracing.dataCollected", (data) => events.push(...(data.value as unknown as Array<TraceEvent>)));
  const complete = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve));
  await cdp.send("Tracing.start", { transferMode: "ReportEvents", traceConfig: { includedCategories: ["input", "cc", "benchmark"] } });
  await during();
  await cdp.send("Tracing.end");
  await complete;
  await cdp.detach();
  return events;
};
