// Which bot memory lines wait for an admin's OK (decision grok.takeaways-go, its call 10): a line that would loosen what asks or merges
// ("never ask before deploying", "merge without review"), taught by someone who isn't an owner or admin, is held:
// it isn't written to the bot's memory until an admin keeps it. Two plain checks, either one holds: the lead's
// `remember` says the line's effect (`loosens`), and the line's own words name a gate (asking, approving, review,
// merging, deploying…) next to a word that waives it (never, without, skip…). Words alone err toward holding: "never
// merge without review" is held too, and an admin keeps it in one press. Taking a line out that names a gate (forget,
// or remember in its place) is held the same way. Pure, so the cloud holds the same lines.

/** What a `remember` call says its line does: `loosens` makes the bot ask less, or merge or deploy with less review. */
export type MemoryEffect = "none" | "loosens";

export const MEMORY_EFFECTS: readonly MemoryEffect[] = ["none", "loosens"];

/** A word for something that stops to ask a person, or checks work before it lands or ships. */
const GATE =
  /\b(ask(s|ed|ing)?|approv\w*|confirm\w*|permission\w*|consent|review\w*|sign[- ]?off|merg\w*|deploy\w*|ship(s|ped|ping)?|releas\w*|publish\w*|push(es|ed|ing)?|checker|wait(s|ing)? for|check(s|ing)? with)\b/u;

/** A word that waives a gate, or lets the bot go ahead on its own. */
const WAIVE =
  /\b(never|no|not|don'?t|doesn'?t|without|skip\w*|stop\w*|bypass\w*|ignor\w*|auto\w*|straight|directly|yourself|unasked|unreviewed|no longer|right away|immediately|go ahead|fine to|ok(ay)? to|allowed to|free to|yolo)\b/u;

/** Whether a line's words loosen a gate, by the two word lists: deterministic, and wider than it needs to be. */
export function loosensByWords(text: string): boolean {
  const t = text.toLowerCase().replace(/[’‘]/gu, "'");
  return GATE.test(t) && WAIVE.test(t);
}

/** Whether a line names a gate at all: one taken out ("always ask before deploying" forgotten or replaced) may loosen it. */
export function namesGate(text: string): boolean {
  return GATE.test(text.toLowerCase().replace(/[’‘]/gu, "'"));
}

/** Whether a line loosens: the lead said so, or its words do. */
export const loosens = (text: string, effect: MemoryEffect | undefined): boolean => effect === "loosens" || loosensByWords(text);

/**
 * Whether a change to a bot's memory loosens: a line written that loosens, or one taken out (`removed`, the whole
 * entry forgotten or replaced) that names a gate, which may have been what kept it asking.
 */
export const changeLoosens = (text: string | undefined, effect: MemoryEffect | undefined, removed: string | undefined): boolean =>
  (text !== undefined && loosens(text, effect)) || (removed !== undefined && namesGate(removed));

/**
 * Whether a bot memory line waits for an admin: it loosens, whoever taught it is not an owner or admin (`taughtByAdmin`
 * false, a line with no person behind it included), and the workspace has an admin to keep it (one with no people
 * yet has nobody to ask, and its lines apply as before).
 */
export const holdsForAdmin = (loosening: boolean, taughtByAdmin: boolean, anyAdmin: boolean): boolean => anyAdmin && !taughtByAdmin && loosening;
