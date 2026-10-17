import type { Ask } from "@fleetd/contracts";

// The terse reply grammar (m3-spec "Reply grammar"). Pure: `parseReply` reads text into a plan, `resolvePlan`
// checks the plan against a batch's items. Neither touches state; Inbox applies the result.
//
//   reply := item ((";"|","|newline|" ") item)*
//   item  := sel verb [note] | "recs" ["fine"|"ok"] | "all" verb | "#B" n (first only) | "pref:" text | "forget" Dn
//   sel   := n | n "-" n | sel "," sel
//   verb  := go|yes|y|ok|rec|recs | no|nvm|drop|skip|n | a-f | done | later | ":" text | "quoted text"
//   note  := ":" text | "quoted text"        (kept as the decision's why)
//
// Free text after ":" (and after "pref:") runs to the end of the line or the next ";".

export type Verb =
  | { readonly kind: "accept" }
  | { readonly kind: "reject" }
  | { readonly kind: "option"; readonly index: number }
  | { readonly kind: "done" }
  | { readonly kind: "later" }
  | { readonly kind: "text"; readonly text: string };

export interface PlanItem {
  readonly number: number;
  readonly verb: Verb;
  readonly note?: string;
}

export interface ReplyPlan {
  /** From a leading "#B<n>". */
  readonly batch?: number;
  /** One per mentioned item number, in reply order. */
  readonly items: ReadonlyArray<PlanItem>;
  /** "recs fine" or "all <verb>": applies to every open item the reply does not mention. */
  readonly rest?: Verb;
  readonly prefs: ReadonlyArray<string>;
  /** Decision numbers from "forget Dn". */
  readonly forgets: ReadonlyArray<number>;
}

export type ParseResult =
  | { readonly parsed: true; readonly plan: ReplyPlan }
  | { readonly parsed: false; readonly hint: string };

export const GRAMMAR_HINT =
  'Reply like "1 go 2 nvm 3 b", "1-3 go", "recs fine", "2: your own answer", "#B4 1 go", "pref: <text>" or "forget D12".';

const MAX_TEXT = 2000;
const MAX_NUMBER = 999;

const VERBS: Record<string, Verb> = {
  go: { kind: "accept" },
  yes: { kind: "accept" },
  y: { kind: "accept" },
  ok: { kind: "accept" },
  rec: { kind: "accept" },
  recs: { kind: "accept" },
  no: { kind: "reject" },
  nvm: { kind: "reject" },
  drop: { kind: "reject" },
  skip: { kind: "reject" },
  n: { kind: "reject" },
  done: { kind: "done" },
  later: { kind: "later" },
  ..."abcdef".split("").reduce<Record<string, Verb>>((acc, letter, index) => {
    acc[letter] = { kind: "option", index };
    return acc;
  }, {}),
};

class ParseError extends Error {}

const fail = (message: string): never => {
  throw new ParseError(message);
};

export const parseReply = (raw: string): ParseResult => {
  try {
    return { parsed: true, plan: parse(raw) };
  } catch (error) {
    if (error instanceof ParseError) return { parsed: false, hint: `${error.message} ${GRAMMAR_HINT}` };
    throw error;
  }
};

const QUOTES: Record<string, string> = { '"': '"', "“": "”" };

