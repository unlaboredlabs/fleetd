// Get started (fleetd cloud's first run in the web app, #/start): what a team still needs before its first bot's lead
// can work, told from the hub's own state (state.ts reads it), so leaving and coming back lands on the same step.
// Nothing here is stored but a skipped GitHub and a Skip for now: a computer that joined, its Claude login, a GitHub
// connection and a bot are the hub's. Pure, so every state is unit-tested.
//
// The real dependencies, in order (fleetd-cloud: accounts, machines, github):
//   - a team: made at the first sign-in, named from the person (accounts' place); a teammate joins one by its invite;
//   - a computer of the team's, online: agents and leads run on it (fleetd hosts only the hub, and a hosted sandbox
//     starts from a machine that makes boxes, so a sandbox account never stands in for the first computer);
//   - Claude logged in on it (machine_claude_login: its sign-in page, then the code it shows; until then the hub has
//     the machine degraded, "claude is not logged in");
//   - GitHub, for a bot from a repo: the person's own connection through fleetd's App and the App installed on the
//     repos (D517), one trip to GitHub; an empty bot needs neither;
//   - a bot: picking a repository clones it onto the computer and opens its chat with the lead.

/** A repository GitHub lets fleetd's App reach, newest push first. */
export interface StartRepo {
  readonly owner: string;
  readonly name: string;
  /** When it was last pushed to, in words ("Today", "Nov 9"). */
  readonly pushed: string;
}

/** A bot of the team, for a teammate to open. */
export interface TeamProject {
  /** Its key (`machineId/projectId`), which opens its chat. */
  readonly key: string;
  readonly name: string;
  /** Its state in a few quiet words ("3 agents at work", "Quiet since Nov 9"). */
  readonly line: string;
  readonly busy: boolean;
}

export type ComputerStep =
  /** No computer yet: the join line to paste, which renews itself when its code runs out; null while it is made. */
  | {
      readonly at: "line";
      readonly line: string | null;
      readonly error?: string;
    }
  /** Joined, and its Claude isn't logged in: Log in, then the code from the sign-in page. */
  | {
      readonly at: "claude";
      readonly machine: string;
      readonly login: "start" | "starting" | "code" | "checking";
      readonly url?: string;
      readonly error?: string;
    }
  | { readonly at: "ready"; readonly machine: string };

export type GithubStep =
  | { readonly at: "todo"; readonly error?: string }
  /** On the way to GitHub: this tab leaves for its page. */
  | { readonly at: "waiting" }
  | { readonly at: "skipped" }
  /** A member of an organization asked one of its owners on GitHub to install the App. */
  | { readonly at: "requested" }
  | { readonly at: "done"; readonly login: string };

export type ProjectStep =
  | {
      readonly at: "pick";
      readonly repos: readonly StartRepo[];
      readonly query: string;
      /** The list is being read. */
      readonly loading?: boolean;
      /** Why the list couldn't be read. */
      readonly problem?: string;
      /** The App reaches no repository of the team's yet: Choose repositories goes back to GitHub's install page. */
      readonly none?: true;
    }
  | { readonly at: "adding"; readonly what: string; readonly machine: string }
  /** The team has a bot: its name. */
  | { readonly at: "made"; readonly name: string };

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

/** GitHub needs nothing more for now: connected, skipped, or asked of an organization's owner. */
const githubSettled = (github: GithubStep): boolean => github.at === "done" || github.at === "skipped" || github.at === "requested";

/** Whether a step needs nothing more. A skipped GitHub counts: the bot step offers an empty bot. */
export const stepDone = (view: StartView, step: StepId): boolean => {
  if (step === "github") return githubSettled(view.github);
  if (view.who === "teammate") return false;
  if (step === "computer") return view.computer.at === "ready";
  return view.project.at === "made";
};

/**
 * The steps the page shows, in order. A teammate's team has its computers and bots already: theirs open first, and
 * their own GitHub is one row under them, its button at its end.
 */
export const stepsOf = (view: StartView): readonly StepId[] => (view.who === "owner" ? ["computer", "github", "project"] : ["project", "github"]);

