// How the Prompts list presents the hub's registry: groups by what a person is looking for (not by how fleetd sends
// a text), a plain name, and one line saying when it is sent. The hub's own title and `sentWhen` stay the fallback,
// so a prompt a newer hub adds still shows up, in "Other", with the hub's words.
import type { PromptGroup, PromptSummary } from "./contracts";

export interface CatalogGroup {
  readonly key: string;
  readonly title: string;
  readonly blurb: string;
}

export const GROUPS = [
  { key: "lead", title: "The lead", blurb: "Each project's lead: its role, the digest it reads, and the frame of every wake." },
  { key: "tasks", title: "Task agents", blurb: "The first message of every writer, reader and reviewer task." },
  { key: "orders", title: "Orders and steering", blurb: "How a new order, your notes, answers and stops reach the lead." },
  { key: "task-news", title: "Task news for the lead", blurb: "What the lead hears when a task finishes, stops or asks." },
  { key: "reviews", title: "Reviews and checks", blurb: "Reviewers, verifiers, judges, and what their verdicts tell the lead." },
  { key: "train", title: "Merge train", blurb: "Messages about pull requests on their way to main." },
  { key: "digest", title: "Digest lines", blurb: "One line each in the digest the lead reads at every wake." },
  { key: "keep-going", title: "Stalls, limits and denied tools", blurb: "What an agent is told when it stalls, hits a limit or a tool is refused." },
  { key: "one-shots", title: "Routing, status and retro", blurb: "Single questions fleetd asks a model without tools." },
  { key: "playbooks", title: "Playbooks", blurb: "How the lead runs each kind of order." },
  { key: "other", title: "Other", blurb: "Prompts this version of the app has no description for yet." },
] as const satisfies ReadonlyArray<CatalogGroup>;

export type GroupKey = (typeof GROUPS)[number]["key"];

interface Entry {
  readonly group: GroupKey;
  readonly name: string;
  readonly description: string;
}

const e = (group: GroupKey, name: string, description: string): Entry => ({ group, name, description });

