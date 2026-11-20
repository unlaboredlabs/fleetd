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
 * the machine it runs on: it has no slots of its own, and never uses a machine's Claude login. Its agents' screens run
 * in their own boxes (node/place/box_screens.ts), as every hosted agent's do.
 */
export const CAP_RUNNER = "hosted_runner";
/** The runner's machine id, and its name where a person reads it. */
export const RUNNER_ID = "hosted";
export const RUNNER_NAME = "Hosted sandboxes";
/**
 * Why the runner's id takes no join code, no roles and no max of its own (W743), as machine_remove already refuses
 * it: it is the hub's, not a computer, and its provider's limit is how many run at once. `what` ends the sentence.
 */
export const runnerRefused = (what: string) => `Hosted sandboxes are the hub's own, not a computer of the team's: ${what}`;

/**
 * Every provider, in the placement order: the order agents go to the connected ones once a machine's own slots are
 * full, which Settings shows. (sandbox/providers' own PROVIDERS is only the clients' list, in no such order.)
 */
export const ORDER: readonly KnownSandboxProvider[] = ["boat"];

export const NAMES: Readonly<Record<KnownSandboxProvider, string>> = { boat: "boat.dev" };

/** How long a provider that failed to make a box is left out of placement (the node's boxes.ts), and so how long a
 * lead whose box didn't come up waits before a message can start it there again (the hub's leads/cut_off.ts). */
export const ASIDE_MS = 10 * 60_000;

export const isProvider = (p: string): p is KnownSandboxProvider => (ORDER as readonly string[]).includes(p);

/**
 * The providers fleetd had and removed, and why, in a person's words: a Linux machine runs agents, their browser,
 * Linux desktop and Android, and a provider whose boxes can't run Android's emulator (it needs KVM in the box) isn't
 * one (D576). Checked on real boxes on 2026-11-19.
 */
export const REMOVED: Readonly<Record<string, { name: string; why: string }>> = {
  e2b: { name: "E2B", why: "its boxes have no KVM (Firecracker microVMs), so they can't run Android's emulator" },
  daytona: { name: "Daytona", why: "its boxes can't open /dev/kvm (user-namespaced containers), so they can't run Android's emulator" },
};

/** A provider's limit when none was set at connect. */
export const DEFAULT_LIMIT = 5;
/** The most agents one provider's limit allows. */
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
      return `test again in a minute; if it keeps failing, check ${machine} reaches ${name}`;
    default:
      return `test again in a minute; if it keeps failing, update fleetd on ${machine}`;
  }
}

/** One connected provider's limit, as the hub sends it to the team's machines (`sandbox_limits`), in ORDER. */
export type Limit = { provider: KnownSandboxProvider; max: number };

/** Each kind of computer by name, where a person reads it. */
export const COMPUTER_NAMES: Readonly<Record<ComputerKind, string>> = { vm: "Local VM", ...NAMES };

const kindOf = (k: string): ComputerKind | undefined => (k === "vm" || isProvider(k) ? k : undefined);

/** A bot's computer as a person reads it: "Local VM · 2 vCPU / 4 GB", "boat.dev · 4 vCPU / 8 GB". */
export const computerLabel = (p: { kind: string; cpu: number; memGb: number }): string => {
  const k = kindOf(p.kind);
  return `${k ? COMPUTER_NAMES[k] : p.kind} · ${sizeText(p)}`;
};

/** Whether a machine of `host`'s CPUs and memory (GB) runs a Local VM of `size`: its CPUs at most, and half its
 * memory at most, the rest for the machine itself and its other agents. A machine that hasn't said runs none. */
export const vmFits = (size: Size, host: { cpus: number; memGb?: number } | undefined): boolean =>
  host !== undefined && host.memGb !== undefined && size.cpu <= host.cpus && size.memGb * 2 <= host.memGb;

/** Why a bot's agents can't have a hosted sandbox: they'd run on their machine's own Claude login, which never leaves it. */
export const NO_ACCOUNT_HOSTED = `hosted sandboxes take only agents on a Claude account, and this bot's run on its machine's own login: connect one in Settings › Your accounts › Claude`;

