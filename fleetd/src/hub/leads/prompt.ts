// What a lead starts with. Its system prompt holds its standing rules, which a
// compaction never summarizes: `lead.start` (a project with no repo's: `assistant.start`), its voice, `lead.profiles`
// while the project allows more than the default, the human's custom instructions, then the memory. Its first message
// holds the state it starts in: the digest, and, for a project with repos besides its own directory, those.
import type { Profile, ProjectRef, ProjectRepo } from "../../shared/contracts.ts";
import type { PromptSet } from "../prompts/set.ts";

/** An automation's order, and the tools that manage them. */
const AUTOMATIONS =
  '## Automations\nAn order that says "From automation" is a run of one of this project\'s automations: start its work without asking the human first; reviews, the train and approvals still apply. For recurring or triggered work the human asks for, use `automation_create`, `automation_list`, `automation_update` (which also pauses and resumes one), `automation_delete`, `automation_run` and `automation_runs`.';

/** The lead's lines while its project's chat tags are on (a trial; artifact threads-design), under "When to speak". */
export const TAG_LINES = [
  "- Work a person asks for becomes an order, as now. Your bubbles are tagged with the order your turn worked on, and the chat shows who each is for: don't start a bubble with a person's name.",
  "- When one message covers more than one order, write a bubble per order and start each with the order's id in brackets, [W12]. fleetd hides it. A quick answer stays untagged.",
  "- A wake line \"… moved a message (…) from X to Y\" is a person's correction: take it as theirs, and act on it if it changes the work.",
].join("\n");

/** The prompt a lead starts from: `assistant.start` for one doing its own work, else `lead.start`. */
export const startPrompt = (ownWork: boolean) => (ownWork ? "assistant.start" : "lead.start");

/** A lead's system prompt and first message. */
export type LeadStart = { system: string; first: string };

/** Both as one text, as a node that can't take a system prompt gets them, and as the session's pin records them. */
export const whole = (s: LeadStart) => `${s.system.trimEnd()}\n\n${s.first}`;

/** `folder`: the folder of a project with no repo, for `assistant.start`; undefined for any other project. */
export function renderLeadStart(
  set: PromptSet,
  r: ProjectRef,
  title: string,
  profiles: Profile[],
  digest: string,
  memory: string,
  people: string,
  folder: string | undefined,
  tagged = false,
): LeadStart {
  const start = set.render(startPrompt(folder !== undefined), {
    people,
    tags: tagged ? `\n${TAG_LINES}` : "",
    project: title,
    projectRef: `${r.machineId}/${r.projectId}`,
    folder: folder ?? "",
  });
  // With the default alone every task runs on it, so the lead isn't told how to pick.
  const def = profiles.find((p) => p.default);
  let profileText = "";
  if (def && profiles.length > 1 && folder === undefined) {
    const lines = profiles.map((p) => `- \`${p.name}\`${p.default ? " (default)" : ""}: ${p.note}`);
    profileText = `\n\n${set.render("lead.profiles", { default: def.name, profiles: lines.join("\n") }).trimEnd()}`;
  }
  const [voice, automations] =
    folder !== undefined ? [set.render("assistant.voice", {}), ""] : [set.render("lead.voice", {}), `\n\n${AUTOMATIONS}`];
  const system = set.withInstructions(`${start.trimEnd()}\n\n${voice.trimEnd()}${profileText}${automations}`);
  return { system: memory ? `${system}\n\n${memory}` : system, first: digest };
}

const sameRef = (a: ProjectRef, b: ProjectRef) => a.machineId === b.machineId && a.projectId === b.projectId;

/**
 * The project's repos for the lead's first message, by name, each with its checkout and where its work lands; none for
 * a project that is only its own repo, or a plain folder with none.
 */
export function reposBlock(r: ProjectRef, repos: ProjectRepo[]): string | undefined {
  if (repos.every((repo) => sameRef(repo.checkout, r))) return undefined;
  const lines = repos.map((repo) => {
    const path = repo.path ?? repo.checkout.projectId;
    const lands = repo.repoKey !== undefined ? (repo.base !== undefined ? `, ${repo.repoKey} on ${repo.base}` : `, ${repo.repoKey}`) : ", no remote";
    const own = sameRef(repo.checkout, r) ? " (the project's own directory)" : "";
    return `- \`${repo.name}\`: ${path}${lands}${own}`;
  });
  const mine = repos.find((repo) => sameRef(repo.checkout, r));
  const absent = mine ? `\`${mine.name}\`` : "the project's directory";
  return `## Repos\nThis project holds these repos, each a checkout on ${r.machineId}:\n${lines.join("\n")}\n\nName the one each agent works in with \`spawn_agent\`'s \`repo\`: its worktree, branch, setup and PR are that repo's. Without \`repo\`, an agent given a \`pr\` works in that PR's repo, and any other in ${absent}. Other repos' files are not in your directory: read them through a read task.`;
}
