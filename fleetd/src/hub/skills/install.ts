// Installing skills from a source, on the hub: the sources `npx skills add`
// takes, fetched with git at one commit, which the skills are then pinned to. `owner/repo`, `owner/repo@skill`,
// GitHub URLs (with `/tree/<ref>/<path>`), and any other git URL. An install fetches as the hub does, with its git
// config and keys. Nothing is read through a symlink: a linked folder is no skill, a source path through a link is
// refused, and a skill that holds a link is refused whole.
import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { ToolError } from "../../shared/errors.ts";
import { filesOf } from "./index.ts";
import { frontmatter, isSkillName, SKILL_BYTES_CAP, SKILL_FILE, SKILL_FILES_CAP } from "./frontmatter.ts";
import { parse, refused, type Source } from "./source.ts";

export { isLocal, parse, record, type Source, sourceOf } from "./source.ts";

const FETCH_TIMEOUT_MS = 120_000;

/** One skill found in a fetched tree: its name, its folder (repo-relative), its files. */
export type Found = { name: string; path: string; files: [string, Uint8Array][] };

/** A source fetched at one commit, in a directory `done` removes. */
export type Fetched = { commit: string; tree: string; done: () => void };

async function git(dir: string, args: string[]): Promise<string> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["git", ...args], {
      cwd: dir,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    throw new ToolError("failed", `cannot run git on the hub: ${(error as Error).message}`, "Install git where the hub runs.");
  }
  const timer = setTimeout(() => proc.kill(), FETCH_TIMEOUT_MS);
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text()]);
  clearTimeout(timer);
  if (proc.signalCode) throw new ToolError("failed", "git took too long to fetch the source.");
  if (code !== 0) {
    const line = err.split("\n").reverse().find((l) => l.trim())?.trim() ?? "failed";
    throw new ToolError("failed", `git ${args[0]}: ${line}`, "Check the source: a public repo, or one the hub's git can read.");
  }
  return out.trim();
}

/** Fetches `source` at the newest commit of its ref, one commit deep. */
export async function fetch(source: Source): Promise<Fetched> {
  const tree = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "fleetd-skill-"));
  const done = () => rmSync(tree, { recursive: true, force: true });
  try {
    await git(tree, ["init", "--quiet"]);
    await git(tree, ["fetch", "--quiet", "--depth", "1", "--no-tags", "--", source.url, source.gitRef]);
    const commit = await git(tree, ["rev-parse", "FETCH_HEAD"]);
    await git(tree, ["-c", "advice.detachedHead=false", "checkout", "--quiet", "FETCH_HEAD"]);
    return { commit, tree, done };
  } catch (error) {
    done();
    throw error;
  }
}

const realDir = (p: string) => {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
};

const isSkill = (dir: string) => {
  try {
    return realDir(dir) && lstatSync(join(dir, SKILL_FILE)).isFile();
  } catch {
    return false;
  }
};

/** The first link in `dir`, folder-relative, looking at every entry (dot-files too) down the tree. */
function firstLink(dir: string): string | undefined {
  const stack: [string, string][] = [[dir, ""]];
  while (stack.length > 0) {
    const [at, prefix] = stack.pop() as [string, string];
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const e of entries) {
      const rel = `${prefix}${e.name}`;
      if (e.isSymbolicLink()) return rel;
      if (e.isDirectory()) stack.push([join(at, e.name), `${rel}/`]);
    }
  }
  return undefined;
}

const listDirs = (dir: string) => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

/** The skill folders of `base`, in the discovery order. */
function skillDirs(root: string, base: string): string[] {
  if (isSkill(base)) return [base];
  let out: string[] = [];
  for (const sub of ["skills", ".agents/skills", ".claude/skills", ""]) {
    const at = join(base, sub);
    out.push(...listDirs(at).filter((e) => e.isDirectory()).map((e) => join(at, e.name)).filter(isSkill).sort());
  }
  if (out.length === 0) {
    const stack: [string, number][] = [[base, 0]];
    while (stack.length > 0) {
      const [dir, depth] = stack.pop() as [string, number];
      if (depth > 4) continue;
      for (const e of listDirs(dir)) {
        if (e.name === ".git" || e.name === "node_modules" || !e.isDirectory()) continue;
        const p = join(dir, e.name);
        if (isSkill(p)) out.push(p);
        else stack.push([p, depth + 1]);
      }
    }
    out.sort();
  }
  out = out.filter((d) => d === root || d.startsWith(root + sep));
  return out;
}

const inside = (root: string, p: string) => {
  try {
    const [a, b] = [realpathSync(p), realpathSync(root)];
    return a === b || a.startsWith(b + sep);
  } catch {
    return false;
  }
};

/** The skills in a fetched tree, under the source's path; `want` keeps one of them. */
export function find(root: string, source: Source, want?: string): Found[] {
  const base = source.path ? join(root, source.path) : root;
  // Each folder from the repo's top down to the source's path is a real one, and it stays in the repo.
  let at = root;
  for (const part of source.path.split("/").filter(Boolean)) {
    at = join(at, part);
    if (!realDir(at)) throw refused(`The source has no folder ${source.path} (a link is not one).`);
  }
  if (!realDir(base) || !inside(root, base)) throw refused(`The source has no folder ${source.path}.`);
  const out: Found[] = [];
  for (const dir of skillDirs(root, base)) {
    let md = "";
    try {
      md = readFileSync(join(dir, SKILL_FILE), "utf8");
    } catch {
      md = "";
    }
    const repo = source.url.replace(/\/+$/, "").replace(/\.git$/, "").split(/[/:]/).pop();
    const fromFolder = dir === root ? repo : dir.split(sep).pop();
    const fm = frontmatter(md).name;
    const name = fm !== undefined && isSkillName(fm) ? fm : fromFolder !== undefined && isSkillName(fromFolder.toLowerCase()) ? fromFolder.toLowerCase() : undefined;
    if (name === undefined || out.some((f) => f.name === name) || (want !== undefined && want !== name) || !inside(root, dir)) continue;
    const link = firstLink(dir);
    if (link !== undefined) {
      throw new ToolError(
        "invalid",
        `${name} holds a link, ${link}: fleetd installs no links, which could reach outside the skill.`,
        "Ask the source's owner to commit the file itself, or install another skill.",
      );
    }
    const listed = filesOf(dir, SKILL_FILES_CAP);
    if (listed.length > SKILL_FILES_CAP) throw refused(`${name} has more than ${SKILL_FILES_CAP} files.`);
    let bytes = 0;
    const files: [string, Uint8Array][] = listed.map((f) => {
      const data = readFileSync(join(dir, f));
      bytes += data.length;
      return [f, new Uint8Array(data)];
    });
    if (bytes > SKILL_BYTES_CAP) throw refused(`${name} is past ${SKILL_BYTES_CAP / 1024} KB.`);
    out.push({ name, path: relative(root, dir), files });
  }
  if (out.length === 0) {
    throw want !== undefined ? refused(`The source has no skill called ${want}.`) : refused("The source has no skill: no folder with a SKILL.md.");
  }
  return out;
}
