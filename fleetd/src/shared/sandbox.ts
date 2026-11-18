// The team's own hosted sandbox accounts (W688), without the hub or the node: the providers in the one fixed order
// agents go to them, the limit's bounds, and what a node's check of a key found. The hub keeps the keys (hub/sandbox)
// and its slot board places agents by count (hub/slots/board.ts); a node checks a key with the provider's client and
// makes one box per agent there (node/sandbox, node/place/hosted.ts).
import type { ComputerChoice, ComputerPick, KnownSandboxCheckReason, KnownSandboxProvider, SandboxProviderState, SlotSandbox } from "./contracts.ts";
import { type ComputerKind, notOffered, SIZES, type Size, sizeText } from "../sandbox/providers/common.ts";

/** The capability a node lists when it creates agents' sandboxes, so the hub tests keys and sends limits there. */
export const CAP_SANDBOX = "sandbox";

/**
 * The capability of the hub's own runner (hub/runner): a node the hub starts itself, so that a team with no computer
 * connected still runs agents. It runs every session (leads too) in a box of the team's connected providers, none on
 * the machine it runs on: it has no slots of its own, offers no screens and never uses a machine's Claude login.
 */
export const CAP_RUNNER = "hosted_runner";
/** The runner's machine id, and its name where a person reads it. */
export const RUNNER_ID = "hosted";
export const RUNNER_NAME = "Hosted sandboxes";

/**
 * Every provider, in the placement order: the order agents go to the connected ones once a machine's own slots are
 * full, which Settings shows. (sandbox/providers' own PROVIDERS is only the clients' list, in no such order.)
 */
export const ORDER: readonly KnownSandboxProvider[] = ["e2b", "boat", "daytona"];

export const NAMES: Readonly<Record<KnownSandboxProvider, string>> = { e2b: "E2B", boat: "boat.dev", daytona: "Daytona" };

export const isProvider = (p: string): p is KnownSandboxProvider => (ORDER as readonly string[]).includes(p);

/** A provider's limit when none was set at connect. */
export const DEFAULT_LIMIT = 5;
/** The most agents one provider's limit allows: E2B Pro's own ceiling is a little above it. */
export const MAX_LIMIT = 500;

/** How long Settings' Test of a key may take on a machine (the provider's list). */
export const CHECK_WAIT = 30_000;

export const REASONS: readonly KnownSandboxCheckReason[] = ["invalid_key", "limit", "billing", "unreachable", "failed"];

/** A check's reason as one this build knows; anything else is `failed`. */
export const reasonOf = (r: unknown): KnownSandboxCheckReason => (REASONS.includes(r as KnownSandboxCheckReason) ? (r as KnownSandboxCheckReason) : "failed");

/** What fixes a failed check of `provider`'s key on `machine`, by its reason (the hub's and fleetd cloud's words). */
export function checkFix(provider: KnownSandboxProvider, reason: string, machine: string): string {
  const name = NAMES[provider];
  switch (reason) {
    case "invalid_key":
      return `${name} refused the key: it may be wrong, revoked or from another account. Make a new one in ${name}'s dashboard and connect it again.`;
    case "limit":
      return `the ${name} account is at its plan's limit: raise the plan at ${name}, or lower the limit here`;
    case "billing":
      return `${name} won't run sandboxes on the account until its billing is sorted: check it in ${name}'s dashboard`;
    case "unreachable":
      return provider === "e2b"
        ? `test again in a minute; with a self-hosted E2B, check its domain answers from ${machine}`
        : `test again in a minute; if it keeps failing, check ${machine} reaches ${name}`;
    default:
      return `test again in a minute; if it keeps failing, update fleetd on ${machine}`;
  }
}

/** One connected provider's limit, as the hub sends it to the team's machines (`sandbox_limits`), in ORDER. */
export type Limit = { provider: KnownSandboxProvider; max: number };

/** A domain as typed (`https://e2b.example.com/`): its host and port, lower case; null when it isn't one. */
export function domainOf(typed: string): string | null {
  const t = typed.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (t === "") return null;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$/.test(t) && t.length <= 253 ? t : null;
}

