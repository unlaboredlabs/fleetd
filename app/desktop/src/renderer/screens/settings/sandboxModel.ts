// The words and choices of the hosted sandbox providers in Hub › Machines › Providers, pure so they are tested on their own: the team's own hosted
// sandbox accounts (E2B, boat.dev, Daytona), each a key connected or not, its last check and its limit, in the one
// fixed order agents go to them once a machine's own slots are full.
import { specOf } from "../../../shared/providers";
import type { SandboxCheck, SandboxProvider, SandboxProviderState, SandboxState } from "../../../shared/contracts";

/** A provider's name as people know it (providersModel); one a newer hub has is shown as it names it. */
export const providerName = (p: SandboxProvider): string => specOf(p).name;

/** What each one is, for its row's hover. */
const HINTS: Readonly<Record<string, string>> = {
  e2b: "Sandboxes on your E2B account (a Pro plan runs them past an hour), or on your own self-hosted E2B: give its domain.",
  boat: "Sandboxes on your boat.dev account, each a whole VM.",
  daytona: "Sandboxes on your Daytona account, up to 8 GB of memory each.",
};
export const providerHint = (p: SandboxProvider): string | undefined => HINTS[p];

/** Only E2B takes a domain: a self-hosted E2B's. */
export const takesDomain = (p: SandboxProvider): boolean => p === "e2b";

/** Providers' hover: what a provider costs, the order agents go to them, and that keys stay sealed. */
export const SECTION_HINT =
  "Your team's own accounts, which bill you while they run. Agents go to the connected ones in the order listed once " +
  "your machines are full, up to each one's limit. Keys are sealed and never shown again.";

/** While no machine places agents there yet, in the section, so nobody connects one expecting room today. */
export const notPlacingLine = (state: Pick<SandboxState, "placing">): string | null =>
  state.placing ? null : "Agents don't run in hosted sandboxes yet: this fleetd keeps the keys and limits for the update that adds them.";

/** The limit's choices: none, then up to 500, and the one set when it isn't among them. */
const STEPS = [0, 1, 2, 3, 4, 5, 8, 10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200, 300, 500];
export const limitChoices = (current: number): Array<{ value: string; label: string }> => {
  const values = STEPS.includes(current) ? STEPS : [...STEPS, current].sort((a, b) => a - b);
  return values.map((n) => ({ value: String(n), label: n === 0 ? "None at once" : `${n} at once` }));
};

/**
 * A provider's row line: what its key's last check found when it failed (with what fixes it), "Works" only just after
 * a check run here, else its self-hosted domain, else nothing.
 */
export const providerLine = (
  p: Pick<SandboxProviderState, "provider" | "connected" | "check" | "domain">,
  justChecked: boolean,
): { text: string; tone: "quiet" | "danger"; fix?: string; domain?: true } | null => {
  if (!p.connected) return null;
  const check: SandboxCheck | undefined = p.check;
  if (check !== undefined && !check.ok) return { text: failWords(p.provider, check), tone: "danger", ...(check.fix === undefined ? {} : { fix: check.fix }) };
  if (check?.ok === true && justChecked) return { text: "Works", tone: "quiet" };
  return p.domain === undefined ? null : { text: p.domain, tone: "quiet", domain: true };
};

/** A failed check in a sentence: the hub's own words, else its reason's. */
const failWords = (provider: SandboxProvider, check: SandboxCheck): string => {
  if (check.message !== undefined && check.message !== "") return check.message;
  const name = providerName(provider);
  switch (check.reason) {
    case "invalid_key":
      return `${name} refused the key: it is wrong, revoked or expired.`;
    case "limit":
      return `The ${name} account is at its plan's limit.`;
    case "billing":
      return `${name} won't run sandboxes until the account's billing is sorted.`;
    case "unreachable":
      return `${name} didn't answer.`;
    default:
      return `Couldn't reach ${name} with the key.`;
  }
};

/** A line and its fix as one sentence pair, the fix capitalised. */
export const withFix = (line: { text: string; fix?: string }): string =>
  line.fix === undefined ? line.text : `${line.text} ${line.fix.charAt(0).toUpperCase()}${line.fix.slice(1)}${/[.!?]$/.test(line.fix) ? "" : "."}`;

/** A pasted key, trimmed: a key copied with a line break or spaces round it still connects; empty is no key. */
export const keyOf = (pasted: string): string | null => {
  const key = pasted.trim();
  return key === "" ? null : key;
};

/** A typed domain, trimmed; empty is none (E2B's own). */
export const domainOf = (typed: string): string | undefined => {
  const d = typed.trim();
  return d === "" ? undefined : d;
};
