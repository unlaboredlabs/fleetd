// Get started's model: which step is open and how many are left, for both paths; GitHub's way back; a last push and a
// teammate's bot in words; a machine whose claude is logged out.
import { describe, expect, it } from "vitest";
import { botOf, claudeLoggedOut, claudeStepOf, currentStep, githubReturnOf, projectLine, pushedWords, stepsLeft, stepsOf, withoutGithubReturn } from "./model";
import { SAMPLES } from "./samples";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const UTC = "UTC";

describe("steps", () => {
  it("opens the first step not done, a skipped GitHub or Tailscale counting as done", () => {
    expect(currentStep(SAMPLES.computer)).toBe("computer");
    expect(currentStep(SAMPLES.tailscale)).toBe("tailscale");
    expect(currentStep(SAMPLES["tailscale-signin"])).toBe("tailscale");
    expect(currentStep(SAMPLES["claude-key"])).toBe("claude");
    expect(currentStep(SAMPLES.claude)).toBe("claude");
    expect(currentStep(SAMPLES.github)).toBe("github");
    expect(currentStep(SAMPLES["github-failed"])).toBe("github");
    expect(currentStep(SAMPLES.project)).toBe("project");
    expect(currentStep(SAMPLES["project-skipped"])).toBe("project");
    expect(currentStep(SAMPLES.teammate)).toBe("project");
  });

  it("puts Tailscale right before Claude, where the hub has it, and leaves it out where it hasn't", () => {
    expect(stepsOf(SAMPLES.tailscale)).toEqual(["computer", "tailscale", "claude", "github", "project"]);
    const { tailscale: _, ...none } = SAMPLES.tailscale;
    expect(stepsOf(none)).toEqual(["computer", "claude", "github", "project"]);
    expect(currentStep(none)).toBe("claude");
  });

  it("counts what is left: five for a fresh team, none once its bot is made; a skipped Tailscale never asks again", () => {
    expect(stepsLeft(SAMPLES.computer)).toBe(5);
    expect(stepsLeft(SAMPLES.tailscale)).toBe(4);
    expect(stepsLeft({ ...SAMPLES.tailscale, tailscale: { at: "skipped" } })).toBe(3);
    expect(stepsLeft(SAMPLES.github)).toBe(2);
    expect(stepsLeft(SAMPLES["project-skipped"])).toBe(1);
    expect(
      stepsLeft({
        ...SAMPLES.project,
        project: { at: "made", name: "notes-api" },
      }),
    ).toBe(0);
    expect(stepsLeft(SAMPLES.teammate)).toBe(1);
    expect(stepsLeft(SAMPLES["teammate-open"])).toBe(0);
    expect(stepsLeft({ ...SAMPLES.teammate, github: { at: "requested" } })).toBe(0);
  });

  it("thinks while the hub's key is saved or a computer's login is checked", () => {
    expect(botOf({ ...SAMPLES["claude-key"], claude: { at: "account", provider: "boat.dev", key: { busy: true } } })).toBe("thinking");
    expect(botOf({ ...SAMPLES.claude, claude: { at: "login", machine: "devbox", login: "checking" } })).toBe("thinking");
    expect(botOf(SAMPLES.github)).toBe("done");
  });
});

describe("GitHub's way back", () => {
  it("reads what the trip ended on, and why when it failed", () => {
    expect(githubReturnOf("")).toBeNull();
    expect(githubReturnOf("?github=installed")).toEqual({ at: "installed" });
    expect(githubReturnOf("?github=requested")).toEqual({ at: "requested" });
    expect(githubReturnOf("?github=failed&why=The%20install%20was%20cancelled.")).toEqual({ at: "failed", why: "The install was cancelled." });
    expect(githubReturnOf("?github=failed")).toEqual({
      at: "failed",
      why: "GitHub didn't finish connecting.",
    });
    expect(githubReturnOf("?github=elsewhere")).toBeNull();
  });

  it("never says an address: only the words around it", () => {
    const why = (text: string) => githubReturnOf(`?github=failed&why=${encodeURIComponent(text)}`);
    expect(why("GitHub refused (https://docs.github.com/rest). Install again in a while.")).toEqual({ at: "failed", why: "GitHub refused. Install again in a while." });
    expect(why("https://github.com/x")).toEqual({ at: "failed", why: "GitHub didn't finish connecting." });
  });

  it("leaves the rest of the address as it was", () => {
    expect(withoutGithubReturn("?github=failed&why=x")).toBe("");
    expect(withoutGithubReturn("?a=1&github=installed")).toBe("?a=1");
  });
});

