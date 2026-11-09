// A PR that would undo work already on its base. A writer that moves its
// commit onto a freshly fetched main while its files are still an older tree's commits those older files. Two exact
// steps find that, so ordinary edits, renames and new files never match:
// - a file the PR changes is put back when its blob in the PR equals the file's blob after one of its last `DEPTH`
//   earlier changes on the base, from no later than the PR's merge base, while the base's current blob differs;
// - such a commit counts only when the PR puts back at least half the files it changed.
// Such a PR goes back to its writer before review, unless its title or body says it reverts named commits or PRs.
// scripts/reverts.sh is the same rule over a local checkout: keep the two in step.
import { GhError, type TrainGitHub } from "./github.ts";

/** How many of a file's earlier changes on the base are looked at, besides its newest. */
export const DEPTH = 10;
const CHUNK = 50;
const COMMITS = 30;
const NAMED = 20;

/** A file as one change on the base left it; `blob` undefined where the change deleted it. */
export type Version = { commit: string; subject: string; at: number; blob?: string };

/** A file the PR puts back to an older version, and the base's commits that changed it since, newest first. */
export type Restore = { path: string; undone: Version[] };

/** The base's commits a PR's `blob` of a file would undo; undefined for anything but an exact restore. */
export function undone(blob: string, mergeBaseAt: number, history: Version[]): Version[] | undefined {
  const [newest, ...older] = history;
  if (!newest || newest.blob === blob) return undefined;
  const k = older.slice(0, DEPTH).findIndex((v) => v.blob === blob && v.at <= mergeBaseAt);
  return k < 0 ? undefined : history.slice(0, k + 1);
}

/** The files a commit changed, each with whether it added it. */
export type Touched = [string, boolean][];

/** `restores` kept to the commits the PR undoes: those it puts back at least half the files of. */
export function counted(restores: Restore[], deleted: Set<string>, touched: Map<string, Touched>): Restore[] {
  const undoes = (commit: string) => {
    const files = touched.get(commit);
    if (!files || files.length === 0) return false;
    const back = files.filter(
      ([path, added]) => (added && deleted.has(path)) || restores.some((r) => r.path === path && r.undone.some((v) => v.commit === commit)),
    ).length;
    return back * 2 >= files.length;
  };
  const commits = new Set(restores.flatMap((r) => r.undone.map((v) => v.commit)).filter(undoes));
  return restores.map((r) => ({ path: r.path, undone: r.undone.filter((v) => commits.has(v.commit)) })).filter((r) => r.undone.length > 0);
}

/** The PR's title or body says it reverts named commits or PRs. */
export const deliberate = (text: string) => /revert.*(#[0-9]+|\b[0-9a-f]{7,40}\b)/i.test(text);

const short = (sha: string) => sha.slice(0, 9);

/** The files, the base's commits they undo and the fix, for the writer. */
export function details(restores: Restore[], base: string): string {
  const commits: Version[] = [];
  for (const v of restores.flatMap((r) => r.undone)) if (!commits.some((c) => c.commit === v.commit)) commits.push(v);
  let text = `Files back to an older version of ${base}'s:\n`;
  for (const r of restores.slice(0, NAMED)) text += `- ${r.path} (undoes ${r.undone.map((v) => short(v.commit)).join(", ")})\n`;
  if (restores.length > NAMED) text += `- and ${restores.length - NAMED} more\n`;
  text += `\nCommits of ${base} it would undo:\n`;
  for (const c of commits) text += `- ${short(c.commit)} ${c.subject}\n`;
  text +=
    `\nYour commit carries files from an older ${base}. Rebuild your branch on origin/${base} and re-apply only ` +
    `your own changes: \`git fetch origin && git checkout -B <branch> origin/${base}\`, redo your edits there, check ` +
    `\`git diff origin/${base}\` shows only them, then force-push. If you mean to revert those commits, say so in ` +
    "the PR's title or body, naming them or their PRs, then push a new head (amending your commit's message is " +
    "enough): the train checks again only when the head moves.";
  return text;
}

const seconds = (iso: string) => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
};

type File = { filename: string; previous_filename?: string | null; sha?: string | null; status: string };

