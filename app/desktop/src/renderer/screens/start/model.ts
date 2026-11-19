// Get started (fleetd cloud's first run in the web app, #/start): what a team still needs before its first bot's lead
// can work, told from the hub's own state (state.ts reads it), so leaving and coming back lands on the same step.
// Nothing here is stored but a skipped GitHub and a Skip for now: a computer that joined, its Claude login, a GitHub
// connection and a bot are the hub's. Pure, so every state is unit-tested.
//
// The real dependencies, in order (fleetd-cloud: accounts, machines, github):
//   - a team: made at the first sign-in, named from the person (accounts' place); a teammate joins one by its invite;
//   - where agents run (D558), either one: a computer of the team's, online; or a hosted sandbox provider on the
//     team's own key, whose agents the hub's runner starts in its boxes;
//   - Tailscale (optional, skippable, D573): one device the hub runs, through which hosted agents reach the team's
//     tailnet (a Claude endpoint on it, MCP servers); one click and a sign-in at Tailscale, nothing pasted;
//   - Claude: the hub's API key with its endpoint (Anthropic's own prefilled; one on the tailnet wants Tailscale), or
//     the way in each place has of its own: a computer's login (machine_claude_login: its sign-in page, then the code it
//     shows; until then the hub has the machine degraded, "claude is not logged in"), the hosted sandboxes' the
//     person's subscription (Settings › Your accounts › Claude);
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
  /** Joined before, and offline now: agents run there once it is back. */
  | { readonly at: "offline"; readonly machine: string }
  /** Joined, and agents can't run there for another reason (claude not installed, say): the hub's words, its fix in them. */
  | { readonly at: "unusable"; readonly machine: string; readonly reason: string }
  /** Joined: agents run there once Claude is set up (the next steps). */
  | { readonly at: "ready"; readonly machine: string }
  /** A hosted provider connected, its sandboxes not ready yet (the hub's runner coming up). */
  | { readonly at: "hosted_wait"; readonly provider: string }
  /** Agents run in the provider's sandboxes once Claude reaches them. */
  | { readonly at: "hosted"; readonly provider: string };

/** The team's Tailscale, as the hub runs its one device (tailnet_get). */
export type TailscaleStep =
  | { readonly at: "todo"; readonly busy?: boolean; readonly error?: string }
  /** Waiting on the person: Tailscale's sign-in page, opened again from a click. */
  | { readonly at: "signin"; readonly url?: string }
  /** Signed in: an admin of the tailnet approves the device in Tailscale's admin console. */
  | { readonly at: "approve" }
  | { readonly at: "skipped" }
  | { readonly at: "done"; readonly tailnet: string };

/** The hub's API key being saved from the step: busy, or why it wasn't. */
export interface KeyState {
  readonly busy?: boolean;
  readonly error?: string;
}

export type ClaudeStep =
  /** Nothing runs agents yet: the step waits on the one before it. */
  | { readonly at: "wait" }
  /** A computer whose claude isn't logged in: Log in, then the code from the sign-in page; or the hub's API key. */
  | {
      readonly at: "login";
      readonly machine: string;
      readonly login: "start" | "starting" | "code" | "checking";
      readonly url?: string;
      /** False when the browser kept Claude's sign-in page from opening (a pop-up blocker): the page says to open it. */
      readonly opened?: boolean;
      readonly error?: string;
      readonly key?: KeyState;
    }
  /** Hosted sandboxes with no Claude account reaching them: the hub's API key, or the person's subscription. */
  | { readonly at: "account"; readonly provider: string; readonly key?: KeyState }
  /** Claude reaches the agents: what on, in a word or two. */
  | { readonly at: "done"; readonly what: string };

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
      /** The cloud listed only the newest of them: Find searches those alone. */
      readonly truncated?: true;
    }
  | { readonly at: "adding"; readonly what: string; readonly machine: string }
  /** The team has a bot: its name. */
  | { readonly at: "made"; readonly name: string };

export type StartView =
  | {
      readonly who: "owner";
      readonly team: string;
      readonly computer: ComputerStep;
      /** Absent on a hub with no Tailscale device to run (an older one, or one whose OS can't). */
      readonly tailscale?: TailscaleStep;
      readonly claude: ClaudeStep;
      /** Whether Tailscale is connected: the Claude step's endpoint on the tailnet says so when it isn't. */
      readonly tailnet?: boolean;
      readonly github: GithubStep;
      readonly project: ProjectStep;
    }
  | {
      readonly who: "teammate";
      readonly team: string;
      readonly github: GithubStep;
      readonly projects: readonly TeamProject[];
    };

export type StepId = "computer" | "tailscale" | "claude" | "github" | "project";

/** GitHub needs nothing more for now: connected, skipped, or asked of an organization's owner. */
const githubSettled = (github: GithubStep): boolean => github.at === "done" || github.at === "skipped" || github.at === "requested";

/** Whether a step needs nothing more. A skipped GitHub or Tailscale counts: neither is needed to go on. */
export const stepDone = (view: StartView, step: StepId): boolean => {
  if (step === "github") return githubSettled(view.github);
  if (view.who === "teammate") return false;
  if (step === "computer") return view.computer.at === "ready" || view.computer.at === "hosted";
  if (step === "tailscale") return view.tailscale === undefined || view.tailscale.at === "done" || view.tailscale.at === "skipped";
  if (step === "claude") return view.claude.at === "done";
  return view.project.at === "made";
};

/**
 * The steps the page shows, in order: Tailscale, optional, right before Claude (where a hub has it). A teammate's team
 * has its computers and bots already: theirs open first, and their own GitHub is one row under them, its button at its
 * end.
 */
export const stepsOf = (view: StartView): readonly StepId[] =>
  view.who === "owner" ? ["computer", ...(view.tailscale === undefined ? [] : (["tailscale"] as const)), "claude", "github", "project"] : ["project", "github"];

/** The one step open now: the first not done; for a teammate, always the team's bots. */
export const currentStep = (view: StartView): StepId => (view.who === "teammate" ? "project" : (stepsOf(view).find((s) => !stepDone(view, s)) ?? "project"));

/**
 * How many steps are left, for the quiet Finish setting up row once the person has gone on to the app. A teammate's
 * one is their GitHub: the team's bots are there already.
 */
export const stepsLeft = (view: StartView): number => (view.who === "teammate" ? (githubSettled(view.github) ? 0 : 1) : stepsOf(view).filter((s) => !stepDone(view, s)).length);

/** Whether the hub's API key is being saved from the Claude step. */
const keyBusy = (c: ClaudeStep): boolean => (c.at === "login" || c.at === "account") && c.key?.busy === true;

/** The bot over the page: waiting with you, a hop when the computer joins, at work while a bot is added. */
export const botOf = (view: StartView): "idle" | "thinking" | "working" | "done" => {
  if (view.who === "owner") {
    if (view.project.at === "adding") return "working";
    if (view.computer.at === "line" || (view.claude.at === "login" && view.claude.login === "checking") || keyBusy(view.claude)) return "thinking";
    if (view.claude.at === "done" && view.github.at === "todo") return "done";
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