/** Keyed by registry id. Order within a group follows this table. */
const ENTRIES: Readonly<Record<string, Entry>> = {
  "lead.start": e("lead", "Lead's role and rules", "The lead's first message: what it does, the commands it uses, what it must never do."),
  "lead.digest": e("lead", "Project digest", "The current state of the project, at the top of the lead's first message and every wake."),
  "wake.frame": e("lead", "Wake frame", "Wraps every wake: the digest, then the list of reasons it was woken."),

  "task.brief.write": e("tasks", "Writer task", "First message of a task that changes code and opens a pull request."),
  "task.brief.read": e("tasks", "Reader task", "First message of a task that only reads and reports back."),
  "task.brief.review": e("tasks", "Review, verify and judge tasks", "First message of every review, verifier and judge task."),

  "wake.intent": e("orders", "New order", "Wakes the lead with an order you gave."),
  "wake.intent.playbook": e("orders", "New order's playbook", "Adds the order's playbook to the wake when the digest does not show it."),
  "wake.intent.playbook_listed": e("orders", "New order's playbook, already listed", "Points the lead at a playbook the digest already shows."),
  "wake.order_refs": e("orders", "Links and files with an order", "Lists the references and attachments that came with a new order."),
  "steer.message": e("orders", "Your steer, mid-run", "Your words (or the lead's) delivered straight to a running agent."),
  "wake.agent_steer": e("orders", "You steered one of its tasks", "Tells the lead, at its next wake, that you spoke to one of its tasks directly."),
  "wake.order_stopped": e("orders", "You stopped an order", "Tells the lead an order was stopped and how many tasks were cancelled."),
  "wake.order_idle": e("orders", "Order with nothing under way", "Wakes the lead when it ended a turn and left an order with no work started."),
  "wake.decision": e("orders", "Your decision", "Wakes the lead with a decision you recorded for the project."),
  "wake.answers": e("orders", "Your answers", "Wakes the lead when you answered its questions."),

  "wake.task_result": e("task-news", "Task finished", "Wakes the lead when a task completes or fails, with its result."),
  "wake.task_cancelled": e("task-news", "Task cancelled", "Wakes the lead when one of its tasks was cancelled."),
  "wake.task_waiting": e("task-news", "Task asks a question", "Wakes the lead when a task is waiting for an answer."),
  "wake.task_start_failed": e("task-news", "Task could not start", "Tells the lead a queued task failed to start, and why."),

  "review.reviewer": e("reviews", "Reviewer", "Reviews a pull request each round, by the project's review rules."),
  "review.verifier": e("reviews", "Verifier", "Checks a large pull request actually does what it claims."),
  judge: e("reviews", "Judge", "Decides whether a done-when check of a claim passed."),
  "judge.research": e("reviews", "Research judge", "Decides whether a research claim's check passed."),
  "task.review_findings": e("reviews", "Blocking findings, to the author", "Sends a review's blocking findings back to the task that wrote the PR."),
  "wake.claim_failed": e("reviews", "Claim failed", "Wakes the lead when a done claim did not pass its checks."),
  "wake.claim_passed": e("reviews", "Claim passed late", "Wakes the lead when a claim passed after it had moved on."),
  "wake.research_verdict.go": e("reviews", "Research says go", "Wakes the lead when a research claim came back GO."),
  "wake.research_verdict.stop": e("reviews", "Research says stop", "Wakes the lead when a research claim came back STOP."),
  "wake.research_verdict.inconclusive": e("reviews", "Research inconclusive", "Wakes the lead when a research claim could not decide."),

  "task.train_rebase": e("train", "PR needs a rebase", "Tells the author task its pull request no longer rebases cleanly."),
  "task.train_ci_failed": e("train", "PR's CI is red", "Tells the author task its pull request failed or timed out in CI."),
  "wake.train.merged": e("train", "PR merged", "Tells the lead a pull request reached main."),
  "wake.train.left": e("train", "PR left the train", "Tells the lead the train gave up on a pull request, and why."),
  "wake.train.refused": e("train", "Train refused a PR", "Tells the lead the train would not take a task's pull request."),
  "wake.train.gave_up": e("train", "GitHub kept refusing a merge", "Tells the lead GitHub refused to merge a pull request too many times."),
  "wake.train.line": e("train", "Train message for the lead", "A train message the lead gets when the PR's author task is gone."),

  "digest.workstream.no_brief": e("digest", "Order without a brief", "One line per order still waiting for its brief."),
  "digest.finish_all_idle": e("digest", "Finish-all has nothing to do", "One line per finish-all order with nothing left to start."),
  "digest.answer.withdrawn": e("digest", "Question you dropped", "One line per question you dropped, so the lead stops pursuing it."),
  "digest.tasks.running": e("digest", "Running task", "One line per task at work."),
  "digest.tasks.idle": e("digest", "Task waiting for input", "One line per task waiting on an answer."),
  "digest.tasks.queued": e("digest", "Queued task", "One line per task waiting for a free slot."),
  "digest.tasks.ended": e("digest", "Task ended", "One line per task that ended since the last wake."),
  "digest.train.repo": e("digest", "Merge train of a repo", "One line per repository's merge train."),
  "digest.train.merged": e("digest", "Merged PR", "One line per pull request merged since the last wake."),
  "digest.train.parked": e("digest", "PR back with its author", "One line per pull request that needs a rebase or has red CI."),
  "digest.train.waived": e("digest", "Waived PR", "One line per pull request let through without its usual checks."),

  "watchdog.nudge": e("keep-going", "Stall nudge", "Sent once to a run that has gone quiet for too long."),
  "usage.continue": e("keep-going", "Continue after a usage limit", "Resumes a paused agent once the usage limit resets."),
  "wake.scheduled_late": e("keep-going", "Scheduled wake, late", "A wake the lead set for itself that fired late."),
  "wake.scheduled_held": e("keep-going", "Scheduled wake, held by a limit", "A wake the lead set that was held while usage was paused."),
  "permission.denied.policy": e("keep-going", "Tool refused by the project's rules", "What an agent reads when the project's policy refuses a tool."),
  "permission.denied.human": e("keep-going", "Tool refused by you", "What an agent reads when you deny a tool request."),
  "permission.denied.withdrawn": e("keep-going", "Tool request withdrawn", "What an agent reads when its tool request was withdrawn unanswered."),
  "permission.denied.answer": e("keep-going", "Tool refused without a reason", "What an agent reads when a tool was denied with no message."),

  router: e("one-shots", "Order router", "Picks the project and playbook for an order you did not address."),
  "router.retry": e("one-shots", "Order router, second try", "Asked once more when the router's first answer was unusable."),
  "status.headline": e("one-shots", "Status headline", "Writes the one-line headline of the Status view."),
  retro: e("one-shots", "Retro", "Reviews recent incidents and proposes playbook changes, at most twice a day."),

  "playbook.bugfix": e("playbooks", "Bug fix", "How the lead runs an order to fix a bug: repro first, then the fix."),
  "playbook.feature": e("playbooks", "Feature", "How the lead runs an order to build something new."),
  "playbook.research": e("playbooks", "Research", "How the lead runs an order to find something out and report."),
  "playbook.finish-all": e("playbooks", "Finish all", "How the lead keeps starting work until nothing valuable is left."),
};

