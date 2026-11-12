// What a launch's Claude account is decided from (index.ts reads it from the database): the hub's setup at one
// moment, whose work a launch is, and what it runs on or why it can't run.
import type {
  ClaudeAccount,
  ClaudeChoice,
  ClaudeHubApi,
  ClaudeRunsOn,
  ClaudeSeal,
  ClaudeSettings,
  ClaudeSubscription,
  HubRole,
  Person,
  PersonClaude,
} from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { isSealedSecret } from "../approvals/sink.ts";
import { administers, refOf } from "../people/roles.ts";

export const CONNECT_REFUSAL = "Connect your Claude to start this order.";

/** Whose work a launch is: the hub's (a lead, or work nobody started), or a person's (their order, their project). */
export type Whose = { hub: true } | { person: string };

/** `hub`, or the person's id: how the hub and the node key an account's records and usage. */
export const accountKey = (a: ClaudeAccount) => (a.kind === "hub" ? "hub" : a.personId);
export function accountFromKey(key: string): ClaudeAccount | undefined {
  if (key === "hub") return { kind: "hub" };
  return /^p_[a-z2-7]{8}$/.test(key) ? { kind: "person", personId: key } : undefined;
}

/** One way some work could run, and whether it is there. */
type Way = { account: ClaudeAccount; held?: string[]; barred?: string };

const accountText = (a: ClaudeAccount) => (a.kind === "hub" ? "The hub's API key" : "The Claude subscription this runs on");
const connectText = (a: ClaudeAccount) =>
  a.kind === "hub"
    ? "Save the hub's API key on the Hub pages of the app's Settings"
    : "Connect the subscription in Settings › Your accounts › Claude";

/** The hub's Claude setup at one moment: what a launch's account is decided from. */
export class Setup {
  constructor(
    readonly hubApi: ClaudeHubApi | undefined,
    readonly settings: ClaudeSettings,
    readonly subscriptions: Map<string, ClaudeSubscription>,
    readonly choices: Map<string, ClaudeChoice>,
    /** The first owner still on the hub. */
    readonly owner: string | undefined,
    readonly roles: Map<string, HubRole>,
  ) {}

  /** Anything at all is set up: else every machine runs on its own `claude login`. */
  configured(): boolean {
    return this.hubApi !== undefined || this.subscriptions.size > 0;
  }

  private hubHeld = () => this.hubApi?.sealedOn.map((s) => s.machineId);
  private subscriptionHeld = (person: string) => this.subscriptions.get(person)?.sealedOn.map((s) => s.machineId);

  /** The hub's API is the person's to use: it is set up, and they administer the hub or members may use it. */
  mayUseHubApi(person: string): boolean {
    const role = this.roles.get(person);
    return this.hubApi !== undefined && (this.settings.membersUseHubApi || (role !== undefined && administers(role)));
  }

  /**
   * What `whose` work runs on, on `machine` (undefined: on any machine holding it): the first of its ways that is set
   * up, theirs to use and held on the machine. One set up but on no such machine refuses the work there rather than
   * run it on the machine's own login.
   */
  runsOn(whose: Whose, machine?: string): ClaudeRunsOn {
    if (!this.configured()) return { kind: "machine_login" };
    const hub: Way = { account: { kind: "hub" }, held: this.hubHeld() };
    let ways: Way[];
    if ("hub" in whose) {
      ways = [hub];
      if (this.owner !== undefined) {
        ways.push({ account: { kind: "person", personId: this.owner }, held: this.subscriptionHeld(this.owner) });
      }
    } else {
      const person = whose.person;
      const own: Way = { account: { kind: "person", personId: person }, held: this.subscriptionHeld(person) };
      const theHub: Way = {
        ...hub,
        ...(this.hubApi !== undefined && !this.mayUseHubApi(person) ? { barred: "members may not use the hub's API on this hub" } : {}),
      };
      const choice = this.choices.get(person);
      ways = choice === "subscription" ? [own] : choice === "hub_api" ? [theHub] : [own, theHub];
    }
    const usable = ways.filter((w): w is Way & { held: string[] } => w.barred === undefined && w.held !== undefined);
    const onMachine = usable.find((w) => (machine === undefined ? w.held.length > 0 : w.held.includes(machine)));
    if (onMachine) return { kind: "account", account: onMachine.account };
    // Set up, but not on this machine: refused there, never run on the machine's own login instead.
    const first = usable[0];
    if (first) {
      const [place, when] =
        machine !== undefined ? [`on ${machine}`, `while ${machine} is online`] : ["on any machine", "while the machines are online"];
      return { kind: "refused", message: `${accountText(first.account)} isn't ${place}.`, fix: `${connectText(first.account)} again ${when}.` };
    }
    // Only members' subscriptions are set up: projects' leads keep the machines' own login.
    if ("hub" in whose) return { kind: "machine_login" };
    return { kind: "refused", message: CONNECT_REFUSAL, fix: this.connectFix(whose.person) };
  }

