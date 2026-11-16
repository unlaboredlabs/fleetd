// The words and choices of Hub › Machines › Screens' Revyl part, pure so they are tested on their own: the team's own
// Revyl key (connected or not, its last check) and, per phone kind, where an agent's screen of it runs. Before a key is
// connected the Revyl choices stay in the list, off, and the row says why and what turns them on: an admin connects
// a key in place, anyone else asks an admin.
import type { RevylCheck, RevylKind, RevylRoute, RevylState } from "../../../shared/contracts";

/** The kinds Revyl hosts, in the picker's order: phones only, never Revyl's Web or Mac. */
export const REVYL_KINDS: ReadonlyArray<{ readonly kind: RevylKind; readonly label: string }> = [
  { kind: "ios", label: "iOS simulator" },
  { kind: "android", label: "Android" },
];

export const ROUTE_WORDS: Readonly<Record<string, string>> = {
  ours_first: "Our machines first, then Revyl",
  ours_only: "Our machines only",
  revyl_only: "Revyl only",
};

const ROUTES: ReadonlyArray<RevylRoute> = ["ours_first", "ours_only", "revyl_only"];

/** Whether a route needs a Revyl key. */
export const usesRevyl = (route: RevylRoute): boolean => route !== "ours_only";

/**
 * A kind's choices: all three, the two that use Revyl off until a key is connected, saying so in their own words
 * (the row's line says what turns them on). A route a newer hub has is listed too, as it names it, so the choice
 * shows what is in effect.
 */
export const routeChoices = (connected: boolean, current: RevylRoute): Array<{ value: RevylRoute; label: string; disabled?: boolean }> => {
  const known = ROUTES.map((value) =>
    connected || !usesRevyl(value) ? { value, label: ROUTE_WORDS[value] ?? value } : { value, label: `${ROUTE_WORDS[value] ?? value} (needs a Revyl key)`, disabled: true },
  );
  return ROUTES.includes(current) ? known : [...known, { value: current, label: current }];
};

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
      return "The hub's machine has no revyl command.";
    default:
      return "Couldn't reach Revyl with the key.";
  }
};

/** Whether a failed check's fix is a command to run on the hub's machine (installing Revyl's CLI). */
export const fixIsCommand = (state: Pick<RevylState, "check">): boolean => state.check?.reason === "no_cli";

/** A pasted key, trimmed: a key copied with a line break or spaces round it still connects; empty is no key. */
export const keyOf = (pasted: string): string | null => {
  const key = pasted.trim();
  return key === "" ? null : key;
};
