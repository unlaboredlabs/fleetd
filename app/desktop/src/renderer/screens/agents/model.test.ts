import { describe, expect, it } from "vitest";
import type { AgentRow, RecentLanding, WorkItem, WorkListOutput } from "../../../shared/contracts";
import type { LiveAgent } from "../../src/data/selectors";
import {
  actionLine,
  agentState,
  allAgents,
  elsewhere,
  headline,
  landedHow,
  nextExpiry,
  onItsPr,
  projectAgents,
  projectGroups,
  STATE_WORD,
  tally,
  workPlace,
  type GroupLine,
  type WorkListAnswer,
} from "./model";

const agent = (project: string, laneId: string, status: AgentRow["status"] = "working", workstreamId = "W1"): LiveAgent => ({
  id: `devbox/${project}/${laneId}`,
  project: `devbox/${project}`,
  row: { laneId, role: "implementer", status, title: laneId, projectRef: { machineId: "devbox", projectId: project }, projectTitle: project, workstreamId },
});

/** A list as words: a line's title in brackets, an agent's lane. */
const words = (list: readonly (GroupLine | LiveAgent)[]) => list.map((a) => ("group" in a ? `[${a.title}]` : a.row.laneId));

describe("the agents list", () => {
  it("lists one project's agents, those waiting on you first, without its lead", () => {
    const lead: LiveAgent = { ...agent("api", "lead:devbox/api"), row: { ...agent("api", "lead:devbox/api").row, role: "lead" } };
    const list = projectAgents([lead, agent("api", "T1"), agent("web", "T2", "waiting"), agent("api", "T3", "waiting"), agent("api", "T4", "queued")], "devbox/api");
    expect(list.map((a) => a.row.laneId)).toEqual(["T3", "T1", "T4"]);
    expect(projectAgents([], "devbox/api")).toEqual([]);
  });

  it("groups one project's agents under their orders' titles, the orders with one waiting on you first", () => {
    const titles: Record<string, string> = { W1: "Dark mode", W2: "Receipts in the store's zone" };
    const list = projectGroups(
      [agent("api", "T1"), agent("api", "T2", "working", "W2"), agent("api", "T3"), agent("api", "T4", "waiting", "W2"), agent("web", "T5", "waiting")],
      "devbox/api",
      (id) => titles[id],
    );
    expect(words(list)).toEqual(["[Receipts in the store's zone]", "T4", "T2", "[Dark mode]", "T1", "T3"]);
    expect(list[0]).toEqual({ group: "order:devbox/api/W2", title: "Receipts in the store's zone", level: "order", count: 2, waiting: 1 });
    expect(list[3]).toMatchObject({ count: 2, waiting: 0 });
  });

  it("puts the agents of an order the board doesn't hold, or of none, under Other agents", () => {
    const { workstreamId: _, ...row } = agent("api", "T2").row;
    const loose: LiveAgent = { ...agent("api", "T2"), row };
    expect(words(projectGroups([agent("api", "T1", "working", "W9"), loose, agent("api", "T3", "working", "W1")], "devbox/api", (id) => (id === "W1" ? "Dark mode" : undefined)))).toEqual([
      "[Other agents]",
      "T1",
      "T2",
      "[Dark mode]",
      "T3",
    ]);
    expect(projectGroups([], "devbox/api")).toEqual([]);
    // Alone, the line heads nothing: the agents stand on their own.
    expect(words(projectGroups([agent("api", "T1", "working", "W9"), loose], "devbox/api"))).toEqual(["T1", "T2"]);
  });

  it("lists every project's agents under its name and then its orders, the projects with one waiting on you first, without the leads", () => {
    const lead: LiveAgent = { ...agent("web", "lead:devbox/web"), row: { ...agent("web", "lead:devbox/web").row, role: "lead" } };
    const list = allAgents([agent("api", "T1"), agent("ops", "T5"), agent("ops", "T6", "waiting", "W7"), lead, agent("web", "T2"), agent("web", "T3", "waiting")], (id) => id);
    expect(words(list)).toEqual(["[ops]", "[W7]", "T6", "[W1]", "T5", "[web]", "[W1]", "T3", "T2", "[api]", "[W1]", "T1"]);
    expect(list[0]).toEqual({ group: "project:devbox/ops", title: "ops", level: "project", count: 2, waiting: 1 });
    // Group keys stay unique across projects that share a workstream id.
    const keys = list.filter((a): a is GroupLine => "group" in a).map((a) => a.group);
    expect(new Set(keys).size).toBe(keys.length);
    expect(allAgents([lead])).toEqual([]);
  });

  it("heads the view with what works, what waits on you and what is queued", () => {
    expect(headline([agent("api", "T1"), agent("api", "T2", "starting"), agent("api", "T3", "waiting"), agent("web", "T4", "queued")])).toBe(
      "2 working · 1 needs you · 1 queued",
    );
    expect(headline([agent("api", "T1", "waiting")])).toBe("1 needs you");
    const lead: LiveAgent = { ...agent("api", "lead:devbox/api"), row: { ...agent("api", "lead:devbox/api").row, role: "lead" } };
    expect(headline([lead, agent("api", "T1", "stalled"), agent("api", "T2")])).toBe("2 working");
    expect(headline([])).toBe("");
    // As the dots count: stalled works, parked and idle wait their turn.
    expect(tally([agent("api", "T1"), agent("api", "T2", "waiting"), agent("api", "T3", "parked"), agent("api", "T4", "idle"), agent("api", "T5", "stalled")])).toEqual({
      working: 2,
      waiting: 1,
      queued: 2,
    });
  });
});