/** Why machine `m`'s VMs won't take a bot's agents (`account`: they run on a Claude account), or undefined when they will:
 * a machine signed in with its own `claude login` puts only agents on an account in its VMs (node/place/microvm.ts). */
export const vmTakes = (m: { name: string; sandbox?: SlotSandbox }, account: boolean): string | undefined =>
  m.sandbox?.accountsOnly && !account
    ? `${m.name}'s VMs take only agents on a Claude account, and this bot's run on its own login: connect one in Settings › Your accounts › Claude`
    : undefined;

/** What a VM takes of its machine's memory beside its guest's, GiB (node/place/microvm.ts memPerAgentBytes). */
const VM_OVERHEAD_GB = 0.1;

/** The slots of its machine a Local VM of `size` takes: as many as its memory is of one of the machine's default VMs
 * (`vmGb`, its overhead with it), rounded up, at least one, so a big VM never over-commits the machine's memory; one
 * while the machine hasn't said its default's. */
export const vmSlots = (size: Size, vmGb: number | undefined): number =>
  vmGb === undefined || vmGb <= 0 ? 1 : Math.max(1, Math.ceil((size.memGb + VM_OVERHEAD_GB) / vmGb - 1e-9));

/** Why machine `m` can never run a Local VM of `size`: it takes more slots than the machine's own cap holds. */
export const overCap = (m: { name: string; cap?: number; host?: { vmGb?: number } }, size: Size): string | undefined => {
  const slots = vmSlots(size, m.host?.vmGb);
  return m.cap !== undefined && slots > m.cap
    ? `${m.name} runs at most ${m.cap} agents at once, and a VM of ${sizeText(size)} takes ${slots} of them (its memory's worth): raise ${m.name}'s max agents in Settings › Hub › Machines, or pick a smaller one`
    : undefined;
};

/** The bot's machine as `computerChoices` reads it, `cap` its own slots; undefined for a bot no machine runs (the
 * hub's runner). */
export type ComputerMachine = { name: string; sandbox?: SlotSandbox; host?: { cpus: number; memGb?: number; vmGb?: number }; cap?: number };

/**
 * What a bot may pick for its agents' computers, each a real machine at an exact size: its machine's Local VM in each
 * size it runs, where it runs VMs (or would, but can't now: then each says why, and the command that fixes it when there is
 * one; off by choice or by design, none), then
 * each connected provider's sizes in ORDER (a key that failed its last check says so). A pick no longer among them (its
 * provider disconnected, a size its machine no longer runs) stays, saying why, so it is never shown as another.
 */
export function computerChoices(o: { machine?: ComputerMachine; providers: readonly SandboxProviderState[]; pick?: ComputerPick; account: boolean }): ComputerChoice[] {
  const out: ComputerChoice[] = [];
  const add = (kind: ComputerKind, size: Size, unavailable?: string, fix?: string) =>
    out.push({
      kind,
      cpu: size.cpu,
      memGb: size.memGb,
      label: computerLabel({ kind, ...size }),
      ...(unavailable ? { unavailable, ...(fix ? { fix } : {}) } : {}),
    });
  const m = o.machine;
  const sb = m?.sandbox;
  if (m && sb && (sb.kind === "microvm" || !sb.expected)) {
    const down = sb.kind !== "microvm";
    const off = down ? `${m.name} runs no VMs now: ${sb.why ?? "no reason given"}` : vmTakes(m, o.account);
    for (const size of SIZES.vm) if (vmFits(size, m.host)) add("vm", size, off ?? overCap(m, size), down ? sb.fix : undefined);
  }
  for (const p of ORDER) {
    const st = o.providers.find((x) => x.provider === p);
    if (!st?.connected) continue;
    const off =
      st.check && !st.check.ok ? `${NAMES[p]}'s key failed its last test: ${st.check.message ?? "test it again in Settings › Hub › Machines"}` : o.account ? undefined : NO_ACCOUNT_HOSTED;
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
