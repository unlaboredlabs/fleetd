// Settings › Sandboxes on the phone (admins only): the team's own hosted sandbox accounts, as the desktop's Hub ›
// Machines › Sandboxes has them, in words the screen shows. Pure, so it is tested on its own.
import type { SandboxCheck, SandboxProvider, SandboxProviderState, SandboxState } from "../../desktop/src/shared/contracts";

const NAMES: Readonly<Record<string, string>> = { e2b: "E2B", boat: "boat.dev", daytona: "Daytona" };
/** A provider's name as people know it; one a newer hub has is shown as it names it. */
export const providerName = (p: SandboxProvider): string => NAMES[p] ?? p;

/** Only E2B takes a domain: a self-hosted E2B's. */
export const takesDomain = (p: SandboxProvider): boolean => p === "e2b";

/** The Settings row shows for an admin on a hub that serves it. */
export const sandboxesShown = (admin: boolean | undefined, serves: boolean): boolean => admin === true && serves;

/** The screen's first footer: what it is for, and while no machine places agents there, that none runs there yet. */
export const introFooter = (state: Pick<SandboxState, "placing" | "providers">): string => {
  const on = state.providers.filter((p) => p.connected).map((p) => providerName(p.provider));
  const order = on.length < 2 ? "" : ` Agents go to ${on.slice(0, -1).join(", then ")}, then ${on.at(-1)}.`;
  const yet = state.placing ? "" : " They don't run there yet: this fleetd keeps the keys and limits for the update that adds them.";
  return `When a machine's own slots are full, agents run in sandboxes on your team's account, which bills you.${order}${yet}`;
};

/** The limit's choices, as an action sheet lists them: none up to 500, and the one set when it isn't among them. */
const STEPS = [0, 1, 2, 3, 5, 10, 20, 50, 100, 200, 500];
export const limitChoices = (current: number): number[] => (STEPS.includes(current) ? STEPS : [...STEPS, current].sort((a, b) => a - b));
export const limitWords = (n: number): string => (n === 0 ? "None" : String(n));

/** A connected provider's footer: its last check's failure with the fix, else its self-hosted domain; none else. */
export const providerFooter = (p: Pick<SandboxProviderState, "provider" | "connected" | "check" | "domain">): { text: string; problem: boolean } | undefined => {
  if (!p.connected) return undefined;
  const check: SandboxCheck | undefined = p.check;
  if (check !== undefined && !check.ok) {
    const words = check.message !== undefined && check.message !== "" ? check.message : `${providerName(p.provider)} didn't take the key.`;
    const fix = check.fix === undefined ? "" : ` ${check.fix.charAt(0).toUpperCase()}${check.fix.slice(1)}${/[.!?]$/.test(check.fix) ? "" : "."}`;
    return { text: `${words}${fix}`, problem: true };
  }
  return p.domain === undefined ? undefined : { text: `Self-hosted at ${p.domain}`, problem: false };
};
