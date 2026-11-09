// Pure: GitHub's answers about a repository into a `ProjectInspect`, the line on what the lead will need, the best
// worker for a clone, and a failed clone's message into a problem with its fix,
// with the contracts' `github_repo`, `short_remote` and `RepoKey::of` (fleetd-contracts projects.rs, work.rs).
import type {
  CiInfo,
  GitHubRepo,
  MachineId,
  MergeRules,
  ProjectAddedData,
  ProjectAddFailedData,
  ProjectInspect,
  ProjectProblem,
} from "../../shared/contracts.ts";
import type { RepoFacts } from "../../shared/sessions.ts";
import { jsPrefix } from "../../shared/text.ts";

/** What GitHub said, one field per `gh api` read; undefined when that read failed (it becomes a note). */
export type GitHubAnswers = {
  /** `repos/{repo}`. */
  repo?: unknown;
  /** `repos/{repo}/branches/{default}`. */
  branch?: unknown;
  /** `repos/{repo}/rules/branches/{default}`. */
  rules?: unknown;
  /** `repos/{repo}/rulesets`. */
  rulesets?: unknown;
  /** `repos/{repo}/actions/workflows`. */
  workflows?: unknown;
  /** Reads that failed, each as "what (why)": CI and merge rules are then unknown, not absent. */
  unread: string[];
};

export const noAnswers = (): GitHubAnswers => ({ unread: [] });

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
/** serde's `as_i64`: an integer. */
const int = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function pushUnique(list: string[], item: string): void {
  if (!list.includes(item)) list.push(item);
}

/** `local` is the checkout's own facts, when there is one: its workflow files stand in when GitHub can't be read. */
export function build(
  repo: GitHubRepo | undefined,
  gh: GitHubAnswers,
  local: RepoFacts | undefined,
  notes: string[],
  ghOk: boolean,
): ProjectInspect {
  const defaultBranch = str(obj(gh.repo)?.default_branch) ?? local?.defaultBranch;
  const ci: CiInfo = { workflows: [], requiredChecks: [] };
  const merge: MergeRules = { protected: false, rulesets: [] };
  const squash = bool(obj(gh.repo)?.allow_squash_merge);
  if (squash !== undefined) merge.squashAllowed = squash;
  const rows = obj(gh.workflows)?.workflows;
  if (Array.isArray(rows)) {
    for (const w of rows) {
      // GitHub's own dynamic workflows (Copilot, Dependabot) are not the repo's CI.
      const dynamic = str(obj(w)?.path)?.startsWith("dynamic/") === true;
      const name = str(obj(w)?.name);
      if (!dynamic && str(obj(w)?.state) === "active" && name !== undefined) pushUnique(ci.workflows, name);
    }
  } else if (local) {
    ci.workflows = [...(local.workflowFiles ?? [])];
  }
  const b = obj(gh.branch);
  if (b) {
    if (bool(b.protected) === true) merge.protected = true;
    const checks = obj(obj(b.protection)?.required_status_checks);
    for (const c of arr(checks?.contexts)) if (typeof c === "string") pushUnique(ci.requiredChecks, c);
  }
  const names: [number, string][] = [];
  for (const r of arr(gh.rulesets)) {
    const id = int(obj(r)?.id);
    const name = str(obj(r)?.name);
    if (id !== undefined && name !== undefined) names.push([id, name]);
  }
  for (const rule of arr(gh.rules)) {
    merge.protected = true;
    const id = int(obj(rule)?.ruleset_id);
    if (id !== undefined) pushUnique(merge.rulesets, names.find(([i]) => i === id)?.[1] ?? `ruleset ${id}`);
    const params = obj(obj(rule)?.parameters);
    switch (str(obj(rule)?.type)) {
      case "required_status_checks": {
        for (const c of arr(params?.required_status_checks)) {
          const context = str(obj(c)?.context);
          if (context !== undefined) pushUnique(ci.requiredChecks, context);
        }
        if (bool(params?.strict_required_status_checks_policy) === true) merge.strict = true;
        break;
      }
      case "pull_request": {
        const n = int(params?.required_approving_review_count) ?? 0;
        const prev = merge.requiredReviews ?? 0;
        merge.requiredReviews = Math.min(Math.max(Math.max(n, prev), 0), 10);
        break;
      }
    }
  }
  if (repo !== undefined && ghOk) {
    for (const what of gh.unread) notes.push(`could not read ${what}`);
    if (gh.repo !== undefined && merge.squashAllowed === undefined) notes.push("merge settings need push access to read");
  }
  const inspect: ProjectInspect = {
    ...(repo !== undefined ? { repo } : {}),
    ...(defaultBranch !== undefined ? { defaultBranch } : {}),
    ci,
    merge: ordered(merge),
    leadNeeds: "ready",
    notes,
  };
  inspect.leadNeeds = jsPrefix(leadNeeds(inspect, ghOk, gh.unread), 300);
  return inspect;
}

