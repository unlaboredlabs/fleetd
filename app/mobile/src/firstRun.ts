// A new fleetd cloud team's first run on the phone, in place of No Chats Yet: what the team still needs before its
// first bot's lead can answer, each step ticked from the team's own state, so coming back lands on the same one. A
// phone sign-up skipped all of it before: the first message then waited forever on a team with no plan, or got a
// line about a machine's Claude sign-in that a cloud team doesn't have (launch-readiness F1626).
//   - where agents run, either one: a computer of the team's own, free (the join line to run on it, Add machine's,
//     with Tailscale's Connect beside it for a machine on a tailnet), or fleetd's computers on a plan or credits once
//     they are on for the team (Billing's own top line says what's wrong; on iOS, which sells nothing (D733), in
//     Billing's plain words, with no call to buy). A phone sign-up only ever saw "Choose a Plan" here, and read it as
//     having to pay;
//   - Claude: the workspace's Anthropic API key, or someone's Claude subscription;
//   - a bot, which + starts.
// Only an owner or admin sees it, who can do each step; a member, or a self-hosted hub, sees No Chats Yet.
import type { ClaudeAccountsGetOutput, Machine } from "../../desktop/src/shared/contracts";
import { billingOn, shownTopLine, type BillingState } from "./billing";
import type { KeptHub } from "./cloud/account";

export type FirstRunId = "where" | "claude" | "bot";

export interface FirstRunStep {
  readonly id: FirstRunId;
  readonly title: string;
  /** Why it's needed, while it isn't done. */
  readonly detail: string | undefined;
  readonly done: boolean;
}

/** The first run shows on a cloud team with no bots yet, to an owner or admin; never on a team they were invited to. */
export const firstRunShown = (hub: Pick<KeptHub, "cloud" | "invited">, s: { readonly projects: Readonly<Record<string, unknown>> | undefined; readonly admin?: boolean | undefined }): boolean =>
  hub.cloud === true && hub.invited !== true && s.admin === true && s.projects !== undefined && Object.keys(s.projects).length === 0;

/** Whether the team's agents have a way into Claude: its API key, or a teammate's subscription. */
export const claudeConnected = (accounts: ClaudeAccountsGetOutput | undefined): boolean =>
  accounts !== undefined && (accounts.hubApi !== undefined || (accounts.people ?? []).some((p) => p.subscription !== undefined) || accounts.me?.subscription !== undefined);

/** A computer of the team's own that joined and is on: neither the runner of fleetd's computers nor the agents' Mac. */
export const ownMachine = <M extends Pick<Machine, "status" | "runner" | "agentsMac">>(machines: ReadonlyArray<M>): M | undefined =>
  machines.find((m) => m.runner !== true && m.agentsMac !== true && m.status !== "offline");

/** fleetd's computers, beside the team's own machine while neither runs agents: Billing's line on a team they stopped for. */
export interface ComputersChoice {
  /** Why they stopped, on a team that had a plan or credits; none on a new one, which just hasn't picked. */
  readonly message: string | undefined;
  /** "Choose a Plan" on a phone that sells, else "Plan or Credits". */
  readonly title: string;
}

/** fleetd's computers as Where Agents Run offers them; null where they aren't on for the team, or already run its agents. */
export const computersChoice = (billing: BillingState | null | undefined, selling = true): ComputersChoice | null => {
  if (!billingOn(billing)) return null;
  const held = shownTopLine(billing!, selling);
  if (held === null) return null;
  return { message: billing!.held === "none" ? undefined : held.message, title: selling ? "Choose a Plan" : "Plan or Credits" };
};

/**
 * The steps, in order. `billing` null or off: a team whose bots run on its own machines, with nothing to buy. `selling`
 * false on a phone that sells nothing (`sells`). `machines`: the team's, live.
 */
export const firstRunSteps = (
  billing: BillingState | null | undefined,
  accounts: ClaudeAccountsGetOutput | undefined,
  selling = true,
  machines: ReadonlyArray<Pick<Machine, "status" | "runner" | "agentsMac">> = [],
): FirstRunStep[] => {
  const steps: FirstRunStep[] = [];
  const computers = billingOn(billing) && shownTopLine(billing!, selling) === null;
  const where = computers || ownMachine(machines) !== undefined;
  steps.push({
    id: "where",
    title: "Where Agents Run",
    detail: where ? undefined : billingOn(billing) ? "Your own machine, free, or fleetd's computers." : "Your own machine: a Mac or Linux computer, free.",
    done: where,
  });
  const claude = claudeConnected(accounts);
  steps.push({ id: "claude", title: claude ? "Claude Connected" : "Connect Claude", detail: claude ? undefined : "The workspace's Anthropic API key, or a Claude subscription, for its agents.", done: claude });
  steps.push({ id: "bot", title: "Start a Bot", detail: "Make one, and its chat shows up here.", done: false });
  return steps;
};

/** The step to do next: the first not done. */
export const nextStep = (steps: readonly FirstRunStep[]): FirstRunId | undefined => steps.find((s) => !s.done)?.id;
