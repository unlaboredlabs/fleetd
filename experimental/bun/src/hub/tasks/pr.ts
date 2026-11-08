// Which PR a write task's result links (crates/fleetd/src/hub/tasks/pr.rs, D67). The host's PR for the task's branch
// is the answer; a URL in the report counts only when the host can't be read, and only one on the project's own
// remote. A URL is never taken for being the last one in the text. Also the remote forms of fleetd-contracts'
// projects.rs (`short_remote`, `github_repo`) that the lookup reads.
import type { ProjectRepo } from "../../shared/contracts.ts";
import { prUrls } from "./render.ts";

/** Why the host gave no answer for a branch's PR (ports.rs `BranchPrError`). */
export type BranchPrError =
  /** It couldn't be reached now (network, timeout, a 5xx, a rate limit): ask again later. */
  | { kind: "unread"; why: string }
  /** It refused, and asking again won't change that (gh not logged in or missing, a 404): the lead is told why. */
  | { kind: "refused"; why: string }
  /** fleetd has no reader for the host. */
  | { kind: "no_reader" };

/** "github.com/acme/shop" from any form of a remote URL: https, ssh, scp-like `git@host:path`, with or without `.git`. */
export function shortRemote(url: string): string {
  let u = url.trim().replace(/\/+$/, "");
  if (u.endsWith(".git")) u = u.slice(0, -4);
  if (u.startsWith("git@")) {
    const rest = u.slice(4);
    const colon = rest.indexOf(":");
    if (colon >= 0) return `${rest.slice(0, colon)}/${rest.slice(colon + 1)}`;
  }
  for (const scheme of ["https://", "http://", "ssh://git@", "ssh://", "git://"]) {
    if (u.startsWith(scheme)) {
      const rest = u.slice(scheme.length);
      const at = rest.lastIndexOf("@");
      return at >= 0 ? rest.slice(at + 1) : rest;
    }
  }
  return u;
}

const REPO = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/;

/** GitHub refuses "." and ".." as repo names. */
export function isRepo(repo: string): boolean {
  const m = REPO.exec(repo);
  return m !== null && m[2] !== "." && m[2] !== "..";
}

/** The GitHub repository ("owner/name") in a URL, `github.com/o/r`, `git@github.com:o/r.git` or `o/r`. */
export function githubRepo(text: string): string | undefined {
  const t = text.trim();
  const short = shortRemote(t);
  let path: string | undefined;
  const rest = short.startsWith("github.com/") ? short.slice(11) : short.startsWith("www.github.com/") ? short.slice(15) : undefined;
  if (rest !== undefined) path = rest.split("/").slice(0, 2).join("/");
  else if (!t.includes(":") && !t.includes(".") && !t.startsWith("/")) path = short;
  if (path === undefined) return undefined;
  if (path.endsWith(".git")) path = path.slice(0, -4);
  return isRepo(path) ? path : undefined;
}

/**
 * `host` is the host's answer for the branch (an Error when it wasn't read); `remote` the project's `origin`,
 * shortened; `texts` the report, read in order.
 */
export function taskPrUrl(host: string | undefined | Error, remote: string | undefined, texts: string[]): string | undefined {
  if (!(host instanceof Error)) return host;
  if (remote === undefined) return undefined;
  return prUrls(texts).findLast((url) => onRemote(url, remote));
}

/** A host's non-2xx answer to a branch's PR lookup: a 5xx, a rate limit or no status is worth asking again. */
export function hostError(status: number, message: string): BranchPrError {
  const rateLimited = status === 429 || (status === 403 && message.toLowerCase().includes("rate limit"));
  const why = `GitHub answered ${status}: ${message}`;
  return status >= 400 && status < 500 && !rateLimited ? { kind: "refused", why } : { kind: "unread", why };
}

/** Whether `url` is on `remote`: the same host and the same repo path. A port on either side is ignored. */
export function onRemote(url: string, remote: string): boolean {
  const u = hostAndPath(url);
  const r = hostAndPath(remote);
  if (!u || !r || u[0] !== r[0]) return false;
  return u[1].startsWith(r[1]) && u[1].slice(r[1].length).startsWith("/");
}

function hostAndPath(text: string): [string, string] | undefined {
  const short = shortRemote(text).toLowerCase();
  const slash = short.indexOf("/");
  if (slash < 0) return undefined;
  let host = short.slice(0, slash).split(":")[0] ?? "";
  if (host.startsWith("www.")) host = host.slice(4);
  const path = short.slice(slash + 1).replace(/^\/+|\/+$/g, "");
  return host !== "" && path !== "" ? [host, path] : undefined;
}

/** The PR is in the repo: its URL is on the repo's remote (`github.com/acme/api/pull/3` on `github.com/acme/api`). */
export function holdsPr(repo: ProjectRepo, pr: string): boolean {
  const short = shortRemote(pr).toLowerCase();
  return repo.repoKey !== undefined && short.startsWith(`${repo.repoKey.toLowerCase()}/`);
}
