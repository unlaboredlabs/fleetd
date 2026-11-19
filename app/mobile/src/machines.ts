// Settings › Machines on the phone (admins only), as the desktop's Hub › Machines has it (D550): the machines and how
// each is, the providers the team connects with its own key (each with what it can run, from the one model in
// desktop/src/shared/providers), and what runs where. In words the screens show; pure, so it is tested on its own.
import type { Machine, SandboxCheck, SandboxProviderState, SandboxState } from "../../desktop/src/shared/contracts";
import { specOf } from "../../desktop/src/shared/providers";

export { agentsWhere, CAPABILITY_WORDS, canWords, KINDS, machinesRun, NONE, noneHow, specOf, YOURS, type Capability } from "../../desktop/src/shared/providers";

/** A provider's name as people know it; one a newer hub has is shown as it names it. */
export const providerName = (p: string): string => specOf(p).name;

/** Only E2B takes a domain: a self-hosted E2B's. */
export const takesDomain = (p: string): boolean => p === "e2b";

/** The Settings row shows for an admin. */
export const machinesShown = (admin: boolean | undefined): boolean => admin === true;

/**
 * A machine's row value: Online, what the hub says is wrong, or Offline; `warn` while it needs someone. The hub's runner
 * with no Claude account for its sandboxes says that in a few words, not the hub's whole sentence.
 */
export const machineValue = (m: Pick<Machine, "status" | "degradedReason" | "degradedCause" | "runner">): { text: string; warn: boolean } => {
  if (m.status === "online") return { text: "Online", warn: false };
  if (m.status === "degraded" && m.runner === true && m.degradedCause === "claude_login") return { text: "Needs a Claude account", warn: true };
  if (m.status === "degraded") {
    const why = m.degradedReason?.split(/\s+Fix:/u)[0]?.trim().replace(/[.:]$/u, "");
    return { text: why === undefined || why === "" ? "Needs a look" : why.charAt(0).toUpperCase() + why.slice(1), warn: true };
  }
  return { text: "Offline", warn: true };
};

/** A provider as Providers lists it: the hub's own state for it. */
export type ProviderState = { id: string; connected: boolean; limit?: number; check?: SandboxCheck | undefined; domain?: string | undefined };

/** Every provider the hub has, in the model's order. */
export const providersOf = (sandboxes: SandboxState | undefined): ProviderState[] =>
  (sandboxes?.providers ?? []).map((p: SandboxProviderState) => ({ id: p.provider, connected: p.connected, limit: p.limit, check: p.check, domain: p.domain }));

/** A provider's row value: not connected, its key refused, its limit, or Connected; `problem` when its check failed. */
export const providerValue = (p: ProviderState): { text: string; problem: boolean } => {
  if (!p.connected) return { text: "Not connected", problem: false };
  if (p.check !== undefined && !p.check.ok) return { text: "Check failed", problem: true };
  return { text: p.limit === undefined ? "Connected" : `${limitWords(p.limit)} at once`, problem: false };
};

/**
 * Providers' footer: what they cost, the order, and while no machine places agents there, that none runs there yet;
 * then a line for each provider fleetd removed that the hub had connected, for a while after the update.
 */
export const providersFooter = (sandboxes: Pick<SandboxState, "placing" | "removed"> | undefined): string => {
  const yet = sandboxes === undefined || sandboxes.placing ? "" : " Agents don't run in hosted sandboxes yet: this fleetd keeps the keys and limits for the update that adds them.";
  const removed = (sandboxes?.removed ?? []).map((line) => `\n\n${line}`).join("");
  return `Your team's own accounts, which bill you. Agents go to the connected ones in this order once your machines are full.${yet}${removed}`;
};

/** The limit's choices, as an action sheet lists them: none up to 500, and the one set when it isn't among them. */
const STEPS = [0, 1, 2, 3, 5, 10, 20, 50, 100, 200, 500];
export const limitChoices = (current: number): number[] => (STEPS.includes(current) ? STEPS : [...STEPS, current].sort((a, b) => a - b));
export const limitWords = (n: number): string => (n === 0 ? "None" : String(n));

/** A connected provider's footer on its screen: its last check's failure with the fix, else its self-hosted domain. */
export const providerFooter = (p: Pick<ProviderState, "id" | "connected" | "check" | "domain">): { text: string; problem: boolean } | undefined => {
  if (!p.connected) return undefined;
  const check = p.check;
  if (check !== undefined && !check.ok) {
    const words = check.message !== undefined && check.message !== "" ? check.message : `${providerName(p.id)} didn't take the key.`;
    const fix = check.fix === undefined ? "" : ` ${check.fix.charAt(0).toUpperCase()}${check.fix.slice(1)}${/[.!?]$/.test(check.fix) ? "" : "."}`;
    return { text: `${words}${fix}`, problem: true };
  }
  return p.domain === undefined ? undefined : { text: `Self-hosted at ${p.domain}`, problem: false };
};

/** How long recordings are kept: its choices, and the one set when it isn't among them. */
export const daysChoices = (current: number): number[] => [...new Set([7, 14, 30, 60, 90, 180, 365, current])].sort((a, b) => a - b);
