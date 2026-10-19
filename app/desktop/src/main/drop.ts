// What was dropped on the window, for Add project. The path comes only from a real drop (the preload maps a dropped
// File with webUtils.getPathForFile; the page never names a path). Even so main reads as little as it can: no
// symlinks, only link files by extension and a folder's .git/config, each under a size cap, and it returns a GitHub
// "owner/name" at most, never file contents.

import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { extname, join } from "node:path";
import type { DropInfo } from "../shared/hub";

/** .webloc, .url and .desktop link files are a few hundred bytes. */
export const LINK_FILE_MAX = 16 * 1024;
/** A .git/config with dozens of remotes and branches is still a few KB. */
export const GIT_CONFIG_MAX = 64 * 1024;
export const LINK_EXTENSIONS: ReadonlySet<string> = new Set([".webloc", ".url", ".desktop"]);

/** GitHubRepo's pattern (crates/fleetd-contracts/src/train.rs). */
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/u;

/** "owner/name" from a GitHub URL or remote (https, ssh, git@), or undefined. */
export const repoOf = (url: string): string | undefined => {
  const m = /^(?:(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?|git@)?(?:www\.)?github\.com[/:]([^/\s]+)\/([^/\s#?]+)/u.exec(url.trim());
  if (m === null) return undefined;
  const repo = `${m[1] ?? ""}/${(m[2] ?? "").replace(/\.git$/u, "")}`;
  return REPO.test(repo) ? repo : undefined;
};

/** The `origin` URL in a `.git/config`. */
export const originUrl = (gitConfig: string): string | undefined => {
  let inOrigin = false;
  for (const raw of gitConfig.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) inOrigin = line.replaceAll(" ", "") === '[remote"origin"]';
    else if (inOrigin) {
      const eq = line.indexOf("=");
      if (eq > 0 && line.slice(0, eq).trim() === "url") return line.slice(eq + 1).trim();
    }
  }
  return undefined;
};

/** The first GitHub repository linked in a link file's text. */
export const linkRepo = (content: string): string | undefined => {
  for (const word of content.split(/[\s<>"'=]+/u)) {
    const repo = word.includes("github.com") ? repoOf(word) : undefined;
    if (repo !== undefined) return repo;
  }
  return undefined;
};

/**
 * A regular file's text, never past `max`. O_NOFOLLOW and a check on the open descriptor itself: a path swapped for a
 * symlink, FIFO or bigger file after the caller looked at it is refused, not read.
 */
const readSmall = async (path: string, max: number): Promise<string | null> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
  if (handle === null) return null;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > max) return null;
    const buf = Buffer.alloc(max);
    const { bytesRead } = await handle.read(buf, 0, max, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle.close();
  }
};

export const readDrop = async (path: string): Promise<DropInfo> => {
  const info = await lstat(path).catch(() => null);
  if (info === null || info.isSymbolicLink()) return { kind: "other" };
  if (info.isDirectory()) {
    const gitDir = await lstat(join(path, ".git")).catch(() => null);
    if (gitDir === null || gitDir.isSymbolicLink()) return { kind: "folder", path, git: false };
    // A worktree's .git is a file pointing elsewhere: a checkout, origin unknown.
    const config = gitDir.isDirectory() ? await readSmall(join(path, ".git", "config"), GIT_CONFIG_MAX) : null;
    const url = config === null ? undefined : originUrl(config);
    const repo = url === undefined ? undefined : repoOf(url);
    return { kind: "folder", path, git: true, ...(repo === undefined ? {} : { repo }) };
  }
  if (!info.isFile() || !LINK_EXTENSIONS.has(extname(path).toLowerCase())) return { kind: "other" };
  const text = await readSmall(path, LINK_FILE_MAX);
  const repo = text === null ? undefined : linkRepo(text);
  return repo === undefined ? { kind: "other" } : { kind: "link", repo };
};
