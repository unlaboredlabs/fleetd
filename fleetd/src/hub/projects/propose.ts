// A lead proposes a new project (`project_propose`, W614, D448). A lead never creates one. Its call is a permission
// prompt in every lead's session (LEAD_ASK_WHY), which the hub answers with a card that says exactly what would be
// made (`proposal`), in every approval mode. Only a person's Approve on the card makes it (`make`), as `project_add`
// from their own device does: on the proposing project's machine, and theirs. Then the lead's call goes through and
// returns what was made (`answer`), or that a clone started, whose end or failure wakes the lead. Denied or
// unanswered, nothing is made, and the call itself makes nothing.
import type { GitHubRepo, MachineId, ProjectProblem, ProjectRef, ToolPreview } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import type { Caller } from "../api/registry.ts";
import { approvals } from "../approvals/index.ts";
import type { PromptVerdict, ProposalApprover } from "../approvals/ports.ts";
import { clipUtf16, sortedValue } from "../integrations/policy.ts";
import { type LeadCall, leadWakes } from "../leads/seams.ts";
import { add, type CloneEnd } from "./add.ts";
import { repoOf } from "./discover.ts";

/** What a card shows, and all that approving it makes. */
type Shown = { title: string; repo: GitHubRepo | null; machineId: MachineId; path: string };

/** What a lead's call returns once a person approved its card. */
type Outcome = { key: string; result: Record<string, unknown> };

/** The approvals that made a project under this hub process, and what each one's call is still to return. */
type Proposals = { made: Set<string>; outcomes: Outcome[] };

const proposals = (hub: Hub) => hub.area<Proposals>("project_proposals", () => ({ made: new Set(), outcomes: [] }));

/** A person's own way to the same, said where a proposal can't go on. */
const THEMSELVES = "The person makes it themselves with New project in the app";

const keyOf = (r: ProjectRef, title: string, repo: GitHubRepo | null) => JSON.stringify([r.machineId, r.projectId, title, repo]);

/** A proposal as its call gives it: a title on one line, and a GitHub repo or none. */
function asked(input: unknown): { title: string; repo: GitHubRepo | null } {
  const { title, url } = (input !== null && typeof input === "object" ? input : {}) as { title?: unknown; url?: unknown };
  const name = typeof title === "string" ? title.trim() : "";
  if (name === "" || name.length > 200 || /[\r\n]/u.test(name)) throw new ToolError("invalid", "Give title: the new project's name, on one line of at most 200 characters.");
  if (url === undefined) return { title: name, repo: null };
  if (typeof url !== "string") throw new ToolError("invalid", "url is a GitHub URL or owner/repo.");
  return { title: name, repo: repoOf(url) };
}

/** A key that may add a project on `m` and nothing else: the hub's own for a card's check, or the approver's. */
function keyFor(m: MachineId, by?: ProposalApprover): Caller {
  return {
    keyId: "project-propose",
    name: by?.name ?? "fleetd",
    prefix: "",
    kind: by ? "human" : "agent",
    grants: [{ role: "operate", machines: [m] }],
    createdAt: new Date(0).toISOString(),
    ...(by?.person ? { person: by.person } : {}),
  } as unknown as Caller;
}

const words = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\.+$/u, "");

function preview(shown: Shown): ToolPreview {
  // As `project_add` from a person's own device: one with no repo is Only me, its maker's; one with a repo is shared.
  const whose = shown.repo === null ? "once you approve. Only you will see it (Only me)" : `cloned from ${shown.repo} once you approve. Everyone on this hub can use it, as with a repo you add yourself`;
  const card = { ...shown, onlyMe: shown.repo === null, what: `A new project on ${shown.machineId}, ${whose}. Nothing is made before that.` };
  return {
    server: "fleetd",
    tool: "project_propose",
    action: "write",
    title: clipUtf16(`Create the project “${shown.title}”`, 200),
    input: JSON.stringify(sortedValue(card), null, 2),
  };
}

/**
 * The card for a proposal: its title, its repo, the machine and the folder, checked as `project_add`'s dry run
 * checks them and making nothing. What could not be made is refused here, before a person is asked.
 */
export async function proposal(hub: Hub, project: ProjectRef, input: unknown): Promise<PromptVerdict> {
  const m = project.machineId;
  try {
    const { title, repo } = asked(input);
    const out = await add(hub, keyFor(m), { ...(repo === null ? { create: true } : { url: repo }), title, machineId: m, dryRun: true });
    if (out.clone?.exists) {
      return { deny: `Blocked by fleetd: no card was shown. ${out.clone.path} already exists on ${m}, so ${repo} can't be cloned there. ${THEMSELVES}, where a checkout that is there can be added as it is.` };
    }
    return { ask: preview({ title, repo, machineId: m, path: out.path }) };
  } catch (e) {
    if (!(e instanceof ToolError)) throw e;
    // A folder that is taken has a fix worded for a person's form; any other fix is the lead's to pass on.
    const fix = e.code === "invalid" || !e.fix ? `Propose it under another title, or: ${THEMSELVES}` : e.fix;
    return { deny: `Blocked by fleetd: no card was shown. ${words(e)}. ${fix.replace(/\.+$/u, "")}.` };
  }
}

