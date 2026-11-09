// pr_list, pr_get, pr_files and pr_diff (crates/fleetd/src/hub/prs/tools.rs). All read-only.
import type { Change, PrReviewEntry, PrRow, ProjectRef } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { redact } from "../../shared/redact.ts";
import { requireRole } from "../api/grants.ts";
import type { Hub } from "../api/hub.ts";
import type { Caller, Registry } from "../api/registry.ts";
import { intOr, optionalText, positive, projectRef, repo as repoInput, text } from "../train/input.ts";
import { clip, isoMs, otherNavis, people, project as projectRow, refKey } from "../train/seams.ts";
import { type GhPull, type PrsGitHub } from "./github.ts";
import {
  agentReview,
  count,
  fillCtx,
  history,
  ownerOf,
  personReview,
  prChanges,
  prsGithub,
  projectChanges,
  projectRepos,
  projectTasks,
  verdicts,
} from "./index.ts";
import * as join from "./join.ts";

/** Rows per `pr_list` page (contracts `PR_LIST_MAX`). */
export const PR_LIST_MAX = 60;
/** Files per `pr_files` page (contracts `PR_FILES_PAGE`). */
export const PR_FILES_PAGE = 100;

/** GitHub pages a Load more reads at most, past the first of each list. */
const MAX_PAGES = 40;

export function register(tools: Registry): void {
  tools.add("pr_list", (hub, caller, input) => prList(hub, caller, input as Record<string, unknown>));
  tools.add("pr_get", (hub, caller, input) => prGet(hub, caller, input as Record<string, unknown>));
  tools.add("pr_files", (hub, caller, input) => prFiles(hub, caller, input as Record<string, unknown>));
  tools.add("pr_diff", (hub, caller, input) => prDiff(hub, caller, input as Record<string, unknown>));
}

const errorText = (error: string | undefined) => (error === undefined ? {} : { githubError: clip(error, 300) });

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
  github: PrsGitHub,
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

async function prList(hub: Hub, caller: Caller, input: Record<string, unknown>) {
  const project = projectRef(input, "projectRef");
  requireRole(caller, "read", project.machineId);
  if (projectRow(hub.db.conn, project) === undefined) {
    throw new ToolError(
      "not_found",
      `No project ${project.projectId} on ${project.machineId}.`,
      `Call project_get with machineId ${project.machineId} and no projectId.`,
      undefined,
      "It was removed, or its machine was: the projects list has the ones that are left.",
    );
  }
  const now = hub.clock.now();
  // No closedSince: every PR, so later pages reach the oldest.
  const since = optionalText(input, "closedSince", 1, 100);
  const closedSince = since === undefined ? "" : join.normalizeIso(since);
  const cursor = optionalText(input, "cursor", 1, 400);
  let after: join.RowKey | undefined;
  if (cursor !== undefined) {
    after = join.keyOfCursor(cursor);
    if (!after) {
      throw new ToolError(
        "invalid",
        "That cursor is not one pr_list gave.",
        "Pass a page's nextCursor as it came, or leave cursor out for the first page.",
      );
    }
  }
  const changes = projectChanges(hub, project);
  const repos = projectRepos(hub, project, changes);
  const ctx = join.rowCtx(projectTasks(hub, project));
  fillCtx(hub, ctx, repos);
  const page = await listPage(prsGithub(hub), repos, changes, closedSince, ctx, after);
  const last = page.rows.at(-1);
  return {
    prs: page.rows,
    ...(last && page.more ? { nextCursor: join.cursorOf(join.rowKey(last)) } : {}),
    ...errorText(page.error),
    at: isoMs(now),
    next: "pr_get with a row's repo and number reads it in full.",
    ...(page.more ? { truncated: true } : {}),
  };
}

/** The project whose PRs `repo` holds, refused unless the key may read it, and not another person's Only me project. */
function owner(hub: Hub, caller: Caller, repo: string): ProjectRef {
  const project = ownerOf(hub, repo);
  if (!project) throw new ToolError("not_found", `No project of this fleet lands PRs on ${repo}.`, "pr_list shows a project's PRs.");
  requireRole(caller, "read", project.machineId);
  const me = caller.person?.personId ?? people.owner(hub.db.conn)?.personId;
  if (otherNavis(hub.db.conn, me).some((n) => refKey(n) === refKey(project))) {
    throw new ToolError(
      "forbidden",
      `${project.projectId} on ${project.machineId} is another person's Only me project: only its owner uses and manages it.`,
      "Your own projects are in your list; make one with project_add.",
    );
  }
  return project;
}

