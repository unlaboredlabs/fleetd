// Where a skill installs from, without git or the disk (install.ts fetches it): a source as skills.sh writes it,
// whether it reads the hub's disk, and the install record kept with the skill.
import type { SkillInstall } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { isSkillName, SKILL_FILE } from "./frontmatter.ts";

/** A source, parsed. `gitRef` is `HEAD` for the default branch; `path` empty for the whole repo. */
export type Source = { url: string; gitRef: string; path: string; skill?: string };

export const refused = (message: string) =>
  new ToolError("invalid", message, "Give owner/repo, owner/repo@skill, a GitHub URL (…/tree/<branch>/<folder> too) or a git URL.");

export const plain = (part: string) => part !== "" && part !== "." && part !== ".." && /^[A-Za-z0-9._-]+$/.test(part);

/** Parses a source as skills.sh writes them. */
export function parse(source: string): Source {
  const s = source.trim();
  if (s.startsWith("-") || /\s/u.test(s)) throw refused(`${s} is not a source.`);
  const gh = s.startsWith("https://github.com/") ? s.slice(19) : s.startsWith("http://github.com/") ? s.slice(18) : undefined;
  if (gh !== undefined) {
    const parts = gh.replace(/\/+$/, "").split("/");
    const [owner, repo0, ...more] = parts;
    const repo = (repo0 ?? "").replace(/(\.git)+$/, "");
    if (owner === undefined || !plain(owner) || !plain(repo)) throw refused(`${s} names no repo.`);
    let gitRef = "HEAD";
    let path = "";
    if (more.length > 0) {
      const [kind, r, ...rest] = more;
      if ((kind !== "tree" && kind !== "blob") || r === undefined || !plain(r) || !rest.every(plain)) {
        throw refused(`${s} is not a repo or a folder in one.`);
      }
      let p = rest.join("/");
      if (p.endsWith(`/${SKILL_FILE}`)) p = p.slice(0, -SKILL_FILE.length - 1);
      gitRef = r;
      path = p === SKILL_FILE ? "" : p;
    }
    return { url: `https://github.com/${owner}/${repo}.git`, gitRef, path };
  }
  if (s.includes("://") || (s.includes("@") && s.includes(":"))) return { url: s, gitRef: "HEAD", path: "" };
  // owner/repo[@skill]
  const at = s.indexOf("@");
  const repo = at < 0 ? s : s.slice(0, at);
  const skill = at < 0 ? undefined : s.slice(at + 1);
  if (skill !== undefined && !isSkillName(skill)) throw refused(`${skill} is not a skill name.`);
  const parts = repo.split("/");
  if (parts.length === 2 && plain(parts[0] as string) && plain(parts[1] as string)) {
    return { url: `https://github.com/${parts[0]}/${(parts[1] as string).replace(/(\.git)+$/, "")}.git`, gitRef: "HEAD", path: "", ...(skill ? { skill } : {}) };
  }
  throw refused(`${s} is not a source.`);
}

/** A source that reads the hub's own disk, which only a person may install from. */
export const isLocal = (source: Source) => source.url.startsWith("file://") || source.url.startsWith("/");

/** The install record for a skill found at `path` of a source fetched at `commit`. */
export const record = (given: string, source: Source, commit: string, path: string, at: string): SkillInstall => ({
  source: given.trim(),
  url: source.url,
  ref: source.gitRef,
  commit,
  path,
  installedAt: at,
});

/** The source an installed skill is updated from: the same URL and ref, and the folder it was found in. */
export const sourceOf = (install: SkillInstall): Source => ({ url: install.url, gitRef: install.ref, path: install.path });
