// Cloning a repo for a project the person adds (sessions/mod.rs
// `repo_clone`), with git's progress sent to the hub as `clone_progress` frames, and `gh repo list` (`gh_repo_list`).
// git writes into a sibling that is renamed into place only when complete, so the destination existing always means
// a whole clone.
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type { ClonePhase } from "../../shared/contracts.ts";
import type { CloneProgressFrame, GhRepo, GhRepos } from "../../shared/sessions.ts";
import { PARTIAL } from "../repos/index.ts";
import { CallRefusal, invalid } from "./refusal.ts";

const GH_LIMIT = "100";
const GH_TIMEOUT_MS = 30_000;

export type Progress = { phase: ClonePhase; percent?: number; detail?: string };

/** One progress report from git's stderr: "Receiving objects:  45% (450/1000), 1.20 MiB | 2.00 MiB/s". */
export function parseProgress(line: string): Progress | undefined {
  let text = line.trim();
  if (text.startsWith("remote: ")) text = text.slice(8);
  const colon = text.indexOf(":");
  if (colon < 0) return undefined;
  const label = text.slice(0, colon);
  const phase: ClonePhase | undefined =
    label === "Receiving objects"
      ? "receiving"
      : label === "Resolving deltas"
        ? "resolving"
        : label === "Updating files" || label === "Checking out files"
          ? "checking_out"
          : ["Enumerating objects", "Counting objects", "Compressing objects"].includes(label)
            ? "starting"
            : undefined;
  if (!phase) return undefined;
  const rest = text.slice(colon + 1).trim();
  const pct = rest.indexOf("%");
  const head = pct < 0 ? "" : rest.slice(0, pct).trim();
  const percent = /^\d{1,3}$/.test(head) && Number(head) <= 100 ? Number(head) : undefined;
  // What follows the counts: "1.20 MiB | 2.00 MiB/s", without the trailing ", done."
  const after = rest.indexOf("), ");
  let detail = after < 0 ? undefined : rest.slice(after + 3);
  if (detail !== undefined) {
    while (detail.endsWith(", done.")) detail = detail.slice(0, -7);
    detail = detail.trim();
    if (!detail || detail === "done.") detail = undefined;
  }
  return { phase, ...(percent !== undefined ? { percent } : {}), ...(detail !== undefined ? { detail } : {}) };
}

const hasGh = () => (process.env.PATH ?? "").split(":").some((dir) => dir && existsSync(`${dir}/gh`));

