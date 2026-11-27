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

/** A waiving word as one name: "don't" is "dont", "skipping" is "skip", "okay to" is "ok to". */
const waiveName = (word: string) => {
  const w = word.replace(/'/gu, "").replace(/^okay/u, "ok");
  return /^(skip|stop|bypass|ignor|auto)/u.exec(w)?.[1] ?? w;
};

const waiversOf = (text: string) => [...new Set([...text.matchAll(new RegExp(WAIVE.source, "gu"))].map((m) => waiveName(m[1] as string)))].sort();

/** Words that cut an exception out of a rule ("Never merge without review, except hotfixes."). */
const EXCEPT = /\b(except|unless|other than|apart from)\b/gu;

/**
 * How a text waives its gates: each gate named in a clause (cut at commas, colons, dashes, brackets) with the waiving
 * words of that clause, "merge:never+without". So "runs in Helsinki, deploys from main, without asking" pairs asking
 * with "without" and leaves deploying alone, and "Merge without review." pairs differently from "Never merge without
 * review.". A sentence whose words loosen with no such clause ("Never, ever deploy") pairs every gate it names with
 * its waiving words, and an exception ("except hotfixes", "unless") joins the words of every gate its sentence names.
 */
export function pairingsOf(text: string): Set<string> {
  const pairs = new Set<string>();
  for (const sentence of lower(text).split(/[.;!?]+(?:\s|$)|\n/u)) {
    // An exception anywhere in a sentence waives each gate it names: "except" after a comma still cuts into "never merge".
    const except = [...new Set([...sentence.matchAll(EXCEPT)].map((m) => m[1] as string))];
    const paired = new Set<string>();
    const pair = (part: string, waivers: string[]) => {
      const words = [...new Set([...waivers, ...except])].sort().join("+");
      for (const gate of gatesOf(part)) {
        pairs.add(`${gate}:${words}`);
        paired.add(gate);
      }
    };
    for (const clause of sentence.split(/[,:()[\]]|\s[-–—]+\s|—/u)) if (WAIVE.test(clause)) pair(clause, waiversOf(clause));
    if (paired.size === 0 && loosensByWords(sentence)) pair(sentence, waiversOf(sentence));
    if (except.length > 0) for (const gate of gatesOf(sentence)) if (!paired.has(gate)) pairs.add(`${gate}:${except.sort().join("+")}`);
  }
  return pairs;
}

/** The gates a text waives, by `pairingsOf`. */
export const waivedGates = (text: string): Set<string> => new Set([...pairingsOf(text)].map((p) => p.slice(0, p.indexOf(":"))));

const within = (some: Set<string>, all: Set<string>) => [...some].every((x) => all.has(x));

/**
 * Whether a change by the nightly memory upkeep loosens (decision memory.upkeep-rewrites-no-hold): it rewords or
 * merges lines already in memory, so it loosens only by what it adds. A line written (`text`, in place of `replaced`
 * when it rewrites one) loosens when it pairs a gate with waiving words the line it replaces didn't pair it with
 * ("Never merge without review." made "Merge without review." holds), when the upkeep's own `effect` says it loosens,
 * or when it drops a gate the line it replaces named. A line taken out (`text` undefined) loosens when it names a gate
 * no line the upkeep wrote this run (`written`) carries. Deterministic, as `changeLoosens`, which a person's change keeps.
 */
export function upkeepLoosens(text: string | undefined, effect: MemoryEffect | undefined, replaced: string | undefined, written: readonly string[] = []): boolean {
  if (text === undefined) return replaced !== undefined && !within(gatesOf(replaced), gatesOf(written.join("\n")));
  const old = replaced ?? "";
  if (effect === "loosens") return true;
  return !within(pairingsOf(text), pairingsOf(old)) || !within(gatesOf(old), gatesOf(text));
}

/**
 * Whether a bot memory line waits for an admin: it loosens, whoever taught it is not an owner or admin (`taughtByAdmin`
 * false, a line with no person behind it included), and the workspace has an admin to keep it (one with no people
 * yet has nobody to ask, and its lines apply as before).
 */
export const holdsForAdmin = (loosening: boolean, taughtByAdmin: boolean, anyAdmin: boolean): boolean => anyAdmin && !taughtByAdmin && loosening;
