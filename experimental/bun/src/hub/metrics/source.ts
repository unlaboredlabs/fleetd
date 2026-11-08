// What the host sweep reads from a repo's git host, one reader per host (crates/fleetd/src/hub/metrics/source/mod.rs).
// GitHub ships first; a repo on a host with no reader is read from git alone (no_host.ts).
import type { ActorKind } from "../../shared/contracts.ts";
import type { HostActs } from "./host_acts.ts";
import { isRemoteRepo } from "./compute.ts";

/** A repo as the sweep reads it: the metrics' key ("github.com/acme/web") and the host's name ("acme/web"). */
export type RepoRef = { remote: string; path: string };

/** What the host says about the repo itself; `upstream` is the repo this one is a fork of. */
export type RepoInfo = { defaultBranch: string; upstream?: string };

/** A PR merged on the host, into any base. */
export type MergedPr = {
  number: number;
  title: string;
  url?: string;
  base: string;
  head: string;
  headRepo?: string;
  /** Whether `head` is the default branch of the repo it is on. */
  headIsDefault: boolean;
  author: ActorKind;
  mergedBy: ActorKind;
  mergedByLogin?: string;
  createdMs?: number;
  updatedMs: number;
  mergedMs: number;
  mergeSha?: string;
  additions?: number;
  deletions?: number;
  /** The members a train batch PR names on its `fleetd-batch:` line. */
  batchMembers: number[];
};

/** One read of merged PRs; `rest` when the page cap cut it short: the page cursor and the oldest update read. */
export type MergedRead = { pulls: MergedPr[]; rest?: [after: string, oldestMs: number] };

/** A commit on the default branch. */
export type LandedCommit = {
  sha: string;
  atMs: number;
  title: string;
  firstParent?: string;
  /** The merged PRs that brought it in, when the host lists them with the commit; undefined asks `prsOfCommit`. */
  prs?: number[];
  /** Pushed under a bot's identity (`…[bot]`). */
  bot: boolean;
};

/** One git host's reads. Errors are plain words a person can act on. */
export interface GitHostSource {
  /** The account the hub reads the host as: the person's own. */
  signedIn(): Promise<string | undefined>;
  repoInfo(repo: RepoRef): Promise<RepoInfo>;
  /** PRs merged into any base updated at or after `sinceMs`, newest update first; `after` goes on from a cut read. */
  mergedSince(repo: RepoRef, sinceMs: number, after?: string): Promise<MergedRead>;
  /** The commits reachable from `branch`, newest first: back to `stopAt` when given, else those since `sinceMs`. */
  defaultCommits(repo: RepoRef, branch: string, sinceMs: number, stopAt?: string): Promise<LandedCommit[]>;
  prsOfCommit(repo: RepoRef, sha: string): Promise<number[]>;
  acts(): HostActs;
}

/** The readers the sweep uses, one per host it can read; a test hub sets fakes, or none. */
export type HostSources = { github?: GitHostSource };

/** Whether fleetd reads a host through its API; a repo on any other is read from git alone. */
export const hasApi = (host: string) => host === "github";

/** Whether fleetd itself posted a review or comment with this body: its marker, the train's words, or a trailer. */
export const fleetdPosted = (body: string) =>
  body.includes("<!-- fleetd:") || body.includes("by the fleetd merge train") || body.split("\n").some((l) => l.trimStart().startsWith("Fleetd-Task:"));

/** The host part of a remote key ("github.com/acme/web" → "github"), as `metric_repos.host` stores it. */
export function hostOf(remote: string): string {
  switch (remote.split("/")[0]) {
    case "github.com":
      return "github";
    case "gitlab.com":
      return "gitlab";
    case "bitbucket.org":
      return "bitbucket";
    case "dev.azure.com":
    case "ssh.dev.azure.com":
      return "azure_devops";
    case "codeberg.org":
      return "gitea";
    default:
      return "git";
  }
}

/** projects::short_remote: host first, no scheme, user or `.git`. */
export function shortRemote(raw: string): string {
  let url = raw.trim().replace(/\/+$/, "");
  if (url.endsWith(".git")) url = url.slice(0, -4);
  if (url.startsWith("git@")) {
    const rest = url.slice(4);
    const colon = rest.indexOf(":");
    if (colon >= 0) return `${rest.slice(0, colon)}/${rest.slice(colon + 1)}`;
  }
  for (const scheme of ["https://", "http://", "ssh://git@", "ssh://", "git://"]) {
    if (url.startsWith(scheme)) {
      const rest = url.slice(scheme.length);
      const at = rest.lastIndexOf("@");
      return at < 0 ? rest : rest.slice(at + 1);
    }
  }
  return url;
}

/** A checkout's origin URL as the metrics' key: host first, lowercased, no scheme, user or `.git`. */
export function remoteKey(url: string): string | undefined {
  const key = shortRemote(url).toLowerCase();
  return isRemoteRepo(key) ? key : undefined;
}
