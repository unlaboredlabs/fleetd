// A new fleetd cloud team's first run on the phone, in place of No Chats Yet: what the team still needs before its
// first bot's lead can answer, each step ticked from the team's own state, so coming back lands on the same one. A
// phone sign-up skipped all of it before: the first message then waited forever on a team with no plan, or got a
// line about a machine's Claude sign-in that a cloud team doesn't have (launch-readiness F1626).
//   - a plan or credits, once fleetd's computers are on for the team (Billing's own top line says what's wrong); on
//     iOS, which sells nothing (D733), it's Plan or Credits in Billing's plain words, with no call to buy;
//   - Claude: the team's Anthropic API key, or someone's Claude subscription;
//   - a bot, which + starts.
// Only an owner or admin sees it, who can do each step; a member, or a self-hosted hub, sees No Chats Yet.
import type { ClaudeAccountsGetOutput } from "../../desktop/src/shared/contracts";
import { billingOn, shownTopLine, type BillingState } from "./billing";
import type { KeptHub } from "./cloud/account";

export type FirstRunId = "plan" | "claude" | "bot";

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

/**
 * The steps, in order. `billing` null or off: a team whose bots run on its own machines, with nothing to buy. `selling`
 * false on a phone that sells nothing (`sells`).
 */
export const firstRunSteps = (billing: BillingState | null | undefined, accounts: ClaudeAccountsGetOutput | undefined, selling = true): FirstRunStep[] => {
  const steps: FirstRunStep[] = [];
  if (billingOn(billing)) {
    const held = shownTopLine(billing!, selling);
    steps.push({
      id: "plan",
      title: held === null || !selling ? "Plan or Credits" : "Choose a Plan",
      detail: held?.message,
      done: held === null,
    });
  }
  const claude = claudeConnected(accounts);
  steps.push({ id: "claude", title: claude ? "Claude Connected" : "Connect Claude", detail: claude ? undefined : "The workspace's Anthropic API key, or a Claude subscription, for its agents.", done: claude });
  steps.push({ id: "bot", title: "Start a Bot", detail: "Make one, and its chat shows up here.", done: false });
  return steps;
};

/** The step to do next: the first not done. */
export const nextStep = (steps: readonly FirstRunStep[]): FirstRunId | undefined => steps.find((s) => !s.done)?.id;
