// The landing scanner's and the bind loop's pure rules, without the hub (landings.ts reads a base over the node link
// and records what landed, bind.ts reads a project's repo and base, train/github.ts reads GitHub's merged PRs): their
// caps, a landing and the lead's words for it, why a fetch failed, a commit as git prints it, where its message says it
// came from, which claims it ends, and a merged PR as GitHub answers it. Exported as `fleetd/hub/work/landing_rules`.
import type { Claim, LandingRoute } from "../../shared/contracts.ts";
import { parseMs } from "../store/time.ts";
import type { Landed } from "./elsewhere.ts";
import { shortRemote, type WorkScope } from "./repo_key.ts";

export const SCAN_EVERY_MS = 60_000;
/** Commits read per watched base per scan; a base further behind catches up over the next scans. */
export const SCAN_MAX = 200;
/** What a node's command output keeps: its last this many characters. */
export const OUTPUT_TAIL_MAX = 2000;
/** How far back GitHub's merged PRs are read for a commit's PR and branch. */
export const MERGED_LOOKBACK_MS = 24 * 3_600_000;
/** Merged Changes searched for a commit's sha. */
export const MERGED_CHANGES = 200;
/** A commit not yet known as the train's waits while a Change on the repo has been merging for less than this. */
export const MERGING_GRACE_MS = 10 * 60_000;

/** The most paths a landing keeps. */
export const LANDING_PATHS_MAX = 200;

/** One commit on the first-parent line of a watched base, whoever made it and however it got there: a `landings` row. */
export type Landing = {
  repoKey: string;
  base: string;
  sha: string;
  /** The commit's committer time. */
  at: string;
  /** When the scanner saw it. */
  seenAt: string;
  route: LandingRoute;
  /** The PR or merge request it came from, when the merge message or the host names one. */
  prNumber?: number;
  prUrl?: string;
  /** The branch it came from, when the merge message or the host names one. */
  headBranch?: string;
  subject: string;
  authorEmail?: string;
  /** What it changed against its first parent; the first LANDING_PATHS_MAX. */
  paths: string[];
  /** The Change it is, or merged. */
  changeId?: string;
  /** The write task whose work it is. */
  taskId?: string;
  /** The claims it ended. */
  claimIds: string[];
};

/** A landing as the lead reads it. */
export function landed(l: Landing): Landed {
  const pr = l.prUrl ?? (l.prNumber !== undefined ? `#${l.prNumber}` : undefined);
  return {
    sha: l.sha,
    atMs: parseMs(l.at) ?? 0,
    route: l.route,
    ...(pr !== undefined ? { pr } : {}),
    subject: l.subject,
    ...(l.authorEmail !== undefined ? { authorEmail: l.authorEmail } : {}),
    covers: [...(l.taskId !== undefined ? [l.taskId] : []), ...l.claimIds],
  };
}

/** What `work.landed` says of a landing. */
export const landingEvent = (l: Landing) => ({
  repoKey: l.repoKey,
  base: l.base,
  sha: l.sha,
  route: l.route,
  ...(l.prNumber !== undefined ? { prNumber: l.prNumber } : {}),
  ...(l.headBranch !== undefined ? { headBranch: l.headBranch } : {}),
  subject: l.subject,
  claimIds: l.claimIds,
  ...(l.changeId !== undefined ? { changeId: l.changeId } : {}),
  ...(l.taskId !== undefined ? { taskId: l.taskId } : {}),
});

/** Whether the scope is on GitHub, where the train's Changes and the merged PRs are read. */
export const onGithub = (scope: WorkScope) => scope.repoKey.startsWith("github.com/");

/** One git command's exit code (null when it didn't exit on its own) and the last 2000 characters of its output. */
export type GitOut = { code: number | null; out: string };
export const gitOk = (o: GitOut) => o.code === 0;

