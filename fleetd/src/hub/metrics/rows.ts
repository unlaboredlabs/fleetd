// The metrics' rows as the figures read them, pure: a landed change and one of the person's acts, and the names they
// share. store.ts writes and reads them; compute.ts and human.ts compute from them, here and in another repository
// that imports the package.

export const DAY_MS = 86_400_000;
/** A landed change's route when it isn't one: with `skipWhy`. */
export const SKIPPED = "skipped";

/** The repo key of a train's GitHub repo ("acme/web"): its remote, host first ("github.com/acme/web"). */
export const githubRemote = (repo: string) => `github.com/${repo.toLowerCase()}`;

/** The train's repo of a GitHub remote, the inverse of `githubRemote`. */
export const trainRepo = (remote: string) => (remote.startsWith("github.com/") ? remote.slice("github.com/".length) : undefined);

/** One landed change (or a skipped merge). Absent fields leave a stored value as it is. */
export type MergeRow = {
  repo: string;
  unitKey: string;
  machineId?: string;
  projectId?: string;
  prNumber?: number;
  mergedMs: number;
  mergedSha?: string;
  /** A MergeRoute, or "skipped" with `skipWhy`. */
  route: string;
  skipWhy?: string;
  workstreamId?: string;
  taskId?: string;
  changeId?: string;
  batchPr?: number;
  requestedMs?: number;
  requestedBasis?: string;
  prCreatedMs?: number;
  firstPrMs?: number;
  reviewPassedMs?: number;
  authorKind?: string;
  mergedByKind?: string;
  additions?: number;
  deletions?: number;
  title?: string;
  url?: string;
  seenClaim?: string;
  src: string;
  /** The merger's login on the git host, for the merge-by-hand touch. Not stored; reads give none. */
  mergedBy?: string;
};

/** One act by the person. Idempotent on `(src, srcKey)`. */
export type TouchRow = {
  /** "chat", "request", "steer", "decision", "order", "merge", "app" or "host". */
  src: string;
  srcKey: string;
  /** A TouchKind. */
  kind: string;
  /** When the act was recorded; the act itself took the `creditMs` before it. */
  atMs: number;
  creditMs: number;
  /** An interval observed as it is (app use): `[atMs, endMs]`. */
  endMs?: number;
  machineId?: string;
  projectId?: string;
  repo?: string;
  workstreamId?: string;
  prNumber?: number;
  /** The name of the key that made it, or the git host login. */
  keyId?: string;
  estimated: boolean;
  /** On work fleetd didn't write. */
  outside: boolean;
};