/** MergeRules in the Rust struct's field order, so its JSON reads (and sizes) the same. */
function ordered(m: MergeRules): MergeRules {
  return {
    protected: m.protected,
    rulesets: m.rulesets,
    ...(m.squashAllowed !== undefined ? { squashAllowed: m.squashAllowed } : {}),
    ...(m.requiredReviews !== undefined ? { requiredReviews: m.requiredReviews } : {}),
    ...(m.strict !== undefined ? { strict: m.strict } : {}),
  };
}

/** What a plain folder's lead can do, as its inspect says it. */
export const FOLDER_NEEDS =
  "a plain folder with no git: its lead chats, remembers and uses screens here; agents that change code need a git repo";

/** The inspect of a plain folder: no git, so no repo, branch, CI or merge rules. */
export const folder = (): ProjectInspect => ({
  ci: { workflows: [], requiredChecks: [] },
  merge: { protected: false, rulesets: [] },
  leadNeeds: FOLDER_NEEDS,
  notes: [],
});

/** One line for a person: the most important thing the lead and the merge train will need here. */
export function leadNeeds(i: ProjectInspect, ghOk: boolean, unread: string[]): string {
  const branch = i.defaultBranch ?? "the default branch";
  const repo = i.repo;
  if (repo === undefined) {
    return "no GitHub remote: the lead can work here, but the merge train needs a GitHub repo to open and merge PRs";
  }
  if (!ghOk) return "gh is not logged in on the hub: run `gh auth login` there so the merge train can open and merge PRs";
  if (unread.length > 0) return `CI and merge rules unknown: gh on the hub could not read ${unread.join(", ")} on ${repo}`;
  if (i.merge.squashAllowed === false) {
    return `squash merges are off on ${repo}: turn them on in its settings, the merge train squash-merges`;
  }
  const reviews = i.merge.requiredReviews ?? 0;
  if (reviews > 0) {
    const s = reviews === 1 ? "" : "s";
    return `${branch} needs ${reviews} approving review${s}: the train's merges wait for a person to approve`;
  }
  if (i.ci.workflows.length === 0 && i.ci.requiredChecks.length === 0) {
    return "no CI found: the merge train holds its PRs until the repo has CI";
  }
  if (i.ci.requiredChecks.length === 0) {
    const n = i.ci.workflows.length;
    const s = n === 1 ? "" : "s";
    return `CI runs (${n} workflow${s}) but ${branch} requires no check: the train still waits for CI on each head`;
  }
  const checks = i.ci.requiredChecks;
  const named = checks.length > 3 ? `${checks.length} checks (${checks.slice(0, 2).join(", ")}, …)` : checks.join(", ");
  return `ready: ${branch} requires ${named}; the train waits for them before each squash merge`;
}

/** serde_json's length of `v`, in bytes. */
export const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

