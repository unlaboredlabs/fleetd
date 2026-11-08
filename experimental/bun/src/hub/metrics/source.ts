// What the host sweep reads from a repo's git host, one implementation per host (crates/fleetd/src/hub/metrics/
// source/mod.rs). GitHub ships first; GitLab, Gitea, Bitbucket and Azure DevOps each fit the same shape (merged PRs
// with who opened and merged them, the default branch's first-parent commits and the PRs each belongs to, reviews and
// comments), and each is its own PR when a project needs it. A repo on a host with no source is still listed, with its
// figures marked as not read.
import type { ActorKind } from "../../shared/contracts.ts";
import { shortRemote } from "../work/repo_key.ts";
import { isRemoteRepo } from "./compute.ts";
import type { HostActs } from "./host_acts.ts";

/** A repo as the sweep reads it. */
export type RepoRef = {
  /** The metrics' key, host first: "github.com/acme/web". */
  remote: string;
  /** The host's own name for it: "acme/web". */
  path: string;
};

/** What the host says about the repo itself. */
export type RepoInfo = {
  defaultBranch: string;
  /** The repo this one is a fork of, by the host's name ("upstream/web"): a PR from its default branch is a sync. */
  upstream?: string;
};

/** A PR merged on the host, into any base. */
export type MergedPr = {
  number: number;
  title: string;
  url?: string;
  base: string;
  head: string;
  /** The repo its head is on, by the host's name, when the host said. */
  headRepo?: string;
  /** Whether `head` is the default branch of the repo it is on. */
  headIsDefault: boolean;
  author: ActorKind;
  mergedBy: ActorKind;
  /** The merger's login. */
  mergedByLogin?: string;
  createdMs?: number;
  updatedMs: number;
  mergedMs: number;
  mergeSha?: string;
  additions?: number;
  deletions?: number;
  /** The members a train batch PR names on its `fleetd-batch:` line, empty for any other PR. */
  batchMembers: number[];
};

/** One read of merged PRs. */
export type MergedRead = {
  pulls: MergedPr[];
  /** When the page cap cut the read short: the host's page cursor to go on from, and the oldest update read. */
  rest?: [string, number];
};

/** A commit on the default branch. */
export type LandedCommit = {
  sha: string;
  atMs: number;
  title: string;
  /** Its first parent, to walk the default branch's own line. */
  firstParent?: string;
  /** The merged PRs that brought it in, when the host lists them with the commit; undefined asks `prsOfCommit`. */
  prs?: number[];
  /** Pushed under a bot's identity (`…[bot]`). */
  bot: boolean;
};

/** Why a git host could not be read, in plain words a person can act on ("GitHub isn't signed in …"). */
export class HostError extends Error {}

/** One git host's reads. Each throws a HostError when the host can't be read. */
export interface GitHostSource {
  /** The account the hub reads the host as, which is the person's own: their reviews and merges are made by it. */
  signedIn(): Promise<string | undefined>;
  repoInfo(repo: RepoRef): Promise<RepoInfo>;
  /**
   * PRs merged into any base whose last update was at or after `sinceMs`, newest update first, paged until past it or
   * until the host's page cap; `after` goes on from where a read the cap cut short stopped.
   */
  mergedSince(repo: RepoRef, sinceMs: number, after?: string): Promise<MergedRead>;
  /**
   * The commits reachable from `branch`, newest first: back to `stopAt` (the last read's head) when given, whatever
   * their dates, else those made at or after `sinceMs`.
   */
  defaultCommits(repo: RepoRef, branch: string, sinceMs: number, stopAt?: string): Promise<LandedCommit[]>;
  /** The merged PRs a commit on the default branch belongs to, for a host that doesn't list them with the commit. */
  prsOfCommit(repo: RepoRef, sha: string): Promise<number[]>;
  /** Reviews and comments, for the person's touches. */
  acts(): HostActs;
}

/**
 * The git host readers the sweep uses, one per host it can read. The shipped hub reads through the hosts' real CLIs;
 * a test or lab hub reads none (or fakes), so it never reaches the network. The real ones are github.ts `realSources`.
 */
export type HostSources = { github?: GitHostSource };

export const noSources = (): HostSources => ({});

/** The source for a host as `metric_repos.host` names it. */
export const sourceFor = (sources: HostSources, host: string): GitHostSource | undefined =>
  host === "github" ? sources.github : undefined;

/**
 * Whether fleetd reads a host, as `metric_repos.host` names it, through its API; a repo on any other is read from git
 * alone (no_host.ts), whichever sources a hub was built with.
 */
export const hasApi = (host: string) => host === "github";

/**
 * Whether fleetd itself posted a review or comment with this body: it posts under the person's own login, so its acts
 * are told apart by their markers: a hidden `<!-- fleetd:… -->` line (the train's), a `Fleetd-Task:` trailer, or the
 * wording of the train's comments from before it marked them.
 */
export function fleetdPosted(body: string): boolean {
  return (
    body.includes("<!-- fleetd:") ||
    body.includes("by the fleetd merge train") ||
    body.split("\n").some((l) => l.trimStart().startsWith("Fleetd-Task:"))
  );
}

const HOSTS = new Map([
  ["github.com", "github"],
  ["gitlab.com", "gitlab"],
  ["bitbucket.org", "bitbucket"],
  ["dev.azure.com", "azure_devops"],
  ["ssh.dev.azure.com", "azure_devops"],
  ["codeberg.org", "gitea"],
]);

/**
 * The host part of a remote key ("github.com/acme/web" → "github"), as `metric_repos.host` stores it: "git" for a
 * host fleetd has no name for.
 */
export const hostOf = (remote: string): string => HOSTS.get(remote.split("/")[0] ?? "") ?? "git";

/** A checkout's origin URL as the metrics' key: host first, lowercased, no scheme, user or `.git`. */
export function remoteKey(url: string): string | undefined {
  const key = shortRemote(url).toLowerCase();
  return isRemoteRepo(key) ? key : undefined;
}