async function gitClone(url: string, dest: string, progress: (p: Progress) => void): Promise<void> {
  const pre = hasGh() ? ["-c", "credential.https://github.com.helper=!gh auth git-credential"] : [];
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" } as Record<string, string>;
  let proc: Bun.Subprocess<"ignore", "ignore", "pipe">;
  try {
    proc = Bun.spawn(["git", ...pre, "clone", "--progress", "--", url, dest], { env, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  } catch (error) {
    throw new Error(`git could not start: ${(error as Error).message}`);
  }
  const decoder = new TextDecoder();
  let line = "";
  let lastLine = "";
  let lastSent: { at: number; p: Progress } | undefined;
  for await (const chunk of proc.stderr) {
    // git rewrites one line with `\r` while a phase runs, and ends it with `\n`.
    for (const ch of decoder.decode(chunk, { stream: true })) {
      if (ch !== "\r" && ch !== "\n") {
        line += ch;
        continue;
      }
      const text = line;
      line = "";
      if (!text.trim()) continue;
      lastLine = text;
      const p = parseProgress(text);
      if (!p) continue;
      const due = !lastSent || lastSent.p.phase !== p.phase || (p.percent === 100 && lastSent.p.percent !== 100) || Date.now() - lastSent.at >= 250;
      if (due) {
        lastSent = { at: Date.now(), p };
        progress(p);
      }
    }
  }
  const code = await proc.exited;
  if (code === 0) return;
  let last = lastLine.trim();
  if (last.startsWith("fatal: ")) last = last.slice(7);
  throw new Error(last ? [...last].slice(0, 500).join("") : `git clone exited with exit status: ${code}`);
}

/** Clones `url` into `dest`, through gh's credentials when gh is installed. Never prompts. */
export async function clone(url: string, dest: string, addId: string, progress: (p: Progress) => void): Promise<void> {
  if (existsSync(dest)) throw new Error(`${dest} already exists`);
  try {
    mkdirSync(dirname(dest), { recursive: true });
  } catch (error) {
    throw new Error(`cannot create ${dirname(dest)}: ${(error as Error).message}`);
  }
  const id = [...addId].filter((c) => /[A-Za-z0-9]/.test(c)).slice(0, 40).join("");
  const partial = `${dest}${PARTIAL}${id}`;
  await rm(partial, { recursive: true, force: true });
  try {
    await gitClone(url, partial, progress);
    try {
      renameSync(partial, dest);
    } catch (error) {
      throw new Error(`cannot move the clone into ${dest}: ${(error as Error).message}`);
    }
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    throw error;
  }
}

/** `repo_clone`: git's progress as `clone_progress` frames, git's own last line as the refusal. */
export async function repoClone(addId: string, url: string, dest: string, send: (frame: CloneProgressFrame) => void): Promise<void> {
  if (!isAbsolute(dest)) throw invalid(`${dest} is not an absolute path`);
  try {
    await clone(url, dest, addId, (p) => send({ addId, ...p }));
  } catch (error) {
    const message = (error as Error).message;
    throw new CallRefusal("git", message.length > 2000 ? message.slice(message.length - 2000) : message);
  }
}

/** gh's stdout, or why not in a person's words. */
async function gh(args: string[]): Promise<string> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(["gh", ...args], { env: { ...process.env } as Record<string, string>, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    throw new Error((error as { code?: string }).code === "ENOENT" ? "gh is not installed" : `gh could not start: ${(error as Error).message}`);
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, GH_TIMEOUT_MS);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  if (timedOut) throw new Error("gh timed out after 30 s");
  if (code === 0) return stdout;
  const lower = stderr.toLowerCase();
  if (code === 4 || lower.includes("gh auth login") || lower.includes("not logged")) throw new Error("gh is not logged in");
  throw new Error(stderr.trim().split("\n").at(-1) || "gh failed");
}

const ghRepo = (row: Record<string, unknown>): GhRepo[] =>
  typeof row.nameWithOwner === "string" && typeof row.url === "string"
    ? [
        {
          nameWithOwner: row.nameWithOwner,
          url: row.url,
          isPrivate: row.isPrivate === true,
          ...(typeof row.description === "string" ? { description: row.description } : {}),
          ...(typeof row.pushedAt === "string" ? { pushedAt: row.pushedAt } : {}),
        },
      ]
    : [];

/** `gh repo list` for the logged-in user, then each org they belong to. gh runs with the node's own environment, so
 * its login (GH_TOKEN, ~/.config/gh) is what the person set up on the machine. */
export async function ghRepoList(): Promise<GhRepos> {
  let login: string;
  try {
    login = (await gh(["api", "user", "--jq", ".login"])).trim();
  } catch (error) {
    return { owners: [], repos: [], problem: (error as Error).message };
  }
  const orgs = await gh(["api", "user/orgs", "--paginate", "--jq", ".[].login"]).catch(() => "");
  const owners = [login, ...orgs.split("\n").map((o) => o.trim()).filter(Boolean)];
  const repos: GhRepo[] = [];
  for (const owner of owners) {
    try {
      const rows = JSON.parse(await gh(["repo", "list", owner, "--limit", GH_LIMIT, "--json", "nameWithOwner,url,isPrivate,description,pushedAt"])) as unknown;
      if (Array.isArray(rows)) repos.push(...rows.flatMap((r) => ghRepo(r as Record<string, unknown>)));
    } catch {}
  }
  return { owners, repos };
}