/** The inspect cut to fit an event's 2 KB of data: the longest list loses half its entries until it fits. */
export function compact(i: ProjectInspect, budget: number): ProjectInspect {
  const out: ProjectInspect = {
    ...i,
    ci: { workflows: [...i.ci.workflows], requiredChecks: [...i.ci.requiredChecks] },
    merge: { ...i.merge, rulesets: [...i.merge.rulesets] },
    notes: [...i.notes],
  };
  while (size(out) > budget) {
    const lists = [out.ci.workflows, out.ci.requiredChecks, out.merge.rulesets, out.notes];
    // Rust's `max_by_key` keeps the last of equals.
    let longest = lists[0] as string[];
    for (const l of lists) if (l.length >= longest.length) longest = l;
    if (longest.length === 0) break;
    longest.length = Math.floor(longest.length / 2);
  }
  return out;
}

/** A machine a clone could go to. */
export type Worker = {
  machineId: MachineId;
  connected: boolean;
  /** Its node understands the repo calls (it is new enough). */
  capable: boolean;
  /** The runner is usable (not degraded). */
  ready: boolean;
  running: number;
  /** load1 / cpus. */
  load?: number;
};

/** Connected first, then a usable runner, then the fewest running threads, then the lowest load, then the id. */
export function bestWorker(workers: Worker[]): MachineId | undefined {
  const order = (a: Worker, b: Worker) =>
    Number(!a.ready) - Number(!b.ready) ||
    a.running - b.running ||
    (a.load ?? Number.MAX_VALUE) - (b.load ?? Number.MAX_VALUE) ||
    (a.machineId < b.machineId ? -1 : a.machineId > b.machineId ? 1 : 0);
  let best: Worker | undefined;
  for (const w of workers.filter((w) => w.connected && w.capable)) if (!best || order(w, best) < 0) best = w;
  return best?.machineId;
}

/** Under the event log's 2 KB of data (it replaces anything larger, addId included, with `{"truncated":true}`). */
const EVENT_DATA_MAX = 1900;

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();
const continuation = (b: number | undefined) => b !== undefined && (b & 0xc0) === 0x80;

/** At most `max` bytes, cut at a character boundary, with "…" when cut. */
export function cut(text: string, max: number): string {
  const bytes = utf8.encode(text);
  if (bytes.length <= max) return text;
  let end = Math.max(0, max - 3);
  while (continuation(bytes[end])) end--;
  return `${fromUtf8.decode(bytes.subarray(0, end))}…`;
}

/** A path's end matters most: "…" and its last `max` bytes. */
export function cutPath(path: string, max: number): string {
  const bytes = utf8.encode(path);
  if (bytes.length <= max) return path;
  let start = bytes.length - Math.max(0, max - 3);
  while (continuation(bytes[start])) start++;
  return `…${fromUtf8.decode(bytes.subarray(start))}`;
}

/** `project.added` data in the Rust struct's field order. */
export const addedData = (d: ProjectAddedData): ProjectAddedData => ({
  ...(d.addId !== undefined ? { addId: d.addId } : {}),
  title: d.title,
  path: d.path,
  created: d.created,
  inspect: d.inspect,
});

/** `project.added` data that fits the event log, so its addId always arrives. */
export function fitAdded(d: ProjectAddedData): ProjectAddedData {
  const out = addedData({ ...d, title: cut(d.title, 300), path: cutPath(d.path, 500) });
  for (let budget = 1500; ; budget -= 200) {
    out.inspect = compact(out.inspect, budget);
    if (size(out) <= EVENT_DATA_MAX || budget <= 200) return out;
  }
}

/** `project.add_failed` data that fits the event log, its problem flattened in. */
export function fitFailed(d: { addId: string; repo?: GitHubRepo; path: string; problem: ProjectProblem }): ProjectAddFailedData {
  const { problem } = d;
  return {
    addId: d.addId,
    ...(d.repo !== undefined ? { repo: d.repo } : {}),
    path: cutPath(d.path, 500),
    code: problem.code,
    message: cut(problem.message, 700),
    ...(problem.fix !== undefined ? { fix: cut(problem.fix, 400) } : {}),
  };
}

