// The providers agents run on, as one model the desktop's Settings › Providers and model pickers and the phone's
// Providers and Lead Model all read: each with the models it runs, told apart by id, and how it is connected. A provider
// fleetd adds is one entry here (and its row's controls). Pure, so it is tested on its own.
import type { AntigravityStatusOutput, Profile, ProfileModel, ProjectRef } from "./contracts/contracts";

export type AgentProviderId = "anthropic" | "google";

export interface AgentProvider {
  readonly id: AgentProviderId;
  readonly name: string;
  /** Whether it runs `model`, a profile's model id. */
  readonly runs: (model: string) => boolean;
}

/** Google's models: Antigravity's Gemini, and any other model Antigravity offers, as `antigravity/<model>`. */
const GOOGLE = /^(gemini-|antigravity\/)/u;

/** Anthropic runs every model no other provider claims. */
const ANTHROPIC: AgentProvider = { id: "anthropic", name: "Anthropic", runs: (m) => !GOOGLE.test(m) };

/** Every provider, in the order the pickers group them. */
export const AGENT_PROVIDERS: ReadonlyArray<AgentProvider> = [ANTHROPIC, { id: "google", name: "Google", runs: (m) => GOOGLE.test(m) }];

export const providerOf = (model: string): AgentProvider => AGENT_PROVIDERS.find((p) => p !== ANTHROPIC && p.runs(model)) ?? ANTHROPIC;

/** A model under its provider's name: Google's without the "(Antigravity)" the hub's list adds. */
export const modelShort = (m: Pick<ProfileModel, "id" | "displayName">): string => (m.displayName ?? m.id).replace(/ \(Antigravity\)$/u, "");

/** `items` by provider, in AGENT_PROVIDERS' order, each in the order given; a provider with none is left out. */
export function byProvider<T>(items: ReadonlyArray<T>, modelOf: (item: T) => string): { provider: AgentProvider; items: T[] }[] {
  return AGENT_PROVIDERS.map((provider) => ({ provider, items: items.filter((i) => providerOf(modelOf(i)).id === provider.id) })).filter((g) => g.items.length > 0);
}

/** What a provider runs, in a line: its first `most` models, then how many more ("Gemini 4 Neon · Gemini 4 Argon · 2
 * more"); every one without `most`. */
export function runsWords(models: ReadonlyArray<ProfileModel>, provider: AgentProviderId, most = Infinity): string {
  const names = models.filter((m) => providerOf(m.id).id === provider).map(modelShort);
  const shown = names.slice(0, most);
  return [...shown, ...(names.length > shown.length ? [`${names.length - shown.length} more`] : [])].join(" · ");
}

/**
 * Whether Google is connected for agents, from antigravity_status (undefined: a hub that doesn't serve it, or it
 * failed): "yes" once the team's key is saved, a machine is signed in or a bot holds a key (that bot's, with
 * `project`); "no" when every machine said it isn't and there is no key; "unknown" otherwise, where a sign-in is offered
 * all the same (it says so at once when it is).
 */
export function googleConnected(status: AntigravityStatusOutput | undefined, project?: ProjectRef): "yes" | "no" | "unknown" {
  if (status === undefined) return "unknown";
  const keyed = status.keyIn.some((r) => project === undefined || (r.machineId === project.machineId && r.projectId === project.projectId));
  if (keyed || (status.teamKey?.sealedOn.length ?? 0) > 0 || status.machines.some((m) => m.signedIn !== undefined)) return "yes";
  return status.machines.every((m) => m.checked) ? "no" : "unknown";
}

/** How Google is connected, in a few words: "API key", "Signed in · Google AI Pro", "API key in 2 bots", some of them,
 * or nothing. */
export function googleWords(status: AntigravityStatusOutput | undefined): string | undefined {
  if (status === undefined) return undefined;
  const plan = status.machines.find((m) => m.signedIn !== undefined)?.signedIn;
  const keys = status.keyIn.length;
  const parts = [
    status.teamKey === undefined ? null : "API key",
    plan === undefined ? null : `Signed in · ${plan}`,
    keys === 0 || status.teamKey !== undefined ? null : `API key in ${keys === 1 ? "1 bot" : `${keys} bots`}`,
  ];
  const said = parts.filter((p) => p !== null).join(" · ");
  return said === "" ? undefined : said;
}

/** The name a profile made from a model takes: the model's id where that fits a profile name and is free. */
export function profileNameFor(model: string, profiles: ReadonlyArray<Pick<Profile, "name">>): string {
  const base = model
    .replace(/^antigravity\//u, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]/gu, "-")
    .replace(/^[^a-z0-9]+/u, "")
    .slice(0, 32);
  const taken = new Set(profiles.map((p) => p.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const name = `${base.slice(0, 30)}-${n}`;
    if (!taken.has(name)) return name;
  }
}
