// The team's own hosted sandbox accounts (W688), without the hub or the node: the providers in the one fixed order
// agents go to them, the limit's bounds, and what a node's check of a key found. The hub keeps the keys (hub/sandbox)
// and its slot board places agents by count (hub/slots/board.ts); a node checks a key with the provider's client and
// makes one box per agent there (node/sandbox, node/place/hosted.ts).
import type { ComputerChoice, ComputerPick, KnownSandboxCheckReason, KnownSandboxProvider, ProviderTrouble, SandboxProviderState, SlotSandbox } from "./contracts.ts";
import { notOffered, SIZES, sizeText } from "../sandbox/providers/common.ts";
import { settingsPath } from "./settings_path.ts";
import { FLEETD_COMPUTERS } from "../../../app/desktop/src/shared/providers.ts";

/** A provider as a person reads it, from its id or the name an older node or cloud put in its words ("boat.dev"). */
export { providerName } from "../../../app/desktop/src/shared/providers.ts";

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

/** Each provider as a person reads it, in every line of the hub's, the node's and fleetd cloud's: fleetd's computers,
 * never the supplier's own name (the apps' one mapping, app/desktop/src/shared/providers.ts). */
export const NAMES: Readonly<Record<KnownSandboxProvider, string>> = { boat: FLEETD_COMPUTERS };

/** How long a provider that failed to make a box is left out of placement (the node's boxes.ts), and so how long a
 * lead whose box didn't come up waits before a message can start it there again (the hub's leads/cut_off.ts). */
export const ASIDE_MS = 10 * 60_000;
/** How long one that refused for its start rate (`rate`: its starts a minute) is left out: its starts free by
 * themselves, so it is asked again in a minute, and a lead whose start it refused is started again then. */
export const RATE_MS = 60_000;
/** The few words a start-rate refusal reads as, after the provider's name (`refusalWords`); the hub's chat line for a
 * lead that couldn't start finds them in the node's words to start it again in a minute (hub/leads/cut_off.ts). */
export const RATE_WORDS = "start rate: trying again in a minute";

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

export const REASONS: readonly KnownSandboxCheckReason[] = ["invalid_key", "limit", "billing", "rate", "unreachable", "failed"];

/** A check's reason as one this build knows; anything else is `failed`. */
export const reasonOf = (r: unknown): KnownSandboxCheckReason => (REASONS.includes(r as KnownSandboxCheckReason) ? (r as KnownSandboxCheckReason) : "failed");

/** What fixes a failed check of `provider`'s key, by its reason (the hub's and fleetd cloud's words): trying again,
 * later for what only fleetd fixes; lowering the limit; nothing for a start rate, which frees by itself. The supplier's
 * own dashboard is never named: the account is fleetd's. */
export function checkFix(_provider: KnownSandboxProvider, reason: string): string {
  switch (reason) {
    case "invalid_key":
    case "billing":
      return "try again later";
    case "limit":
      return "lower the limit here, or try again later";
    case "rate":
      return "";
    default:
      return "try again in a minute";
  }
}

/** The longest a provider's own words go into a line a person reads. */
const WHY_MAX = 200;

/** The supplier's own name and domains, as a sentence relayed from a box or an older node may still carry them. */
const SUPPLIER = /\b(?:[\w-]+\.)*boat\.dev\b|\bboat\b(?=\s)/giu;

/**
 * A provider's or box's own sentence as a person reads it: no status code in brackets, no address, the supplier never
 * named (fleetd's computers instead, as every line names them), at most WHY_MAX characters.
 */
export function plainWhy(text: string): string {
  const t = text
    .replace(/\s*\((?:HTTP )?\d{3}\b[^)]*\)/g, "")
    .replace(/\b(?:https?|wss?):\/\/\S+/giu, "")
    .replace(/\s*\([^()]*\b(?:[\w-]+\.)*boat\.dev\b[^()]*\)/giu, "")
    .replace(/\bboat(?:\.dev)?'s\b/giu, `${FLEETD_COMPUTERS}'`)
    .replace(SUPPLIER, FLEETD_COMPUTERS)
    .replace(/\(\s*\)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.;:,]+$/, "");
  return t.length > WHY_MAX ? `${t.slice(0, WHY_MAX - 1)}…` : t;
}

/** What a refusal of `provider` means, in a few words, by its reason (`failed`: the provider's own, `why`). */
export function refusalWords(provider: KnownSandboxProvider, reason: string, why: string): string {
  const name = NAMES[provider];
  switch (reason) {
    case "invalid_key":
      return `${name} refused the key`;
    case "billing":
      return `${name} refused: billing isn't set up on the account`;
    case "limit":
      return `${name} refused: the account is at its plan's limit`;
    case "rate":
      return `${name} are at their ${RATE_WORDS}`;
    case "unreachable":
      return `${name} didn't answer`;
    default:
      return plainWhy(why) || `${name} didn't start a sandbox`;
  }
}