/** Whether a machine's node can take the repo calls: linked, and new enough to list them in its hello. */
export function repoGate(m: MachineId, connected: boolean, capable: boolean): ProjectProblem | undefined {
  if (!connected) {
    return { code: "machine_offline", message: `${m} is offline`, fix: `Start the node on ${m} (fleetd node run) or check its network, then retry` };
  }
  if (!capable) {
    return { code: "node_too_old", message: `${m}'s node is too old to find, inspect or clone repos`, fix: `Run fleetd update on ${m}, then retry` };
  }
  return undefined;
}

/** A clone's failure, from git's own last line. */
export function cloneProblem(message: string, repo: GitHubRepo, machine: MachineId, dest: string): ProjectProblem {
  const m = message.toLowerCase();
  let code: ProjectProblem["code"] = "clone_failed";
  let fix: string;
  if (
    (m.includes("repository") && m.includes("not found")) ||
    m.includes("could not read username") ||
    m.includes("authentication failed") ||
    m.includes("terminal prompts disabled") ||
    m.includes("permission denied")
  ) {
    code = "gh_no_access";
    fix = `On ${machine}, run \`gh auth login\` with an account that can read ${repo}, then add it again`;
  } else if (m.includes("already exists")) {
    code = "dest_exists";
    fix = `Add the existing checkout at ${dest} on ${machine} instead, or clone into another folder`;
  } else if (m.includes("no space left")) {
    fix = `Free disk space on ${machine}, then add it again`;
  } else if (m.includes("no answer within") || m.includes("link dropped")) {
    fix = `The link to ${machine} dropped mid-clone; add it again (a finished checkout is offered for reuse)`;
  } else {
    fix = `Run \`git clone https://github.com/${repo} ${dest}\` on ${machine} to see why`;
  }
  return { code, message: `cloning ${repo} on ${machine} failed: ${message}`, fix };
}

// ---- The contracts' repository helpers (fleetd-contracts projects.rs, train.rs, work.rs).

const REPO = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/;

/** `owner/name`, as GitHub has it ("." and ".." are no repo names). */
export function isGitHubRepo(repo: string): boolean {
  const m = REPO.exec(repo);
  return m !== null && m[2] !== "." && m[2] !== "..";
}

/** A remote shortened to `host/path`: `git@github.com:acme/shop.git` → `github.com/acme/shop`. */
export function shortRemote(remote: string): string {
  let url = remote.trim().replace(/\/+$/, "");
  if (url.endsWith(".git")) url = url.slice(0, -4);
  if (url.startsWith("git@")) {
    const rest = url.slice(4);
    const colon = rest.indexOf(":");
    if (colon >= 0) return `${rest.slice(0, colon)}/${rest.slice(colon + 1)}`;
  }
  for (const scheme of ["https://", "http://", "ssh://git@", "ssh://", "git://"]) {
    if (url.startsWith(scheme)) {
      const rest = url.slice(scheme.length);
      const at = rest.lastIndexOf("@");
      return at >= 0 ? rest.slice(at + 1) : rest;
    }
  }
  return url;
}

/**
 * The GitHub repository in what a person pastes or drops: a URL (a `/tree/main` or `/pull/3` tail is ignored),
 * `github.com/o/r`, `git@github.com:o/r.git` or `o/r`.
 */
export function githubRepo(text: string): GitHubRepo | undefined {
  const t = text.trim();
  const short = shortRemote(t);
  let path: string | undefined;
  for (const host of ["github.com/", "www.github.com/"]) {
    if (short.startsWith(host)) {
      path = short.slice(host.length).split("/").slice(0, 2).join("/");
      break;
    }
  }
  if (path === undefined) {
    if (t.includes(":") || t.includes(".") || t.startsWith("/")) return undefined;
    path = short;
  }
  if (path.endsWith(".git")) path = path.slice(0, -4);
  return isGitHubRepo(path) ? path : undefined;
}

/** `RepoKey::of`: a remote as its repo key (`github.com/acme/shop`), undefined when it makes none. */
export function repoKeyOf(remote: string): string | undefined {
  const key = shortRemote(remote).toLowerCase();
  return key !== "" && key.length <= 300 && !/[\r\n]/.test(key) ? key : undefined;
}
