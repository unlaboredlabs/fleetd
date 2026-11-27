// Which bot memory lines wait for an admin's OK (decision grok.takeaways-go, its call 10): a line that would loosen what asks or merges
// ("never ask before deploying", "merge without review"), taught by someone who isn't an owner or admin, is held:
// it isn't written to the bot's memory until an admin keeps it. Two plain checks, either one holds: the lead's
// `remember` says the line's effect (`loosens`), and the line's own words name a gate (asking, approving, review,
// merging, deploying…) next to a word that waives it (never, without, skip…). Words alone err toward holding: "never
// merge without review" is held too, and an admin keeps it in one press. Taking a line out that names a gate (forget,
// or remember in its place) is held the same way. The nightly upkeep's rewrites and merges hold only for what they add
// (`upkeepLoosens`, decision memory.upkeep-rewrites-no-hold). Pure, so the cloud holds the same lines.

/** What a `remember` call says its line does: `loosens` makes the bot ask less, or merge or deploy with less review. */
export type MemoryEffect = "none" | "loosens";

export const MEMORY_EFFECTS: readonly MemoryEffect[] = ["none", "loosens"];

/** A word for something that stops to ask a person, or checks work before it lands or ships, by the gate it names. */
const GATES: readonly (readonly [string, string])[] = [
  ["ask", "ask(s|ed|ing)?"],
  ["approve", "approv\\w*"],
  ["confirm", "confirm\\w*"],
  ["permission", "permission\\w*"],
  ["consent", "consent"],
  ["review", "review\\w*"],
  ["sign-off", "sign[- ]?off"],
  ["merge", "merg\\w*"],
  ["deploy", "deploy\\w*"],
  ["ship", "ship(s|ped|ping)?"],
  ["release", "releas\\w*"],
  ["publish", "publish\\w*"],
  ["push", "push(es|ed|ing)?"],
  ["checker", "checker"],
  ["wait for", "wait(s|ing)? for"],
  ["check with", "check(s|ing)? with"],
];
const GATE = new RegExp(`\\b(${GATES.map(([, word]) => word).join("|")})\\b`, "u");
const GATE_EACH = GATES.map(([gate, word]) => [gate, new RegExp(`\\b(${word})\\b`, "u")] as const);

/** A word that waives a gate, or lets the bot go ahead on its own. */
const WAIVE =
  /\b(never|no|not|don'?t|doesn'?t|without|skip\w*|stop\w*|bypass\w*|ignor\w*|auto\w*|straight|directly|yourself|unasked|unreviewed|no longer|right away|immediately|go ahead|fine to|ok(ay)? to|allowed to|free to|yolo)\b/u;

const lower = (text: string) => text.toLowerCase().replace(/[’‘]/gu, "'");

/** Whether a line's words loosen a gate, by the two word lists: deterministic, and wider than it needs to be. */
export function loosensByWords(text: string): boolean {
  const t = lower(text);
  return GATE.test(t) && WAIVE.test(t);
}

/** Whether a line names a gate at all: one taken out ("always ask before deploying" forgotten or replaced) may loosen it. */
export function namesGate(text: string): boolean {
  return GATE.test(lower(text));
}

/** Whether a line loosens: the lead said so, or its words do. */
export const loosens = (text: string, effect: MemoryEffect | undefined): boolean => effect === "loosens" || loosensByWords(text);

/**
 * Whether a change to a bot's memory loosens: a line written that loosens, or one taken out (`removed`, the whole
 * entry forgotten or replaced) that names a gate, which may have been what kept it asking.
 */
export const changeLoosens = (text: string | undefined, effect: MemoryEffect | undefined, removed: string | undefined): boolean =>
  (text !== undefined && loosens(text, effect)) || (removed !== undefined && namesGate(removed));

/** The gates a text names, by name ("ask", "deploy"…). */
export function gatesOf(text: string): Set<string> {
  const t = lower(text);
  return new Set(GATE_EACH.flatMap(([gate, word]) => (word.test(t) ? [gate] : [])));
}

/**
 * The gates a text waives: those named in a clause (cut at commas, colons, dashes, brackets) that also has a waiving
 * word, so "runs in Helsinki, deploys from main, without asking" waives asking and not deploying. A sentence whose
 * words loosen with no such clause ("Never, ever deploy") waives every gate it names.
 */
export function waivedGates(text: string): Set<string> {
  const waived = new Set<string>();
  for (const sentence of lower(text).split(/[.;!?]+(?:\s|$)|\n/u)) {
    const before = waived.size;
    for (const clause of sentence.split(/[,:()[\]]|\s[-–—]+\s|—/u)) {
      if (WAIVE.test(clause)) for (const gate of gatesOf(clause)) waived.add(gate);
    }
    if (waived.size === before && loosensByWords(sentence)) for (const gate of gatesOf(sentence)) waived.add(gate);
  }
  return waived;
}

const within = (some: Set<string>, all: Set<string>) => [...some].every((gate) => all.has(gate));

/**
 * Whether a change by the nightly memory upkeep loosens (decision memory.upkeep-rewrites-no-hold): it rewords or
 * merges lines already in memory, so it loosens only by what it adds. A line written (`text`, in place of `replaced`
 * when it rewrites one) loosens when it waives a gate the line it replaces didn't, or the upkeep's own `effect` says
 * it loosens and the line it replaces didn't by its words; it drops a gate when the line it replaces named one the new
 * line doesn't. A line taken out (`text` undefined) loosens when it names a gate no line the upkeep wrote this run
 * (`written`) carries. Deterministic, as `changeLoosens`, which a person's change keeps.
 */
export function upkeepLoosens(text: string | undefined, effect: MemoryEffect | undefined, replaced: string | undefined, written: readonly string[] = []): boolean {
  if (text === undefined) return replaced !== undefined && !within(gatesOf(replaced), gatesOf(written.join("\n")));
  const old = replaced ?? "";
  if (effect === "loosens" && !loosensByWords(old)) return true;
  return !within(waivedGates(text), waivedGates(old)) || !within(gatesOf(old), gatesOf(text));
}

/**
 * Whether a bot memory line waits for an admin: it loosens, whoever taught it is not an owner or admin (`taughtByAdmin`
 * false, a line with no person behind it included), and the workspace has an admin to keep it (one with no people
 * yet has nobody to ask, and its lines apply as before).
 */
export const holdsForAdmin = (loosening: boolean, taughtByAdmin: boolean, anyAdmin: boolean): boolean => anyAdmin && !taughtByAdmin && loosening;
