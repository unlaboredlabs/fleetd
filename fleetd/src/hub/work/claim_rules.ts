// What work_claim and work_list decide and answer, without the hub (tools.ts reads the work in flight and saves the
// claim): their limits and input checks, a claim's owner and intent, which items a key may see, whether a claim goes
// ahead or is refused, and its answer.
import type {
  AgentKeyInfo,
  Claim,
  ClaimObserved,
  ClaimOwner,
  ProjectRef,
  RecentLanding,
  WorkClaimInput,
  WorkClaimOutput,
  WorkClaimStatus,
  WorkItem,
  WorkKey,
  WorkMatch,
} from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { isHuman, readable } from "../api/grants.ts";
import { cap } from "../api/refusals.ts";
import { isoMs } from "../store/time.ts";
import { addDeclared, matcherKeys, matcherScope } from "./check.ts";
import type { Landed } from "./elsewhere.ts";
import { readWork, type Work as Intent } from "./matcher.ts";
import type { WorkScope } from "./repo_key.ts";
import * as view from "./view.ts";
import { isLine } from "./view.ts";

/** The projects whose items a key isn't shown: another person's Only me ones (navi/owner.ts `Refs`). */
export type Navis = { has(r: ProjectRef): boolean };

/** Matches a claim's answer shows. */
export const MATCHES_MAX = 10;
/** Items work_list shows. */
export const ITEMS_MAX = 100;
/** Landings outside the train work_list shows. */
export const LANDINGS_MAX = 10;
/** The base when nothing says otherwise. */
export const DEFAULT_BASE = "main";
/** The contracts' `checked!` rules on work_claim's and work_list's input, with their words. */
export function checkInput(input: { repo?: string; projectRef?: ProjectRef; notDuplicateOf?: string[]; notDuplicateWhy?: string }): void {
  if (input.repo === undefined && input.projectRef === undefined) throw new ToolError("invalid", "give repo (its origin remote) or projectRef");
  if (input.notDuplicateOf !== undefined && input.notDuplicateWhy === undefined) {
    throw new ToolError("invalid", "notDuplicateOf needs notDuplicateWhy: one line on why it is different work");
  }
}

/**
 * A person's own session only with a human key. Any other key may be a fleetd agent that loaded the person's MCP
 * config, so its claims are an agent key's, and it never claims taken work.
 */
export function ownerOf(caller: AgentKeyInfo): ClaimOwner {
  const label = [...caller.name].slice(0, 120).join("");
  return {
    kind: isHuman(caller) ? "human_session" : "agent_key",
    keyId: isLine(caller.keyId, 200) ? caller.keyId : [...caller.keyId].slice(0, 200).join(""),
    ...(isLine(label, 120) ? { label } : {}),
  };
}

/** Items on machines the key can't read, and those of another person's Only me project, are left out of what it is shown. */
export const visible = (caller: AgentKeyInfo, navis: Navis, item: WorkItem) =>
  !item.projectRef || (readable(caller, item.projectRef.machineId) && !navis.has(item.projectRef));

export const isMine = (caller: AgentKeyInfo, item: WorkItem) => item.owner?.keyId === caller.keyId;

/** "T12 (an agent of devbox/shop): dark mode toggle". */
export function describe(item: WorkItem): string {
  const project = item.projectRef ? `${item.projectRef.machineId}/${item.projectRef.projectId}` : "";
  let who: string;
  if (item.kind === "task") who = `an agent of ${project}`;
  else if (item.kind === "change") who = `a PR on ${project}'s merge train`;
  else if (item.kind === "claim" && item.owner) {
    const name = item.owner.label ?? item.owner.keyId;
    who = item.owner.kind === "human_session" ? `${name}'s session` : item.owner.kind === "agent_key" ? `a session on key ${name}` : `the lead of ${name}`;
  } else if (item.kind === "claim") who = "a claim";
  else who = "an open PR";
  return `${item.id} (${who}${item.state === "expired" ? ", expired" : ""}): ${item.title}`;
}

