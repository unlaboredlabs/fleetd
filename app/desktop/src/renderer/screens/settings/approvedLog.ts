// What ran without asking (project_approvals' log, W601), as the Approvals page and the phone show it: the same action
// run again and again in a row is one row with its count and its latest time, the page shows the newest few, and the
// rest reads in pages from the hub, oldest last, so a busy project's log never takes over the page.
import type { AutoApproved } from "../../../shared/contracts";

/** The newest rows the page shows before "Show all". */
export const SHOWN = 5;
/** What the page's first read asks for: enough for `SHOWN` rows when a few repeat. */
export const FIRST_PAGE = 25;
/** Each older page "Show all" reads as it scrolls. */
export const PAGE = 50;

/** One row: the newest of a run of the same action, and how many ran in that run. */
export type LogRow = { readonly entry: AutoApproved; readonly count: number };

/** Repeats of the same action, one after another in the log, as one row; newest first, as the log is. */
export const fold = (log: ReadonlyArray<AutoApproved>): LogRow[] => {
  const rows: Array<{ entry: AutoApproved; count: number }> = [];
  for (const entry of log) {
    const last = rows[rows.length - 1];
    if (last !== undefined && last.entry.what === entry.what && last.entry.by === entry.by) last.count += 1;
    else rows.push({ entry, count: 1 });
  }
  return rows;
};

/** "3 times", beside a folded row's name; nothing for one. */
export const timesWord = (count: number): string | undefined => (count > 1 ? `${String(count)} times` : undefined);

/** The control that opens the rest: with the whole log's count when the hub says it. */
export const showAllWord = (total: number | undefined): string => (total === undefined ? "Show all" : `Show all ${String(total)}`);

/** Whether there is more than the page shows: more rows than `SHOWN`, or an older page to read. */
export const hasMore = (rows: ReadonlyArray<LogRow>, older: number | undefined): boolean => rows.length > SHOWN || older !== undefined;

/** What "Show all" holds: the entries read so far, and where the next older page starts. */
export type Pages = { readonly log: ReadonlyArray<AutoApproved>; readonly older?: number | undefined };

/** An older page read, after what was there. */
export const addPage = (pages: Pages, page: Pages): Pages => ({ log: [...pages.log, ...page.log], older: page.older });