/** Each kind of computer by name, where a person reads it. */
export const COMPUTER_NAMES: Readonly<Record<ComputerKind, string>> = { vm: "Local VM", ...NAMES };

const kindOf = (k: string): ComputerKind | undefined => (k === "vm" || isProvider(k) ? k : undefined);

/** A bot's computer as a person reads it: "Local VM · 2 vCPU / 4 GB", "E2B · 4 vCPU / 8 GB". */
export const computerLabel = (p: { kind: string; cpu: number; memGb: number }): string => {
  const k = kindOf(p.kind);
  return `${k ? COMPUTER_NAMES[k] : p.kind} · ${sizeText(p)}`;
};

/** Whether a machine of `host`'s CPUs and memory (GB) runs a Local VM of `size`: its CPUs at most, and half its
 * memory at most, the rest for the machine itself and its other agents. A machine that hasn't said runs none. */
export const vmFits = (size: Size, host: { cpus: number; memGb?: number } | undefined): boolean =>
  host !== undefined && host.memGb !== undefined && size.cpu <= host.cpus && size.memGb * 2 <= host.memGb;

/** The bot's machine as `computerChoices` reads it; undefined for a bot no machine runs (the hub's runner). */
export type ComputerMachine = { name: string; sandbox?: SlotSandbox; host?: { cpus: number; memGb?: number } };

/**
 * What a bot may pick for its agents' computers, each a real machine at an exact size: its machine's Local VM in each
 * size it runs, where it runs VMs (or would, but can't now: then each says why; off by choice or by design, none), then
 * each connected provider's sizes in ORDER (a key that failed its last check says so). A pick no longer among them (its
 * provider disconnected, a size its machine no longer runs) stays, saying why, so it is never shown as another.
 */
export function computerChoices(o: { machine?: ComputerMachine; providers: readonly SandboxProviderState[]; pick?: ComputerPick }): ComputerChoice[] {
  const out: ComputerChoice[] = [];
  const add = (kind: ComputerKind, size: Size, unavailable?: string) =>
    out.push({ kind, cpu: size.cpu, memGb: size.memGb, label: computerLabel({ kind, ...size }), ...(unavailable ? { unavailable } : {}) });
  const m = o.machine;
  const sb = m?.sandbox;
  if (m && sb && (sb.kind === "microvm" || !sb.expected)) {
    const off = sb.kind === "microvm" ? undefined : `${m.name} runs no VMs now: ${sb.why ?? "no reason given"}`;
    for (const size of SIZES.vm) if (vmFits(size, m.host)) add("vm", size, off);
  }
  for (const p of ORDER) {
    const st = o.providers.find((x) => x.provider === p);
    if (!st?.connected) continue;
    const off = st.check && !st.check.ok ? `${NAMES[p]}'s key failed its last test: ${st.check.message ?? "test it again in Settings › Hub › Machines"}` : undefined;
    for (const size of SIZES[p]) add(p, size, off);
  }
  const pick = o.pick;
  if (pick && !out.some((c) => c.kind === pick.kind && c.cpu === pick.cpu && c.memGb === pick.memGb)) {
    const k = kindOf(pick.kind);
    const why = !k
      ? `this hub doesn't know ${pick.kind}`
      : (notOffered(k, pick) ??
        (k === "vm"
          ? !m
            ? "no computer of the team's runs this bot"
            : m.sandbox?.kind === "microvm" || (m.sandbox && !m.sandbox.expected)
              ? `${m.name} hasn't the CPUs or memory for it`
              : `${m.name} runs no VMs${m.sandbox?.why ? `: ${m.sandbox.why}` : ""}`
          : `${NAMES[k as KnownSandboxProvider]} isn't connected: an admin connects it in Settings › Hub › Machines`));
    out.push({ kind: pick.kind, cpu: pick.cpu, memGb: pick.memGb, label: computerLabel(pick), unavailable: why });
  }
  return out;
}