async function get<T>(github: TrainGitHub, path: string): Promise<T> {
  const r = await github.get(path);
  if (!r.ok) throw GhError.failed(`gh api ${path} failed: ${r.message}`);
  if (r.value === null || typeof r.value !== "object") throw GhError.failed(`gh api ${path} returned an unexpected shape`);
  return r.value as T;
}

/** The PR's restores of files on `base`, kept to the commits it undoes, from GitHub. */
export async function restores(github: TrainGitHub, repo: string, base: string, head: string): Promise<Restore[]> {
  const path = `repos/${repo}/compare/${base}...${head}`;
  const compare = await get<{ base_commit: { sha: string }; merge_base_commit: { commit: { committer: { date: string } } }; files?: File[] }>(github, path);
  const mergeBaseAt = compare.merge_base_commit?.commit?.committer?.date ? seconds(compare.merge_base_commit.commit.committer.date) : undefined;
  if (mergeBaseAt === undefined) throw GhError.failed(`gh api ${path}: no merge base time`);
  const deleted = new Set<string>();
  const changed: [string, string][] = [];
  for (const f of compare.files ?? []) {
    if (f.previous_filename) deleted.add(f.previous_filename);
    if (f.status === "removed") deleted.add(f.filename);
    else if (f.sha) changed.push([f.filename, f.sha.toLowerCase()]);
  }
  const slash = repo.indexOf("/");
  const [owner, name] = slash < 0 ? [repo, ""] : [repo.slice(0, slash), repo.slice(slash + 1)];
  const found: Restore[] = [];
  for (let i = 0; i < changed.length; i += CHUNK) {
    const chunk = changed.slice(i, i + CHUNK);
    const hist = await histories(github, owner, name, compare.base_commit.sha, chunk);
    chunk.forEach(([p, blob], j) => {
      const u = undone(blob, mergeBaseAt, hist[j] ?? []);
      if (u) found.push({ path: p, undone: u });
    });
  }
  const touched = new Map<string, Touched>();
  for (const r of found) {
    for (const v of r.undone) {
      if (touched.size < COMMITS && !touched.has(v.commit)) {
        const commit = await get<{ files?: File[] }>(github, `repos/${repo}/commits/${v.commit}`);
        const t: Touched = [];
        for (const f of commit.files ?? []) {
          if (f.previous_filename) t.push([f.previous_filename, false]);
          t.push([f.filename, f.status === "added" || f.status === "renamed" || f.status === "copied"]);
        }
        touched.set(v.commit, t);
      }
    }
  }
  return counted(found, deleted, touched);
}

/** Each file's last `DEPTH` + 1 changes on the commit `at`, newest first. */
async function histories(github: TrainGitHub, owner: string, name: string, at: string, files: [string, string][]): Promise<Version[][]> {
  const vars: [string, string][] = [
    ["owner", owner],
    ["name", name],
    ["at", at],
  ];
  let params = "$owner:String!,$name:String!,$at:String!";
  let fields = "";
  files.forEach(([path], i) => {
    vars.push([`p${i}`, path]);
    params += `,$p${i}:String!`;
    fields += ` f${i}:history(first:${DEPTH + 1},path:$p${i}){nodes{oid messageHeadline committedDate file(path:$p${i}){oid}}}`;
  });
  const query = `query(${params}){repository(owner:$owner,name:$name){object(expression:$at){...on Commit{${fields}}}}}`;
  const data = (await github.graphql(query, vars)) as any;
  const commit = data?.repository?.object ?? {};
  return files.map((_, i) => {
    const nodes = commit[`f${i}`]?.nodes;
    return Array.isArray(nodes) ? nodes.map(version).filter((v): v is Version => v !== undefined) : [];
  });
}

function version(node: any): Version | undefined {
  if (typeof node?.oid !== "string" || typeof node.committedDate !== "string") return undefined;
  const at = seconds(node.committedDate);
  if (at === undefined) return undefined;
  const v: Version = { commit: node.oid.toLowerCase(), subject: typeof node.messageHeadline === "string" ? node.messageHeadline : "", at };
  if (typeof node.file?.oid === "string") v.blob = node.file.oid.toLowerCase();
  return v;
}
