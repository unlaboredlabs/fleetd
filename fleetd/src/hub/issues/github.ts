// The issues area's GitHub (index.ts `IssueGitHub`) on the train's reader: the hub's `gh`, as its App where the App is
// installed, with the train's rate-limit budget and its ETags, so a poll of a repo where nothing changed costs no call.
import type { TrainGitHub } from "../train/github.ts";
import { canWrite, isLogin, ISSUE_LABEL, type IssueSeen, type Labelling, readIssue } from "./rules.ts";
import type { IssueGitHub } from "./index.ts";

const ACCEPT = "Accept: application/vnd.github+json";

const failed = (path: string, r: { status: number; message: string }) => new Error(`gh api ${path}: ${r.status} ${r.message}`);

function parse(text: string): unknown {
  try {
    return JSON.parse(text === "" ? "null" : text);
  } catch {
    return undefined;
  }
}

/** The last labellings of an issue that GraphQL reads, newest last; far more than an issue is ever labelled again. */
const LABELLINGS = 20;

export class GhIssues implements IssueGitHub {
  constructor(private readonly gh: TrainGitHub) {}

  async labelledOpen(repo: string): Promise<IssueSeen[]> {
    const path = `repos/${repo}/issues?labels=${ISSUE_LABEL}&state=open&sort=updated&direction=desc&per_page=100`;
    const r = await this.gh.exchange("GET", path, ACCEPT);
    if (!r.ok) throw failed(path, r);
    const list = parse(r.text);
    return Array.isArray(list) ? list.flatMap((v) => readIssue(repo, v) ?? []) : [];
  }

  async issue(repo: string, n: number): Promise<{ issue: IssueSeen; closedBy?: string } | undefined> {
    const path = `repos/${repo}/issues/${n}`;
    const r = await this.gh.exchange("GET", path, ACCEPT);
    if (!r.ok && (r.status === 404 || r.status === 410)) return undefined;
    if (!r.ok) throw failed(path, r);
    const v = parse(r.text) as { closed_by?: { login?: unknown } | null } | undefined;
    const issue = readIssue(repo, v);
    if (!issue) return undefined;
    const by = v?.closed_by?.login;
    return typeof by === "string" ? { issue, closedBy: by } : { issue };
  }

  async labellings(repo: string, n: number): Promise<Labelling[]> {
    const [owner, name] = repo.split("/");
    // The number is the hub's own integer; owner and name go as variables, which also pick the App's token.
    const query =
      `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { issue(number: ${Math.trunc(n)}) { ` +
      `timelineItems(itemTypes: [LABELED_EVENT], last: ${LABELLINGS}) { nodes { ... on LabeledEvent { id createdAt ` +
      "label { name } actor { login __typename } } } } } } }";
    const data = (await this.gh.graphql(query, [
      ["owner", owner ?? ""],
      ["name", name ?? ""],
    ])) as { repository?: { issue?: { timelineItems?: { nodes?: unknown[] } } | null } | null } | null;
    const nodes = data?.repository?.issue?.timelineItems?.nodes ?? [];
    const out: Labelling[] = [];
    for (const node of nodes) {
      const e = node as { id?: unknown; createdAt?: unknown; label?: { name?: unknown }; actor?: { login?: unknown; __typename?: unknown } | null };
      if (typeof e.id !== "string" || typeof e.createdAt !== "string") continue;
      if (typeof e.label?.name !== "string" || e.label.name.toLowerCase() !== ISSUE_LABEL) continue;
      const login = typeof e.actor?.login === "string" ? e.actor.login : "";
      out.push({ id: e.id, at: e.createdAt, actor: login || "someone", actorIsBot: e.actor?.__typename !== "User" });
    }
    return out;
  }

  async canWrite(repo: string, login: string): Promise<boolean> {
    if (!isLogin(login)) return false;
    const r = await this.gh.get(`repos/${repo}/collaborators/${login}/permission`);
    // Not a collaborator at all: GitHub answers 404.
    if (!r.ok && r.status === 404) return false;
    if (!r.ok) throw failed("the labeller's permission", r);
    return canWrite(r.value as { permission?: unknown; role_name?: unknown });
  }

  async comment(repo: string, n: number, body: string): Promise<void> {
    const path = `repos/${repo}/issues/${n}/comments`;
    const r = await this.gh.exchange("POST", path, ACCEPT, [["body", body]]);
    if (!r.ok) throw failed(path, r);
  }

  async pullBody(repo: string, n: number): Promise<string> {
    return (await this.gh.pull(repo, n)).body ?? "";
  }

  async pullMerge(repo: string, n: number): Promise<{ sha?: string } | undefined> {
    const p = await this.gh.pull(repo, n);
    if (!p.merged) return undefined;
    return p.merge_commit_sha ? { sha: p.merge_commit_sha } : {};
  }

  async setPullBody(repo: string, n: number, body: string): Promise<void> {
    const path = `repos/${repo}/pulls/${n}`;
    const r = await this.gh.exchange("PATCH", path, ACCEPT, [["body", body]]);
    if (!r.ok) throw failed(path, r);
  }
}