/** The one step open now: the first not done; for a teammate, always the team's bots. */
export const currentStep = (view: StartView): StepId => (view.who === "teammate" ? "project" : (stepsOf(view).find((s) => !stepDone(view, s)) ?? "project"));

/**
 * How many steps are left, for the quiet Finish setting up row once the person has gone on to the app. A teammate's
 * one is their GitHub: the team's bots are there already.
 */
export const stepsLeft = (view: StartView): number => (view.who === "teammate" ? (githubSettled(view.github) ? 0 : 1) : stepsOf(view).filter((s) => !stepDone(view, s)).length);

/** The bot over the page: waiting with you, a hop when the computer joins, at work while a bot is added. */
export const botOf = (view: StartView): "idle" | "thinking" | "working" | "done" => {
  if (view.who === "owner") {
    if (view.project.at === "adding") return "working";
    if (view.computer.at === "line" || (view.computer.at === "claude" && view.computer.login === "checking")) return "thinking";
    if (view.computer.at === "ready" && view.github.at === "todo") return "done";
  }
  return view.github.at === "waiting" ? "thinking" : "idle";
};

/** Repos the field's words match, by name or owner. */
export const matching = (repos: readonly StartRepo[], query: string): readonly StartRepo[] => {
  const q = query.trim().toLowerCase();
  return q === "" ? repos : repos.filter((r) => `${r.owner}/${r.name}`.toLowerCase().includes(q));
};

const DAY_MS = 86_400_000;

/** A last push in words, against `now`: Today, Yesterday, a weekday this week, "Nov 9" this year, else "Dec 2025". */
export const pushedWords = (iso: string, now: number, timeZone?: string): string => {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const zone = timeZone === undefined ? {} : { timeZone };
  const day = (ms: number) => new Date(ms).toLocaleDateString("en-CA", zone);
  if (day(at) === day(now)) return "Today";
  if (day(at) === day(now - DAY_MS)) return "Yesterday";
  if (now - at < 6 * DAY_MS && at <= now) return new Date(at).toLocaleDateString("en", { weekday: "long", ...zone });
  const year = (ms: number) => new Date(ms).toLocaleDateString("en", { year: "numeric", ...zone });
  if (year(at) === year(now))
    return new Date(at).toLocaleDateString("en", {
      month: "short",
      day: "numeric",
      ...zone,
    });
  return new Date(at).toLocaleDateString("en", {
    month: "short",
    year: "numeric",
    ...zone,
  });
};

/** What GitHub's trip ended on, from the `?github=` it came back with; null when this page wasn't its end. */
export type GithubReturn = { readonly at: "connected" | "installed" | "requested" } | { readonly at: "failed"; readonly why: string };

export const githubReturnOf = (search: string): GithubReturn | null => {
  const query = new URLSearchParams(search);
  const said = query.get("github");
  if (said === "connected" || said === "installed" || said === "requested") return { at: said };
  if (said === "failed")
    return {
      at: "failed",
      why: (query.get("why") ?? "").trim().slice(0, 300) || "GitHub didn't finish connecting.",
    };
  return null;
};

/** The same address without GitHub's words, for history.replaceState once they are read. */
export const withoutGithubReturn = (search: string): string => {
  const query = new URLSearchParams(search);
  query.delete("github");
  query.delete("why");
  const left = query.toString();
  return left === "" ? "" : `?${left}`;
};

/** The hub's words for a machine whose claude isn't logged in (the node's runner_info problem, kept as degradedReason). */
export const claudeLoggedOut = (machine: { readonly status: string; readonly degradedReason?: string | undefined }): boolean =>
  machine.status === "degraded" && /not logged in/iu.test(machine.degradedReason ?? "");

/** A teammate's row of a bot: its agents at work, else when it was last busy. */
export const projectLine = (running: number, working: boolean, lastActivityAt: string, now: number, timeZone?: string): string => {
  if (running > 0) return `${String(running)} ${running === 1 ? "agent" : "agents"} at work`;
  if (working) return "At work";
  const when = pushedWords(lastActivityAt, now, timeZone);
  return when === "" ? "Quiet" : when === "Today" ? "Quiet today" : `Quiet since ${when}`;
};
