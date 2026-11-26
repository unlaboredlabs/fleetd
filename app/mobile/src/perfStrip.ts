// What the phone's performance strip says (screens/PerfCard.tsx), as plain logic: the desktop's verdict and measures
// (perfModel) for a viewer that draws at most MAX_FPS a second, the three numbers the closed strip shows, and the
// measures its open card shows, in their order, in words short enough for a third of the phone's width.
import { groupsOf, verdictOf, type PerfNow, type Row, type Verdict } from "./desktop";
import { MAX_FPS } from "./screen";

type Kind = Parameters<typeof groupsOf>[1]["kind"];

/** The measures the open card shows, in this order: the frames, the data and delay, the machine. */
const SHOWN = ["Shown", "Sent", "At most", "Data", "Round trip", "Gets through", "Encoder", "CPU", "Memory", "Path"] as const;
/** Shorter words where a third of the phone's width holds them. */
const SHORT: Readonly<Record<string, string>> = { "Through the workspace": "Workspace", "Straight to the machine": "Direct" };

export type Strip = {
  verdict: Verdict;
  /** The closed strip's numbers: frames shown, round trip, the machine's CPU, those measured. */
  brief: string;
  /** The open card's measures. */
  rows: Row[];
};

export function stripOf(now: PerfNow | undefined, kind: Kind): Strip {
  const rows = groupsOf(now, { kind, screen: undefined, shownWidth: undefined, direct: false, machine: undefined, drawsAtMost: MAX_FPS })
    .flatMap((g) => g.rows)
    .filter((r) => (SHOWN as readonly string[]).includes(r.label))
    .sort((a, b) => SHOWN.indexOf(a.label as (typeof SHOWN)[number]) - SHOWN.indexOf(b.label as (typeof SHOWN)[number]))
    .map((r) => ({ ...r, label: r.label === "Shown" ? `Shown, of ${String(MAX_FPS)} max` : r.label, value: SHORT[r.value] ?? r.value }));
  const value = (label: string) => rows.find((r) => r.label === label)?.value;
  const cpu = value("CPU");
  const brief = [now === undefined ? undefined : `${String(now.viewer.drawn)}/s`, value("Round trip"), cpu === undefined ? undefined : `CPU ${cpu}`]
    .filter((x) => x !== undefined)
    .join(" · ");
  return { verdict: verdictOf(now, MAX_FPS), brief, rows };
}