describe("an agent's state and where its work is", () => {
  it("tells five states apart: working, queued, waiting, done and failed", () => {
    const states = Object.fromEntries((Object.keys(STATE_WORD) as AgentRow["status"][]).map((st) => [st, agentState(st)]));
    expect(states).toEqual({
      queued: "queued",
      starting: "working",
      working: "working",
      stalled: "working",
      idle: "queued",
      done: "done",
      failed: "failed",
      cancelled: "done",
      waiting: "waiting",
      parked: "queued",
    });
    expect(STATE_WORD.working).toBe("working");
    expect(STATE_WORD.waiting).toBe("needs you");
    expect(STATE_WORD.parked).toBe("paused");
  });

  it("shows its PR with the train's word for it, else its branch, else nothing", () => {
    const pr = { changeId: "X1", number: 212, repo: "acme/shop", reviewsDone: 0, reviewsNeeded: 1, url: "https://github.com/acme/shop/pull/212" } as const;
    expect(workPlace({ pr: { ...pr, state: "ci" }, branch: "fleetd/T1-dark-mode" })).toEqual({ kind: "pr", text: "#212", state: "in CI", tone: "quiet" });
    expect(workPlace({ pr: { ...pr, state: "ci_failed" } })).toMatchObject({ state: "CI failed", tone: "danger" });
    expect(workPlace({ pr: { ...pr, state: "merged" } })).toMatchObject({ tone: "success" });
    // A fleetd branch reads by its slug; its full name, task id and all, is the tooltip.
    expect(workPlace({ branch: "fleetd/T1-dark-mode" })).toEqual({ kind: "branch", text: "dark-mode", full: "fleetd/T1-dark-mode", tone: "quiet" });
    expect(workPlace({ branch: "ada/dark-mode" })).toEqual({ kind: "branch", text: "ada/dark-mode", tone: "quiet" });
    expect(workPlace({ branch: "" })).toBeUndefined();
    expect(workPlace({})).toBeUndefined();
  });

  it("knows when the window is on the agent's own PR, by number alone or with its repo", () => {
    const pr = { changeId: "X1", number: 212, repo: "acme/shop", reviewsDone: 0, reviewsNeeded: 1, url: "https://github.com/acme/shop/pull/212", state: "ci" } as const;
    const row = { projectRef: { machineId: "devbox", projectId: "api" }, pr };
    const on = (repo: string | null, number: number, projectId = "api") =>
      onItsPr({ id: "project", project: { machineId: "devbox", projectId }, message: null, panel: { tab: "prs", pr: { repo, number } } }, row);
    expect(on("acme/shop", 212)).toBe(true);
    expect(on(null, 212)).toBe(true);
    expect(on("acme/other", 212)).toBe(false);
    expect(on("acme/shop", 7)).toBe(false);
    expect(on("acme/shop", 212, "web")).toBe(false);
    expect(onItsPr({ id: "project", project: row.projectRef, message: null, panel: { tab: "agents", agent: null } }, row)).toBe(false);
    expect(onItsPr({ id: "status" }, row)).toBe(false);
    expect(onItsPr({ id: "project", project: row.projectRef, message: null, panel: { tab: "prs", pr: { repo: null, number: 212 } } }, { projectRef: row.projectRef })).toBe(false);
  });
});

