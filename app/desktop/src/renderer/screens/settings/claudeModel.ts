// Which Claude account work runs on (teams step 8, D200), in a person's words: Settings › Your accounts › Claude (each person's own
// choice and subscription) and Settings › Hub accounts › Claude (the hub's API key, who may use it, what leads run on) read
// claude_accounts_get and say it the same way. Pure, so the wording is tested without a hub.
import type { ClaudeAccount, ClaudeChoice, ClaudeRunsOn, ClaudeSealedOn, ClaudeTest, PersonClaude, PersonRef, UsageStatus } from "../../../shared/contracts";
import type { ClaudeAccountRequest } from "../../../shared/ipc";
import { when } from "../status/view";

/** The plain line for someone with nothing to run on, as the brief and spawn_agent say it. */
export const CONNECT = "Connect your Claude to start orders";

/** The steps for a subscription's token, and the token's look, said the same on both pages. */
export const SETUP_TOKEN = "claude setup-token";
export const TOKEN_PLACEHOLDER = "sk-ant-oat01-…";
export const KEY_PLACEHOLDER = "sk-ant-api03-…";
export const CONSOLE_KEYS = "https://console.anthropic.com/settings/keys";

/** An account by whose it is: "the hub's API key", "your subscription", "Sam Rivera's subscription". */
export function accountWords(account: ClaudeAccount, people: ReadonlyArray<PersonRef>, me?: string): string {
  if (account.kind === "hub") return "the hub's API key";
  if (account.personId === me) return "your subscription";
  const name = people.find((p) => p.personId === account.personId)?.name;
  return name === undefined ? "a person's subscription" : `${name}'s subscription`;
}

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** What some work runs on now, as one line: "Your subscription.", "Each machine's own Claude login.". */
export function runsOnLine(runsOn: ClaudeRunsOn, people: ReadonlyArray<PersonRef>, me?: string): string {
  switch (runsOn.kind) {
    case "machine_login":
      return "Each machine's own Claude login.";
    case "account":
      return `${capital(accountWords(runsOn.account, people, me))}.`;
    case "refused":
      return runsOn.message;
  }
}

/** Someone's account in a list of everyone's: "Own subscription", "Hub API key", "Nothing to run on". */
export function theirRunsOn(runsOn: ClaudeRunsOn): string {
  switch (runsOn.kind) {
    case "machine_login":
      return "Machine's own login";
    case "account":
      return runsOn.account.kind === "hub" ? "Hub API key" : "Own subscription";
    case "refused":
      return "Nothing to run on";
  }
}

/** The radio a person's choice shows: what they picked, else what the default lands on now. */
export function shownChoice(me: PersonClaude): ClaudeChoice | undefined {
  if (me.choice !== undefined) return me.choice;
  if (me.runsOn.kind !== "account") return undefined;
  return me.runsOn.account.kind === "hub" ? "hub_api" : "subscription";
}

/** Machines that run agents and don't hold the secret: nothing runs on it there. */
export const missingOn = (sealedOn: ReadonlyArray<ClaudeSealedOn>, machines: ReadonlyArray<string>): string[] =>
  machines.filter((m) => !sealedOn.some((s) => s.machineId === m)).sort();

/** Where a secret is, never what: "Sealed on buildbox and devbox." */
export function sealedLine(sealedOn: ReadonlyArray<ClaudeSealedOn>): string {
  const names = sealedOn.map((s) => s.machineId).sort();
  if (names.length === 0) return "Sealed on no machine.";
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Sealed on ${list ?? ""}.`;
}

/** A Test's verdict: "Worked on devbox, today 14:02." or claude's own words, the secret masked by the node. */
export function testLine(test: ClaudeTest, nowMs: number): { ok: boolean; text: string } {
  const at = when(test.at, nowMs);
  if (test.ok) return { ok: true, text: `Worked on ${test.machineId}, ${at}.` };
  const said = (test.error ?? "claude failed and said nothing").trim().replace(/\.$/u, "");
  return { ok: false, text: `Failed on ${test.machineId}, ${at}: ${said}.` };
}

/** The box keys a Claude secret is sealed to: every machine whose node has one. */
export const boxesOf = (machines: Readonly<Record<string, { machineId: string; boxPubKey?: unknown }>>): ClaudeAccountRequest["boxes"] =>
  Object.values(machines)
    .filter((m): m is { machineId: string; boxPubKey: string } => typeof m.boxPubKey === "string")
    .map((m) => ({ machineId: m.machineId, boxPubKey: m.boxPubKey }))
    .sort((a, b) => a.machineId.localeCompare(b.machineId));

/** One account's usage pause, on any machine: "Paused on devbox until today 15:00: usage limit reached." */
export function pauseLine(account: ClaudeAccount, usage: ReadonlyArray<UsageStatus>, nowMs: number): string | null {
  const key = (a: ClaudeAccount) => (a.kind === "hub" ? "hub" : a.personId);
  const lines = usage.flatMap((m) =>
    (m.accounts ?? [])
      .filter((a) => key(a.account) === key(account) && a.breaker.state === "open")
      .map((a) => {
        const until = a.breaker.until ?? a.breaker.checkAt;
        const time = until === undefined ? "" : ` until ${when(until, nowMs)}`;
        const why = a.breaker.message === undefined ? "" : `: ${a.breaker.message.trim().replace(/\.$/u, "")}`;
        return `Paused on ${m.machineId}${time}${why}.`;
      }),
  );
  return lines.length === 0 ? null : lines.join(" ");
}
