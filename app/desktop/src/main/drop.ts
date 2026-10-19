// What was dropped on the window, for Add project. The renderer has no filesystem; it gets back only whether a
// folder is a git checkout and its GitHub origin, or a link file's GitHub address, never file contents.

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DropInfo } from "../shared/hub";

/** Link files are small; anything bigger isn't one. */
const LINK_FILE_MAX = 64 * 1024;

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

/** The first github.com address in a link file (.webloc, .url, .desktop) or text; the renderer checks it is a repo. */
export const githubWord = (content: string): string | undefined =>
  content.split(/[\s<>"'=]+/u).find((w) => /^(?:https?:\/\/)?(?:www\.)?github\.com\/[^/]+\/[^/]+/u.test(w));

export const readDrop = async (path: string): Promise<DropInfo> => {
  const info = await stat(path).catch(() => null);
  if (info === null) return { kind: "missing", path };
  if (info.isDirectory()) {
    const config = await readFile(join(path, ".git", "config"), "utf8").catch(() => null);
    const origin = config === null ? undefined : originUrl(config);
    return { kind: "folder", path, git: config !== null, ...(origin === undefined ? {} : { origin }) };
  }
  if (!info.isFile() || info.size > LINK_FILE_MAX) return { kind: "file", path };
  const link = githubWord(await readFile(path, "utf8").catch(() => ""));
  return { kind: "file", path, ...(link === undefined ? {} : { link }) };
};