describe("an agent's steps", () => {
  const step = (action: Partial<Extract<Parameters<typeof actionLine>[0], { kind: "action" }>["action"]>) =>
    actionLine({ kind: "action", id: "a1", at: "2026-10-19T10:00:00.000Z", action: { at: "2026-10-19T10:00:00.000Z", kind: "command", status: "completed", failed: false, summary: "npm test", ...action } });

  it("says each action in the past tense, the one running in the present, and a failure with its exit code", () => {
    expect(step({})).toEqual({ words: "ran", machine: "npm test", tone: "quiet" });
    expect(step({ status: "running" }).words).toBe("running");
    expect(step({ kind: "file_change", summary: "src/a.ts" }).words).toBe("edited");
    expect(step({ failed: true, status: "failed", exitCode: 1 })).toMatchObject({ tone: "danger", outcome: "failed, exit 1" });
    expect(step({ failed: true, status: "failed" }).outcome).toBe("failed");
    expect(step({ kind: "other", summary: "compacted" }).words).toBe("");
  });
});

describe("work elsewhere on the repo", () => {
  const NOW = Date.parse("2026-10-25T12:00:00.000Z");
  const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
  const H = 3_600_000;
  const api = { machineId: "devbox", projectId: "api" };
  const web = { machineId: "devbox", projectId: "web" };
  const item = (id: string, kind: WorkItem["kind"], more: Partial<WorkItem> = {}): WorkItem => ({
    id,
    kind,
    title: `${id} title`,
    state: "running",
    keys: [],
    paths: [],
    since: iso(-H),
    ...more,
  });
  const claim = (id: string, owner: WorkItem["owner"], state = "active", expiresIn = 9 * H): WorkItem =>
    item(id, "claim", { state, claimId: id, ...(owner === undefined ? {} : { owner }), projectRef: api, expiresAt: iso(expiresIn) });
  const person = { kind: "human_session", keyId: "k-laptop", label: "laptop" } as const;
  const landing = (sha: string, route: RecentLanding["route"], more: Partial<RecentLanding> = {}): RecentLanding => ({
    sha: sha.repeat(40),
    at: iso(-2 * H),
    route,
    subject: "feat: dark mode toggle",
    covers: [],
    ...more,
  });
  const list = (items: WorkItem[], recentLandings: RecentLanding[] = []): WorkListOutput => ({
    scope: { repoKey: "github.com/acme/shop", base: "main" },
    items,
    recentLandings,
  });
  const titles: Record<string, string> = { "devbox/api": "api", "devbox/web": "web" };
  const rows = (out: WorkListAnswer) => elsewhere(out, "devbox/api", NOW, (k) => titles[k]);

  it("lists a person's claims first, then other work, then outside landings, and expired claims last", () => {
    const out = list(
      [
        item("T7", "task", { projectRef: web, taskId: "T7" }),
        claim("C3", { kind: "agent_key", keyId: "k-ci", label: "ci-bot" }),
        claim("C1", person, "expired", -3 * H),
        claim("C2", person),
        item("X4", "change", { projectRef: web, state: "ci" }),
        item("acme/shop#57", "pr", { state: "open" }),
      ],
      [landing("a", "direct_push", { authorEmail: "ada@example.com" })],
    );
    expect(rows(out).map((r) => r.id)).toEqual(["C2", "T7", "C3", "X4", "acme/shop#57", `landing:${"a".repeat(40)}`, "C1"]);
    expect(rows(out).map((r) => r.dim)).toEqual([false, false, false, false, false, false, true]);
  });

  it("leaves out the project's own agents and PRs, and the claims its lead holds", () => {
    const out = list([
      item("T1", "task", { projectRef: api }),
      item("X1", "change", { projectRef: api }),
      claim("C1", { kind: "lead", keyId: "devbox/api" }),
      claim("C2", { kind: "lead", keyId: "devbox/web" }),
    ]);
    expect(rows(out).map((r) => r.id)).toEqual(["C2"]);
    expect(rows(out)[0]?.meta).toBe("held by web’s lead · expires in 9 h");
    expect(rows(list([]))).toEqual([]);
  });

  it("says who holds a claim and when it expires, or expired", () => {
    const [mine, theirs, gone] = rows(
      list([claim("C2", person, "active", 40 * 60_000), claim("C3", { kind: "agent_key", keyId: "k-ci" }), claim("C1", { kind: "human_session", keyId: "k-desk" }, "expired", -3 * H)]),
    );
    expect(mine).toMatchObject({ tag: "You", title: "C2 title", meta: "held by you (laptop) · expires in 40 min" });
    expect(theirs).toMatchObject({ tag: "Claim", meta: "held by agent key k-ci · expires in 9 h" });
    expect(gone).toMatchObject({ tag: "Expired", meta: "held by you · expired 3 h ago", dim: true });
  });

  it("says whose an agent or PR is, and what it is doing", () => {
    const [task, change, pr] = rows(list([item("T7", "task", { projectRef: web }), item("X4", "change", { projectRef: web, state: "ci_failed" }), item("acme/shop#57", "pr", { state: "open" })]));
    expect(task).toMatchObject({ tag: "Agent", meta: "web’s agent · running" });
    expect(change).toMatchObject({ tag: "PR", meta: "web’s PR · CI failed" });
    expect(pr).toMatchObject({ tag: "PR", meta: "open PR outside fleetd · acme/shop#57" });
  });

  it("reads a hub from before recentLandings and claims' expiresAt: no landings, and a claim says only who holds it", () => {
    const { expiresAt: _, ...old } = claim("C2", person);
    const answer: WorkListAnswer = { scope: { repoKey: "github.com/acme/shop", base: "main" }, items: [old, item("T7", "task", { projectRef: web })] };
    expect(rows(answer)).toEqual([
      { id: "C2", tag: "You", title: "C2 title", meta: "held by you (laptop)", dim: false },
      { id: "T7", tag: "Agent", title: "T7 title", meta: "web’s agent · running", dim: false },
    ]);
    expect(nextExpiry(answer, NOW)).toBeUndefined();
  });

  it("knows when the soonest active claim shown expires, to read the list again then", () => {
    const out = list([claim("C1", person, "expired", -3 * H), claim("C2", person, "active", 2 * H), claim("C3", person, "active", 40 * 60_000), claim("C4", person, "active", -60_000)]);
    expect(nextExpiry(out, NOW)).toBe(NOW + 40 * 60_000);
    expect(nextExpiry(list([]), NOW)).toBeUndefined();
  });

  it("says how each landing got there, by whom, when, and what it covers", () => {
    const pushed = landing("a", "direct_push", { authorEmail: "ada@example.com", covers: ["P5"] });
    const merged = landing("b", "pr_outside", { pr: "#57" });
    const [one, two, ...rest] = rows(list([], [pushed, merged, landing("c", "train")]));
    expect(one).toEqual({
      id: `landing:${"a".repeat(40)}`,
      tag: "Pushed",
      title: "feat: dark mode toggle",
      meta: "pushed straight to main by ada@example.com · 2 h ago · covers P5",
      dim: false,
      sha: "a".repeat(40),
    });
    expect(two).toMatchObject({ tag: "Merged", meta: "PR #57 merged outside fleetd · 2 h ago" });
    expect(rest).toEqual([]);
    expect(landedHow(landing("d", "pr_outside"), "develop")).toBe("merged outside fleetd");
    expect(landedHow(landing("d", "direct_push"), "develop")).toBe("pushed straight to develop");
  });
});