/** Why a fetch failed, from git's output (node/worktree.rs `FetchError::of_text`), and its words. */
export function fetchError(text: string): { kind: "offline" | "no_ssh" | "auth" | "no_access" | "other"; why: string } {
  const has = (needles: string[]) => needles.some((n) => text.includes(n));
  // The first line git explains itself on, without our "git … failed: " prefix.
  const at = text.indexOf(" failed: ");
  const rest = at < 0 ? text : text.slice(at + " failed: ".length);
  const line = (rest.split("\n").find((l) => l.trim() !== "") ?? "").trim();
  // The network first: a dropped or refused connection says nothing about access, whatever git adds after it.
  if (
    has([
      "timed out after",
      "kex_exchange_identification",
      "Connection closed by remote host",
      "Connection reset by peer",
      "Broken pipe",
      "Could not resolve host",
      "Could not resolve hostname",
      "Temporary failure in name resolution",
      "Connection refused",
      "Connection timed out",
      "Operation timed out",
      "Network is unreachable",
      "No route to host",
      "Failed to connect",
    ])
  ) {
    return { kind: "offline", why: "offline" };
  }
  if (has(["ssh: not found", "cannot run ssh", "ssh: No such file or directory"])) return { kind: "no_ssh", why: line };
  if (has(["Authentication failed", "Permission denied (publickey", "could not read Username", "could not read Password", "error: 403", "Host key verification failed"])) {
    return { kind: "auth", why: line };
  }
  if (has(["Repository not found", "does not appear to be a git repository", "could not be found"])) return { kind: "no_access", why: line };
  return { kind: "other", why: line };
}

/** The lead's line: "abc1234 "feat: dark mode" was pushed straight to main by ada@example.com; it ended claim C7." */
export function wakeLine(l: Landing): string {
  const short = l.sha.slice(0, 7);
  const by = l.authorEmail !== undefined ? ` by ${l.authorEmail}` : "";
  let how: string;
  if (l.route === "direct_push") how = `was pushed straight to ${l.base}${by}`;
  else {
    const pr = l.prUrl !== undefined ? ` from ${l.prUrl}` : l.prNumber !== undefined ? ` from PR #${l.prNumber}` : "";
    how = `was merged into ${l.base}${pr}${by} without the merge train`;
  }
  let line = `${short} "${l.subject}" ${how}`;
  if (l.claimIds.length > 0) line += `; it ended claim ${l.claimIds.join(", ")}`;
  if (l.taskId !== undefined) line += `; it is ${l.taskId}'s work`;
  return `${line}.`;
}

/** The body first: when the node keeps only the tail, the fields after it are whole. */
export const COMMIT_FORMAT = "--format=%b%x1e%H%x1f%ct%x1f%ae%x1f%P%x1f%at%x1f%s";

/** One commit as `git show -s` prints it with COMMIT_FORMAT. */
export type Commit = {
  sha: string;
  atSecs: number;
  email: string;
  parents: string[];
  /** Its author time, which a rebase or cherry-pick keeps. */
  authoredSecs: number;
  subject: string;
  /** What the node's output kept of it: its end. */
  body: string;
};

const int = (s: string | undefined) => (s !== undefined && /^[+-]?\d+$/.test(s.trim()) ? Number(s.trim()) : undefined);

export function parseCommit(out: string): Commit | undefined {
  const at = out.lastIndexOf("\u001e");
  if (at < 0) return undefined;
  const body = out.slice(0, at);
  const f = out.slice(at + 1).split("\u001f");
  // splitn(6): the subject keeps any separator it holds.
  if (f.length < 6) return undefined;
  const subjectRaw = f.slice(5).join("\u001f");
  const atSecs = int(f[1]);
  const authoredSecs = int(f[4]);
  if (atSecs === undefined || authoredSecs === undefined) return undefined;
  return {
    sha: f[0]!.trim().toLowerCase(),
    atSecs,
    email: f[2]!.trim(),
    parents: f[3]!.split(/\s+/).filter(Boolean),
    authoredSecs,
    subject: subjectRaw.replace(/\n+$/, ""),
    body,
  };
}

/** What a rebase, an amend of the committer or a cherry-pick keeps: the author, the author time and the subject. */
export const rewriteKey = (c: Commit) => `${c.email.toLowerCase()}\u001f${c.authoredSecs}\u001f${c.subject}`;

