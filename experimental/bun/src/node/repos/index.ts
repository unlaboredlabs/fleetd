// Adding a project, the machine's half (crates/fleetd/src/node/repos.rs, cli/setup/detect.rs): find checkouts, look
// at one. Clones and `gh repo list` are ../actions/clone.ts's.
import { type Dirent, existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { defaultBranch, git as runGit } from "../worktree/index.ts";

const MAX_REPOS = 200;
export const PARTIAL = ".fleetd-partial-";
/** Where people keep checkouts, under the home directory. */
export const REPO_ROOTS = ["src", "code", "projects", "dev", "Developer", "repos", "git"];

/** Removes clones a previous node process left half done (`<dest>.fleetd-partial-<addId>`), under the usual source
 * dirs, two levels down. Run at start, before any clone. How many it removed. */
export function removePartials(home: string): number {
  let removed = 0;
  let dirs = REPO_ROOTS.map((r) => join(home, r));
  for (let depth = 0; depth < 2 && dirs.length; depth++) {
    const next: string[] = [];
    for (const dir of dirs) {
      let entries: Dirent[] = [];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {}
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const path = join(dir, e.name);
        if (e.name.includes(PARTIAL)) {
          try {
            rmSync(path, { recursive: true, force: true });
            removed++;
          } catch {}
        } else if (!existsSync(join(path, ".git"))) next.push(path);
      }
    }
    dirs = next;
  }
  return removed;
}

/** Where a clone goes by default: the first of ~/src, ~/code, ~/projects that exists, else ~/src. */
export const cloneRoot = (home: string) => ["src", "code", "projects"].map((d) => join(home, d)).find((d) => existsSync(d) && statSync(d).isDirectory()) ?? join(home, "src");
/** Where a new project's folder goes by default. */
export const projectsRoot = (home: string) => join(home, "fleetd", "projects");

/** The origin's URL in a git config, else the first remote's. */
export function parseGitRemote(config: string): string | undefined {
  let section = "";
  let first: string | undefined;
  for (const raw of config.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      section = line;
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0 || line.slice(0, eq).trim() !== "url" || !section.startsWith("[remote ")) continue;
    const url = line.slice(eq + 1).trim();
    if (section === '[remote "origin"]') return url;
    first ??= url;
  }
  return first;
}

export type Repo = { path: string; remote?: string };

/** Git checkouts under `roots`, at most two levels down, without looking inside a checkout. */
export function findRepos(roots: string[]): Repo[] {
  const found: Repo[] = [];
  const visit = (dir: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "target")
        .map((e) => e.name)
        .sort();
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      const git = join(path, ".git");
      if (existsSync(git) && statSync(git).isDirectory()) {
        let remote: string | undefined;
        try {
          remote = parseGitRemote(readFileSync(join(git, "config"), "utf8"));
        } catch {}
        found.push({ path, ...(remote ? { remote } : {}) });
      } else if (depth < 2) visit(path, depth + 1);
    }
  };
  for (const root of roots) visit(root, 1);
  return found;
}

export function scan(home: string): { cloneRoot: string; repos: Repo[] } {
  const repos: Repo[] = [];
  for (const r of findRepos(REPO_ROOTS.map((d) => join(home, d)))) {
    if (r.path.includes(PARTIAL)) continue;
    if (repos.some((x) => x.path.toLowerCase() === r.path.toLowerCase())) continue;
    repos.push(r);
  }
  return { cloneRoot: cloneRoot(home), repos: repos.slice(0, MAX_REPOS) };
}

export type RepoFacts = { exists: boolean; isGit: boolean; remote?: string; defaultBranch?: string; workflowFiles: string[] };

/** What is at `path`: whether it exists and is a checkout, its remote, default branch and workflow files. */
export async function inspect(path: string): Promise<RepoFacts> {
  if (!existsSync(path)) return { exists: false, isGit: false, workflowFiles: [] };
  const git = join(path, ".git");
  if (!existsSync(git)) return { exists: true, isGit: false, workflowFiles: [] };
  let remote = (await runGit(path, ["remote", "get-url", "origin"]).catch(() => "")).trim() || undefined;
  if (!remote) {
    try {
      remote = parseGitRemote(readFileSync(join(git, "config"), "utf8"));
    } catch {}
  }
  let workflowFiles: string[] = [];
  try {
    workflowFiles = readdirSync(join(path, ".github/workflows"))
      .filter((n) => n.endsWith(".yml") || n.endsWith(".yaml"))
      .sort();
  } catch {}
  const branch = await defaultBranch(path);
  return { exists: true, isGit: true, ...(remote ? { remote } : {}), ...(branch ? { defaultBranch: branch } : {}), workflowFiles };
}