async function prGet(hub: Hub, caller: Caller, input: Record<string, unknown>) {
  const repo = repoInput(input, "repo");
  const number = positive(input, "number");
  const project = owner(hub, caller, repo);
  const changes = prChanges(hub, repo, number);
  const read = await prsGithub(hub).detail(repo, number);
  const detail = read.value;
  if (!detail && changes.length === 0) {
    throw new ToolError("not_found", `${repo}#${number}: ${read.error ?? "GitHub has no such PR."}`, "pr_list shows the project's PRs.");
  }
  const change = changes[0];
  const ctx = join.rowCtx(projectTasks(hub, project));
  fillCtx(hub, ctx, [repo]);
  const pr = join.row(repo, detail?.pull, change, ctx);
  if (!pr) throw new ToolError("failed", `${repo}#${number} could not be read.`);
  const head = detail?.pull.headRefOid ?? change?.headSha ?? "";
  const reviews: PrReviewEntry[] = verdicts(hub, pr.url).map((v) => {
    const current = change ? join.isCurrent(change, v.taskId, v.sha) : v.sha === head;
    return agentReview(v.verdict, v.at, ctx.tasksById.get(v.taskId), current);
  });
  if (detail) for (const r of detail.reviews) {
    const entry = personReview(r, head);
    if (entry) reviews.push(entry);
  }
  reviews.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const checks = detail ? detail.pull.statusCheckRollup.map(join.check).filter((c) => c !== undefined).slice(0, 60) : [];
  const mergeSha = detail?.mergeCommit?.oid ?? change?.mergedSha;
  const links = {
    files: `${pr.url}/files`,
    checks: `${pr.url}/checks`,
    pr: pr.url,
    ...(mergeSha ? { mergeCommit: `https://github.com/${repo}/commit/${mergeSha}` } : {}),
  };
  return {
    pr,
    body: clip(redact(detail?.body ?? ""), 8000),
    ...(detail && detail.baseRefName !== "" ? { baseBranch: detail.baseRefName } : {}),
    ...(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head) ? { headSha: head } : {}),
    ...(detail ? { additions: count(detail.additions), deletions: count(detail.deletions), changedFiles: count(detail.changedFiles) } : {}),
    checks,
    reviews: reviews.slice(0, 30),
    history: history(hub, changes.map((c) => c.changeId)),
    links,
    ...errorText(read.error),
    next: "pr_files lists its changed files; pr_diff pages one file's diff.",
  };
}

/** The PR's head and changed-file count from its detail, or why GitHub couldn't say. */
async function headOf(hub: Hub, repo: string, number: number): Promise<{ head: string; files: number }> {
  const read = await prsGithub(hub).detail(repo, number);
  const d = read.value;
  if (d && d.pull.headRefOid !== "") return { head: d.pull.headRefOid, files: Math.max(d.changedFiles, 0) };
  throw new ToolError(
    "failed",
    read.error ?? `GitHub has no files for ${repo}#${number}.`,
    "Try again in a minute; pr_get shows what fleetd records meanwhile.",
  );
}

const githubFailed = (error: string | undefined) => new ToolError("failed", error ?? "GitHub couldn't be read.", "Try again in a minute.");
const sha = (head: string) => (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head) ? { headSha: head } : {});

async function prFiles(hub: Hub, caller: Caller, input: Record<string, unknown>) {
  const repo = repoInput(input, "repo");
  const number = positive(input, "number");
  const offset = intOr(input, "offset", 0, 3000, 0);
  owner(hub, caller, repo);
  const { head, files: total } = await headOf(hub, repo, number);
  const page = Math.floor(offset / PR_FILES_PAGE);
  const read = await prsGithub(hub).files(repo, number, head, page);
  if (!read.value) throw githubFailed(read.error);
  const next = (page + 1) * PR_FILES_PAGE;
  return {
    files: read.value.map(join.file).filter((f) => f !== undefined),
    total: count(total),
    ...(next < total && read.value.length === PR_FILES_PAGE ? { nextOffset: next } : {}),
    ...sha(head),
  };
}

async function prDiff(hub: Hub, caller: Caller, input: Record<string, unknown>) {
  const repo = repoInput(input, "repo");
  const number = positive(input, "number");
  const path = text(input, "path", 1, 1000);
  const offsetIn = intOr(input, "offset", 0, 1_000_000, 0);
  const limit = intOr(input, "limit", 1, 400, 200);
  owner(hub, caller, repo);
  const { head, files: totalFiles } = await headOf(hub, repo, number);
  const pages = Math.max(Math.ceil(totalFiles / PR_FILES_PAGE), 1);
  let found;
  for (let page = 0; page < pages; page++) {
    const read = await prsGithub(hub).files(repo, number, head, page);
    if (!read.value) throw githubFailed(read.error);
    found = read.value.find((f) => f.filename === path);
    if (found || read.value.length < PR_FILES_PAGE) break;
  }
  if (!found) throw new ToolError("not_found", `${repo}#${number} doesn't change ${path}.`, "pr_files lists the files it changes.");
  const lines = found.patch != null ? join.diffLines(found.patch) : [];
  const total = lines.length;
  const offset = Math.min(offsetIn, total);
  const shown = lines.slice(offset, offset + limit);
  const end = offset + shown.length;
  return {
    lines: shown,
    total: count(total),
    ...(end < total ? { nextOffset: end } : {}),
    ...(found.patch == null ? { noDiff: true } : {}),
    ...sha(head),
  };
}
