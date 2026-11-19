// The providers a team connects with its own key, as one model the desktop's Hub › Machines and the phone's Machines
// both read (D550): each with what it can run (agents, and which kinds of screen), so Providers lists them all, each
// saying what it runs, and What runs where offers a kind only the connected providers that run it. A provider that
// gains a kind is one entry here. Pure so it is tested on its own.

/** What a provider can run: agents, or a kind of agent screen. */
export type Capability = "agents" | "browser" | "desktop" | "android" | "ios" | "mac";

export const SCREEN_KINDS: ReadonlyArray<Capability> = ["browser", "desktop", "android", "ios", "mac"];

export interface ProviderSpec {
  /** The hub's id for it: a sandbox provider's (`e2b`). */
  readonly id: string;
  readonly name: string;
  readonly can: ReadonlyArray<Capability>;
}

/** Every provider fleetd knows, in the order agents go to the connected ones; one a newer hub has goes last, as named. */
export const PROVIDERS: ReadonlyArray<ProviderSpec> = [
  { id: "e2b", name: "E2B", can: ["agents"] },
  { id: "boat", name: "boat.dev", can: ["agents"] },
  { id: "daytona", name: "Daytona", can: ["agents"] },
];

/** A provider by its id; an unknown one runs agents (the hub lists it among its sandbox providers) under its own id. */
export const specOf = (id: string): ProviderSpec => PROVIDERS.find((p) => p.id === id) ?? { id, name: id, can: ["agents"] };

/** Whether a provider runs any of `what`: a group lists the providers that serve what it is about. */
export const serves = (spec: ProviderSpec, what: ReadonlyArray<Capability>): boolean => spec.can.some((c) => what.includes(c));

/** Ids in the model's order, any the model doesn't know after them in the order given. */
export const ordered = (ids: ReadonlyArray<string>): string[] => {
  const known = PROVIDERS.map((p) => p.id).filter((id) => ids.includes(id));
  return [...known, ...ids.filter((id) => !known.includes(id))];
};

/** How a capability reads, beside a provider's name and as a row of What runs where. */
export const CAPABILITY_WORDS: Readonly<Record<Capability, string>> = {
  agents: "Agents",
  browser: "Browser",
  desktop: "Linux desktop",
  android: "Android",
  ios: "iOS simulator",
  mac: "Mac",
};

/** What a provider runs, quietly beside its name: "Agents", "iOS simulator · Android". */
export const canWords = (spec: ProviderSpec): string => spec.can.map((c) => CAPABILITY_WORDS[c]).join(" · ");

/** What runs where's rows, one a kind, in this order. */
export const KINDS: ReadonlyArray<Capability> = ["agents", "browser", "desktop", "android", "ios", "mac"];

export const YOURS = "Your machines";
export const NONE = "None yet";

/**
 * Where agents run, in words: the machines (`machines`: any of the team's computers runs agents), then each connected
 * provider with room (a limit above none) in the order agents go to them once the machines' own limit is reached. With
 * no machine, the providers alone; with neither, none yet. Not a choice: each provider's limit sets it.
 */
export const agentsWhere = (providers: ReadonlyArray<{ provider: string; connected: boolean; limit: number }>, machines = true): string => {
  const names = ordered(providers.filter((p) => p.connected && p.limit > 0).map((p) => p.provider)).map((id) => specOf(id).name);
  if (names.length === 0) return machines ? YOURS : NONE;
  return machines ? `${YOURS} first, then ${names.join(", then ")}` : names.join(", then ");
};

/** The machines a kind of screen can run on now, as machine_roles has them. */
type Machine = { roles: ReadonlyArray<string>; mac?: { on: boolean } | undefined; hosts?: ReadonlyArray<{ host: string; on?: boolean; ready: boolean }> | undefined };

/** Whether any of the team's machines runs `kind` now: one for agents, one with the kind on, the agents' Mac. */
export const machinesRun = (kind: Capability, machines: ReadonlyArray<Machine>): boolean => {
  if (kind === "agents") return machines.some((m) => m.mac === undefined && m.roles.includes("agents"));
  if (kind === "ios") return machines.some((m) => m.mac?.on === true);
  return machines.some((m) => (m.roles.includes("sessions") || m.mac !== undefined) && (m.hosts ?? []).some((h) => h.host === kind && (h.on ?? h.ready)));
};

/** Where a kind with no provider to choose runs, and how to add one when none does. */
export const noneHow: Readonly<Record<Capability, string>> = {
  agents: "Add a machine with the plus above, or connect a provider.",
  browser: "Turn Browser on in a machine's Screens.",
  desktop: "Turn Linux desktop on in a machine's Screens.",
  android: "Turn Android on in a machine's Screens.",
  ios: "Add a Mac for agents with the plus above.",
  mac: "Add a Mac for agents with the plus above.",
};