describe("words", () => {
  it("says a last push as a day: today, yesterday, this week, this year, then a month and year", () => {
    expect(pushedWords("2026-11-18T08:00:00Z", NOW, UTC)).toBe("Today");
    expect(pushedWords("2026-11-17T08:00:00Z", NOW, UTC)).toBe("Yesterday");
    expect(pushedWords("2026-11-14T08:00:00Z", NOW, UTC)).toBe("Saturday");
    expect(pushedWords("2026-11-09T08:00:00Z", NOW, UTC)).toBe("Nov 9");
    expect(pushedWords("2025-12-02T08:00:00Z", NOW, UTC)).toBe("Dec 2025");
    expect(pushedWords("not a time", NOW, UTC)).toBe("");
  });

  it("says a teammate's bot as its agents at work, else when it was last busy", () => {
    expect(projectLine(3, true, "2026-11-18T08:00:00Z", NOW, UTC)).toBe("3 agents at work");
    expect(projectLine(1, true, "2026-11-18T08:00:00Z", NOW, UTC)).toBe("1 agent at work");
    expect(projectLine(0, true, "2026-11-18T08:00:00Z", NOW, UTC)).toBe("At work");
    expect(projectLine(0, false, "2026-11-18T08:00:00Z", NOW, UTC)).toBe("Quiet today");
    expect(projectLine(0, false, "2026-11-16T08:00:00Z", NOW, UTC)).toBe("Quiet since Monday");
  });

  it("knows a machine whose claude isn't logged in by the hub's words, not any degraded one", () => {
    expect(
      claudeLoggedOut({
        status: "degraded",
        degradedReason: "claude is not logged in. Fix: run `claude` on this machine and log in",
      }),
    ).toBe(true);
    expect(
      claudeLoggedOut({
        status: "degraded",
        degradedReason: "Claude Code is not logged in on this machine",
      }),
    ).toBe(true);
    expect(
      claudeLoggedOut({
        status: "degraded",
        degradedReason: "the node refused the read request",
      }),
    ).toBe(false);
    expect(claudeLoggedOut({ status: "online" })).toBe(false);
  });
});

describe("the Claude step", () => {
  const computers = { at: "hosted", provider: "fleetd's computers" } as const;
  const facts = { hubKey: false, leadsRunOn: "machine_login", ready: null, computer: computers, provider: "fleetd's computers", login: null } as const;

  it("on fleetd's computers with no Claude account is open, never ticked for the computers alone (G1)", () => {
    expect(claudeStepOf(facts)).toEqual({ at: "account", provider: "fleetd's computers" });
    expect(claudeStepOf({ ...facts, leadsRunOn: undefined })).toEqual({ at: "account", provider: "fleetd's computers" });
    expect(claudeStepOf({ ...facts, leadsRunOn: "refused" })).toEqual({ at: "account", provider: "fleetd's computers" });
  });

  it("is done once Claude reaches the agents: the hub's key, a subscription the leads run on, a computer's own login", () => {
    expect(claudeStepOf({ ...facts, hubKey: true, leadsRunOn: "account" })).toEqual({ at: "done", what: "API key" });
    expect(claudeStepOf({ ...facts, leadsRunOn: "account" })).toEqual({ at: "done", what: "Claude subscription" });
    expect(claudeStepOf({ ...facts, ready: "devbox", computer: { at: "ready", machine: "devbox" } })).toEqual({ at: "done", what: "devbox" });
  });

  it("asks a logged-out computer to log in, and waits while nothing runs agents", () => {
    const login = { at: "login", machine: "devbox", login: "start" } as const;
    expect(claudeStepOf({ ...facts, computer: { at: "ready", machine: "devbox" }, login })).toBe(login);
    expect(claudeStepOf({ ...facts, computer: { at: "line", line: null } })).toEqual({ at: "wait" });
  });
});
