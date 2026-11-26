// `app_error_report`: the phone app's errors into the workspace's own log, one line each, so the next crash says where
// it happened (the screen, the build, folded or not, the stack) without anyone sending Apple's report. Nothing is kept
// past the log. A key sends at most REPORTS_PER_HOUR in an hour; the rest are counted, not logged.
import type { AppErrorReport } from "../../shared/contracts.ts";
import type { Registry } from "../api/registry.ts";

export const REPORTS_PER_HOUR = 60;
const HOUR_MS = 3_600_000;

/** One report as its log line: what the phone said, by whom, on one line (the stack's lines joined by " ⏎ "). */
export const logLine = (report: AppErrorReport, from: string): string => {
  const where = [
    report.screen === undefined ? undefined : `screen ${report.screen}`,
    `${report.wide ? "wide" : "narrow"} ${report.window}`,
    `build ${report.build}${report.update === undefined ? "" : ` update ${report.update}`}`,
    [report.platform, report.os, report.device].filter((p) => p !== undefined).join(" "),
    `at ${report.at}`,
  ].filter((p) => p !== undefined);
  const stack = report.stack.trim().split(/\r?\n/u).map((l) => l.trim()).filter((l) => l !== "").join(" ⏎ ");
  return `app error${report.fatal ? " (fatal)" : ""} from ${from}: ${report.message.replace(/\s+/gu, " ").trim()} | ${where.join(" | ")}${stack === "" ? "" : ` | stack: ${stack}`}`;
};

/** How many reports each key sent in the hour it is counting, and when that hour began. */
type Window = { start: number; sent: number; dropped: number };

export function register(tools: Registry): void {
  const windows = new Map<string, Window>();
  tools.add("app_error_report", (hub, caller, input) => {
    const now = hub.clock.now();
    let w = windows.get(caller.keyId);
    if (w === undefined || now - w.start >= HOUR_MS) {
      if (w !== undefined && w.dropped > 0) console.warn(`app error: ${String(w.dropped)} more from ${caller.name} in the hour before weren't logged`);
      w = { start: now, sent: 0, dropped: 0 };
      windows.set(caller.keyId, w);
    }
    const from = caller.person === undefined ? caller.name : `${caller.name} (${caller.person.name})`;
    let kept = 0;
    for (const report of input.errors) {
      if (w.sent >= REPORTS_PER_HOUR) {
        w.dropped++;
        continue;
      }
      w.sent++;
      kept++;
      console.warn(logLine(report, from));
    }
    return { kept };
  });
}