  /** What someone with no way to run does, in their own settings. */
  private connectFix(person: string): string {
    const subscribe =
      "connect your subscription in Settings › Your accounts › Claude (paste the token `claude setup-token` prints)";
    const choice = this.choices.get(person);
    if (choice === "hub_api" && this.hubApi === undefined) {
      return `The hub has no API key yet: ${subscribe}, or ask an admin to add one on the Hub pages of the app's Settings.`;
    }
    if (choice === "hub_api") return `Members may not use the hub's API on this hub: ${subscribe}, or ask an admin.`;
    if (this.hubApi !== undefined && !this.mayUseHubApi(person)) return `Members may not use the hub's API on this hub: ${subscribe}.`;
    return `Open Settings › Your accounts › Claude and ${subscribe}.`;
  }

  /** A person's setup as the tools show it. */
  person(person: Person): PersonClaude {
    const id = person.personId;
    const choice = this.choices.get(id);
    const subscription = this.subscriptions.get(id);
    return {
      person: refOf(person),
      ...(choice !== undefined ? { choice } : {}),
      ...(subscription !== undefined ? { subscription } : {}),
      mayUseHubApi: this.mayUseHubApi(id),
      runsOn: this.runsOn({ person: id }),
    };
  }
}

/** Why a launch can't run, and what to do. */
export type Refusal = { message: string; fix: string };

/** What a machine's node said of Claude accounts in its hello. */
export type NodeAccounts = "runs" | "too_old" | "offline";

/** What `whose` work on `machine` runs on: undefined for the machine's own login; a Refusal when it can't run. */
export function launchAccount(setup: Setup, whose: Whose, machine: string, node: () => NodeAccounts): ClaudeAccount | undefined | Refusal {
  const on = setup.runsOn(whose, machine);
  if (on.kind === "machine_login") return undefined;
  if (on.kind === "refused") return { message: on.message, fix: on.fix };
  const state = node();
  if (state === "runs") return on.account;
  if (state === "too_old") {
    return { message: `${machine}'s node is too old to run work on a Claude account.`, fix: `Run fleetd update on ${machine}.` };
  }
  return {
    message: `${machine}'s node is offline, so no work starts there.`,
    fix: `It starts once ${machine}'s node links again: check that fleetd's node runs there.`,
  };
}

export const isRefusal = (v: ClaudeAccount | undefined | Refusal): v is Refusal => v !== undefined && "message" in v;

/** The node capability a machine needs to run work on a Claude account. */
export const CAP_CLAUDE_ACCOUNTS = "claude_accounts";

/** The seals of one secret: each a sealed box, no machine twice (claude_accounts.rs `seals_distinct`). */
export function checkSeals(seals: unknown): ClaudeSeal[] {
  if (!Array.isArray(seals)) throw new ToolError("invalid", "sealed is a list of { machineId, sealed }.");
  const seen = new Set<string>();
  for (const s of seals as ClaudeSeal[]) {
    if (typeof s?.machineId !== "string" || typeof s.sealed !== "string" || !isSealedSecret(s.sealed)) {
      throw new ToolError("invalid", "each seal is { machineId, sealed }, sealed a sealed box in standard base64.");
    }
    if (seen.has(s.machineId)) throw new ToolError("invalid", `${s.machineId} is sealed to twice.`);
    seen.add(s.machineId);
  }
  return seals as ClaudeSeal[];
}
