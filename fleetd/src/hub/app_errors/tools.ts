// `app_error_report`: the phone app's errors into the workspace's own log, one line each, so the next crash says where
// it happened (the screen, the build, folded or not, the stack) without anyone sending Apple's report. Nothing is kept
// past the log. A key sends at most REPORTS_PER_HOUR in an hour; the rest are counted, not logged. On fleetd's own
// workspace each one also counts against the over-the-air update it ran, which is pulled when they spike (pull.ts).
import { join } from "node:path";
import type { AppErrorReport } from "../../shared/contracts.ts";
import type { Registry } from "../api/registry.ts";
import { runGh } from "../train/gh.ts";
import { reportToIn } from "../update/index.ts";
import { count, failed } from "./pull.ts";

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

/** Starts the rollout's pull of phone update `id` in `repo` (.github/workflows/rollout.yml). */
export type Pull = (repo: string, id: string) => Promise<void>;

const pullByGh: Pull = async (repo, id) => {
  const out = await runGh("gh", ["workflow", "run", "rollout.yml", "-R", repo, "-f", "action=phone-pull", "-f", `build=${id}`]);
  if (out.exitCode !== 0) throw new Error((out.stderr || out.stdout).trim() || `gh exited ${out.exitCode}`);
};

export function register(tools: Registry, pull: Pull = pullByGh): void {
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
    // Every report counts against its update, the ones past the hour's limit too.
    const repo = reportToIn(hub.config.home);
    if (repo !== undefined) {
      const file = join(hub.config.home, "update", "phone-errors.json");
      for (const report of input.errors) {
        const due = count(file, report.update, report.fatal, now);
        if (due === undefined) continue;
        console.warn(`app error: pulling phone update ${due.pull} (${due.why})`);
        pull(repo, due.pull).then(
          () => console.info(`app error: ${repo}'s rollout pulls phone update ${due.pull}`),
          (e: unknown) => {
            failed(file, due.pull);
            console.warn(`app error: couldn't pull phone update ${due.pull} in ${repo}: ${(e as Error).message}`);
          },
        );
      }
    }
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
