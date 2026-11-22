// The providers a team connects with its own key, as one model the desktop's Hub › Machines and the phone's Machines
// both read (D550): each with what it can run (agents, and which kinds of screen), so Providers lists them all, each
// saying what it runs; and What runs where's two rows, Linux machine and Mac machine. A provider that
// gains a kind is one entry here. Pure so it is tested on its own.

/** What a provider can run: agents, or a kind of agent screen. */
export type Capability = "agents" | "browser" | "desktop" | "android" | "ios" | "mac";

export const SCREEN_KINDS: ReadonlyArray<Capability> = ["browser", "desktop", "android", "ios", "mac"];

export interface ProviderSpec {
  /** The hub's id for it: a sandbox provider's (`boat`). */
  readonly id: string;
  readonly name: string;
  readonly can: ReadonlyArray<Capability>;
}

/**
 * fleetd's computers: the one name every provider of fleetd's own computers goes by wherever a person reads it, in the
 * apps, the docs and fleetd's own lines (fleetd/src/shared/sandbox.ts NAMES reads it from here). A supplier's own name
 * never shows; .github/supplier-check.mjs fails CI if one does.
 */
export const FLEETD_COMPUTERS = "fleetd's computers";

/** Every provider fleetd knows, in the order agents go to the connected ones; one a newer hub has goes last, as named. */
export const PROVIDERS: ReadonlyArray<ProviderSpec> = [
  { id: "boat", name: FLEETD_COMPUTERS, can: ["agents", "browser", "desktop", "android"] },
];

/** The words an older hub or cloud may still send for a provider (its supplier's name), by the provider's id. */
const SENT_AS: Readonly<Record<string, string>> = { "boat.dev": "boat" };

/**
 * The hub's own runner's machine id (fleetd's RUNNER_ID): the hosted sandboxes, a provider's, never a machine of the
 * team's. A link to it lands on the providers' rows (hostedReveal), not a machine's page.
 */
export const RUNNER_ID = "hosted";

/** The reveal key of a provider's row in Hub › Machines (Sandboxes.tsx), where every link to hosted sandboxes lands. */
export const providerReveal = (id: string): string => `hub.sandbox.${id}`;

/** The provider the hosted sandboxes are, where a person reads of them: the first, the one agents go to first. */
export const hostedProvider = (): ProviderSpec => PROVIDERS[0] ?? specOf("boat");

/** The row a link to the hosted sandboxes opens: their provider's. */
export const hostedReveal = (): string => providerReveal(hostedProvider().id);

/** A provider by its id; an unknown one runs agents (the hub lists it among its sandbox providers) under its own id. */
export const specOf = (id: string): ProviderSpec => PROVIDERS.find((p) => p.id === id) ?? { id, name: id, can: ["agents"] };

/** A provider as a person reads it, from its id or from the name a hub or cloud sent: "boat" and "boat.dev" both read
 * fleetd's computers. */
export const providerName = (idOrName: string): string => specOf(SENT_AS[idOrName] ?? idOrName).name;

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

/** What runs where's two rows: where agents and every Linux screen run, and where the Mac's screens run. */
export const LINUX = "Linux machine";
export const MAC = "Mac machine";

/** A choice of the Linux machine (sandbox_where_set): its value and its words. */
export type Choice = { readonly value: string; readonly label: string };

/**
 * The Linux machine's choices: with a machine of the team's, Your machines; with connected providers too, Your machines
 * first, then them in order; and each connected provider alone. The pick in effect stays listed when it no longer is
 * (its provider disconnected, the last machine gone), so it shows what holds and can be moved off. One choice or none:
 * not a choice, a plain value (`linuxValue`).
 */
export const linuxChoices = (providers: ReadonlyArray<{ provider: string; connected: boolean }>, machines: boolean, current = "ours_first"): Choice[] => {
  const connected = ordered(providers.filter((p) => p.connected).map((p) => p.provider));
  const names = connected.map((id) => specOf(id).name);
  const out: Choice[] = [];
  if (machines) out.push({ value: "ours_only", label: YOURS });
  if (machines && connected.length > 0) out.push({ value: "ours_first", label: `${YOURS} first, then ${names.join(", then ")}` });
  for (const id of connected) out.push({ value: id, label: `${specOf(id).name} only` });
  // With no machine, machines first is the providers in order: shown as such when there is only one.
  const only = names.length === 1 ? names[0] : undefined;
  if (!machines && only !== undefined && current === "ours_first") return [{ value: "ours_first", label: only }];
  if (current !== "ours_first" && !out.some((c) => c.value === current)) out.push({ value: current, label: current === "ours_only" ? YOURS : `${specOf(current).name} only` });
  return out;
};

/** The Linux machine as a plain value, where there is nothing to choose: Your machines, the one provider, or None yet. */
export const linuxValue = (providers: ReadonlyArray<{ provider: string; connected: boolean }>, machines: boolean): string => {
  const connected = ordered(providers.filter((p) => p.connected).map((p) => p.provider));
  if (machines) return YOURS;
  return connected.length === 0 ? NONE : connected.map((id) => specOf(id).name).join(", then ");
};

/** How to get a Linux machine, or a Mac machine, when there is none yet: the row's hover. */
export const LINUX_NONE = "Add a machine with the plus above, or connect a provider.";
export const MAC_NONE = "Add a Mac for agents with the plus above.";

/** The machines a kind of screen can run on, as machine_roles has them. */
type Machine = { roles: ReadonlyArray<string>; mac?: { on: boolean } | undefined; hosts?: ReadonlyArray<{ host: string; off?: string; ready: boolean }> | undefined };

/**
 * Whether any of the team's machines runs `kind`: one for agents; one that hosts screens and can run the kind, ready
 * now or once what it needs is there (no switch turns a kind off, D574); the agents' Mac for iOS.
 */
export const machinesRun = (kind: Capability, machines: ReadonlyArray<Machine>): boolean => {
  if (kind === "agents") return machines.some((m) => m.mac === undefined && m.roles.includes("agents"));
  if (kind === "ios") return machines.some((m) => m.mac?.on === true);
  return machines.some((m) => (m.roles.includes("sessions") || m.mac !== undefined) && (m.hosts ?? []).some((h) => h.host === kind && h.off !== "unsupported"));
};