function shownOf(shown: unknown): Shown | undefined {
  const s = (shown !== null && typeof shown === "object" ? shown : {}) as Record<string, unknown>;
  if (typeof s.title !== "string" || typeof s.machineId !== "string" || typeof s.path !== "string") return undefined;
  if (s.repo !== null && typeof s.repo !== "string") return undefined;
  return { title: s.title, repo: s.repo as GitHubRepo | null, machineId: s.machineId as MachineId, path: s.path };
}

/** Wakes the proposing lead with one line. Never throws: what it tells of has happened. */
function tell(hub: Hub, r: ProjectRef, text: string): void {
  try {
    leadWakes(hub).trigger(r, { kind: "line", line: "request", text });
  } catch (error) {
    console.warn("a lead was not told of the project it proposed:", error);
  }
}

const cloneDone = (hub: Hub, addId: string) => hub.db.conn.query("DELETE FROM project_setup_clones WHERE add_id = ?").run(addId);

/** What the lead whose proposal's clone a hub restart cut off is told (calls.ts `tellInterrupted`). */
export const interrupted = (title: string, repo: string, path: string) =>
  `project_propose: the hub restarted while cloning ${repo} into ${path}, so the project ${title} was not created. Tell the person: they can add it with New project in the app, where a clone that finished on the machine is added as it is.`;

/**
 * A person approved the card showing `shown`: the project is made as their own `project_add` makes it, at the folder
 * the card named. A string is why it was not made. A card approved twice (its answer undelivered) makes one.
 */
export async function make(hub: Hub, project: ProjectRef, shown: unknown, by: ProposalApprover, requestId: string): Promise<string | undefined> {
  const state = proposals(hub);
  if (state.made.has(requestId)) return undefined;
  const card = shownOf(shown);
  const m = project.machineId;
  if (!card || card.machineId !== m) return "its card showed nothing to create";
  const { title, repo, path } = card;
  const who = by.person?.name ?? by.name;
  const LEAD = "its own lead starts with their first message there";
  const done = (result: Record<string, unknown>) => {
    state.made.add(requestId);
    state.outcomes.push({ key: keyOf(project, title, repo), result });
    // What no call came back for (a turn that ended first) is not kept for ever.
    if (state.outcomes.length > 50) state.outcomes.shift();
  };
  try {
    if (repo === null) {
      const out = await add(hub, keyFor(m, by), { create: true, title, path, machineId: m });
      done({ created: true, projectId: out.projectId, title, path: out.path, next: `${title} is a project now, at ${out.path} on ${m}. It is ${who}'s alone (Only me), in their list of projects; ${LEAD}.` });
      return undefined;
    }
    // A clone can end before `add` returns: its row is written only while it still runs.
    let ended = false;
    let addId: string | undefined;
    const end: CloneEnd = {
      added: (projectId, at) => {
        ended = true;
        if (addId !== undefined) cloneDone(hub, addId);
        tell(hub, project, `project_propose: ${repo} is cloned, and ${title} is a project now (${projectId}), at ${at} on ${m}, as one ${who} added themselves; ${LEAD}.`);
      },
      failed: (problem: ProjectProblem) => {
        ended = true;
        if (addId !== undefined) cloneDone(hub, addId);
        tell(hub, project, `project_propose: the project ${title} was not created. ${problem.message}${problem.fix ? ` ${problem.fix}.` : ""} Tell the person.`);
      },
    };
    const out = await add(hub, keyFor(m, by), { url: repo, title, dest: path, machineId: m }, end);
    addId = out.addId;
    if (!ended && addId !== undefined) {
      hub.db.conn
        .query("INSERT OR REPLACE INTO project_setup_clones (add_id, machine_id, project_id, repo, path, proposed) VALUES (?, ?, ?, ?, ?, ?)")
        .run(addId, m, project.projectId, repo, out.path, title);
    }
    done({
      cloning: true,
      title,
      path: out.path,
      next: `${who} approved it: cloning ${repo} into ${out.path} on ${m}, and ${title} is a project once that ends. You are woken when it ends, or when it fails: tell the person then, and never before that it exists.`,
    });
    return undefined;
  } catch (e) {
    if (!(e instanceof ToolError)) throw e;
    return `the project was not created: ${words(e)}. Propose it again once that is sorted, or: ${THEMSELVES}`;
  }
}

/**
 * The lead's call itself, which runs only once its prompt was allowed: what the person's approval made. With no
 * approval behind it, it makes nothing and says so.
 */
export function answer(hub: Hub, project: ProjectRef, call: LeadCall): Record<string, unknown> {
  const { title, repo } = asked(call);
  const { outcomes } = proposals(hub);
  const at = outcomes.findIndex((o) => o.key === keyOf(project, title, repo));
  if (at < 0) {
    throw new ToolError(
      "forbidden",
      `Nothing was created: no approval of a project named ${title} is waiting here. Only a person's Approve on the card project_propose shows them makes one.`,
      "If they approved it a moment ago, project_list shows it. Otherwise call project_propose as your own tool and wait for their answer",
    );
  }
  return (outcomes.splice(at, 1)[0] as Outcome).result;
}

/** Fills the approvals' hooks for a proposal's card and its approval. */
export function fill(hub: Hub): void {
  Object.assign(approvals(hub).deps.hooks, {
    projectProposal: (project: ProjectRef, input: unknown) => proposal(hub, project, input),
    projectProposed: (project: ProjectRef, shown: unknown, by: ProposalApprover, requestId: string) => make(hub, project, shown, by, requestId),
  });
}