/** The lines of an output the node may have cut: a cut first line is dropped. */
export function cutLines(out: string): string[] {
  const cut = out.length >= OUTPUT_TAIL_MAX;
  return out
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .slice(cut ? 1 : 0)
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/** `<sha>\trefs/heads/main` in `git ls-remote origin refs/heads/main`. */
export function lsRemoteSha(out: string, baseRef: string): string | undefined {
  for (const line of out.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const [sha, name] = [line.slice(0, tab), line.slice(tab + 1)];
    if (name.trim() === baseRef && /^[0-9a-fA-F]+$/.test(sha) && sha.length >= 40) return sha.toLowerCase();
  }
  return undefined;
}

/** The host whose merge message named the PR: GitHub (and Gitea, Forgejo), GitLab, Bitbucket, Azure DevOps. */
export type GitHost = "github" | "gitlab" | "bitbucket" | "azure";

/** What a commit's message says about where it came from. */
export type Origin = { pr?: number; head?: string; host?: GitHost };

function numberAfter(text: string, marker: string): [number, string] | undefined {
  const at = text.indexOf(marker);
  if (at < 0) return undefined;
  const rest = text.slice(at + marker.length);
  const digits = /^[0-9]*/.exec(rest)![0];
  if (digits === "") return undefined;
  return [Number(digits), rest.slice(digits.length)];
}

/** The first `'quoted'` name in `text`. */
function quoted(text: string): string | undefined {
  const a = text.indexOf("'");
  if (a < 0) return undefined;
  const b = text.indexOf("'", a + 1);
  if (b < 0) return undefined;
  const name = text.slice(a + 1, b);
  return name === "" ? undefined : name;
}

/**
 * Reads each host's default merge message: GitHub's `Merge pull request #12 from owner/branch` (Gitea's and Forgejo's
 * `Merge pull request 'title' (#12) from branch into main`), a squash subject ending in `(#12)`, GitLab's `See merge
 * request group/proj!12` and `Merge branch 'feature' into 'main'`, Bitbucket's `Merged in branch (pull request #12)`,
 * Azure DevOps' `Merged PR 12: title`, and a local merge pushed: `Merge branch 'feature'`.
 */
export function originOf(subjectRaw: string, body: string): Origin {
  const subject = subjectRaw.trim();
  const origin: Origin = {};
  if (subject.startsWith("Merge pull request ")) {
    const rest = subject.slice("Merge pull request ".length);
    origin.host = "github";
    const n = numberAfter(rest, "#");
    if (n) origin.pr = n[0];
    const from = rest.lastIndexOf(" from ");
    if (from >= 0) {
      const words = rest.slice(from + 6).split(/\s+/).filter(Boolean);
      const first = words[0] ?? "";
      const head = words[1] === "into" ? first : first.includes("/") ? first.slice(first.indexOf("/") + 1) : undefined;
      if (head) origin.head = head;
    }
    return origin;
  }
  if (subject.startsWith("Merged in ")) {
    const rest = subject.slice("Merged in ".length);
    const n = numberAfter(rest, "(pull request #");
    if (n) {
      origin.host = "bitbucket";
      origin.pr = n[0];
      const head = rest.split(/\s+/).filter(Boolean)[0];
      if (head !== undefined) origin.head = head;
      return origin;
    }
  }
  if (subject.startsWith("Merged PR ")) {
    const n = numberAfter(subject, "Merged PR ");
    if (n && n[1].startsWith(":")) {
      origin.host = "azure";
      origin.pr = n[0];
      return origin;
    }
  }
  for (const line of [...body.split("\n"), subject]) {
    const t = line.trim();
    if (!t.startsWith("See merge request ")) continue;
    const rest = t.slice("See merge request ".length);
    const bang = rest.lastIndexOf("!");
    if (bang < 0) continue;
    const n = rest.slice(bang + 1).trim().replace(/\.+$/, "");
    if (/^\+?[0-9]+$/.test(n)) {
      origin.host = "gitlab";
      origin.pr = Number(n);
      break;
    }
  }
  for (const prefix of ["Merge branch ", "Merge remote-tracking branch "]) {
    if (!subject.startsWith(prefix)) continue;
    const name = quoted(subject.slice(prefix.length));
    if (name === undefined) continue;
    origin.head = prefix === "Merge branch " || !name.includes("/") ? name : name.slice(name.indexOf("/") + 1);
    return origin;
  }
  if (origin.pr === undefined && subject.endsWith(")")) {
    const open = subject.lastIndexOf("(#");
    const n = open >= 0 ? subject.slice(open + 2, -1) : "";
    if (/^\+?[0-9]+$/.test(n)) {
      origin.host = "github";
      origin.pr = Number(n);
    }
  }
  return origin;
}

/** The PR's URL on hosts whose URLs fleetd knows: github.com, bitbucket.org, and GitLab wherever its message said so. */
export function prUrl(repoKey: string, host: GitHost | undefined, n: number): string | undefined {
  if (host === "github" && repoKey.startsWith("github.com/")) return `https://${repoKey}/pull/${n}`;
  if (host === "bitbucket" && repoKey.startsWith("bitbucket.org/")) return `https://${repoKey}/pull-requests/${n}`;
  if (host === "gitlab" && !repoKey.startsWith("/")) return `https://${repoKey}/-/merge_requests/${n}`;
  return undefined;
}

/** A PR URL's number when it is on the repo: `/pull/57`, `/pulls/57`, `/-/merge_requests/57`, `/pull-requests/57`. */
export function prNumberIn(url: string, repoKey: string): number | undefined {
  const short = shortRemote(url).toLowerCase();
  if (!short.startsWith(repoKey)) return undefined;
  const after = short.slice(repoKey.length);
  if (!after.startsWith("/")) return undefined;
  const parts = after.slice(1).split("/").filter((p) => p !== "-");
  const kind = parts[0];
  if (kind !== "pull" && kind !== "pulls" && kind !== "merge_requests" && kind !== "pull-requests") return undefined;
  const n = parts[1];
  return n !== undefined && /^\+?[0-9]+$/.test(n) ? Number(n) : undefined;
}

/** Words that close an issue in a commit message, on GitHub, GitLab, Gitea and Bitbucket alike. */
const CLOSING = new Set(["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved", "implement", "implements", "implemented"]);

/** Whether `text` closes `key` ("#12", "SHOP-12"): the key as a whole word right after a closing word. An empty key closes nothing. */
export function closes(textRaw: string, keyRaw: string): boolean {
  if (keyRaw === "") return false;
  const [text, key] = [textRaw.toLowerCase(), keyRaw.toLowerCase()];
  for (let at = text.indexOf(key); at >= 0; at = text.indexOf(key, at + 1)) {
    const after = [...text.slice(at + key.length)][0];
    if (after !== undefined && /[\p{Alphabetic}\p{N}]/u.test(after)) continue;
    const head = text.slice(0, at);
    const before = head.replace(/[\s:]+$/u, "");
    if (before.length === head.length && before !== "") continue;
    const word = before.split(/[^\p{Alphabetic}\p{N}]/u).at(-1) ?? "";
    if (CLOSING.has(word)) return true;
  }
  return false;
}

/** The keys a closing reference to the claim's issue may use. An issue URL counts only on the landing's own repo. */
export function issueRefs(issue: string, repoKey: string): string[] {
  if (!issue.includes("://")) return [issue];
  const short = shortRemote(issue).toLowerCase();
  if (!short.startsWith(repoKey) || short[repoKey.length] !== "/") return [];
  let rest = short.slice(repoKey.length + 1);
  while (rest.startsWith("-/")) rest = rest.slice(2);
  const refs = [issue];
  if (rest.startsWith("issues/")) {
    const n = rest.slice("issues/".length).split("/")[0] ?? "";
    if (/^[0-9]+$/.test(n)) refs.push(`#${n}`);
  }
  return refs;
}

/** It landed (why, for the claim's end), or its author's push touched its paths (its work is going on). */
export type ClaimMatch = { ends?: string; renews?: true };

export function claimMatch(claim: Claim, landing: Landing, body: string): ClaimMatch | undefined {
  const head = landing.headBranch;
  const branches = [...(claim.branch !== undefined ? [claim.branch] : []), ...claim.keys.flatMap((k) => ("branch" in k ? [k.branch] : []))];
  for (const branch of branches) if (branch === head) return { ends: `branch ${branch}` };
  const message = `${landing.subject}\n${body}`;
  for (const key of claim.keys) {
    if ("pr" in key) {
      const n = prNumberIn(key.pr, landing.repoKey);
      if (n !== undefined && n === landing.prNumber) return { ends: `PR ${key.pr}` };
    } else if ("issue" in key && issueRefs(key.issue, landing.repoKey).some((r) => closes(message, r))) {
      return { ends: `issue ${key.issue}` };
    }
  }
  const own = claim.authorEmail !== undefined && landing.authorEmail !== undefined && asciiLower(claim.authorEmail) === asciiLower(landing.authorEmail);
  if (!own) return undefined;
  const claimPaths = [...claim.paths, ...(claim.observed?.paths ?? [])];
  const sameFile = landing.paths.some((p) => claimPaths.some((g) => pathMatches(g, p)));
  if (landing.route === "direct_push" && stronglyMatches(claim.title, landing.subject, sameFile)) {
    return { ends: `pushed by ${landing.authorEmail ?? "its author"} and matching its title` };
  }
  return sameFile ? { renews: true } : undefined;
}

const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** `app/settings/**`, `app/*.ts` or a plain path against a repo-relative path. */
export function pathMatches(glob: string, path: string): boolean {
  if (glob.endsWith("/**")) {
    const dir = glob.slice(0, -3);
    return path === dir || path.startsWith(`${dir}/`);
  }
  if (!glob.includes("*")) return glob === path;
  const parts = glob.split("*");
  const [first, last] = [parts[0]!, parts.at(-1)!];
  if (!path.startsWith(first) || !path.endsWith(last) || path.length < first.length + last.length) return false;
  let rest = path.slice(first.length, path.length - last.length);
  for (const part of parts.slice(1, -1)) {
    const at = rest.indexOf(part);
    if (at < 0) return false;
    rest = rest.slice(at + part.length);
  }
  return true;
}

const COMMIT_TYPES = new Set(["feat", "fix", "chore", "docs", "refactor", "test", "tests", "perf", "build", "ci", "style"]);
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "into", "that", "this", "add", "adds", "added", "update", "updates", "fix", "fixes",
  "make", "makes", "support", "use", "uses", "when", "now",
]);

