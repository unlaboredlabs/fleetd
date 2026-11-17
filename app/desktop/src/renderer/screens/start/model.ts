// Get started (fleetd cloud's first run, #/start): what a team still needs before its first project's lead can work,
// told from the hub's own state, so leaving and coming back lands on the same step. Nothing here is stored but a
// skipped GitHub: a computer that joined, its Claude login, a GitHub connection and a project are the hub's.
//
// The real dependencies, in order (fleetd-cloud: accounts, machines, github):
//   - a team: made at the first sign-in, named from the person (accounts' place); a teammate joins one by its invite;
//   - a computer of the team's, online: agents and leads run on it (fleetd hosts only the hub, and a hosted sandbox
//     starts from a machine that makes boxes, so a sandbox account never stands in for the first computer);
//   - Claude logged in on it (machine_claude_login: its sign-in page, then the code it shows; the node brings
//     Claude Code itself to the hub's version);
//   - GitHub, for a project from a repo: the person's own connection through fleetd's App and the App installed on
//     the repos (D517), one trip to GitHub; an empty project needs neither;
//   - a project: picking one clones it onto the computer and opens its chat with the lead.

/** A repository GitHub lets fleetd's App reach, newest push first. */
export interface StartRepo {
  readonly owner: string;
  readonly name: string;
  /** When it was last pushed to, in words ("2 h"). */
  readonly pushed: string;
}

/** A project of the team, for a teammate to open. */
export interface TeamProject {
  readonly name: string;
  /** Its state in a few quiet words ("3 agents at work", "Quiet since Monday"). */
  readonly line: string;
  readonly busy: boolean;
}

export type ComputerStep =
  /** No computer yet: the join line to paste, which renews itself when its code runs out. */
  | { readonly at: "line"; readonly line: string }
  /** Joined, and its Claude isn't logged in: Log in, then the code from the sign-in page. */
  | { readonly at: "claude"; readonly machine: string; readonly login: "start" | "code" | "checking"; readonly error?: string }
  | { readonly at: "ready"; readonly machine: string };

export type GithubStep =
  | { readonly at: "todo" }
  | { readonly at: "waiting" }
  | { readonly at: "skipped" }
  | { readonly at: "done"; readonly login: string };

export type ProjectStep =
  | { readonly at: "pick"; readonly repos: readonly StartRepo[]; readonly query: string }
  | { readonly at: "adding"; readonly what: string; readonly machine: string };

export type StartView =
  | {
      readonly who: "owner";
      readonly team: string;
      readonly computer: ComputerStep;
      readonly github: GithubStep;
      readonly project: ProjectStep;
    }
  | {
      readonly who: "teammate";
      readonly team: string;
      readonly github: GithubStep;
      readonly projects: readonly TeamProject[];
    };

export type StepId = "computer" | "github" | "project";

/** Whether a step needs nothing more. A skipped GitHub counts: the project step offers an empty project. */
export const stepDone = (view: StartView, step: StepId): boolean => {
  if (step === "github") return view.github.at === "done" || view.github.at === "skipped";
  if (view.who === "teammate") return false;
  if (step === "computer") return view.computer.at === "ready";
  return false;
};

/**
 * The steps the page shows, in order. A teammate's team has its computers and projects already: theirs open first, and
 * their own GitHub is one row under them, its button at its end.
 */
export const stepsOf = (view: StartView): readonly StepId[] => (view.who === "owner" ? ["computer", "github", "project"] : ["project", "github"]);

/** The one step open now: the first not done; for a teammate, always the team's projects. */
export const currentStep = (view: StartView): StepId => (view.who === "teammate" ? "project" : (stepsOf(view).find((s) => !stepDone(view, s)) ?? "project"));

/** How many steps are left, for the quiet Finish setting up row once the person has gone on to the app. */
export const stepsLeft = (view: StartView): number => stepsOf(view).filter((s) => !stepDone(view, s)).length;

/** The bot over the page: waiting with you, a hop when the computer joins, at work while a project is added. */
export const botOf = (view: StartView): "idle" | "thinking" | "working" | "done" => {
  if (view.who === "owner") {
    if (view.project.at === "adding") return "working";
    if (view.computer.at === "line" || view.computer.at === "claude" && view.computer.login === "checking") return "thinking";
    if (view.computer.at === "ready" && view.github.at === "todo") return "done";
  }
  return view.github.at === "waiting" ? "thinking" : "idle";
};

/** Repos the field's words match, by name or owner. */
export const matching = (repos: readonly StartRepo[], query: string): readonly StartRepo[] => {
  const q = query.trim().toLowerCase();
  return q === "" ? repos : repos.filter((r) => `${r.owner}/${r.name}`.toLowerCase().includes(q));
};