const ORDER: ReadonlyMap<string, number> = new Map(Object.keys(ENTRIES).map((id, ix) => [id, ix]));

/** The hub's groups, for a prompt this table does not know. */
const HUB_GROUP: Readonly<Record<PromptGroup, GroupKey>> = {
  lead: "lead",
  tasks: "tasks",
  reviews_and_checks: "reviews",
  wakes_and_messages: "other",
  one_shots: "one-shots",
  playbooks: "playbooks",
  instructions: "other",
};

export interface CatalogRow {
  readonly summary: PromptSummary;
  readonly name: string;
  readonly description: string;
}

/** A prompt's plain name and one-line description. */
export function describe(p: Pick<PromptSummary, "id" | "title" | "sentWhen">): { name: string; description: string } {
  const known = ENTRIES[p.id];
  return known ? { name: known.name, description: known.description } : { name: p.title, description: sentence(p.sentWhen) };
}

export function groupOf(summary: PromptSummary): GroupKey {
  return ENTRIES[summary.id]?.group ?? HUB_GROUP[summary.group];
}

/**
 * "per new order" → "Sent per new order.", with the hub's tool names read as words ("every lead_restart" → "every
 * lead restart"), since this line is for people.
 */
function sentence(sentWhen: string): string {
  const s = sentWhen
    .trim()
    .replace(/\.$/u, "")
    .replace(/`/gu, "")
    .replace(/\b([a-z]+(?:_[a-z]+)+)\b/gu, (w) => w.replaceAll("_", " "));
  return s === "" ? "" : `Sent ${s}.`;
}

export interface CatalogSection {
  readonly group: CatalogGroup & { readonly key: GroupKey };
  readonly rows: ReadonlyArray<CatalogRow>;
}

/** Folds case and accents, so "resume" finds "Résumé". */
const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/**
 * The list as shown: grouped, in table order, filtered by every word of `query` (each must appear in the name,
 * the description, the hub's title or the id). Empty groups are left out. Instructions have their own page.
 */
export function sections(prompts: ReadonlyArray<PromptSummary>, query: string): CatalogSection[] {
  const words = fold(query).split(/\s+/u).filter(Boolean);
  const byGroup = new Map<GroupKey, CatalogRow[]>();
  for (const summary of prompts) {
    if (summary.kind === "instructions") continue;
    const row: CatalogRow = { summary, ...describe(summary) };
    if (words.length > 0) {
      const hay = fold(`${row.name} ${row.description} ${summary.title} ${summary.id}`);
      if (!words.every((w) => hay.includes(w))) continue;
    }
    const key = groupOf(summary);
    const rows = byGroup.get(key) ?? [];
    rows.push(row);
    byGroup.set(key, rows);
  }
  const rank = (r: CatalogRow) => ORDER.get(r.summary.id) ?? Number.MAX_SAFE_INTEGER;
  return GROUPS.flatMap((group) => {
    const rows = byGroup.get(group.key);
    if (!rows) return [];
    rows.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    return [{ group, rows }];
  });
}
