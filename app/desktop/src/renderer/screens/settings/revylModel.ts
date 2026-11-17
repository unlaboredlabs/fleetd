// The words and choices of Revyl in Hub › Machines (Providers, What runs where), pure so they are tested on their own: the team's own
// Revyl key (connected or not, its last check) and, per phone kind, where an agent's screen of it runs. Before a key is
// connected the Revyl choices stay in the list, off, and the row says why and what turns them on: an admin connects
// a key in place, anyone else asks an admin.
import type { RevylCheck, RevylKind, RevylState } from "../../../shared/contracts";

/** The kinds Revyl hosts, in the picker's order: phones only, never Revyl's Web or Mac. */
export const REVYL_KINDS: ReadonlyArray<{ readonly kind: RevylKind; readonly label: string }> = [
  { kind: "ios", label: "iOS simulator" },
  { kind: "android", label: "Android" },
];

export { ROUTE_WORDS, routeChoices, routeChosen, usesRevyl } from "../../../shared/providers";

/**
 * Why a kind's Revyl choices are off and what turns them on, null while they are on: an admin gets Connect Revyl
 * beside it, anyone else is told whom to ask.
 */
export const routeOffLine = (connected: boolean, admin: boolean): string | null =>
  connected ? null : admin ? "Revyl choices need a Revyl key." : "Revyl choices need a Revyl key: ask an admin to connect one in Settings › Hub › Machines.";

/**
 * The Revyl row's line: what its key's last check found when it failed (with what fixes it), and "Works" only just
 * after a check run here; nothing at rest while it works, or while no key is connected (Connect says that).
 */
export const revylLine = (state: Pick<RevylState, "connected" | "check">, justChecked: boolean): { text: string; tone: "quiet" | "danger"; fix?: string } | null => {
  const check: RevylCheck | undefined = state.check;
  if (!state.connected || check === undefined) return null;
  if (check.ok) return justChecked ? { text: "Works", tone: "quiet" } : null;
  return { text: failWords(check), tone: "danger", ...(check.fix === undefined ? {} : { fix: check.fix }) };
};

/** A failed check in a sentence: the hub's own words, else its reason's. */
const failWords = (check: RevylCheck): string => {
  if (check.message !== undefined && check.message !== "") return check.message;
  switch (check.reason) {
    case "invalid_key":
      return "Revyl refused the key: it is wrong, revoked or expired.";
    case "no_cli":
      return "Revyl's CLI couldn't be installed where the key is tested.";
    default:
      return "Couldn't reach Revyl with the key.";
  }
};

/** A pasted key, trimmed: a key copied with a line break or spaces round it still connects; empty is no key. */
export const keyOf = (pasted: string): string | null => {
  const key = pasted.trim();
  return key === "" ? null : key;
};