/** A title's words: lowercase letters and digits, without the conventional-commit type, stop words, numbers or short words. */
export function words(title: string): string[] {
  let text = title.toLowerCase();
  const at = text.search(/[:(]/);
  if (at >= 0) {
    const first = text.slice(0, at).trim().replace(/!+$/, "");
    if (COMMIT_TYPES.has(first)) text = text.slice(first.length);
  }
  const out: string[] = [];
  for (const word of text.split(/[^\p{Alphabetic}\p{N}]/u)) {
    if ([...word].length >= 3 && !/^[0-9]*$/.test(word) && !STOP_WORDS.has(word) && !out.includes(word)) out.push(word);
  }
  return out;
}

/** The strong tier: shared words over the smaller set ≥ 0.6 with ≥ 3 shared, or ≥ 0.4 with ≥ 2 shared and a file in common. */
export function stronglyMatches(a: string, b: string, sameFile: boolean): boolean {
  const [x, y] = [words(a), words(b)];
  const smaller = Math.min(x.length, y.length);
  if (smaller === 0) return false;
  const shared = x.filter((w) => y.includes(w)).length;
  const score = shared / smaller;
  return (score >= 0.6 && shared >= 3) || (score >= 0.4 && shared >= 2 && sameFile);
}

/** `ref: refs/heads/main\tHEAD` in `git ls-remote --symref origin HEAD` → `main`. */
export function remoteHead(out: string): string | undefined {
  for (const line of out.split("\n")) {
    if (!line.startsWith("ref: ")) continue;
    const tab = line.indexOf("\t", 5);
    if (tab < 0) continue;
    const [target, name] = [line.slice(5, tab), line.slice(tab + 1)];
    if (name.trim() === "HEAD" && target.startsWith("refs/heads/")) return target.slice("refs/heads/".length);
  }
  return undefined;
}

export type MergedPull = {
  number: number;
  mergedAt: string;
  mergeSha?: string;
  base: string;
  /** Its branch. */
  head: string;
  /** Opened by a bot account, when GitHub said. */
  authorBot?: boolean;
  createdAt?: string;
};

export type ClosedPull = {
  number: number;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  base: { ref: string };
  head: { ref: string };
  user?: { type?: string } | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export function merged(p: ClosedPull): MergedPull | undefined {
  if (p.merged_at == null) return undefined;
  const m: MergedPull = { number: p.number, mergedAt: p.merged_at, base: p.base.ref, head: p.head.ref };
  if (p.merge_commit_sha != null) m.mergeSha = p.merge_commit_sha;
  if (p.user != null) m.authorBot = p.user.type === "Bot";
  if (p.created_at != null) m.createdAt = p.created_at;
  return m;
}

/** Pages of closed PRs `mergedPulls` reads at most per check. */
export const MERGED_PAGES = 2;
export const MERGED_PAGE = 100;
