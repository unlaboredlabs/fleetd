// The words and choices of the hosted sandbox providers in Hub › Machines › Providers, pure so they are tested on their own: the team's own hosted
// sandbox accounts (fleetd's computers), each a key connected or not and its limit, in the one fixed order agents go to them once
// a machine's own slots are full. A row's state and its line are shared/hostedRow.ts's, which the phone shares.
import { specOf } from "../../../shared/providers";
import type { SandboxProvider } from "../../../shared/contracts";

/** A provider's name as people know it (providersModel); one a newer hub has is shown as it names it. */
export const providerName = (p: SandboxProvider): string => specOf(p).name;

/** What each one is, for its row's hover. */
const HINTS: Readonly<Record<string, string>> = {
  boat: "fleetd's computers, each a whole VM, with its own browser, Linux desktop and Android.",
};
export const providerHint = (p: SandboxProvider): string | undefined => HINTS[p];

/** Providers' hover: what a provider costs, the order agents go to them, and that keys stay sealed. */
export const SECTION_HINT =
  "Your workspace's own accounts, which bill you while they run. Agents go to the connected ones in the order listed once " +
  "your machines are full, up to each one's limit. Keys are sealed and never shown again.";

/** The limit's choices: none, then up to 500, and the one set when it isn't among them. */
const STEPS = [0, 1, 2, 3, 4, 5, 8, 10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200, 300, 500];
export const limitChoices = (current: number): Array<{ value: string; label: string }> => {
  const values = STEPS.includes(current) ? STEPS : [...STEPS, current].sort((a, b) => a - b);
  return values.map((n) => ({ value: String(n), label: n === 0 ? "None at once" : `${n} at once` }));
};

/** A pasted key, trimmed: a key copied with a line break or spaces round it still connects; empty is no key. */
export const keyOf = (pasted: string): string | null => {
  const key = pasted.trim();
  return key === "" ? null : key;
};