/** What the claim is, as the matcher reads it: its title's own keys and paths, and the ones declared. */
export function intentOf(owner: ClaimOwner, input: WorkClaimInput, scope: WorkScope): Intent {
  const ms = matcherScope(scope);
  const intent = readWork(owner.keyId, input.title, "", ms);
  const keys: WorkKey[] = [...(input.keys ?? []), ...(input.branch !== undefined ? [{ branch: input.branch }] : [])];
  addDeclared(intent, keys.flatMap((k) => matcherKeys(k, ms)));
  intent.paths.push(...(input.paths ?? []), ...(input.changed ?? []));
  return intent;
}

export function observedOf(input: WorkClaimInput, now: number): ClaimObserved | undefined {
  if (!input.changed) return undefined;
  return { paths: input.changed, ...(input.headSha !== undefined ? { headSha: input.headSha } : {}), at: isoMs(now) };
}

export const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** `items` with its claims replaced by `claims`, as read where the claim is saved. */
export const withClaims = (items: WorkItem[], claims: Claim[]): WorkItem[] => [
  ...items.filter((i) => i.kind !== "claim"),
  ...view.items({ ...view.emptySources(), claims }),
];

export type Refusal = { refused: WorkClaimOutput };

/** What `found` says about the claim: go ahead, with a note for `work.claimed` when it overrides one; or the answer that refuses it. */
export function decide(caller: AgentKeyInfo, navis: Navis, person: boolean, input: WorkClaimInput, found: WorkMatch[]): { note?: string } | Refusal {
  const theirs = found.filter((m) => !isMine(caller, m.item));
  const nameOf = (m: WorkMatch) => (visible(caller, navis, m.item) ? describe(m.item) : `${m.item.id} (on a machine or project this key can't read)`);
  const refuse = (status: WorkClaimStatus, message: string, next: string): Refusal => ({
    refused: answer(caller, navis, found, status, undefined, message, next),
  });
  const exact = theirs.find((m) => m.strength === "exact");
  if (exact) {
    const held = nameOf(exact);
    if (person && input.anyway === true) return { note: `anyway, though ${exact.item.id} holds it: ${exact.why}` };
    const next = person
      ? `Tell the user before going on: ${held}. To claim it anyway, call again with anyway: true.`
      : `Tell the user before going on: ${held}. Only a person can claim taken work, with a human key: \`fleetd work claim --anyway\`.`;
    return refuse("taken", `taken by ${held} (${exact.why})`, next);
  }
  const acknowledged = input.notDuplicateOf;
  const unacknowledged = theirs.filter((m) => m.strength === "strong" && !(acknowledged ?? []).includes(m.item.id));
  const first = unacknowledged[0];
  if (first) {
    const ids = unacknowledged.map((m) => `"${m.item.id}"`);
    return refuse(
      "possible_duplicate",
      `may repeat ${nameOf(first)} (${first.why})`,
      `Tell the user before going on. If it is different work, call again with notDuplicateOf: [${ids.join(", ")}] and notDuplicateWhy.`,
    );
  }
  if (acknowledged && input.notDuplicateWhy !== undefined) return { note: `not a duplicate of ${acknowledged.join(", ")}: ${input.notDuplicateWhy}` };
  return {};
}

/** The answer, with the matches the caller may see (not its own), strongest first. */
export function answer(
  caller: AgentKeyInfo,
  navis: Navis,
  found: WorkMatch[],
  status: WorkClaimStatus,
  claim: Claim | undefined,
  message: string,
  next: string,
): WorkClaimOutput {
  const shown = cap(
    found.filter((m) => visible(caller, navis, m.item) && !isMine(caller, m.item)),
    MATCHES_MAX,
  );
  return {
    status,
    ...(claim ? { claim } : {}),
    matches: shown.items,
    message,
    next,
    ...(shown.truncated ? { truncated: true } : {}),
  };
}

export function recentLanding(l: Landed): RecentLanding {
  return {
    sha: l.sha,
    at: isoMs(l.atMs),
    route: l.route,
    ...(l.pr !== undefined ? { pr: l.pr } : {}),
    subject: l.subject,
    ...(l.authorEmail !== undefined ? { authorEmail: l.authorEmail } : {}),
    covers: l.covers,
  };
}