/** A provider's trouble as a machine reported it (shared/node_link.ts SandboxTrouble), as the apps show it: what is
 * wrong and its fix in plain words, and when its agents are tried there again. */
export function troubleOf(provider: KnownSandboxProvider, t: { what: string; reason: string; why: string; until?: number }): ProviderTrouble {
  const reason = reasonOf(t.reason);
  const message =
    t.what === "keep_alive"
      ? `${NAMES[provider]} couldn't keep their sandboxes running: ${reason === "failed" ? plainWhy(t.why) || "no reason given" : refusalWords(provider, reason, t.why)}`
      : refusalWords(provider, reason, t.why);
  const fix = checkFix(provider, reason);
  return { what: t.what, reason, message, ...(fix ? { fix } : {}), ...(t.until !== undefined ? { until: new Date(t.until).toISOString() } : {}) };
}

/** A trouble's line where a person reads why an agent waits or didn't start: what is wrong, its fix, and when it is
 * tried again ("fleetd's computers refused: billing isn't set up on the account (try again later); trying again at
 * 12:45", the hub's clock, UTC, as its other lines). A start rate's own words say when: "in a minute". */
export const troubleLine = (t: Pick<ProviderTrouble, "message" | "fix" | "until"> & { reason?: string }): string =>
  `${t.message}${t.fix ? ` (${t.fix})` : ""}${t.until && t.reason !== "rate" ? `; trying again at ${t.until.slice(11, 16)}` : ""}`;

/** One connected provider's limit, as the hub sends it to the team's machines (`sandbox_limits`), in ORDER. */
export type Limit = { provider: KnownSandboxProvider; max: number };

/** A bot's computer as a person reads it: "fleetd's computers · 4 vCPU / 8 GB". */
export const computerLabel = (p: { kind: string; cpu: number; memGb: number }): string => `${isProvider(p.kind) ? NAMES[p.kind] : p.kind} · ${sizeText(p)}`;

/** Why a bot's agents can't have a hosted sandbox: they'd run on their machine's own Claude login, which never leaves it. */
export const NO_ACCOUNT_HOSTED = `hosted sandboxes take only agents on a Claude account, and this bot's run on its machine's own login: connect one in Settings › Accounts › Claude`;

/** The bot's machine as fleetd cloud still passes it to `computerChoices` until its W760 pin move: no choice reads it. */
export type ComputerMachine = { name: string; sandbox?: SlotSandbox; host?: { cpus: number; memGb?: number; vmGb?: number }; cap?: number };

/**
 * What a bot may pick for its agents' computers, each a real machine at an exact size: each connected provider's sizes
 * in ORDER (a key that failed its last test says so). A pick no longer among them (its provider disconnected) stays,
 * saying why, so it is never shown as another. None where no provider is connected: the bot's agents run on its
 * machine, and there is nothing to pick.
 */
export function computerChoices(o: { providers: readonly SandboxProviderState[]; pick?: ComputerPick; account: boolean; machine?: ComputerMachine }): ComputerChoice[] {
  const out: ComputerChoice[] = [];
  for (const p of ORDER) {
    const st = o.providers.find((x) => x.provider === p);
    if (!st?.connected) continue;
    const off =
      st.check && !st.check.ok ? `the key for ${NAMES[p]} failed its last test: ${st.check.message ?? `test it again in ${settingsPath()} › Machines`}` : o.account ? undefined : NO_ACCOUNT_HOSTED;
    for (const size of SIZES[p]) out.push({ kind: p, cpu: size.cpu, memGb: size.memGb, label: computerLabel({ kind: p, ...size }), ...(off ? { unavailable: off } : {}) });
  }
  const pick = o.pick;
  if (pick && !out.some((c) => c.kind === pick.kind && c.cpu === pick.cpu && c.memGb === pick.memGb)) {
    const why = !isProvider(pick.kind)
      ? `this hub doesn't know ${pick.kind}`
      : (notOffered(pick.kind, pick, NAMES[pick.kind]) ?? `${NAMES[pick.kind]} aren't connected: an admin connects them in ${settingsPath()} › Machines`);
    out.push({ kind: pick.kind, cpu: pick.cpu, memGb: pick.memGb, label: computerLabel(pick), unavailable: why });
  }
  return out;
}
