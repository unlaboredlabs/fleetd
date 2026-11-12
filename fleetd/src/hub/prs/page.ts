// A page of `pr_list`: GitHub's lists of a project's repos joined with fleetd's Changes, read on only as far as a page
// needs (tools.ts gives it the hub's reader, PrsGitHub).
import type { Change, PrRow } from "../../shared/contracts.ts";
import * as join from "./join.ts";
import type { GhPage, GhPull, Read } from "./shapes.ts";

/** Rows per `pr_list` page (contracts `PR_LIST_MAX`). */
export const PR_LIST_MAX = 60;
/** Files per `pr_files` page (contracts `PR_FILES_PAGE`). */
export const PR_FILES_PAGE = 100;

/** GitHub pages a Load more reads at most, past the first of each list. */
const MAX_PAGES = 40;

/** What a page reads GitHub's lists through: PrsGitHub's `page`. */
export type PageReader = { page(repo: string, closed: boolean, after?: string): Promise<Read<GhPage>> };

/** One of GitHub's lists a page is drawn from: a repo's open PRs or its closed ones, as far as read. */
type Source = { repo: string; closed: boolean; pulls: GhPull[]; next?: string };

/** The key past which its unread PRs sort, while it has any. */
function frontier(s: Source): join.RowKey | undefined {
  if (s.next === undefined) return undefined;
  const last = s.pulls.at(-1);
  return last ? join.pullKey(s.repo, last) : undefined;
}

const keyGte = (a: join.RowKey | undefined, b: join.RowKey | undefined) =>
  // Rust's `Option` order: None sorts before every Some.
  a === undefined ? b === undefined : b === undefined || join.compareKeys(a, b) >= 0;

/**
 * One page of rows from GitHub's lists of `repos` and fleetd's `changes`: those past `after` that no unread PR can
 * sort before. The first page reads each list's first GitHub page only; a later one reads on until there is a page of
 * rows or nothing left to read.
 */
export async function listPage(
  github: PageReader,
  repos: string[],
  changes: Change[],
  closedSince: string,
  ctx: join.RowCtx,
  after: join.RowKey | undefined,
): Promise<{ rows: PrRow[]; more: boolean; error?: string }> {
  let error: string | undefined;
  const sources: Source[] = [];
  for (const repo of repos) {
    for (const closed of [false, true]) {
      const read = await github.page(repo, closed);
      error ??= read.error;
      const page = read.value ?? { pulls: [] };
      sources.push({ repo, closed, pulls: [...page.pulls], ...(page.next !== undefined ? { next: page.next } : {}) });
    }
  }
  const maxPages = after !== undefined ? MAX_PAGES : 0;
  let pages = 0;
  for (;;) {
    for (const s of sources.filter((s) => s.closed)) {
      // Closed lists go by update, which is never before the close: past closedSince nothing more is shown.
      const f = frontier(s);
      if (f !== undefined && f[1] < closedSince) delete s.next;
    }
    const pulls: [string, GhPull][] = sources.flatMap((s) => s.pulls.map((p) => [s.repo, p] as [string, GhPull]));
    const all = join.rows(pulls, changes, closedSince, ctx, Number.MAX_SAFE_INTEGER).rows;
    const afterCursor = all.filter((r) => after === undefined || join.compareKeys(join.rowKey(r), after) < 0);
    // The source whose unread PRs could sort first: the greatest frontier (the last one of equals, as max_by_key).
    let blocking: Source | undefined;
    for (const s of sources) {
      const f = frontier(s);
      if (f === undefined) continue;
      if (!blocking || join.compareKeys(f, frontier(blocking)!) >= 0) blocking = s;
    }
    let safe: number;
    if (!blocking) {
      safe = afterCursor.length;
    } else {
      const f = frontier(blocking);
      safe = 0;
      while (safe < afterCursor.length && keyGte(join.rowKey(afterCursor[safe]!), f)) safe++;
    }
    if (!blocking || safe > PR_LIST_MAX || pages >= maxPages) {
      const shown = Math.min(safe, PR_LIST_MAX);
      const more = afterCursor.length > shown || sources.some((s) => s.next !== undefined);
      return { rows: afterCursor.slice(0, shown), more, ...(error !== undefined ? { error } : {}) };
    }
    pages++;
    const read = await github.page(blocking.repo, blocking.closed, blocking.next);
    if (read.value && read.error === undefined) {
      blocking.pulls.push(...read.value.pulls);
      if (read.value.next !== undefined) blocking.next = read.value.next;
      else delete blocking.next;
    } else {
      error ??= read.error;
      delete blocking.next;
    }
  }
}