const parse = (raw: string): ReplyPlan => {
  let pos = 0;
  const items: Array<PlanItem> = [];
  const seen = new Set<number>();
  const prefs: Array<string> = [];
  const forgets: Array<number> = [];
  let rest: Verb | undefined;
  let batch: number | undefined;
  let first = true;

  /** Matches `re` (compiled sticky) at `pos`, advancing past it. */
  const eat = (re: RegExp): RegExpExecArray | undefined => {
    re.lastIndex = pos;
    const match = re.exec(raw);
    if (!match) return undefined;
    pos = re.lastIndex;
    return match;
  };
  const snippet = () => raw.slice(pos).split(/[\s;,]/u)[0] || raw.slice(pos, pos + 12);

  /** Text up to the end of the line or the next ";". */
  const lineText = (what: string) => {
    const match = eat(/[^;\n]*/uy);
    const text = (match?.[0] ?? "").trim();
    if (text === "") fail(`${what} is empty.`);
    if (text.length > MAX_TEXT) fail(`${what} is longer than ${MAX_TEXT} characters.`);
    return text;
  };

  const quoted = (): string | undefined => {
    const open = raw[pos];
    const close = open === undefined ? undefined : QUOTES[open];
    if (close === undefined) return undefined;
    const end = raw.indexOf(close, pos + 1);
    if (end < 0) fail("A quote is not closed.");
    const text = raw.slice(pos + 1, end).trim();
    pos = end + 1;
    if (text === "") fail("A quoted answer is empty.");
    if (text.length > MAX_TEXT) fail(`An answer is longer than ${MAX_TEXT} characters.`);
    return text;
  };

  const number = (text: string) => {
    const n = Number(text);
    if (n < 1 || n > MAX_NUMBER) fail(`There is no item ${text}.`);
    return n;
  };

  /** n, n-n, and comma lists of either. */
  const selection = (): Array<number> => {
    const numbers: Array<number> = [];
    do {
      const match = eat(/(\d+)(?:[ \t]*-[ \t]*(\d+))?/uy)!;
      const from = number(match[1]!);
      const to = match[2] === undefined ? from : number(match[2]);
      if (to < from) fail(`The range ${from}-${to} runs backwards.`);
      if (to - from >= 100) fail(`The range ${from}-${to} is too long.`);
      for (let n = from; n <= to; n++) numbers.push(n);
    } while (eat(/[ \t]*,[ \t]*(?=\d)/uy));
    return numbers;
  };

  /** A verb; `subject` names what it answers, for hints. */
  const verb = (subject: string): Verb => {
    eat(/[ \t]*/uy);
    if (eat(/:/uy)) return { kind: "text", text: lineText(`The answer to ${subject}`) };
    const text = quoted();
    if (text !== undefined) return { kind: "text", text };
    const word = eat(/([a-z]+)(?![a-z])/iuy);
    if (!word) fail(`${subject} needs an answer such as go, nvm, a, done, later or ": text".`);
    const found = VERBS[word![1]!.toLowerCase()];
    if (found === undefined) fail(`"${word![1]}" is not an answer word.`);
    if (word![1]!.toLowerCase() === "recs") eat(/[ \t]+(?:fine|ok)(?![a-z])/iuy);
    return found!;
  };

  /** An optional `: why` or quoted why after a word verb. */
  const note = (): string | undefined => {
    const before = pos;
    eat(/[ \t]*/uy);
    if (eat(/:/uy)) return lineText("The note");
    const text = quoted();
    if (text !== undefined) return text;
    pos = before;
    return undefined;
  };

  const setRest = (next: Verb) => {
    if (rest !== undefined) fail('Use only one of "recs fine" and "all <answer>".');
    rest = next;
  };

  while (true) {
    eat(/[\s,;]*/uy);
    if (pos >= raw.length) break;
    let match: RegExpExecArray | undefined;
    if ((match = eat(/#b[ \t]*(\d+)(?![a-z0-9])/iuy))) {
      if (!first) fail("#B<n> must come first.");
      batch = Number(match[1]);
      if (batch < 1) fail("There is no batch B0.");
    } else if (eat(/pref[ \t]*:/iuy)) {
      prefs.push(lineText("The preference"));
    } else if ((match = eat(/forget[ \t]+d(\d+)(?![a-z0-9])/iuy))) {
      const n = Number(match[1]);
      if (n < 1) fail("There is no decision D0.");
      forgets.push(n);
    } else if (eat(/forget(?![a-z])/iuy)) {
      fail('"forget" needs a decision id, like "forget D12".');
    } else if (eat(/recs(?:[ \t]+(?:fine|ok))?(?![a-z0-9])/iuy)) {
      setRest({ kind: "accept" });
    } else if (eat(/all(?![a-z])/iuy)) {
      setRest(verb('"all"'));
    } else if (/\d/u.test(raw[pos] ?? "")) {
      const numbers = selection();
      const subject = `Item ${numbers.join(",")}`;
      const v = verb(subject);
      const why = v.kind === "text" ? undefined : note();
      for (const n of numbers) {
        if (seen.has(n)) fail(`Item ${n} is answered twice.`);
        seen.add(n);
        items.push(why === undefined ? { number: n, verb: v } : { number: n, verb: v, note: why });
      }
    } else {
      fail(`Could not read "${snippet()}".`);
    }
    first = false;
  }

  if (first) fail("The reply is empty.");
  return {
    ...(batch === undefined ? {} : { batch }),
    items,
    ...(rest === undefined ? {} : { rest }),
    prefs,
    forgets,
  };
};

export type Action =
  | { readonly kind: "answer"; readonly number: number; readonly ask: Ask; readonly value: string; readonly note?: string }
  | { readonly kind: "withdraw"; readonly number: number; readonly ask: Ask }
  | { readonly kind: "later"; readonly number: number; readonly ask: Ask };

export type Resolution =
  | { readonly ok: true; readonly actions: ReadonlyArray<Action> }
  | { readonly ok: false; readonly hint: string };

/**
 * Checks `plan` against the batch's items and turns it into actions. An item is open when its ask is open and
 * still in this batch. "recs fine" skips open items with no recommendation (do-asks); every other mismatch
 * refuses the whole reply.
 */
export const resolvePlan = (
  plan: ReplyPlan,
  batchId: string,
  items: ReadonlyArray<{ readonly number: number; readonly ask: Ask }>,
): Resolution => {
  const byNumber = new Map(items.map((item) => [item.number, item.ask]));
  const isOpen = (ask: Ask) => ask.state === "open" && ask.batchId === batchId;
  const actions: Array<Action> = [];
  const hints: Array<string> = [];

  const act = (number: number, ask: Ask, verb: Verb, note: string | undefined, fromRest: boolean) => {
    const answer = (value: string) =>
      actions.push(note === undefined ? { kind: "answer", number, ask, value } : { kind: "answer", number, ask, value, note });
    switch (verb.kind) {
      case "accept":
        if (ask.recommendation === undefined) {
          if (!fromRest) hints.push(`Item ${number} is a do-ask with no recommendation: reply "${number} done" once finished.`);
          return;
        }
        return answer(ask.recommendation);
      case "reject":
        // A product call the human hands back is withdrawn ("your call"); a refused money, credential or
        // irreversible step is logged as "no" so it is not asked again.
        if (ask.class === "product") return actions.push({ kind: "withdraw", number, ask });
        return answer("no");
      case "option": {
        const option = ask.options?.[verb.index];
        if (option === undefined) {
          hints.push(`Item ${number} has no option ${"abcdef"[verb.index]}.`);
          return;
        }
        return answer(option);
      }
      case "done":
        if (ask.kind !== "do") {
          if (!fromRest) hints.push(`Item ${number} is a question, not a checklist: answer it instead of "done".`);
          return;
        }
        return answer("done");
      case "later":
        return actions.push({ kind: "later", number, ask });
      case "text":
        return answer(verb.text);
    }
  };

  for (const item of plan.items) {
    const ask = byNumber.get(item.number);
    if (ask === undefined) hints.push(`${batchId} has no item ${item.number}.`);
    else if (!isOpen(ask)) hints.push(`Item ${item.number} of ${batchId} is already ${ask.state === "open" ? "moved" : ask.state}.`);
    else act(item.number, ask, item.verb, item.note, false);
  }
  if (plan.rest) {
    const mentioned = new Set(plan.items.map((item) => item.number));
    for (const item of items) {
      if (!mentioned.has(item.number) && isOpen(item.ask)) act(item.number, item.ask, plan.rest, undefined, true);
    }
  }
  return hints.length > 0 ? { ok: false, hint: hints.join(" ") } : { ok: true, actions };
};
